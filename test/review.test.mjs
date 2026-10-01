/**
 * Tests for the deterministic review analyser and the tool that exposes it.
 *
 * @module test/review
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REVIEW_MARKER,
  RULES,
  analyseDiff,
  parseUnifiedDiff,
  renderReviewBody,
  toReviewComments,
} from '../lib/review.js'
import { loadPlugin, callTool, callToolExpectingError, mockFetch, unmockFetch } from './harness.mjs'

test.afterEach(() => unmockFetch())

/** A diff that trips several rules at once. */
const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,6 @@',
  ' const x = 1',
  '+console.log("debug")',
  '+const apiKey = "sk-AAAAAAAAAAAAAAAAAAAAAAAA"',
  ' const y = 2',
  '+// TODO: remove this',
  'diff --git a/.env b/.env',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/.env',
  '@@ -0,0 +1,1 @@',
  '+SECRET=abc',
].join('\n')

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

test('parseUnifiedDiff keeps post-image line numbers', () => {
  const files = parseUnifiedDiff(DIFF)
  assert.equal(files.length, 2)
  assert.deepEqual(
    files[0].added.map((entry) => entry.line),
    [2, 3, 5],
  )
  assert.equal(files[0].path, 'src/app.js')
  assert.equal(files[0].removed, 0)
  assert.equal(files[0].hunks, 1)
  assert.equal(files[1].path, '.env')
})

test('parseUnifiedDiff handles removals and a missing trailing newline', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,2 @@',
    '-old line',
    '+new line',
    ' context',
    '\\ No newline at end of file',
  ].join('\n')
  const [file] = parseUnifiedDiff(diff)
  assert.equal(file.removed, 1)
  assert.deepEqual(file.added, [{ line: 1, text: 'new line' }])
})

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

test('secret literals and known token prefixes are errors', () => {
  const analysis = analyseDiff(DIFF)
  const rules = analysis.findings.map((finding) => finding.rule)
  assert.ok(rules.includes('secret-literal'))
  assert.ok(rules.includes('known-token-prefix'))
  const secret = analysis.findings.find((finding) => finding.rule === 'secret-literal')
  assert.equal(secret.severity, 'error')
  assert.equal(secret.path, 'src/app.js')
  assert.equal(secret.line, 3)
})

test('debug output, deferred markers and sensitive files are all reported', () => {
  const analysis = analyseDiff(DIFF)
  const byRule = Object.fromEntries(analysis.findings.map((finding) => [finding.rule, finding]))
  assert.equal(byRule['debug-leftover'].severity, 'warning')
  assert.equal(byRule['debug-leftover'].line, 2)
  assert.equal(byRule['todo-added'].severity, 'note')
  assert.equal(byRule['sensitive-file'].severity, 'error')
  assert.equal(byRule['sensitive-file'].path, '.env')
  assert.equal(byRule['sensitive-file'].line, null, 'file-level findings carry no line')
})

test('counts add up and roll-up totals match the diff', () => {
  const analysis = analyseDiff(DIFF)
  assert.equal(analysis.files, 2)
  assert.equal(analysis.additions, 4)
  assert.equal(analysis.deletions, 0)
  const total = analysis.counts.error + analysis.counts.warning + analysis.counts.note
  assert.equal(total, analysis.findings.length)
})

test('every rule declares a known severity and an anchor', () => {
  for (const rule of RULES) {
    assert.ok(['error', 'warning', 'note'].includes(rule.severity), rule.id)
    assert.ok(rule.test !== undefined || rule.file !== undefined, `${rule.id} can never fire`)
    assert.equal(typeof rule.message, 'string')
  }
})

test('a clean diff produces no findings', () => {
  const diff = [
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,1 +1,2 @@',
    ' # Title',
    '+A useful sentence.',
  ].join('\n')
  const analysis = analyseDiff(diff)
  assert.deepEqual(analysis.findings, [])
  assert.deepEqual(analysis.counts, { error: 0, warning: 0, note: 0 })
})

test('importing child_process is not treated as dynamic evaluation', () => {
  // Regression: this exact line in this plugin's own diff was flagged before
  // the rule was narrowed to real evaluation constructs.
  const diff = [
    'diff --git a/lib/x.js b/lib/x.js',
    '--- a/lib/x.js',
    '+++ b/lib/x.js',
    '@@ -1,1 +1,3 @@',
    ' // header',
    "+import { execFile } from 'node:child_process'",
    '+const out = await execFile("git", ["status"])',
  ].join('\n')
  assert.deepEqual(analyseDiff(diff).findings, [])

  const evaluated = [
    'diff --git a/lib/y.js b/lib/y.js',
    '--- a/lib/y.js',
    '+++ b/lib/y.js',
    '@@ -1,1 +1,2 @@',
    ' // header',
    '+const result = eval(userInput)',
  ].join('\n')
  const findings = analyseDiff(evaluated).findings
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'dangerous-eval')
})

