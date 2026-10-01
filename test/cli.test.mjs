/**
 * Tests for the standalone review CLI.
 *
 * `run()` takes its IO by injection, so nothing here spawns a process, touches
 * the network, or needs a GitHub repository.
 *
 * @module test/cli
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseArgs, renderReport, run } from '../bin/review.mjs'
import { analyseDiff } from '../lib/review.js'
import { mockFetch, unmockFetch } from './harness.mjs'

test.afterEach(() => unmockFetch())

/** A diff with one error, one warning and one note. */
const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,2 +1,4 @@',
  ' const a = 1',
  '+const apiKey = "sk-abcdefghijklmnopqrstuvwx"',
  '+console.log("debug")',
  '+// TODO: tidy',
].join('\n')

/** Build an injected IO bundle. */
function makeIo({ files = { 'pr.diff': DIFF }, env = {}, lines = [] } = {}) {
  const out = []
  const err = []
  return {
    out,
    err,
    io: {
      readFile: (path) => {
        if (path in files) return files[path]
        throw new Error(`ENOENT: no such file ${path}`)
      },
      stdin: (async function* generate() {
        for (const line of lines) yield Buffer.from(line)
      })(),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      env,
    },
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test('parseArgs defaults and rejects bad input', () => {
  const defaults = parseArgs(['pr.diff'])
  assert.equal(defaults.file, 'pr.diff')
  assert.equal(defaults.minSeverity, 'warning')
  assert.equal(defaults.failOn, 'error')
  assert.equal(defaults.post, false)

  assert.match(parseArgs([]).error, /no diff file/)
  assert.match(parseArgs(['pr.diff', '--nope']).error, /unknown option --nope/)
  assert.match(parseArgs(['a', 'b']).error, /unexpected extra argument b/)
  assert.match(parseArgs(['pr.diff', '--min-severity', 'fatal']).error, /--min-severity must be one of/)
  assert.match(parseArgs(['pr.diff', '--fail-on', 'fatal']).error, /--fail-on must be one of/)
  assert.match(parseArgs(['pr.diff', '--max-comments', '0']).error, /--max-comments/)
  assert.match(parseArgs(['pr.diff', '--max-comments', '51']).error, /--max-comments/)
})

// ---------------------------------------------------------------------------
// analyse mode
// ---------------------------------------------------------------------------

test('the default run fails on errors and reports them', async () => {
  const { io, out, err } = makeIo()
  const code = await run(['pr.diff'], io)
  assert.equal(code, 1)
  assert.equal(err.length, 0)
  assert.match(out.join('\n'), /\[error\] secret-literal src\/a\.js:2/)
  assert.match(out.join('\n'), /2 error \/ 1 warning \/ 1 note/)
})

test('--fail-on none always exits zero', async () => {
  const { io, out } = makeIo()
  const code = await run(['pr.diff', '--fail-on', 'none'], io)
  assert.equal(code, 0)
  assert.match(out.join('\n'), /secret-literal/)
})

test('--fail-on note tightens the gate', async () => {
  const clean = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1,2 @@', ' a', '+b'].join('\n')
  const strict = makeIo({ files: { 'pr.diff': clean } })
  assert.equal(await run(['pr.diff', '--fail-on', 'note'], strict.io), 0)

  const noisy = makeIo({ files: { 'pr.diff': `${clean}\n+// TODO: later\n` } })
  assert.equal(await run(['pr.diff', '--fail-on', 'note'], noisy.io), 1)
})

test('--json prints the analysis plus the publishable pieces', async () => {
  const { io, out } = makeIo()
  await run(['pr.diff', '--json', '--fail-on', 'none'], io)
  const parsed = JSON.parse(out.join('\n'))
  assert.equal(parsed.counts.error, 2)
  assert.equal(parsed.counts.warning, 1)
  assert.equal(parsed.counts.note, 1)
  assert.ok(parsed.reviewBody.startsWith('<!-- dsh-plugin-github:review -->'))
  assert.ok(Array.isArray(parsed.inlineComments))
  assert.ok(Array.isArray(parsed.unanchoredFindings))
})

test('- reads the diff from stdin', async () => {
  const { io, out } = makeIo({ lines: DIFF.split('\n').map((line) => `${line}\n`) })
  const code = await run(['-', '--fail-on', 'none'], io)
  assert.equal(code, 0)
  assert.match(out.join('\n'), /secret-literal/)
})

test('an unreadable diff is a usage failure, not a finding', async () => {
  const { io, err } = makeIo()
  const code = await run(['missing.diff'], io)
  assert.equal(code, 2)
  assert.match(err.join('\n'), /cannot read diff/)
})

test('bad options print usage and exit 2', async () => {
  const { io, err } = makeIo()
  assert.equal(await run(['pr.diff', '--min-severity', 'fatal'], io), 2)
  assert.match(err.join('\n'), /usage: node bin\/review\.mjs/)
})

// ---------------------------------------------------------------------------
// post mode
// ---------------------------------------------------------------------------

test('--post without a token fails closed', async () => {
  const { io, err } = makeIo({ env: { GITHUB_REPOSITORY: 'o/r' } })
  assert.equal(await run(['pr.diff', '--post', '--pr', '1'], io), 2)
  assert.match(err.join('\n'), /needs GITHUB_TOKEN/)
})

test('--post without a repository or pull number fails closed', async () => {
  const { io, err } = makeIo({ env: { GITHUB_TOKEN: 't' } })
  assert.equal(await run(['pr.diff', '--post'], io), 2)
  assert.match(err.join('\n'), /needs GITHUB_REPOSITORY and a pull request number/)
})

test('--post is idempotent: a review carrying the marker stops a second post', async () => {
  const calls = mockFetch([
    ['/reviews?per_page=100', { body: [{ id: 1, body: '<!-- dsh-plugin-github:review -->\nold' }] }],
  ])
  const { io, out } = makeIo({ env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' } })
  const code = await run(['pr.diff', '--post', '--pr', '5', '--fail-on', 'none'], io)

  assert.equal(code, 0)
  assert.match(out.join('\n'), /already reviewed #5/)
  assert.equal(calls.length, 1, 'only the listing call is made')
})

test('--force posts even when a marked review already exists', async () => {
  const calls = mockFetch([
    ['/reviews?per_page=100', { body: [{ id: 1, body: '<!-- dsh-plugin-github:review -->' }] }],
    ['/reviews', (record) => (record.method === 'POST' ? { body: { id: 99 } } : { body: [] })],
  ])
  const { io, out } = makeIo({ env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' } })
  assert.equal(await run(['pr.diff', '--post', '--pr', '5', '--force', '--fail-on', 'none'], io), 0)
  assert.match(out.join('\n'), /posted review 99/)
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
})

test('--post sends inline comments and exits 1 when errors remain', async () => {
  const calls = mockFetch([
    ['/reviews?per_page=100', { body: [] }],
    ['/reviews', (record) => (record.method === 'POST' ? { body: { id: 7 } } : { body: [] })],
  ])
  const { io, out } = makeIo({ env: { GITHUB_TOKEN: 'secret-token', GITHUB_REPOSITORY: 'o/r' } })
  const code = await run(['pr.diff', '--post', '--pr', '5'], io)

  assert.equal(code, 1)
  const post = calls.find((call) => call.method === 'POST')
  assert.equal(post.url, 'https://api.github.com/repos/o/r/pulls/5/reviews')
  assert.equal(post.body.event, 'COMMENT')
  assert.ok(post.body.body.startsWith('<!-- dsh-plugin-github:review -->'))
  assert.ok(post.body.comments.length >= 1)
  assert.equal(post.headers.authorization, 'Bearer secret-token')
  assert.ok(!out.join('\n').includes('secret-token'), 'the token must not be printed')
})

test('--post reads the pull request number from the event payload', async () => {
  const calls = mockFetch([
    ['/reviews?per_page=100', { body: [] }],
    ['/reviews', (record) => (record.method === 'POST' ? { body: { id: 11 } } : { body: [] })],
  ])
  const { io } = makeIo({
    files: { 'pr.diff': DIFF, 'event.json': JSON.stringify({ pull_request: { number: 42 } }) },
    env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: 'event.json' },
  })
  assert.equal(await run(['pr.diff', '--post', '--fail-on', 'none'], io), 0)
  assert.ok(calls.some((call) => call.url.includes('/pulls/42/reviews')))
})

test('a failed publish is reported rather than swallowed', async () => {
  mockFetch([
    ['/reviews?per_page=100', { body: [] }],
    ['/reviews', { status: 422, body: { message: 'Validation Failed' } }],
  ])
  const { io, err } = makeIo({ env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' } })
  assert.equal(await run(['pr.diff', '--post', '--pr', '5'], io), 2)
  assert.match(err.join('\n'), /HTTP 422/)
  assert.match(err.join('\n'), /Validation Failed/)
})

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

test('renderReport says so when there is nothing to report', () => {
  const clean = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1,2 @@', ' a', '+b'].join('\n')
  const text = renderReport(analyseDiff(clean), 'Review')
  assert.match(text, /no findings/)
})
