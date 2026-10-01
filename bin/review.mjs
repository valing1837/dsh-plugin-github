#!/usr/bin/env node
/**
 * Standalone front end for the deterministic review analyser.
 *
 * It exists so the same rules can run outside DSH — in a composite action, a
 * pre-commit hook, or a plain shell — with nothing installed but Node. The
 * analyser needs no model, so publishing a review from CI needs no model
 * credential either: GitHub's own `GITHUB_TOKEN` is enough.
 *
 * Usage:
 *   node bin/review.mjs <diff-file|-> [options]
 *
 *   --json                     print the analysis as JSON instead of a report
 *   --min-severity <level>     error | warning | note        (default warning)
 *   --max-comments <n>         inline comment cap, 1..50     (default 20)
 *   --fail-on <level>          error | warning | note | none (default error)
 *   --post                     publish the review, then exit
 *   --pr <number>              pull request number (otherwise read from the event)
 *   --force                    post even if this plugin already reviewed
 *   --title <text>             review body title
 *
 * Environment for --post: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo),
 * GITHUB_API_URL (optional), GITHUB_EVENT_PATH (optional), PR_NUMBER (optional).
 *
 * `run()` is exported and takes its IO by injection so the whole thing is
 * testable without spawning a process or touching the network.
 *
 * @module dsh-plugin-github/bin/review
 */

import { readFileSync } from 'node:fs'

import { REVIEW_MARKER, SEVERITIES, analyseDiff, renderReviewBody, toReviewComments } from '../lib/review.js'

const USAGE = 'usage: node bin/review.mjs <diff-file|-> [--json] [--min-severity error|warning|note] [--max-comments n] [--fail-on error|warning|note|none] [--post] [--pr n] [--force] [--title text]'

/**
 * Parse argv into options.
 *
 * @param argv - Arguments after the script name.
 * @returns Parsed options, or `{ error }` when the input is not usable.
 */
export function parseArgs(argv) {
  const options = {
    file: undefined,
    json: false,
    minSeverity: 'warning',
    maxComments: 20,
    failOn: 'error',
    post: false,
    pr: undefined,
    force: false,
    title: undefined,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--json': options.json = true; break
      case '--post': options.post = true; break
      case '--force': options.force = true; break
      case '--min-severity': options.minSeverity = argv[++index]; break
      case '--max-comments': options.maxComments = Number(argv[++index]); break
      case '--fail-on': options.failOn = argv[++index]; break
      case '--pr': options.pr = Number(argv[++index]); break
      case '--title': options.title = argv[++index]; break
      default:
        if (arg.startsWith('--')) return { error: `unknown option ${arg}` }
        if (options.file !== undefined) return { error: `unexpected extra argument ${arg}` }
        options.file = arg
    }
  }

  if (options.file === undefined) return { error: 'no diff file given (use - for stdin)' }
  if (!SEVERITIES.includes(options.minSeverity)) return { error: `--min-severity must be one of ${SEVERITIES.join(', ')}` }
  if (options.failOn !== 'none' && !SEVERITIES.includes(options.failOn)) {
    return { error: `--fail-on must be one of ${SEVERITIES.join(', ')}, none` }
  }
  if (!Number.isInteger(options.maxComments) || options.maxComments < 1 || options.maxComments > 50) {
    return { error: '--max-comments must be an integer between 1 and 50' }
  }
  if (options.post && options.pr !== undefined && !Number.isInteger(options.pr)) {
    return { error: '--pr must be an integer' }
  }

  return options
}

/**
 * Render the human-readable report.
 *
 * @param analysis - Result of `analyseDiff`.
 * @param title - Report title.
 * @returns Report text.
 */
export function renderReport(analysis, title) {
  const lines = [
    title,
    `${analysis.files} file(s) · +${analysis.additions} −${analysis.deletions} · ` +
      `${analysis.counts.error} error / ${analysis.counts.warning} warning / ${analysis.counts.note} note`,
  ]
  if (analysis.findings.length === 0) {
    lines.push('no findings')
    return lines.join('\n')
  }
  for (const finding of analysis.findings) {
    const where = finding.path === null ? '' : ` ${finding.path}${finding.line === null ? '' : `:${finding.line}`}`
    lines.push(`  [${finding.severity}] ${finding.rule}${where}`)
  }
  if (analysis.truncated) lines.push('  (findings truncated)')
  return lines.join('\n')
}

/** The severity levels at or above the `--fail-on` threshold. */
function failingCount(analysis, failOn) {
  if (failOn === 'none') return 0
  const allowed = SEVERITIES.slice(0, SEVERITIES.indexOf(failOn) + 1)
  let total = 0
  for (const severity of allowed) total += analysis.counts[severity]
  return total
}

