/**
 * `dsh-plugin-github` — host-only GitHub integration for DeepSeek Harness.
 *
 * Deliberately has NO browser half: no `dsh.client` field, no `lib/client.js`.
 * On DSH 0.2.x a client bundle must self-register through
 * `window.__ModuleLoader__.load({...})`; shipping plain ESM there is a hard
 * boot failure. This plugin only registers host-side tools, so that entire
 * class of failure cannot happen.
 *
 * The token is never stored here. It resolves, in order, from:
 *   1. the `token` config field (a literal, `role('secret')`),
 *   2. the DSH credentials domain via `credentialRef(config.tokenRef)`
 *      (i.e. a name under `refs:` in `$DSH_HOME/.credentials.yaml`),
 *   3. the process environment variable named by `tokenRef`.
 *
 * @module dsh-plugin-github
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { promisify } from 'node:util'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import {
  DEFAULT_LARGE_CHANGE_LINES,
  SEVERITIES,
  analyseDiff,
  renderReviewBody,
  toReviewComments,
} from './review.js'

const execFileAsync = promisify(execFile)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'github'

/** The tool registry this plugin contributes into. */
export const inject = ['tools']

/** Default credential reference resolved from the DSH credentials domain. */
const DEFAULT_TOKEN_REF = 'GITHUB_TOKEN'
const DEFAULT_API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'
/** JSON representation. */
const ACCEPT_JSON = 'application/vnd.github+json'
/** Unified-diff representation, used to read a whole pull request as a patch. */
const ACCEPT_DIFF = 'application/vnd.github.v3.diff'

export const Config = Schema.object({
  tokenRef: Schema.string()
    .role('credential-ref')
    .default(DEFAULT_TOKEN_REF)
    .description('Credential reference resolved through the DSH credentials domain.'),
  token: Schema.string()
    .role('secret')
    .description('Literal token. Prefer tokenRef so the secret stays out of the profile config.'),
  apiBase: Schema.string()
    .default(DEFAULT_API_BASE)
    .description('GitHub REST API base URL. Point at a GitHub Enterprise host if needed.'),
  defaultOwner: Schema.string()
    .description('Owner (user or organisation) assumed when a tool call omits one.'),
  userAgent: Schema.string()
    .default('dsh-plugin-github')
    .description('User-Agent header sent with every request.'),
  gitPath: Schema.string()
    .default('git')
    .description('git executable used by github_push.'),
  gitHost: Schema.string()
    .default('github.com')
    .description('Host used to build clone/push URLs. Change it for GitHub Enterprise.'),
  sslBackend: Schema.string()
    .default('openssl')
    .description(
      "git http.sslBackend forced for every github_push invocation. 'openssl' keeps git off the Windows certificate store, which a confined host may deny; set an empty string to leave git's own default alone.",
    ),
  authorName: Schema.string()
    .default('DeepSeek Harness')
    .description('Commit author name used only when the repository has no user.name configured.'),
  authorEmail: Schema.string()
    .default('dsh@localhost')
    .description('Commit author email used only when the repository has no user.email configured.'),
  approveWrites: Schema.boolean()
    .default(true)
    .description(
      'Ask for human approval before any tool that changes state on GitHub. Delivered as an `ask` decision from tools/pre-execute; the runtime routes it through the approval service and fails closed when no answerer is available.',
    ),
  reviewMinSeverity: Schema.string()
    .default('warning')
    .description('Least severe finding that becomes an inline review comment: error, warning or note.'),
  reviewMaxComments: Schema.number()
    .step(1)
    .min(1)
    .max(50)
    .default(20)
    .description('Maximum inline comments produced by github_analyze_pull.'),
  largeChangeLines: Schema.number()
    .step(1)
    .min(50)
    .default(DEFAULT_LARGE_CHANGE_LINES)
    .description('Changed-line budget above which github_analyze_pull flags a pull request as large.'),
})

/** Content blocks the model reads for an object-shaped result. */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Canonical object result: structured for programs, JSON text for the model. */
const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: renderJson,
}

/**
 * Resolve the GitHub token and report where it came from, so `github_status`
 * can explain a misconfiguration without leaking the secret.
 *
 * @param ctx - Cordis context.
 * @param config - Resolved plugin config.
 * @returns token plus a human-readable source label, or undefined token.
 */
async function resolveToken(ctx, config) {
  if (typeof config.token === 'string' && config.token.length > 0) {
    return { token: config.token, source: 'config.token' }
  }

  const ref = config.tokenRef ?? DEFAULT_TOKEN_REF
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(credentialRef(ref))
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
        return { token: hit.value, source: `credentials:${ref}` }
      }
    } catch (error) {
      return { token: undefined, source: `credentials:${ref} (resolve failed: ${error?.message ?? error})` }
    }
  }

  const ambient = process.env[ref]
  if (typeof ambient === 'string' && ambient.length > 0) {
    return { token: ambient, source: `env:${ref}` }
  }

  return { token: undefined, source: `unset (${ref})` }
}

/** Throw the same shaped error everywhere so tool failures read consistently. */
function fail(message) {
  return new Error(`github: ${message}`)
}

/**
 * One GitHub REST call.
 *
 * @param ctx - Cordis context (for credential resolution).
 * @param config - Resolved plugin config.
 * @param method - HTTP method.
 * @param path - API path beginning with `/`.
 * @param body - Optional JSON request body.
 * @param signal - Abort signal from the tool execution.
 * @param accept - Accept media type; `diff` selects the unified-diff representation.
 * @returns Parsed JSON body, or the raw text for non-JSON media types.
 */
async function request(ctx, config, method, path, body, signal, accept = ACCEPT_JSON) {
  const { token, source } = await resolveToken(ctx, config)
  if (token === undefined) {
    throw fail(`no token available (looked in ${source}). Set one with: dsh/github_status, or add ${config.tokenRef ?? DEFAULT_TOKEN_REF} to $DSH_HOME/.credentials.yaml refs.`)
  }

  const base = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const headers = {
    accept,
    'x-github-api-version': API_VERSION,
    'user-agent': config.userAgent ?? 'dsh-plugin-github',
    authorization: `Bearer ${token}`,
  }
  if (body !== undefined) headers['content-type'] = 'application/json'

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })

  const text = await response.text()
  const wantsJson = accept === ACCEPT_JSON

  let parsed
  if (wantsJson && text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
  }

  if (!response.ok) {
    const detail = (wantsJson ? parsed?.message : undefined) ?? text.slice(0, 300)
    const error = fail(`${method} ${path} -> HTTP ${response.status}: ${detail}`)
    error.status = response.status
    if (parsed?.documentation_url !== undefined) error.documentationUrl = parsed.documentation_url
    throw error
  }

  return wantsJson ? parsed : text
}

/** Strip a secret from anything that may reach the model, a card or a log. */
function redact(text, secret) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (typeof secret !== 'string' || secret.length === 0) return text
  return text.split(secret).join('***').split(encodeURIComponent(secret)).join('***')
}

