/**
 * Contract tests for the plugin's tool surface.
 *
 * Run with `npm test` (which is `node --test test/`). Nothing here touches the
 * network, a DSH profile, or a real repository: `test/harness.mjs` stubs the
 * three DSH packages and the global fetch.
 *
 * @module test/tools
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadPlugin, callTool, callToolExpectingError, mockFetch, unmockFetch } from './harness.mjs'

/** Convenience: load the plugin with a JSON-returning fetch stub. */
async function withRoutes(routes, overrides) {
  const calls = mockFetch(routes)
  const loaded = await loadPlugin(overrides)
  return { ...loaded, calls }
}

test.afterEach(() => unmockFetch())

test('registers the whole tool surface', async () => {
  const { tools } = await loadPlugin()
  assert.equal(tools.size, 29)
  for (const name of [
    'github_status',
    'github_create_pull',
    'github_review_pull',
    'github_search',
    'github_get_checks',
    'github_set_status',
    'github_compare',
    'github_put_file',
    'github_delete_file',
    'github_create_release',
    'github_analyze_pull',
  ]) {
    assert.ok(tools.has(name), `missing tool ${name}`)
  }
})

test('github_status reports where the token came from without leaking it', async () => {
  const { tools } = await loadPlugin()
  const result = await callTool(tools, 'github_status')
  assert.equal(result.tokenPresent, true)
  assert.equal(result.tokenSource, 'config.token')
  assert.equal(result.tokenLength, 'test-token'.length)
  assert.ok(!JSON.stringify(result).includes('test-token'))
})

test('github_status reports an absent token instead of throwing', async () => {
  const { tools } = await loadPlugin({ token: undefined })
  const result = await callTool(tools, 'github_status')
  assert.equal(result.tokenPresent, false)
  assert.match(result.tokenSource, /GITHUB_TOKEN/)
})

test('github_search issues index builds the right query and shapes results', async () => {
  const { tools, calls } = await withRoutes([
    [
      '/search/issues',
      {
        body: {
          total_count: 1,
          items: [
            {
              number: 7,
              title: 'Broken build',
              state: 'open',
              html_url: 'https://github.com/o/r/issues/7',
              repository_url: 'https://api.github.com/repos/o/r',
              user: { login: 'ada' },
            },
          ],
        },
      },
    ],
  ])

  const result = await callTool(tools, 'github_search', { kind: 'issues', query: 'repo:o/r is:open' })
  assert.equal(calls[0].url, 'https://api.github.com/search/issues?q=repo%3Ao%2Fr%20is%3Aopen&per_page=20')
  assert.equal(result.kind, 'issues')
  assert.equal(result.totalCount, 1)
  assert.deepEqual(result.items[0], {
    repository: 'o/r',
    number: 7,
    title: 'Broken build',
    state: 'open',
    isPullRequest: false,
    htmlUrl: 'https://github.com/o/r/issues/7',
  })
})

test('github_search maps the repositories and code indexes', async () => {
  const { tools, calls } = await withRoutes([
    ['/search/repositories', { body: { total_count: 1, items: [{ full_name: 'o/r', private: false, stargazers_count: 3, description: null, html_url: 'u' }] } }],
    ['/search/code', { body: { total_count: 1, items: [{ repository: { full_name: 'o/r' }, path: 'a/b.js', name: 'b.js', html_url: 'u' }] } }],
  ])

  const repos = await callTool(tools, 'github_search', { kind: 'repositories', query: 'dsh' })
  assert.equal(repos.items[0].fullName, 'o/r')
  const code = await callTool(tools, 'github_search', { kind: 'code', query: 'register' })
  assert.equal(code.items[0].path, 'a/b.js')
  assert.equal(calls.length, 2)
})

test('github_search rejects an unknown index', async () => {
  const { tools } = await withRoutes([])
  const message = await callToolExpectingError(tools, 'github_search', { kind: 'commits', query: 'x' })
  assert.match(message, /kind must be issues, repositories or code/)
})