/** Read the whole of stdin. */
async function readStdin(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse a response body through `text()`, matching how the plugin reads the API. */
async function readJson(response) {
  const text = await response.text()
  return text === '' ? undefined : JSON.parse(text)
}

/** Pull the pull-request number out of a GitHub event payload. */
function prFromEvent(payload) {
  return payload?.pull_request?.number ?? payload?.issue?.number ?? payload?.number
}

/**
 * Run the CLI.
 *
 * @param argv - Arguments after the script name.
 * @param io - Injected environment: `{ readFile, stdin, stdout, stderr, env, fetch }`.
 * @returns The process exit code.
 */
export async function run(argv, io) {
  const { stdout, stderr, env } = io
  const fetchImpl = io.fetch ?? globalThis.fetch

  const options = parseArgs(argv)
  if (options.error !== undefined) {
    stderr(`${options.error}\n${USAGE}`)
    return 2
  }

  let diff
  try {
    diff = options.file === '-' ? await readStdin(io.stdin) : io.readFile(options.file, 'utf8')
  } catch (error) {
    stderr(`cannot read diff: ${error?.message ?? error}`)
    return 2
  }

  const analysis = analyseDiff(diff)
  const projection = toReviewComments(analysis, { minSeverity: options.minSeverity, limit: options.maxComments })
  const title = options.title ?? 'Deterministic review'
  const reviewBody = renderReviewBody(analysis, { title })

  if (!options.post) {
    stdout(options.json ? JSON.stringify({ ...analysis, inlineComments: projection.inline, unanchoredFindings: projection.unanchored, reviewBody }, null, 2) : renderReport(analysis, title))
    return failingCount(analysis, options.failOn) > 0 ? 1 : 0
  }

  // ---- publish ----
  const token = env.GITHUB_TOKEN
  const repository = env.GITHUB_REPOSITORY ?? env.GITHUB_REPOSITORY_OWNER
  if (token === undefined || token === '') {
    stderr('--post needs GITHUB_TOKEN')
    return 2
  }
  let number = options.pr
  if (number === undefined && env.GITHUB_EVENT_PATH !== undefined) {
    try {
      number = prFromEvent(JSON.parse(io.readFile(env.GITHUB_EVENT_PATH, 'utf8')))
    } catch {
      // fall through to the explicit error below
    }
  }
  if (number === undefined && env.PR_NUMBER !== undefined && env.PR_NUMBER !== '') number = Number(env.PR_NUMBER)
  if (repository === undefined || !Number.isInteger(number)) {
    stderr('--post needs GITHUB_REPOSITORY and a pull request number (--pr, GITHUB_EVENT_PATH or PR_NUMBER)')
    return 2
  }

  const api = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'dsh-plugin-github-action',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }

  // Idempotency: never post twice for the same pull request.
  if (options.force !== true) {
    const listed = await fetchImpl(`${api}/repos/${repository}/pulls/${number}/reviews?per_page=100`, { headers })
    if (!listed.ok) {
      stderr(`could not list existing reviews: HTTP ${listed.status}`)
      return 2
    }
    const existing = await readJson(listed)
    if (existing.some((review) => typeof review.body === 'string' && review.body.includes(REVIEW_MARKER))) {
      const note = `already reviewed #${number}; nothing posted (use --force to post again)`
      // With --json stdout must stay machine-readable, so progress goes to stderr.
      if (options.json) stderr(note)
      else stdout(note)
      return failingCount(analysis, options.failOn) > 0 ? 1 : 0
    }
  }

  const payload = { event: 'COMMENT', body: reviewBody }
  if (projection.inline.length > 0) payload.comments = projection.inline

  const posted = await fetchImpl(`${api}/repos/${repository}/pulls/${number}/reviews`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  if (!posted.ok) {
    stderr(`could not post the review: HTTP ${posted.status} ${(await posted.text()).slice(0, 300)}`)
    return 2
  }
  const review = await readJson(posted)
  if (options.json) {
    stdout(
      JSON.stringify(
        {
          ...analysis,
          inlineComments: projection.inline,
          unanchoredFindings: projection.unanchored,
          reviewBody,
          reviewId: review?.id ?? null,
        },
        null,
        2,
      ),
    )
  } else {
    stdout(`posted review ${review?.id} on #${number} (${projection.inline.length} inline comment(s))`)
  }
  return failingCount(analysis, options.failOn) > 0 ? 1 : 0
}

/** Wire `run` to the real process. */
async function main() {
  const code = await run(process.argv.slice(2), {
    readFile: readFileSync,
    stdin: process.stdin,
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    env: process.env,
  })
  process.exitCode = code
}

// Only run when executed directly, so importing this module in a test is inert.
// `pathToFileURL` is what makes the comparison hold on Windows, where
// `import.meta.url` is `file:///C:/...` but `process.argv[1]` is `C:\...`.
const { pathToFileURL } = await import('node:url')
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
