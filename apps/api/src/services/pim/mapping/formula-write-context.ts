import { AsyncLocalStorage } from 'node:async_hooks'
import type { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'

export interface FormulaWriteContext {
  productId: string
  writeField: string
  operations?: () => unknown[]
  results?: unknown[]
  run?: <T>(work: () => Promise<T>) => Promise<T>
  userId?: string | null
}

// Fastify injection crosses async-resource boundaries. A short-lived, unguessable handle carries
// the internal transaction work; HTTP payloads can never supply operations themselves.
const pending = new Map<string, FormulaWriteContext>()
export const currentFormulaWrite = (token: unknown) => typeof token === 'string' ? pending.get(token) : undefined
export const runFormulaWrite = <T>(token: unknown, work: () => Promise<T>) => currentFormulaWrite(token)?.run?.(work) ?? work()
export async function withFormulaWrite<T>(context: FormulaWriteContext, action: (token: string) => Promise<T>): Promise<T> {
  const token = randomUUID()
  pending.set(token, context)
  try { return await action(token) } finally { pending.delete(token) }
}

// Carry the caller's session through internal HTTP delegation; permission checks still run normally.
const requestHeaders = new AsyncLocalStorage<Record<string, string>>()
export const formulaRequestHeaders = () => requestHeaders.getStore() ?? {}
export const registerFormulaRequestContext: FastifyPluginAsync = async fastify => {
  fastify.addHook('onRequest', (request, _reply, done) => {
    const headers: Record<string, string> = {}
    for (const key of ['cookie', 'authorization', 'x-nexus-csrf']) {
      const value = request.headers[key]
      if (typeof value === 'string') headers[key] = value
    }
    // Re-enter the database transaction before authentication reads, including a one-connection pool.
    void runFormulaWrite(request.headers['x-nexus-formula-write'], async () => requestHeaders.run(headers, done)).catch(done)
  })
}
