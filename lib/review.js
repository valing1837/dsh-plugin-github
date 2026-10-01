/**
 * Deterministic pull-request analysis.
 *
 * This module is pure: it takes a unified diff (the `application/vnd.github.v3.diff`
 * representation of a pull request) and returns findings. No network, no clock,
 * no randomness — which is what makes it testable and what would let the same
 * code run inside a composite action as well as inside this plugin.
 *
 * It is deliberately **not** a model call. Every finding must be defensible from
 * the diff alone, because a review that posts to somebody's pull request should
 * not depend on a sampling model's mood. Judgement calls stay with the caller.
 *
 * @module dsh-plugin-github/review
 */

/** Severity vocabulary, most severe first. */
export const SEVERITIES = ['error', 'warning', 'note']

/** Maximum number of findings reported for one pull request. */
export const DEFAULT_MAX_FINDINGS = 40

/** Changed-line budget above which the pull request is flagged as large. */
export const DEFAULT_LARGE_CHANGE_LINES = 800

/** Stable marker a caller can put in a review body to recognise its own reviews. */
export const REVIEW_MARKER = '<!-- dsh-plugin-github:review -->'

/**
 * Parse a unified diff into per-file records with 1-based line numbers on the
 * post-image, which is what GitHub's review-comment API addresses.
 *
 * @param diff - Unified diff text.
 * @returns One record per file, in diff order.
 */
export function parseUnifiedDiff(diff) {
  const files = []
  let current = null
  let newLine = 0
  let inHunk = false

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = { path: '', added: [], removed: 0, hunks: 0 }
      files.push(current)
      inHunk = false
      continue
    }
    if (current === null) continue

    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim()
      current.path = path === '/dev/null' ? '' : path.replace(/^b\//, '')
      continue
    }
    // The `--- a/...` half of the file header looks like a removal but is not
    // one, and neither is any other header line that precedes the first hunk.
    if (raw.startsWith('--- ')) continue
    if (raw.startsWith('@@')) {
      const match = /\+(\d+)/.exec(raw)
      newLine = match === null ? 0 : Number(match[1])
      current.hunks += 1
      inHunk = true
      continue
    }
    if (!inHunk) continue
    // "\ No newline at end of file" belongs to the previous line.
    if (raw.startsWith('\\')) continue

    if (raw.startsWith('+')) {
      current.added.push({ line: newLine, text: raw.slice(1) })
      newLine += 1
      continue
    }
    if (raw.startsWith('-')) {
      current.removed += 1
      continue
    }
    // Context line: advances the post-image counter.
    if (raw !== '') newLine += 1
  }

  return files.filter((file) => file.path !== '')
}

/**
 * One rule. `test` runs against each added line; `file` may add file-level findings.
 *
 * @typedef {object} Rule
 * @property {string} id
 * @property {'error'|'warning'|'note'} severity
 * @property {string} message
 * @property {RegExp} [test]
 * @property {(path: string) => boolean} [file]
 */

