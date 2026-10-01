/**
 * Tests for the two extension seams: the write-approval gate on
 * `tools/pre-execute`, and the `/github` human command.
 *
 * @module test/gate-and-commands
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadPlugin, mockFetch, unmockFetch, fakeCommands, runPreExecute } from './harness.mjs'

test.afterEach(() => unmockFetch())

const signal = () => new AbortController().signal

/** Load with a fake command runtime, returning its registrations. */
async function withCommands(overrides = {}) {
  const commands = fakeCommands()
  const loaded = await loadPlugin(overrides, new Map([['commands', commands]]))
  return { ...loaded, commands, handler: commands.registered[0]?.handler }
}

// ---------------------------------------------------------------------------
// Write-approval gate
// ---------------------------------------------------------------------------

test('the gate asks before a tool that changes state on GitHub', async () => {
  const { listeners } = await loadPlugin()
  const decision = await runPreExecute(listeners, {
    name: 'github_delete_repo',
    arguments: { owner: 'o', repo: 'r', confirm: 'o/r' },
  })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /github_delete_repo/)
  assert.match(decision.reason, /o\/r/)
})

test('the gate names the target so the prompt is answerable', async () => {
  const { listeners } = await loadPlugin()
  const decision = await runPreExecute(listeners, {
    name: 'github_merge_pull',
    arguments: { owner: 'o', repo: 'r', number: 12 },
  })
  assert.match(decision.reason, /o\/r #12/)
})

test('the gate delegates every read tool to the next listener', async () => {
  const { listeners } = await loadPlugin()
  for (const name of ['github_get_pull', 'github_list_pulls', 'github_search', 'github_status']) {
    assert.deepEqual(await runPreExecute(listeners, { name, arguments: {} }), { kind: 'allow' }, name)
  }
})

test('github_clone is not gated, because it does not write to GitHub', async () => {
  const { listeners } = await loadPlugin()
  assert.deepEqual(await runPreExecute(listeners, { name: 'github_clone', arguments: {} }), { kind: 'allow' })
})

test('every declared write tool is gated', async () => {
  const { listeners, tools } = await loadPlugin()
  const writeTools = [
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
  ]
  for (const name of writeTools) {
    assert.ok(tools.has(name), `write tool ${name} is not registered`)
    assert.equal((await runPreExecute(listeners, { name, arguments: {} })).kind, 'ask', name)
  }
})

test('approveWrites: false removes the gate entirely', async () => {
  const { listeners } = await loadPlugin({ approveWrites: false })
  assert.equal((listeners.get('tools/pre-execute') ?? []).length, 0)
  assert.deepEqual(await runPreExecute(listeners, { name: 'github_delete_repo', arguments: {} }), { kind: 'allow' })
})

// ---------------------------------------------------------------------------
// /github command
// ---------------------------------------------------------------------------

test('the command is registered and the plugin still loads without the runtime', async () => {
  const withRuntime = await withCommands()
  assert.equal(withRuntime.commands.registered.length, 1)
  assert.equal(withRuntime.commands.registered[0].name, 'github')

  // No command service composed: every tool must still register.
  const without = await loadPlugin()
  assert.equal(without.tools.size, 29)
})

test('/github with no argument reports status, including the gate state', async () => {
  const { handler } = await withCommands()
  const result = await handler({ rawInput: '', signal: signal() })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /token {5}: present \(10 chars\)/)
  assert.match(result.text, /write gate: ask/)
})

test('/github whoami reads the account', async () => {
  const calls = mockFetch([['/user', { body: { login: 'ada', type: 'User', public_repos: 3, html_url: 'u' } }]])
  const { handler } = await withCommands()
  const result = await handler({ rawInput: 'whoami', signal: signal() })
  assert.match(result.text, /ada \(User\) · 3 public repos/)
  assert.equal(calls[0].url, 'https://api.github.com/user')
})

test('/github repo validates its argument and then summarises the repository', async () => {
  const calls = mockFetch([
    [
      '/repos/o/r',
      {
        body: {
          full_name: 'o/r',
          private: true,
          default_branch: 'main',
          open_issues_count: 2,
          stargazers_count: 9,
          forks_count: 1,
          description: null,
          html_url: 'u',
        },
      },
    ],
  ])
  const { handler } = await withCommands()

  const usage = await handler({ rawInput: 'repo', signal: signal() })
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /usage: \/github repo/)
  assert.equal(calls.length, 0, 'the usage error must not reach the network')

  const result = await handler({ rawInput: 'repo o/r', signal: signal() })
  assert.match(result.text, /o\/r \(private\)/)
  assert.match(result.text, /stars \/ forks : 9 \/ 1/)
})