test('github_get_checks reads both check runs and the combined status', async () => {
  const { tools, calls } = await withRoutes([
    ['/check-runs', { body: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', html_url: 'u' }] } }],
    ['/status', { body: { state: 'success', total_count: 1, statuses: [{ context: 'ci', state: 'success' }] } }],
  ])

  const result = await callTool(tools, 'github_get_checks', { owner: 'o', repo: 'r', ref: 'abc123' })
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/commits/abc123/check-runs?per_page=100')
  assert.equal(calls[1].url, 'https://api.github.com/repos/o/r/commits/abc123/status')
  assert.equal(result.checkRuns[0].conclusion, 'success')
  assert.equal(result.combinedStatus.state, 'success')
})

test('github_set_status posts the status and truncates the description', async () => {
  const { tools, calls } = await withRoutes([
    ['/statuses/', { body: { id: 1, state: 'pending', context: 'dsh', url: 'u' } }],
  ])

  const result = await callTool(tools, 'github_set_status', {
    owner: 'o',
    repo: 'r',
    sha: 'deadbeef',
    state: 'pending',
    description: 'x'.repeat(200),
  })
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/statuses/deadbeef')
  assert.equal(calls[0].body.context, 'dsh')
  assert.equal(calls[0].body.description.length, 140)
  assert.equal(result.state, 'pending')
})

test('github_set_status refuses a state GitHub does not accept', async () => {
  const { tools } = await withRoutes([])
  const message = await callToolExpectingError(tools, 'github_set_status', {
    owner: 'o',
    repo: 'r',
    sha: 's',
    state: 'green',
  })
  assert.match(message, /state must be error, failure, pending or success/)
})

test('github_list_branches can filter to protected branches', async () => {
  const { tools } = await withRoutes([
    [
      '/branches',
      {
        body: [
          { name: 'main', protected: true, commit: { sha: 'a', commit: { message: 'head\nmore' } } },
          { name: 'topic', protected: false, commit: { sha: 'b', commit: { message: 'wip' } } },
        ],
      },
    ],
  ])

  const all = await callTool(tools, 'github_list_branches', { owner: 'o', repo: 'r' })
  assert.equal(all.count, 2)
  assert.equal(all.branches[0].headMessage, 'head')

  const protectedOnly = await callTool(tools, 'github_list_branches', { owner: 'o', repo: 'r', protectedOnly: true })
  assert.equal(protectedOnly.count, 1)
  assert.equal(protectedOnly.branches[0].name, 'main')
})

test('github_compare encodes both refs into one path segment', async () => {
  const { tools, calls } = await withRoutes([
    ['/compare/', { body: { status: 'ahead', ahead_by: 2, behind_by: 0, total_commits: 2, commits: [], files: [] } }],
  ])

  const result = await callTool(tools, 'github_compare', { owner: 'o', repo: 'r', base: 'main', head: 'feature/x' })
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/compare/main...feature%2Fx')
  assert.equal(result.status, 'ahead')
})

test('github_update_pull patches only what it was given', async () => {
  const { tools, calls } = await withRoutes([
    ['/pulls/5', { body: { number: 5, title: 'New', state: 'closed', base: { ref: 'main' }, head: { ref: 'x' }, user: { login: 'a' } } }],
  ])

  const result = await callTool(tools, 'github_update_pull', { owner: 'o', repo: 'r', number: 5, state: 'closed' })
  assert.equal(calls[0].method, 'PATCH')
  assert.deepEqual(calls[0].body, { state: 'closed' })
  assert.equal(result.number, 5)
  assert.equal(result.state, 'closed')
})

test('github_update_pull refuses an empty patch and a bad state', async () => {
  const { tools } = await withRoutes([])
  assert.match(
    await callToolExpectingError(tools, 'github_update_pull', { owner: 'o', repo: 'r', number: 1 }),
    /nothing to update/,
  )
  assert.match(
    await callToolExpectingError(tools, 'github_update_pull', { owner: 'o', repo: 'r', number: 1, state: 'merged' }),
    /state must be open or closed/,
  )
})

test('github_update_issue sends snake_case for the state reason', async () => {
  const { tools, calls } = await withRoutes([
    ['/issues/3', { body: { number: 3, title: 'T', state: 'closed', state_reason: 'not_planned', labels: [], assignees: [], html_url: 'u' } }],
  ])

  const result = await callTool(tools, 'github_update_issue', {
    owner: 'o',
    repo: 'r',
    number: 3,
    state: 'closed',
    stateReason: 'not_planned',
    labels: ['bug'],
  })
  assert.equal(calls[0].body.state_reason, 'not_planned')
  assert.deepEqual(calls[0].body.labels, ['bug'])
  assert.equal(result.stateReason, 'not_planned')
})

test('github_put_file creates a new file without a sha lookup on the write', async () => {
  const { tools, calls } = await withRoutes([
    ['/contents/docs/new.md', (record) => (record.method === 'GET'
      ? { status: 404, body: { message: 'Not Found' } }
      : { body: { content: { path: 'docs/new.md', html_url: 'u' }, commit: { sha: 'commit1' } } })],
  ])

  const result = await callTool(tools, 'github_put_file', {
    owner: 'o',
    repo: 'r',
    path: 'docs/new.md',
    text: 'hello',
    message: 'Add docs',
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].method, 'PUT')
  assert.equal(calls[1].body.content, Buffer.from('hello', 'utf8').toString('base64'))
  assert.equal(calls[1].body.message, 'Add docs')
  assert.equal('sha' in calls[1].body, false)
  assert.deepEqual(result, { path: 'docs/new.md', created: true, commitSha: 'commit1', htmlUrl: 'u' })
})

test('github_put_file looks up the blob sha when updating an existing file', async () => {
  const { tools, calls } = await withRoutes([
    ['/contents/README.md', (record) => (record.method === 'GET'
      ? { body: { sha: 'blob9', type: 'file' } }
      : { body: { content: { path: 'README.md', html_url: 'u' }, commit: { sha: 'commit2' } } })],
  ])

  const result = await callTool(tools, 'github_put_file', { owner: 'o', repo: 'r', path: 'README.md', text: 'new' })
  assert.equal(calls[1].body.sha, 'blob9')
  assert.equal(result.created, false)
})

test('github_delete_file deletes by sha and refuses a directory', async () => {
  const { tools } = await withRoutes([
    ['/contents/gone.txt', (record) => (record.method === 'GET'
      ? { body: { sha: 'blob1', type: 'file' } }
      : { body: { commit: { sha: 'commit3' } } })],
    ['/contents/dir', { body: [{ name: 'a', type: 'file', path: 'dir/a' }] }],
  ])

  const result = await callTool(tools, 'github_delete_file', { owner: 'o', repo: 'r', path: 'gone.txt' })
  assert.equal(result.commitSha, 'commit3')
  assert.match(
    await callToolExpectingError(tools, 'github_delete_file', { owner: 'o', repo: 'r', path: 'dir' }),
    /is a directory/,
  )
})

test('github_create_release posts the tag and defaults draft flags', async () => {
  const { tools, calls } = await withRoutes([
    ['/releases', (record) => (record.method === 'POST'
      ? { body: { id: 9, tag_name: 'v1.0.0', name: 'v1.0.0', draft: false, prerelease: false, html_url: 'u' } }
      : { body: [] })],
  ])

  const result = await callTool(tools, 'github_create_release', { owner: 'o', repo: 'r', tag: 'v1.0.0', body: 'notes' })
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, { tag_name: 'v1.0.0', draft: false, prerelease: false, body: 'notes' })
  assert.equal(result.tagName, 'v1.0.0')

  const list = await callTool(tools, 'github_list_releases', { owner: 'o', repo: 'r' })
  assert.equal(list.count, 0)
})

test('github_review_pull refuses a bad event and an empty review', async () => {
  const { tools } = await withRoutes([])
  assert.match(
    await callToolExpectingError(tools, 'github_review_pull', { owner: 'o', repo: 'r', number: 1, event: 'LGTM' }),
    /event must be COMMENT, APPROVE or REQUEST_CHANGES/,
  )
  assert.match(
    await callToolExpectingError(tools, 'github_review_pull', { owner: 'o', repo: 'r', number: 1, event: 'APPROVE' }),
    /needs either a body or at least one inline comment/,
  )
})

test('github_review_pull defaults inline comments to the RIGHT side', async () => {
  const { tools, calls } = await withRoutes([
    ['/reviews', { body: { id: 2, state: 'COMMENTED', user: { login: 'a' }, submitted_at: 'now', html_url: 'u' } }],
  ])

  await callTool(tools, 'github_review_pull', {
    owner: 'o',
    repo: 'r',
    number: 1,
    event: 'comment',
    comments: [{ path: 'a.js', line: 4, body: 'why?' }],
  })
  assert.equal(calls[0].body.event, 'COMMENT')
  assert.deepEqual(calls[0].body.comments, [{ path: 'a.js', line: 4, side: 'RIGHT', body: 'why?' }])
})

test('github_merge_pull rejects an unknown method and passes the head sha through', async () => {
  const { tools, calls } = await withRoutes([
    ['/merge', { body: { merged: true, sha: 'merge1', message: 'ok' } }],
  ])

  assert.match(
    await callToolExpectingError(tools, 'github_merge_pull', { owner: 'o', repo: 'r', number: 1, method: 'fast-forward' }),
    /method must be merge, squash or rebase/,
  )

  const result = await callTool(tools, 'github_merge_pull', { owner: 'o', repo: 'r', number: 1, sha: 'head1' })
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].body.merge_method, 'merge')
  assert.equal(calls[0].body.sha, 'head1')
  assert.equal(result.merged, true)
})