test('a large pull request is flagged once, ahead of the per-line findings', () => {
  const added = Array.from({ length: 60 }, (_, index) => `+line ${index}`)
  const diff = [
    'diff --git a/big.txt b/big.txt',
    '--- a/big.txt',
    '+++ b/big.txt',
    `@@ -0,0 +1,${added.length} @@`,
    ...added,
  ].join('\n')

  const analysis = analyseDiff(diff, { largeChangeLines: 50 })
  assert.equal(analysis.findings[0].rule, 'large-change')
  assert.equal(analysis.findings[0].severity, 'note')

  const relaxed = analyseDiff(diff, { largeChangeLines: 5000 })
  assert.equal(relaxed.findings.filter((finding) => finding.rule === 'large-change').length, 0)
})

test('findings are truncated to maxFindings and the flag is set', () => {
  const added = Array.from({ length: 40 }, () => '+console.log("x")')
  const diff = [
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    `@@ -0,0 +1,${added.length} @@`,
    ...added,
  ].join('\n')

  const analysis = analyseDiff(diff, { maxFindings: 5 })
  assert.equal(analysis.findings.length, 5)
  assert.equal(analysis.truncated, true)
  assert.equal(analysis.counts.warning, 40, 'counts describe everything found, not just the returned page')
})

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

test('toReviewComments anchors line findings and separates the rest', () => {
  const analysis = analyseDiff(DIFF)
  const { inline, unanchored } = toReviewComments(analysis, { minSeverity: 'warning', limit: 20 })

  assert.equal(inline.length, 3, 'two error lines plus one debug line')
  for (const comment of inline) {
    assert.equal(comment.side, 'RIGHT')
    assert.equal(typeof comment.line, 'number')
    assert.match(comment.body, /\*\*(error|warning)\*\*/)
  }
  assert.ok(unanchored.some((finding) => finding.rule === 'sensitive-file'))
  assert.ok(unanchored.every((finding) => finding.line === null))
})

test('toReviewComments honours minSeverity and the comment limit', () => {
  const analysis = analyseDiff(DIFF)
  const errorsOnly = toReviewComments(analysis, { minSeverity: 'error', limit: 20 })
  assert.ok(errorsOnly.inline.every((comment) => comment.body.includes('**error**')))

  const everything = toReviewComments(analysis, { minSeverity: 'note', limit: 20 })
  assert.ok(everything.inline.length > errorsOnly.inline.length)

  const capped = toReviewComments(analysis, { minSeverity: 'note', limit: 1 })
  assert.equal(capped.inline.length, 1)
  assert.ok(capped.unanchored.length >= 2, 'overflow is reported, not dropped')
})

test('the rendered body always carries the stable marker', () => {
  const body = renderReviewBody(analyseDiff(DIFF), { title: 'Review of #1' })
  assert.ok(body.startsWith(REVIEW_MARKER))
  assert.match(body, /## Review of #1/)
  assert.match(body, /2 file\(s\) · \+4 −0/)
  assert.match(body, /`secret-literal`/)
})

// ---------------------------------------------------------------------------
// The tool that exposes the analyser
// ---------------------------------------------------------------------------

test('github_analyze_pull reads the diff and returns publishable pieces', async () => {
  const calls = mockFetch([['/pulls/3', { body: DIFF }]])
  const { tools } = await loadPlugin()
  const result = await callTool(tools, 'github_analyze_pull', { owner: 'o', repo: 'r', number: 3 })

  assert.equal(calls[0].headers.accept, 'application/vnd.github.v3.diff')
  assert.equal(result.pullNumber, 3)
  assert.equal(result.counts.error, 3)
  assert.ok(result.reviewBody.startsWith(REVIEW_MARKER))
  assert.ok(result.inlineComments.length > 0)
  assert.ok(Array.isArray(result.unanchoredFindings))
})

test('github_analyze_pull validates minSeverity and clamps maxComments', async () => {
  mockFetch([['/pulls/3', { body: DIFF }]])
  const { tools } = await loadPlugin()

  assert.match(
    await callToolExpectingError(tools, 'github_analyze_pull', { owner: 'o', repo: 'r', number: 3, minSeverity: 'fatal' }),
    /minSeverity must be one of error, warning, note/,
  )

  const result = await callTool(tools, 'github_analyze_pull', {
    owner: 'o',
    repo: 'r',
    number: 3,
    minSeverity: 'note',
    maxComments: 999,
  })
  assert.ok(result.inlineComments.length <= 50)
})