test('/github pr validates its argument and summarises the pull request', async () => {
  mockFetch([
    [
      '/pulls/7',
      {
        body: {
          number: 7,
          title: 'Fix the thing',
          state: 'open',
          draft: true,
          mergeable_state: 'clean',
          user: { login: 'ada' },
          head: { ref: 'feature/x', sha: 'h' },
          base: { ref: 'main' },
          additions: 12,
          deletions: 3,
          changed_files: 2,
          labels: [],
          html_url: 'u',
        },
      },
    ],
  ])
  const { handler } = await withCommands()

  assert.match((await handler({ rawInput: 'pr o/r', signal: signal() })).text, /usage: \/github pr/)

  const result = await handler({ rawInput: 'pr o/r 7', signal: signal() })
  assert.match(result.text, /#7 Fix the thing/)
  assert.match(result.text, /\(draft\)/)
  assert.match(result.text, /\+12 -3 across 2 files/)
})

test('/github checks reports how many runs are not green', async () => {
  mockFetch([
    [
      '/check-runs',
      {
        body: {
          check_runs: [
            { name: 'ci', conclusion: 'success', status: 'completed' },
            { name: 'lint', conclusion: 'failure', status: 'completed' },
            { name: 'docs', conclusion: 'skipped', status: 'completed' },
          ],
        },
      },
    ],
    ['/status', { body: { state: 'failure', total_count: 0, statuses: [] } }],
  ])
  const { handler } = await withCommands()

  assert.match((await handler({ rawInput: 'checks o/r', signal: signal() })).text, /usage: \/github checks/)

  const result = await handler({ rawInput: 'checks o/r main', signal: signal() })
  assert.match(result.text, /3 \(1 not green\)/)
  assert.match(result.text, /! lint: failure/)
  assert.doesNotMatch(result.text, /docs/, 'skipped runs are not failures')
})

test('/github search reports an empty result set and a populated one', async () => {
  mockFetch([['/search/issues', { body: { total_count: 0, items: [] } }]])
  const empty = await withCommands()
  assert.match((await empty.handler({ rawInput: 'search nothing', signal: signal() })).text, /no results/)

  unmockFetch()
  mockFetch([
    [
      '/search/issues',
      {
        body: {
          total_count: 42,
          items: [
            {
              number: 1,
              title: 'A bug',
              repository_url: 'https://api.github.com/repos/o/r',
              pull_request: { url: 'x' },
            },
          ],
        },
      },
    ],
  ])
  const filled = await withCommands()
  const result = await filled.handler({ rawInput: 'search is:open', signal: signal() })
  assert.match(result.text, /42 results/)
  assert.match(result.text, /o\/r#1 A bug \[pr\]/)
})

test('/github turns an API failure into an error result instead of throwing', async () => {
  mockFetch([['/user', { status: 401, body: { message: 'Bad credentials' } }]])
  const { handler } = await withCommands()
  const result = await handler({ rawInput: 'whoami', signal: signal() })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /HTTP 401: Bad credentials/)
})

test('/github rejects an unknown subcommand and lists the valid ones', async () => {
  const { handler } = await withCommands()
  const result = await handler({ rawInput: 'frobnicate', signal: signal() })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /unknown subcommand "frobnicate"/)
  assert.match(result.text, /status, whoami, repo/)
})

test('/github review analyses a pull request diff', async () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,1 +1,2 @@',
    ' const a = 1',
    '+console.log("debug")',
  ].join('\n')
  const calls = mockFetch([['/pulls/9', { body: diff }]])
  const { handler } = await withCommands()

  assert.match((await handler({ rawInput: 'review o/r', signal: signal() })).text, /usage: \/github review/)
  assert.equal(calls.length, 0, 'the usage error must not reach the network')

  const result = await handler({ rawInput: 'review o/r 9', signal: signal() })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /o\/r#9/)
  assert.match(result.text, /1 file\(s\) · \+1 −0/)
  assert.match(result.text, /\[warning\] debug-leftover src\/a\.js:2/)
  assert.equal(calls[0].headers.accept, 'application/vnd.github.v3.diff')
})
