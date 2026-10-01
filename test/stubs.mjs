/**
 * Module stubs that let the plugin be imported and exercised outside DSH.
 *
 * `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools` and
 * `@deepseek-ai/dsh-credentials` only exist inside a DSH installation, so they
 * are intercepted here before the plugin is imported. The interception uses
 * Node's synchronous module hooks, which keeps the repository free of a
 * committed `node_modules`.
 *
 * @module test/stubs
 */

import { registerHooks } from 'node:module'

/** Chainable Schemastery stand-in: every accessor returns the same object. */
function chainable() {
  const proxy = new Proxy(function () {}, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => 'schema'
      if (property === 'toString') return () => 'schema'
      if (property === 'then') return undefined
      return () => proxy
    },
    apply() {
      return proxy
    },
  })
  return proxy
}

const SCHEMASTERy_STUB = `
const chainable = () => new Proxy(function () {}, {
  get(_t, p) {
    if (p === Symbol.toPrimitive) return () => 'schema'
    if (p === 'toString') return () => 'schema'
    if (p === 'then') return undefined
    return () => proxy
  },
  apply() { return proxy },
})
const proxy = chainable()
const Schema = {
  object: () => chainable(),
  string: () => chainable(),
  number: () => chainable(),
  boolean: () => chainable(),
  array: () => chainable(),
  union: () => chainable(),
  dict: () => chainable(),
}
export default Schema
export { Schema }
`

const TOOLS_STUB = `
/** Identity stand-in: the real defineTool only types and wraps the definition. */
export function defineTool(definition) { return definition }
export default { defineTool }
`

const CREDENTIALS_STUB = `
/** Identity stand-in: the real helper brands the reference name. */
export function credentialRef(name) { return name }
export default { credentialRef }
`

const STUBS = new Map([
  ['@deepseek-ai/schemastery', SCHEMASTERy_STUB],
  ['@deepseek-ai/dsh-tools', TOOLS_STUB],
  ['@deepseek-ai/dsh-credentials', CREDENTIALS_STUB],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBS.has(specifier)) return { url: `stub:${specifier}`, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith('stub:')) {
      return { format: 'module', source: STUBS.get(url.slice(5)), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

/** The stubbed specifier names, so a test can assert the hook is active. */
export const STUBBED_PACKAGES = [...STUBS.keys()]