/**
 * Run one git command.
 *
 * Never throws on a non-zero exit: the caller decides which failures are fatal,
 * because several probes (config lookups, porcelain status) legitimately fail
 * on a fresh repository.
 */
async function runGit(config, args, options) {
  const argv = []
  const backend = config.sslBackend ?? 'openssl'
  if (backend !== '') argv.push('-c', `http.sslBackend=${backend}`)
  if (options.identity !== undefined) {
    argv.push('-c', `user.name=${options.identity.name}`, '-c', `user.email=${options.identity.email}`)
  }
  argv.push(...args)

  try {
    const { stdout, stderr } = await execFileAsync(config.gitPath ?? 'git', argv, {
      cwd: options.cwd,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      signal: options.signal,
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr:
        typeof error?.stderr === 'string' && error.stderr.length > 0
          ? error.stderr
          : String(error?.message ?? error),
    }
  }
}

/** Trim a full PR payload down to the fields a review actually needs. */
function summarisePull(pull) {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft ?? false,
    merged: pull.merged ?? false,
    mergeableState: pull.mergeable_state,
    author: pull.user?.login,
    headRef: pull.head?.ref,
    headSha: pull.head?.sha,
    baseRef: pull.base?.ref,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    labels: (pull.labels ?? []).map((label) => label.name),
    body: pull.body ?? '',
    htmlUrl: pull.html_url,
  }
}

/**
 * Register the GitHub tool surface.
 *
 * @param ctx - Cordis context.
 * @param config - Resolved plugin config.
 */