/** @type {Rule[]} */
export const RULES = [
  {
    id: 'secret-literal',
    severity: 'error',
    message: 'A credential-looking literal is being added. Move it to the DSH credential store or a secret.',
    test: /(api[_-]?key|secret|passwd|password|auth[_-]?token|access[_-]?token)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,
  },
  {
    id: 'known-token-prefix',
    severity: 'error',
    message: 'This looks like a real token (known prefix). Revoke it and load it from a secret instead.',
    test: /\b(ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  },
  {
    id: 'conflict-marker',
    severity: 'error',
    message: 'An unresolved merge conflict marker is being committed.',
    test: /^(<{7}|={7}|>{7})(\s|$)/,
  },
  {
    id: 'focused-test',
    severity: 'error',
    message: 'A focused test is being committed, which silently skips the rest of the suite.',
    test: /(\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(|@pytest\.mark\.only|\[Ignore\]|#\[ignore\])/,
  },
  {
    id: 'debug-leftover',
    severity: 'warning',
    message: 'Debug output left in the change.',
    test: /(\bconsole\.(log|debug|dir|trace)\s*\(|\bdebugger\b|\bbinding\.pry\b|\bdbg!\s*\(|\bfmt\.Print(ln)?\s*\()/,
  },
  {
    id: 'dangerous-eval',
    severity: 'warning',
    message: 'Dynamic code evaluation is being added.',
    test: /(\beval\s*\(|\bnew\s+Function\s*\(|child_process|\bexecSync\s*\()/,
  },
  {
    id: 'destructive-shell',
    severity: 'warning',
    message: 'A destructive shell command is being added.',
    test: /(\brm\s+-[a-z]*r[a-z]*f|\bgit\s+push\s+[^\n]*--force\b|\bgit\s+reset\s+--hard\b)/,
  },
  {
    id: 'todo-added',
    severity: 'note',
    message: 'A deferred-work marker is being added.',
    test: /\b(TODO|FIXME|XXX|HACK)\b/,
  },
  {
    id: 'trailing-whitespace',
    severity: 'note',
    message: 'Trailing whitespace is being added.',
    test: /[ \t]+$/,
  },
  {
    id: 'sensitive-file',
    severity: 'error',
    message: 'A file that must never be committed is being added or changed.',
    file: (path) => /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|id_ecdsa|credentials(\.json|\.yml|\.yaml)?)$/i.test(path)
      || /\.(pem|pfx|p12|key|keystore|jks)$/i.test(path),
  },
  {
    id: 'lockfile-only',
    severity: 'note',
    message: 'A lockfile changed. Confirm the matching manifest changed too.',
    file: (path) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock)$/i.test(path),
  },
]

/**
 * Shorten a code excerpt so a review comment stays readable.
 *
 * @param text - The added line.
 * @param limit - Maximum characters.
 * @returns The trimmed excerpt.
 */
function excerpt(text, limit = 160) {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`
}

/**
 * Analyse one unified diff.
 *
 * @param diff - Unified diff text.
 * @param options - Analysis options.
 * @returns Findings, counts and roll-up totals.
 */
export function analyseDiff(diff, options = {}) {
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS
  const largeChangeLines = options.largeChangeLines ?? DEFAULT_LARGE_CHANGE_LINES
  const files = parseUnifiedDiff(diff)

  const findings = []
  let additions = 0
  let deletions = 0

  for (const file of files) {
    additions += file.added.length
    deletions += file.removed

    for (const rule of RULES) {
      if (rule.file !== undefined && rule.file(file.path)) {
        findings.push({ rule: rule.id, severity: rule.severity, path: file.path, line: null, message: rule.message, excerpt: null })
      }
    }

    for (const line of file.added) {
      for (const rule of RULES) {
        if (rule.test === undefined || !rule.test.test(line.text)) continue
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          path: file.path,
          line: line.line,
          message: rule.message,
          excerpt: excerpt(line.text),
        })
      }
    }
  }

  if (additions + deletions > largeChangeLines) {
    findings.unshift({
      rule: 'large-change',
      severity: 'note',
      path: null,
      line: null,
      message: `This pull request changes ${additions + deletions} lines across ${files.length} file(s), above the ${largeChangeLines}-line budget. Consider splitting it.`,
      excerpt: null,
    })
  }

  const counts = { error: 0, warning: 0, note: 0 }
  for (const finding of findings) counts[finding.severity] += 1

  return {
    files: files.length,
    additions,
    deletions,
    truncated: findings.length > maxFindings,
    findings: findings.slice(0, maxFindings),
    counts,
    marker: REVIEW_MARKER,
  }
}

/**
 * Project findings onto GitHub's review-comment shape.
 *
 * Only findings anchored to a concrete added line can become inline comments;
 * file-level and pull-request-level findings are returned separately so a caller
 * can fold them into the review body instead of dropping them.
 *
 * @param analysis - The result of `analyseDiff`.
 * @param options - Projection options.
 * @returns Inline comments plus the findings that have no line to attach to.
 */
export function toReviewComments(analysis, options = {}) {
  const limit = options.limit ?? 20
  const minSeverity = options.minSeverity ?? 'warning'
  const allowed = new Set(SEVERITIES.slice(0, SEVERITIES.indexOf(minSeverity) + 1))

  const inline = []
  const unanchored = []

  for (const finding of analysis.findings) {
    if (!allowed.has(finding.severity)) continue
    if (finding.line === null || finding.path === null) {
      unanchored.push(finding)
      continue
    }
    if (inline.length >= limit) {
      unanchored.push(finding)
      continue
    }
    inline.push({
      path: finding.path,
      line: finding.line,
      side: 'RIGHT',
      body: `**${finding.severity}** · \`${finding.rule}\`\n\n${finding.message}${finding.excerpt === null ? '' : `\n\n\`\`\`\n${finding.excerpt}\n\`\`\``}`,
    })
  }

  return { inline, unanchored }
}

/**
 * Render the analysis as a review body in Markdown.
 *
 * @param analysis - The result of `analyseDiff`.
 * @param options - Rendering options.
 * @returns A Markdown body ending with the stable marker.
 */
export function renderReviewBody(analysis, options = {}) {
  const title = options.title ?? 'Deterministic review'
  const lines = [
    REVIEW_MARKER,
    `## ${title}`,
    '',
    `${analysis.files} file(s) · +${analysis.additions} −${analysis.deletions} · ` +
      `${analysis.counts.error} error / ${analysis.counts.warning} warning / ${analysis.counts.note} note`,
  ]

  if (analysis.findings.length === 0) {
    lines.push('', 'No findings from the deterministic rules.')
  } else {
    lines.push('')
    for (const finding of analysis.findings) {
      const where = finding.path === null ? '' : ` — \`${finding.path}${finding.line === null ? '' : `:${finding.line}`}\``
      lines.push(`- **${finding.severity}** \`${finding.rule}\`${where}: ${finding.message}`)
    }
  }

  if (analysis.truncated) lines.push('', '_Findings were truncated._')

  return lines.join('\n')
}