test('github_delete_repo refuses unless confirm repeats owner/repo exactly', async () => {
  const { tools, calls } = await withRoutes([
    ['/repos/o/r', { status: 204, body: '' }],
  ])

  assert.match(
    await callToolExpectingError(tools, 'github_delete_repo', { owner: 'o', repo: 'r', confirm: 'o/other' }),
    /confirm must be exactly "o\/r"/,
  )
  assert.equal(calls.length, 0, 'the guard must run before any request')

  const result = await callTool(tools, 'github_delete_repo', { owner: 'o', repo: 'r', confirm: 'o/r' })
  assert.equal(calls[0].method, 'DELETE')
  assert.deepEqual(result, { deleted: true, repository: 'o/r' })
})

test('a GitHub error surfaces the status and message', async () => {
  const { tools } = await withRoutes([
    ['/user', { status: 401, body: { message: 'Bad credentials' } }],
  ])
  const message = await callToolExpectingError(tools, 'github_whoami')
  assert.match(message, /HTTP 401: Bad credentials/)
})

test('a request without any token explains where it looked', async () => {
  const { tools } = await withRoutes([], { token: undefined })
  const message = await callToolExpectingError(tools, 'github_whoami')
  assert.match(message, /no token available/)
  assert.match(message, /GITHUB_TOKEN/)
})
