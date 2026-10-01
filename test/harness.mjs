/**
 * Stand-in for the network and for the DSH context, so every tool, the
 * write-approval gate and the human command can be exercised with plain
 * `node --test test/` — no DSH profile, no restart, and no real GitHub traffic.
 *
 * @module test/harness
 */

import './stubs.mjs'

/** Route table entry: [url substring, canned response | responder]. */
function toResponse(result) {
  const status = result.status ?? 200
  const body = result.body
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
  }
}

/**
 * Install a fetch stand-in.
 *
 * @param routes - `[substring, response]` pairs, matched in order.
 * @returns The recorded calls, each `{url, method, body, headers}`.
 */
export function mockFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    }
    calls.push(record)
    for (const [pattern, responder] of routes) {
      if (record.url.includes(pattern)) {
        const result = typeof responder === 'function' ? responder(record) : responder
        if (result instanceof Error) throw result
        return toResponse(result)
      }
    }
    throw new Error(`unmocked fetch: ${record.method} ${record.url}`)
  }
  return calls
}

/** Restore the platform fetch. */
export function unmockFetch() {
  delete globalThis.fetch
}

/** A `ctx.commands` stand-in that records registrations. */
export function fakeCommands() {
  const registered = []
  return {
    registered,
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
}

/**
 * Import the plugin and run its `apply` against a captured context.
 *
 * @param overrides - Config overrides; a literal token is supplied by default.
 * @param services - Extra services `ctx.get(name)` should resolve.
 * @returns Tools, event listeners, the context and the resolved config.
 */
export async function loadPlugin(overrides = {}, services = new Map()) {
  const module = await import('../lib/index.js')
  const tools = new Map()
  const listeners = new Map()

  const ctx = {
    get: (name) => services.get(name),
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }

  const config = {
    token: 'test-token',
    tokenRef: 'GITHUB_TOKEN',
    apiBase: 'https://api.github.com',
    gitHost: 'github.com',
    userAgent: 'dsh-plugin-github-test',
    ...overrides,
  }

  module.apply(ctx, config)
  return { module, tools, listeners, ctx, services, config }
}

/** Call one registered tool. */
export async function callTool(tools, name, args = {}) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool not registered: ${name}`)
  const exec = { signal: new AbortController().signal, token: 'exec-token' }
  return definition.execute(args, exec)
}

/** Call one registered tool and expect it to reject, returning the message. */
export async function callToolExpectingError(tools, name, args = {}) {
  try {
    await callTool(tools, name, args)
  } catch (error) {
    return error.message
  }
  throw new Error(`expected ${name} to throw, but it resolved`)
}

/**
 * Drive the `tools/pre-execute` waterfall the way the registry does: listeners
 * run in registration order and `next()` delegates to the following one,
 * resolving to `allow` when the chain is exhausted.
 */
export async function runPreExecute(listeners, exec) {
  const chain = listeners.get('tools/pre-execute') ?? []
  let index = 0
  const next = async () => {
    if (index >= chain.length) return { kind: 'allow' }
    const handler = chain[index]
    index += 1
    return handler(exec, next)
  }
  return next()
}