export function apply(ctx, config) {
  const tokenRef = config.tokenRef ?? DEFAULT_TOKEN_REF

  ctx.tools.register(
    defineTool({
      name: 'github_status',
      description:
        'Report the GitHub plugin configuration and whether a token resolves. Performs no network request and never prints the secret.',
      parameters: {},
      output: JSON_OUTPUT,
      async execute() {
        const { token, source } = await resolveToken(ctx, config)
        return {
          tokenPresent: token !== undefined,
          tokenSource: source,
          tokenLength: token === undefined ? 0 : token.length,
          tokenRef,
          apiBase: config.apiBase ?? DEFAULT_API_BASE,
          defaultOwner: config.defaultOwner ?? null,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_whoami',
      description:
        'Verify the GitHub token and return the authenticated account. Use this first: a 401 here means the token is wrong or expired.',
      parameters: {},
      output: JSON_OUTPUT,
      async execute(_args, exec) {
        const user = await request(ctx, config, 'GET', '/user', undefined, exec.signal)
        return {
          login: user.login,
          name: user.name ?? null,
          type: user.type,
          htmlUrl: user.html_url,
          publicRepos: user.public_repos,
          privateRepos: user.total_private_repos ?? null,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_create_repo',
      description:
        'Create a GitHub repository. Owner defaults to the authenticated user; pass an organisation name to create it there.',
      parameters: {
        name: { type: 'string', required: true, description: 'Repository name.' },
        owner: { type: 'string', description: 'User or organisation login. Defaults to the authenticated user.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Create as private. Defaults to true.' },
        autoInit: { type: 'boolean', description: 'Initialise with a README so the repo has a first commit.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const owner = args.owner ?? config.defaultOwner
        const body = {
          name: args.name,
          private: args.private ?? true,
          auto_init: args.autoInit ?? false,
        }
        if (args.description !== undefined) body.description = args.description

        const path = owner === undefined ? '/user/repos' : `/orgs/${owner}/repos`
        const repo = await request(ctx, config, 'POST', path, body, exec.signal)
        return {
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          cloneUrl: repo.clone_url,
          sshUrl: repo.ssh_url,
          htmlUrl: repo.html_url,
          owner: repo.owner?.login,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_list_pulls',
      description: 'List pull requests in a repository.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        state: { type: 'string', description: 'open (default), closed, or all.' },
        limit: { type: 'number', description: 'Maximum number of pull requests to return. Defaults to 20.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const state = args.state ?? 'open'
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
        const pulls = await request(
          ctx,
          config,
          'GET',
          `/repos/${args.owner}/${args.repo}/pulls?state=${encodeURIComponent(state)}&per_page=${limit}`,
          undefined,
          exec.signal,
        )
        return {
          count: pulls.length,
          pulls: pulls.map((pull) => ({
            number: pull.number,
            title: pull.title,
            author: pull.user?.login,
            draft: pull.draft ?? false,
            headRef: pull.head?.ref,
            baseRef: pull.base?.ref,
            updatedAt: pull.updated_at,
            htmlUrl: pull.html_url,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_get_pull',
      description:
        'Read one pull request: metadata, the list of changed files, and (unless disabled) the unified diff. This is the input for a code review.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        number: { type: 'number', required: true, description: 'Pull request number.' },
        includePatch: { type: 'boolean', description: 'Include each file patch and the full diff. Defaults to true.' },
        maxPatchBytes: { type: 'number', description: 'Truncate the combined patch beyond this many bytes. Defaults to 200000.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const includePatch = args.includePatch ?? true
        const maxPatchBytes = args.maxPatchBytes ?? 200000
        const repoPath = `/repos/${args.owner}/${args.repo}/pulls/${args.number}`

        const pull = await request(ctx, config, 'GET', repoPath, undefined, exec.signal)
        const files = await request(ctx, config, 'GET', `${repoPath}/files?per_page=100`, undefined, exec.signal)

        let patch
        let patchTruncated = false
        if (includePatch) {
          const diff = await request(ctx, config, 'GET', repoPath, undefined, exec.signal, ACCEPT_DIFF)
          if (typeof diff === 'string') {
            patchTruncated = diff.length > maxPatchBytes
            patch = patchTruncated ? diff.slice(0, maxPatchBytes) : diff
          }
        }

        return {
          pull: summarisePull(pull),
          files: files.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: includePatch ? (file.patch ?? null) : undefined,
          })),
          patch,
          patchTruncated,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_review_pull',
      description:
        'Submit a pull request review. event=COMMENT leaves a plain review, APPROVE approves, REQUEST_CHANGES blocks the merge. Line comments attach to the diff.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        number: { type: 'number', required: true, description: 'Pull request number.' },
        event: { type: 'string', required: true, description: 'COMMENT, APPROVE, or REQUEST_CHANGES.' },
        body: { type: 'string', description: 'Review summary body (Markdown).' },
        comments: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Inline comments: [{ path, line, body }]. `line` is the line in the file at the head commit and must fall inside the diff.',
        },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const event = String(args.event).toUpperCase()
        if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) {
          throw fail(`event must be COMMENT, APPROVE or REQUEST_CHANGES (got ${args.event})`)
        }
        if ((args.body === undefined || args.body === '') && (args.comments ?? []).length === 0) {
          throw fail('a review needs either a body or at least one inline comment')
        }

        const payload = { event }
        if (args.body !== undefined) payload.body = args.body
        if (args.comments !== undefined) {
          payload.comments = args.comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: comment.side ?? 'RIGHT',
            body: comment.body,
          }))
        }

        const review = await request(
          ctx,
          config,
          'POST',
          `/repos/${args.owner}/${args.repo}/pulls/${args.number}/reviews`,
          payload,
          exec.signal,
        )
        return {
          id: review.id,
          state: review.state,
          author: review.user?.login,
          submittedAt: review.submitted_at,
          htmlUrl: review.html_url,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_create_pull',
      description:
        'Open a pull request. The head branch must already exist on the remote, so push it with github_push first. The base branch defaults to the repository default branch.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        title: { type: 'string', required: true, description: 'Pull request title.' },
        head: {
          type: 'string',
          required: true,
          description: 'Branch holding the changes. Prefix it with "owner:" to open one from a fork.',
        },
        base: {
          type: 'string',
          description: 'Branch to merge into. Defaults to the repository default branch.',
        },
        body: { type: 'string', description: 'Pull request description (Markdown).' },
        draft: { type: 'boolean', description: 'Open as a draft. Defaults to false.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        let base = args.base
        if (base === undefined) {
          const repoInfo = await request(
            ctx,
            config,
            'GET',
            `/repos/${args.owner}/${args.repo}`,
            undefined,
            exec.signal,
          )
          base = repoInfo.default_branch
        }

        const payload = { title: args.title, head: args.head, base, draft: args.draft ?? false }
        if (args.body !== undefined) payload.body = args.body

        const pull = await request(
          ctx,
          config,
          'POST',
          `/repos/${args.owner}/${args.repo}/pulls`,
          payload,
          exec.signal,
        )

        return {
          number: pull.number,
          title: pull.title,
          state: pull.state,
          draft: pull.draft ?? false,
          baseRef: pull.base?.ref,
          headRef: pull.head?.ref,
          mergeableState: pull.mergeable_state,
          changedFiles: pull.changed_files,
          htmlUrl: pull.html_url,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_create_issue',
      description: 'Open an issue in a repository.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        title: { type: 'string', required: true, description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body (Markdown).' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const payload = { title: args.title }
        if (args.body !== undefined) payload.body = args.body
        if (args.labels !== undefined) payload.labels = args.labels

        const issue = await request(
          ctx,
          config,
          'POST',
          `/repos/${args.owner}/${args.repo}/issues`,
          payload,
          exec.signal,
        )
        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          htmlUrl: issue.html_url,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_push',
      description:
        'Publish a local working tree to GitHub: git init when needed, stage everything, commit once, then push the branch. The token rides a one-shot push URL, so it is never written to .git/config and never appears in the output.',
      parameters: {
        directory: {
          type: 'string',
          required: true,
          description: 'Absolute path of the local working tree to publish.',
        },
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        branch: {
          type: 'string',
          description: 'Target branch. Defaults to main for a new repository, otherwise the current branch.',
        },
        message: { type: 'string', description: 'Commit message, used only when there is something to commit.' },
        commit: { type: 'boolean', description: 'Stage and commit before pushing. Defaults to true.' },
        force: { type: 'boolean', description: 'Force push. Defaults to false and should stay false.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const directory = args.directory
        if (!existsSync(directory) || !statSync(directory).isDirectory()) {
          throw fail(`directory not found: ${directory}`)
        }

        const steps = []
        const inside = await runGit(config, ['rev-parse', '--is-inside-work-tree'], {
          cwd: directory,
          signal: exec.signal,
        })

        let initialised = false
        if (!inside.ok || inside.stdout.trim() !== 'true') {
          const initBranch = args.branch ?? 'main'
          const init = await runGit(config, ['init', '-b', initBranch], { cwd: directory, signal: exec.signal })
          if (!init.ok) throw fail(`git init failed in ${directory}: ${init.stderr.trim()}`)
          initialised = true
          steps.push(`git init -b ${initBranch}`)
        }

        // Supply an identity only when the repository has none, so a real git
        // identity configured by the user always wins.
        const emailProbe = await runGit(config, ['config', 'user.email'], { cwd: directory, signal: exec.signal })
        const identity =
          emailProbe.ok && emailProbe.stdout.trim() !== ''
            ? undefined
            : {
                name: config.authorName ?? 'DeepSeek Harness',
                email: config.authorEmail ?? 'dsh@localhost',
              }

        let committed = null
        if (args.commit ?? true) {
          const add = await runGit(config, ['add', '-A'], { cwd: directory, signal: exec.signal })
          if (!add.ok) throw fail(`git add failed: ${add.stderr.trim()}`)

          const staged = await runGit(config, ['status', '--porcelain'], { cwd: directory, signal: exec.signal })
          const changes = staged.stdout.split('\n').filter((line) => line.trim() !== '')
          if (changes.length > 0) {
            const message = args.message ?? `Update from DeepSeek Harness (${new Date().toISOString()})`
            const commitResult = await runGit(config, ['commit', '-m', message], {
              cwd: directory,
              signal: exec.signal,
              identity,
            })
            if (!commitResult.ok) throw fail(`git commit failed: ${commitResult.stderr.trim()}`)
            const sha = await runGit(config, ['rev-parse', 'HEAD'], { cwd: directory, signal: exec.signal })
            committed = { message, sha: sha.stdout.trim(), files: changes.length }
            steps.push(`git commit -m "${message}" (${changes.length} files)`)
          } else {
            steps.push('nothing to commit')
          }
        }

        let branch = args.branch
        if (branch === undefined) {
          const probe = await runGit(config, ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: directory,
            signal: exec.signal,
          })
          branch = probe.ok ? probe.stdout.trim() : ''
          if (branch === '' || branch === 'HEAD') branch = 'main'
        }

        const head = await runGit(config, ['rev-parse', 'HEAD'], { cwd: directory, signal: exec.signal })
        if (!head.ok) throw fail(`nothing to push (no commit in ${directory}): ${head.stderr.trim()}`)
        const headSha = head.stdout.trim()

        const { token, source } = await resolveToken(ctx, config)
        if (token === undefined) {
          throw fail(
            `local commit ${headSha.slice(0, 12)} is ready, but no token is available (looked in ${source}); the push was skipped. Add ${tokenRef} to $DSH_HOME/.credentials.yaml refs.`,
          )
        }

        const host = config.gitHost ?? 'github.com'
        const plainUrl = `https://${host}/${args.owner}/${args.repo}.git`
        const pushUrl = `https://x-access-token:${token}@${host}/${args.owner}/${args.repo}.git`

        // Leave a credential-free origin behind so later manual git work works.
        const remoteProbe = await runGit(config, ['remote', 'get-url', 'origin'], {
          cwd: directory,
          signal: exec.signal,
        })
        if (!remoteProbe.ok || remoteProbe.stdout.trim() === '') {
          const added = await runGit(config, ['remote', 'add', 'origin', plainUrl], {
            cwd: directory,
            signal: exec.signal,
          })
          if (added.ok) steps.push(`git remote add origin ${plainUrl}`)
        }

        const pushArgs = ['push']
        if (args.force === true) pushArgs.push('--force')
        pushArgs.push(pushUrl, `HEAD:refs/heads/${branch}`)

        const push = await runGit(config, pushArgs, { cwd: directory, signal: exec.signal })
        if (!push.ok) throw fail(`git push failed: ${redact(push.stderr.trim(), token)}`)
        steps.push(`git push origin HEAD:refs/heads/${branch}`)

        return {
          repository: `${args.owner}/${args.repo}`,
          branch,
          head: headSha,
          initialised,
          committed,
          origin: plainUrl,
          htmlUrl: `https://${host}/${args.owner}/${args.repo}/tree/${branch}`,
          steps,
          gitOutput: redact((push.stderr.trim() || push.stdout.trim()), token),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_clone',
      description:
        'Clone a repository into a local directory so it can be read, reviewed or edited. An existing clone is fetched and checked out instead of re-cloned. The token is stripped from the stored origin, so the resulting tree is credential-free.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        directory: { type: 'string', required: true, description: 'Absolute path to clone into.' },
        branch: { type: 'string', description: 'Branch to check out. Defaults to the remote default branch.' },
        depth: { type: 'number', description: 'Shallow clone depth. Omit for a full clone.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const host = config.gitHost ?? 'github.com'
        const plainUrl = `https://${host}/${args.owner}/${args.repo}.git`
        const { token } = await resolveToken(ctx, config)
        const authUrl =
          token === undefined ? plainUrl : `https://x-access-token:${token}@${host}/${args.owner}/${args.repo}.git`

        const target = args.directory
        const isRepo = existsSync(`${target}\\.git`) || existsSync(`${target}/.git`)
        const steps = []

        if (isRepo) {
          const fetch = await runGit(config, ['fetch', 'origin', '--prune'], { cwd: target, signal: exec.signal })
          if (!fetch.ok) throw fail(`git fetch failed: ${redact(fetch.stderr.trim(), token)}`)
          steps.push('git fetch origin --prune')
          if (args.branch !== undefined) {
            const checkout = await runGit(config, ['checkout', args.branch], { cwd: target, signal: exec.signal })
            if (!checkout.ok) throw fail(`git checkout failed: ${checkout.stderr.trim()}`)
            steps.push(`git checkout ${args.branch}`)
          }
        } else {
          if (existsSync(target)) {
            throw fail(`directory exists and is not a git repository: ${target}`)
          }
          const cloneArgs = ['clone']
          if (args.depth !== undefined) cloneArgs.push('--depth', String(args.depth))
          if (args.branch !== undefined) cloneArgs.push('--branch', args.branch)
          cloneArgs.push(authUrl, target)
          const clone = await runGit(config, cloneArgs, { cwd: undefined, signal: exec.signal })
          if (!clone.ok) throw fail(`git clone failed: ${redact(clone.stderr.trim(), token)}`)
          steps.push(`git clone ${plainUrl} ${target}`)
        }

        // Never leave the credential in .git/config.
        if (token !== undefined) {
          const strip = await runGit(config, ['remote', 'set-url', 'origin', plainUrl], {
            cwd: target,
            signal: exec.signal,
          })
          if (strip.ok) steps.push(`git remote set-url origin ${plainUrl}`)
          else throw fail(`could not strip the credential from origin: ${strip.stderr.trim()}`)
        }

        const head = await runGit(config, ['rev-parse', 'HEAD'], { cwd: target, signal: exec.signal })
        const branchNow = await runGit(config, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, signal: exec.signal })

        return {
          repository: `${args.owner}/${args.repo}`,
          directory: target,
          reused: isRepo,
          branch: branchNow.ok ? branchNow.stdout.trim() : null,
          head: head.ok ? head.stdout.trim() : null,
          origin: plainUrl,
          steps,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_get_file',
      description:
        'Read one file from a repository at a ref, or list a directory. Returns decoded UTF-8 text, so no base64 handling is needed by the caller.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        path: { type: 'string', required: true, description: 'Path inside the repository, e.g. src/index.js.' },
        ref: { type: 'string', description: 'Branch, tag or commit SHA. Defaults to the default branch.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const query = args.ref === undefined ? '' : `?ref=${encodeURIComponent(args.ref)}`
        const apiPath = `/repos/${args.owner}/${args.repo}/contents/${args.path}${query}`
        const entry = await request(ctx, config, 'GET', apiPath, undefined, exec.signal)

        if (Array.isArray(entry)) {
          return {
            kind: 'directory',
            path: args.path,
            entries: entry.map((item) => ({ name: item.name, type: item.type, size: item.size, path: item.path })),
          }
        }

        if (entry.type !== 'file') {
          return { kind: entry.type, path: entry.path, size: entry.size, sha: entry.sha }
        }

        // The contents API returns an empty `content` above ~1 MB; the raw
        // media type serves those directly.
        if (typeof entry.content === 'string' && entry.content.length > 0) {
          return {
            kind: 'file',
            path: entry.path,
            size: entry.size,
            sha: entry.sha,
            encoding: 'base64',
            text: Buffer.from(entry.content, 'base64').toString('utf8'),
          }
        }

        const raw = await request(
          ctx,
          config,
          'GET',
          apiPath,
          undefined,
          exec.signal,
          'application/vnd.github.raw',
        )
        return { kind: 'file', path: entry.path, size: entry.size, sha: entry.sha, encoding: 'raw', text: raw }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_list_repos',
      description:
        "List repositories. Without owner it lists the authenticated user's repositories including private ones; with owner it tries the organisation first, then the user namespace.",
      parameters: {
        owner: { type: 'string', description: 'User or organisation login. Omit for the authenticated user.' },
        limit: { type: 'number', description: 'Maximum number of repositories. Defaults to 30.' },
        sort: { type: 'string', description: 'updated (default), pushed, full_name, or created.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const limit = Math.min(Math.max(args.limit ?? 30, 1), 100)
        const sort = args.sort ?? 'updated'
        const suffix = `/repos?per_page=${limit}&sort=${encodeURIComponent(sort)}`

        let repos
        let scope
        if (args.owner === undefined) {
          repos = await request(ctx, config, 'GET', `/user${suffix}`, undefined, exec.signal)
          scope = 'authenticated user'
        } else {
          try {
            repos = await request(ctx, config, 'GET', `/orgs/${args.owner}${suffix}`, undefined, exec.signal)
            scope = `org ${args.owner}`
          } catch (error) {
            if (error?.status !== 404) throw error
            repos = await request(ctx, config, 'GET', `/users/${args.owner}${suffix}`, undefined, exec.signal)
            scope = `user ${args.owner}`
          }
        }

        return {
          scope,
          count: repos.length,
          repos: repos.map((repo) => ({
            fullName: repo.full_name,
            private: repo.private,
            defaultBranch: repo.default_branch,
            description: repo.description ?? null,
            updatedAt: repo.updated_at,
            htmlUrl: repo.html_url,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_list_issues',
      description: 'List issues in a repository. Pull requests are filtered out unless includePulls is set.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        state: { type: 'string', description: 'open (default), closed, or all.' },
        limit: { type: 'number', description: 'Maximum number of issues. Defaults to 20.' },
        includePulls: { type: 'boolean', description: 'Include pull requests, which the issues endpoint also returns. Defaults to false.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const state = args.state ?? 'open'
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
        const items = await request(
          ctx,
          config,
          'GET',
          `/repos/${args.owner}/${args.repo}/issues?state=${encodeURIComponent(state)}&per_page=${limit}`,
          undefined,
          exec.signal,
        )
        const issues = (args.includePulls ?? false) ? items : items.filter((item) => item.pull_request === undefined)
        return {
          count: issues.length,
          issues: issues.map((issue) => ({
            number: issue.number,
            title: issue.title,
            state: issue.state,
            author: issue.user?.login,
            labels: (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)),
            comments: issue.comments,
            isPullRequest: issue.pull_request !== undefined,
            updatedAt: issue.updated_at,
            htmlUrl: issue.html_url,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_get_issue',
      description: 'Read one issue with its comments. Pull requests can be read here too, which is useful for the conversation around a review.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        number: { type: 'number', required: true, description: 'Issue or pull request number.' },
        includeComments: { type: 'boolean', description: 'Include the comment thread. Defaults to true.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const issue = await request(
          ctx,
          config,
          'GET',
          `/repos/${args.owner}/${args.repo}/issues/${args.number}`,
          undefined,
          exec.signal,
        )
        let comments
        if (args.includeComments ?? true) {
          const list = await request(
            ctx,
            config,
            'GET',
            `/repos/${args.owner}/${args.repo}/issues/${args.number}/comments?per_page=50`,
            undefined,
            exec.signal,
          )
          comments = list.map((comment) => ({
            author: comment.user?.login,
            createdAt: comment.created_at,
            body: comment.body,
          }))
        }
        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          author: issue.user?.login,
          isPullRequest: issue.pull_request !== undefined,
          labels: (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)),
          body: issue.body ?? '',
          htmlUrl: issue.html_url,
          comments,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_comment',
      description:
        'Post a plain comment on an issue or pull request. Use github_review_pull instead when you want an approval, a change request, or inline diff comments.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        number: { type: 'number', required: true, description: 'Issue or pull request number.' },
        body: { type: 'string', required: true, description: 'Comment body (Markdown).' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const comment = await request(
          ctx,
          config,
          'POST',
          `/repos/${args.owner}/${args.repo}/issues/${args.number}/comments`,
          { body: args.body },
          exec.signal,
        )
        return { id: comment.id, author: comment.user?.login, htmlUrl: comment.html_url }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_merge_pull',
      description:
        'Merge a pull request. method picks merge, squash or rebase. GitHub refuses when the branch protection rules or the mergeable state do not allow it, and the refusal is returned verbatim.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        number: { type: 'number', required: true, description: 'Pull request number.' },
        method: { type: 'string', description: 'merge (default), squash, or rebase.' },
        commitTitle: { type: 'string', description: 'Title for the merge commit.' },
        commitMessage: { type: 'string', description: 'Extra detail for the merge commit.' },
        sha: { type: 'string', description: 'Expected head SHA; the merge fails if the head moved since you read it.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const method = (args.method ?? 'merge').toLowerCase()
        if (!['merge', 'squash', 'rebase'].includes(method)) {
          throw fail(`method must be merge, squash or rebase (got ${args.method})`)
        }
        const payload = { merge_method: method }
        if (args.commitTitle !== undefined) payload.commit_title = args.commitTitle
        if (args.commitMessage !== undefined) payload.commit_message = args.commitMessage
        if (args.sha !== undefined) payload.sha = args.sha

        const result = await request(
          ctx,
          config,
          'PUT',
          `/repos/${args.owner}/${args.repo}/pulls/${args.number}/merge`,
          payload,
          exec.signal,
        )
        return { merged: result.merged === true, sha: result.sha ?? null, message: result.message ?? null }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_delete_repo',
      description:
        'Permanently delete a repository. Irreversible: it removes the repository, its issues, pull requests and releases. The confirm argument must repeat "owner/repo" exactly, and a classic token needs the repo scope; a fine-grained token needs Administration: write.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        confirm: {
          type: 'string',
          required: true,
          description: 'Must equal "owner/repo". Guards against an accidental call.',
        },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const expected = `${args.owner}/${args.repo}`
        if (args.confirm !== expected) {
          throw fail(`confirm must be exactly "${expected}" (got ${JSON.stringify(args.confirm)})`)
        }
        await request(ctx, config, 'DELETE', `/repos/${expected}`, undefined, exec.signal)
        return { deleted: true, repository: expected }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_search',
      description:
        'Search GitHub. kind selects the index: issues (issues and pull requests), repositories, or code. Query syntax is GitHub\'s own, so qualifiers like repo:, is:pr, is:open, label: and path: work. Code search only indexes default branches and lags behind recent pushes, so a freshly pushed file can legitimately return zero results.',
      parameters: {
        kind: { type: 'string', required: true, description: 'issues, repositories, or code.' },
        query: { type: 'string', required: true, description: 'Search query, GitHub qualifier syntax allowed.' },
        limit: { type: 'number', description: 'Maximum results. Defaults to 20, capped at 100.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const kind = String(args.kind).toLowerCase()
        const index = { issues: 'issues', repositories: 'repositories', repos: 'repositories', code: 'code' }[kind]
        if (index === undefined) throw fail(`kind must be issues, repositories or code (got ${args.kind})`)

        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
        const result = await request(
          ctx,
          config,
          'GET',
          `/search/${index}?q=${encodeURIComponent(args.query)}&per_page=${limit}`,
          undefined,
          exec.signal,
        )

        const items = (result.items ?? []).map((item) => {
          if (index === 'repositories') {
            return { fullName: item.full_name, private: item.private, stars: item.stargazers_count, description: item.description ?? null, htmlUrl: item.html_url }
          }
          if (index === 'code') {
            return { repository: item.repository?.full_name, path: item.path, name: item.name, htmlUrl: item.html_url }
          }
          return {
            repository: item.repository_url?.replace('https://api.github.com/repos/', '') ?? null,
            number: item.number,
            title: item.title,
            state: item.state,
            isPullRequest: item.pull_request !== undefined,
            htmlUrl: item.html_url,
          }
        })

        return { kind: index, totalCount: result.total_count ?? items.length, returned: items.length, items }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_get_checks',
      description:
        'Read the CI state of a commit: check runs plus the legacy combined commit status. Use it to decide whether a pull request is actually green before merging.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        ref: { type: 'string', required: true, description: 'Commit SHA, branch or tag.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const base = `/repos/${args.owner}/${args.repo}/commits/${encodeURIComponent(args.ref)}`
        const runs = await request(ctx, config, 'GET', `${base}/check-runs?per_page=100`, undefined, exec.signal)
        const combined = await request(ctx, config, 'GET', `${base}/status`, undefined, exec.signal)

        return {
          ref: args.ref,
          checkRuns: (runs.check_runs ?? []).map((run) => ({
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            startedAt: run.started_at,
            completedAt: run.completed_at,
            htmlUrl: run.html_url,
          })),
          combinedStatus: {
            state: combined.state,
            totalCount: combined.total_count,
            statuses: (combined.statuses ?? []).map((status) => ({
              context: status.context,
              state: status.state,
              description: status.description,
              targetUrl: status.target_url,
            })),
          },
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_set_status',
      description:
        'Publish a commit status check. This is the primitive a review gate uses: post pending before work starts, then success or failure with a context name that identifies the producer.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        sha: { type: 'string', required: true, description: 'Commit SHA to attach the status to.' },
        state: { type: 'string', required: true, description: 'error, failure, pending, or success.' },
        context: { type: 'string', description: 'Status name shown in the checks list. Defaults to "dsh".' },
        description: { type: 'string', description: 'Short one-line summary.' },
        targetUrl: { type: 'string', description: 'Link shown next to the status.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const state = String(args.state).toLowerCase()
        if (!['error', 'failure', 'pending', 'success'].includes(state)) {
          throw fail(`state must be error, failure, pending or success (got ${args.state})`)
        }
        const payload = { state, context: args.context ?? 'dsh' }
        if (args.description !== undefined) payload.description = args.description.slice(0, 140)
        if (args.targetUrl !== undefined) payload.target_url = args.targetUrl

        const status = await request(
          ctx,
          config,
          'POST',
          `/repos/${args.owner}/${args.repo}/statuses/${args.sha}`,
          payload,
          exec.signal,
        )
        return { id: status.id, state: status.state, context: status.context, url: status.url }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_list_branches',
      description: 'List branches with the head commit of each.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        limit: { type: 'number', description: 'Maximum branches. Defaults to 50.' },
        protectedOnly: { type: 'boolean', description: 'Only branches with protection rules. Defaults to false.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 100)
        const branches = await request(
          ctx,
          config,
          'GET',
          `/repos/${args.owner}/${args.repo}/branches?per_page=${limit}`,
          undefined,
          exec.signal,
        )
        const selected = (args.protectedOnly ?? false) ? branches.filter((b) => b.protected === true) : branches
        return {
          count: selected.length,
          branches: selected.map((branch) => ({
            name: branch.name,
            protected: branch.protected ?? false,
            headSha: branch.commit?.sha,
            headMessage: branch.commit?.commit?.message?.split('\n')[0] ?? null,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_compare',
      description:
        'Compare two refs. Reports how far ahead and behind they are and lists the commits and changed files between them — useful before opening or merging a pull request.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        base: { type: 'string', required: true, description: 'Base branch, tag or SHA.' },
        head: { type: 'string', required: true, description: 'Head branch, tag or SHA.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const result = await request(
          ctx,
          config,
          'GET',
          `/repos/${args.owner}/${args.repo}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`,
          undefined,
          exec.signal,
        )
        return {
          status: result.status,
          aheadBy: result.ahead_by,
          behindBy: result.behind_by,
          totalCommits: result.total_commits,
          commits: (result.commits ?? []).map((commit) => ({
            sha: commit.sha,
            message: commit.commit?.message?.split('\n')[0] ?? null,
            author: commit.commit?.author?.name ?? commit.author?.login ?? null,
          })),
          files: (result.files ?? []).map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_update_pull',
      description:
        'Edit an existing pull request: retitle, rewrite the body, retarget the base branch, or close and reopen it by setting state.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        number: { type: 'number', required: true, description: 'Pull request number.' },
        title: { type: 'string', description: 'New title.' },
        body: { type: 'string', description: 'New body (Markdown).' },
        base: { type: 'string', description: 'New base branch.' },
        state: { type: 'string', description: 'open or closed. Use closed to close the pull request.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const payload = {}
        for (const key of ['title', 'body', 'base', 'state']) {
          if (args[key] !== undefined) payload[key] = args[key]
        }
        if (Object.keys(payload).length === 0) throw fail('nothing to update: pass at least one of title, body, base, state')
        if (payload.state !== undefined && !['open', 'closed'].includes(payload.state)) {
          throw fail(`state must be open or closed (got ${payload.state})`)
        }

        const pull = await request(
          ctx,
          config,
          'PATCH',
          `/repos/${args.owner}/${args.repo}/pulls/${args.number}`,
          payload,
          exec.signal,
        )
        return summarisePull(pull)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_update_issue',
      description:
        'Edit an existing issue: retitle, rewrite the body, close or reopen it, or replace its labels and assignees.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        number: { type: 'number', required: true, description: 'Issue number.' },
        title: { type: 'string', description: 'New title.' },
        body: { type: 'string', description: 'New body (Markdown).' },
        state: { type: 'string', description: 'open or closed.' },
        stateReason: { type: 'string', description: 'completed, not_planned, or reopened. Only meaningful with state.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Replacement label set.' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'Replacement assignee set.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const payload = {}
        for (const key of ['title', 'body', 'state', 'labels', 'assignees']) {
          if (args[key] !== undefined) payload[key] = args[key]
        }
        if (args.stateReason !== undefined) payload.state_reason = args.stateReason
        if (Object.keys(payload).length === 0) throw fail('nothing to update: pass at least one field')
        if (payload.state !== undefined && !['open', 'closed'].includes(payload.state)) {
          throw fail(`state must be open or closed (got ${payload.state})`)
        }

        const issue = await request(
          ctx,
          config,
          'PATCH',
          `/repos/${args.owner}/${args.repo}/issues/${args.number}`,
          payload,
          exec.signal,
        )
        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          stateReason: issue.state_reason ?? null,
          labels: (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)),
          assignees: (issue.assignees ?? []).map((user) => user.login),
          htmlUrl: issue.html_url,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_put_file',
      description:
        'Create or update one file through the contents API, producing a commit without a local clone. When updating, the existing blob SHA is looked up automatically if sha is omitted.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        path: { type: 'string', required: true, description: 'Path inside the repository.' },
        text: { type: 'string', required: true, description: 'Full file contents as UTF-8 text.' },
        message: { type: 'string', description: 'Commit message. Defaults to a generated one.' },
        branch: { type: 'string', description: 'Branch to commit on. Defaults to the default branch.' },
        sha: { type: 'string', description: 'Blob SHA of the file being replaced. Looked up when omitted.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const apiPath = `/repos/${args.owner}/${args.repo}/contents/${args.path}`
        let sha = args.sha
        if (sha === undefined) {
          const existing = await request(
            ctx,
            config,
            'GET',
            `${apiPath}${args.branch === undefined ? '' : `?ref=${encodeURIComponent(args.branch)}`}`,
            undefined,
            exec.signal,
          ).catch(() => undefined)
          if (existing !== undefined && Array.isArray(existing)) throw fail(`${args.path} is a directory, not a file`)
          sha = existing?.sha
        }

        const payload = {
          message: args.message ?? `${sha === undefined ? 'Add' : 'Update'} ${args.path}`,
          content: Buffer.from(args.text, 'utf8').toString('base64'),
        }
        if (sha !== undefined) payload.sha = sha
        if (args.branch !== undefined) payload.branch = args.branch

        const result = await request(ctx, config, 'PUT', apiPath, payload, exec.signal)
        return {
          path: result.content?.path ?? args.path,
          created: sha === undefined,
          commitSha: result.commit?.sha ?? null,
          htmlUrl: result.content?.html_url ?? null,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_delete_file',
      description: 'Delete one file through the contents API, producing a commit without a local clone.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        path: { type: 'string', required: true, description: 'Path inside the repository.' },
        message: { type: 'string', description: 'Commit message. Defaults to a generated one.' },
        branch: { type: 'string', description: 'Branch to commit on. Defaults to the default branch.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const apiPath = `/repos/${args.owner}/${args.repo}/contents/${args.path}`
        const query = args.branch === undefined ? '' : `?ref=${encodeURIComponent(args.branch)}`
        const existing = await request(ctx, config, 'GET', `${apiPath}${query}`, undefined, exec.signal)
        if (Array.isArray(existing)) throw fail(`${args.path} is a directory, not a file`)

        const payload = { message: args.message ?? `Delete ${args.path}`, sha: existing.sha }
        if (args.branch !== undefined) payload.branch = args.branch

        const result = await request(ctx, config, 'DELETE', apiPath, payload, exec.signal)
        return { path: args.path, commitSha: result?.commit?.sha ?? null }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_list_releases',
      description: 'List releases, newest first.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        limit: { type: 'number', description: 'Maximum releases. Defaults to 20.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
        const releases = await request(
          ctx,
          config,
          'GET',
          `/repos/${args.owner}/${args.repo}/releases?per_page=${limit}`,
          undefined,
          exec.signal,
        )
        return {
          count: releases.length,
          releases: releases.map((release) => ({
            id: release.id,
            tagName: release.tag_name,
            name: release.name,
            draft: release.draft,
            prerelease: release.prerelease,
            publishedAt: release.published_at,
            assetCount: (release.assets ?? []).length,
            htmlUrl: release.html_url,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_create_release',
      description:
        'Create a release. GitHub creates the tag if it does not exist yet, pointed at targetCommitish. Set draft to stage it without publishing.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        tag: { type: 'string', required: true, description: 'Tag name, e.g. v0.2.0.' },
        name: { type: 'string', description: 'Release title. Defaults to the tag name.' },
        body: { type: 'string', description: 'Release notes (Markdown).' },
        targetCommitish: { type: 'string', description: 'Commitish the tag is created from. Defaults to the default branch.' },
        draft: { type: 'boolean', description: 'Create as a draft. Defaults to false.' },
        prerelease: { type: 'boolean', description: 'Mark as a pre-release. Defaults to false.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const payload = { tag_name: args.tag, draft: args.draft ?? false, prerelease: args.prerelease ?? false }
        if (args.name !== undefined) payload.name = args.name
        if (args.body !== undefined) payload.body = args.body
        if (args.targetCommitish !== undefined) payload.target_commitish = args.targetCommitish

        const release = await request(
          ctx,
          config,
          'POST',
          `/repos/${args.owner}/${args.repo}/releases`,
          payload,
          exec.signal,
        )
        return {
          id: release.id,
          tagName: release.tag_name,
          name: release.name,
          draft: release.draft,
          prerelease: release.prerelease,
          htmlUrl: release.html_url,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_analyze_pull',
      description:
        'Run the deterministic review rules over a pull request diff. Returns findings, a ready-to-post review body carrying the plugin marker, and inline comments in GitHub review shape. Read-only: it never writes to GitHub, so publish what it finds with github_review_pull.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        number: { type: 'number', required: true, description: 'Pull request number.' },
        minSeverity: { type: 'string', description: 'Least severe finding to turn into a comment: error, warning (default) or note.' },
        maxComments: { type: 'number', description: 'Maximum inline comments to produce. Defaults to 20, capped at 50.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const minSeverity = args.minSeverity ?? config.reviewMinSeverity ?? 'warning'
        if (!SEVERITIES.includes(minSeverity)) {
          throw fail(`minSeverity must be one of ${SEVERITIES.join(', ')} (got ${args.minSeverity})`)
        }
        const maxComments = Math.min(Math.max(args.maxComments ?? config.reviewMaxComments ?? 20, 1), 50)

        const diff = await request(
          ctx,
          config,
          'GET',
          `/repos/${args.owner}/${args.repo}/pulls/${args.number}`,
          undefined,
          exec.signal,
          ACCEPT_DIFF,
        )

        const analysis = analyseDiff(diff, {
          largeChangeLines: config.largeChangeLines ?? DEFAULT_LARGE_CHANGE_LINES,
        })
        const projection = toReviewComments(analysis, { minSeverity, limit: maxComments })

        return {
          repository: `${args.owner}/${args.repo}`,
          pullNumber: args.number,
          files: analysis.files,
          additions: analysis.additions,
          deletions: analysis.deletions,
          counts: analysis.counts,
          findings: analysis.findings,
          reviewBody: renderReviewBody(analysis, { title: `Deterministic review of #${args.number}` }),
          inlineComments: projection.inline,
          unanchoredFindings: projection.unanchored,
        }
      },
    }),
  )

  // ---------------------------------------------------------------------------
  // Write-approval gate
  // ---------------------------------------------------------------------------

  /**
   * Tools that change state on GitHub.
   *
   * `github_clone` is deliberately absent: it only reads from GitHub, and where
   * it writes locally is governed by the file sandbox rather than by this gate.
   */
  const WRITE_TOOLS = new Set([
    'github_create_repo',
    'github_delete_repo',
    'github_push',
    'github_create_pull',
    'github_update_pull',
    'github_review_pull',
    'github_merge_pull',
    'github_create_issue',
    'github_update_issue',
    'github_comment',
    'github_put_file',
    'github_delete_file',
    'github_create_release',
    'github_set_status',
  ])

  /** One-line target description for the approval prompt. */
  function describeTarget(exec) {
    const args = exec?.arguments ?? {}
    const parts = []
    if (typeof args.owner === 'string' && typeof args.repo === 'string') parts.push(`${args.owner}/${args.repo}`)
    if (args.number !== undefined) parts.push(`#${args.number}`)
    if (typeof args.path === 'string') parts.push(args.path)
    if (typeof args.tag === 'string') parts.push(args.tag)
    if (typeof args.ref === 'string') parts.push(`ref ${args.ref}`)
    if (typeof args.sha === 'string') parts.push(args.sha.slice(0, 12))
    if (typeof args.name === 'string') parts.push(args.name)
    if (typeof args.branch === 'string') parts.push(`-> ${args.branch}`)
    return parts.length > 0 ? parts.join(' ') : 'no explicit target'
  }

  // Returning `ask` is the whole gate: the tools runtime routes it through the
  // approval service and only proceeds on `allowed-once`. A deployment with no
  // answerer denies instead, so the failure direction is closed.
  if (config.approveWrites ?? true) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (typeof exec?.name !== 'string' || !WRITE_TOOLS.has(exec.name)) return next()
      return {
        kind: 'ask',
        reason: `${exec.name} will change state on GitHub: ${describeTarget(exec)}`,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Human commands
  // ---------------------------------------------------------------------------

  // Looked up rather than injected: a profile without the command runtime should
  // still get every tool, so the plugin must not fail to load over this.
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    const ok = (text) => ({ kind: 'success', text })
    const bad = (text) => ({ kind: 'error', text })

    /** Split `owner/repo` plus trailing extras out of raw command input. */
    function splitTarget(raw) {
      const parts = raw.trim().split(/\s+/).filter((part) => part !== '')
      const slug = parts.shift() ?? ''
      const slash = slug.indexOf('/')
      if (slash <= 0 || slash === slug.length - 1) return undefined
      return { owner: slug.slice(0, slash), repo: slug.slice(slash + 1), rest: parts }
    }

    commands.register({
      definitionId: 'github',
      name: 'github',
      description: 'GitHub lookups without a model turn: status, whoami, repo, pr, checks, search.',
      handler: async (invocation) => {
        const parts = invocation.rawInput.trim().split(/\s+/).filter((part) => part !== '')
        const sub = (parts.shift() ?? 'status').toLowerCase()
        const signal = invocation.signal

        try {
          switch (sub) {
            case 'status': {
              const { token, source } = await resolveToken(ctx, config)
              return ok(
                [
                  `token     : ${token === undefined ? 'missing' : `present (${token.length} chars)`}`,
                  `source    : ${source}`,
                  `apiBase   : ${config.apiBase ?? DEFAULT_API_BASE}`,
                  `gitHost   : ${config.gitHost ?? 'github.com'}`,
                  `write gate: ${(config.approveWrites ?? true) ? 'ask' : 'off'}`,
                ].join('\n'),
              )
            }

            case 'whoami': {
              const user = await request(ctx, config, 'GET', '/user', undefined, signal)
              return ok(`${user.login} (${user.type}) · ${user.public_repos} public repos · ${user.html_url}`)
            }

            case 'repo': {
              const target = splitTarget(parts.join(' '))
              if (target === undefined) return bad('usage: /github repo <owner>/<name>')
              const repo = await request(
                ctx,
                config,
                'GET',
                `/repos/${target.owner}/${target.repo}`,
                undefined,
                signal,
              )
              return ok(
                [
                  `${repo.full_name}${repo.private ? ' (private)' : ''}`,
                  `default branch: ${repo.default_branch}`,
                  `open issues   : ${repo.open_issues_count}`,
                  `stars / forks : ${repo.stargazers_count} / ${repo.forks_count}`,
                  `description   : ${repo.description ?? '(none)'}`,
                  repo.html_url,
                ].join('\n'),
              )
            }

            case 'pr': {
              const target = splitTarget(parts.join(' '))
              const number = Number(target?.rest?.[0])
              if (target === undefined || !Number.isInteger(number)) {
                return bad('usage: /github pr <owner>/<name> <number>')
              }
              const pull = await request(
                ctx,
                config,
                'GET',
                `/repos/${target.owner}/${target.repo}/pulls/${number}`,
                undefined,
                signal,
              )
              const summary = summarisePull(pull)
              return ok(
                [
                  `#${summary.number} ${summary.title}`,
                  `state         : ${summary.state}${summary.draft ? ' (draft)' : ''}`,
                  `mergeable     : ${summary.mergeableState}`,
                  `${summary.headRef} -> ${summary.baseRef}`,
                  `+${summary.additions} -${summary.deletions} across ${summary.changedFiles} files`,
                  summary.htmlUrl,
                ].join('\n'),
              )
            }

            case 'checks': {
              const target = splitTarget(parts.join(' '))
              const ref = target?.rest?.[0]
              if (target === undefined || ref === undefined) {
                return bad('usage: /github checks <owner>/<name> <ref>')
              }
              const base = `/repos/${target.owner}/${target.repo}/commits/${encodeURIComponent(ref)}`
              const runs = await request(ctx, config, 'GET', `${base}/check-runs?per_page=100`, undefined, signal)
              const combined = await request(ctx, config, 'GET', `${base}/status`, undefined, signal)
              const failed = (runs.check_runs ?? []).filter(
                (run) => run.conclusion !== null && run.conclusion !== 'success' && run.conclusion !== 'neutral' && run.conclusion !== 'skipped',
              )
              return ok(
                [
                  `${target.owner}/${target.repo} @ ${ref}`,
                  `check runs    : ${(runs.check_runs ?? []).length} (${failed.length} not green)`,
                  `combined state: ${combined.state}`,
                  ...failed.map((run) => `  ! ${run.name}: ${run.conclusion}`),
                ].join('\n'),
              )
            }

            case 'review': {
              const target = splitTarget(parts.join(' '))
              const number = Number(target?.rest?.[0])
              if (target === undefined || !Number.isInteger(number)) {
                return bad('usage: /github review <owner>/<name> <number>')
              }
              const diff = await request(
                ctx,
                config,
                'GET',
                `/repos/${target.owner}/${target.repo}/pulls/${number}`,
                undefined,
                signal,
                ACCEPT_DIFF,
              )
              const analysis = analyseDiff(diff, {
                largeChangeLines: config.largeChangeLines ?? DEFAULT_LARGE_CHANGE_LINES,
              })
              const projection = toReviewComments(analysis, {
                minSeverity: config.reviewMinSeverity ?? 'warning',
                limit: config.reviewMaxComments ?? 20,
              })

              const head = [
                `${target.owner}/${target.repo}#${number}`,
                `${analysis.files} file(s) · +${analysis.additions} −${analysis.deletions} · ` +
                  `${analysis.counts.error} error / ${analysis.counts.warning} warning / ${analysis.counts.note} note`,
                `inline comments ready: ${projection.inline.length}`,
              ]
              const listed =
                analysis.findings.length === 0
                  ? ['no findings from the deterministic rules']
                  : analysis.findings.slice(0, 12).map((finding) => {
                      const where =
                        finding.path === null
                          ? ''
                          : ` ${finding.path}${finding.line === null ? '' : `:${finding.line}`}`
                      return `  [${finding.severity}] ${finding.rule}${where}`
                    })
              return ok([...head, ...listed].join('\n'))
            }

            case 'search': {
              const query = parts.join(' ')
              if (query === '') return bad('usage: /github search <query>')
              const result = await request(
                ctx,
                config,
                'GET',
                `/search/issues?q=${encodeURIComponent(query)}&per_page=5`,
                undefined,
                signal,
              )
              const items = result.items ?? []
              if (items.length === 0) return ok(`no results for "${query}"`)
              return ok(
                [
                  `${result.total_count} results for "${query}" (showing ${items.length})`,
                  ...items.map((item) => {
                    const slug = item.repository_url?.replace('https://api.github.com/repos/', '') ?? '?'
                    return `  ${slug}#${item.number} ${item.title}${item.pull_request !== undefined ? ' [pr]' : ''}`
                  }),
                ].join('\n'),
              )
            }

            default:
              return bad(
                `unknown subcommand "${sub}". Try: status, whoami, repo <owner>/<name>, pr <owner>/<name> <n>, checks <owner>/<name> <ref>, search <query>`,
              )
          }
        } catch (error) {
          return bad(String(error?.message ?? error))
        }
      },
    })
  }
}
