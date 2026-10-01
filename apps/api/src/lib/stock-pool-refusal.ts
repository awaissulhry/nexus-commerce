/**
 * Shared stock by SKU, Owner D1 (2026-10-01): while a product shares stock with another business, neither
 * business may rename its SKU, delete it or move it — "Disconnect it first". The database refuses it
 * (stock-pool.sql, nexus_stock_pool_product_guard), whichever writer tries: the product studio, a bulk edit,
 * an import, a script. This turns that refusal into a 409 with the guard's own sentence, so the person reads
 * what to do instead of a database error. Every other error is left to the next handler exactly as it was.
 */
import type { FastifyInstance } from 'fastify'

// The guard's two sentences (stock-pool.sql); the SKU and the business name are in them.
const SENTENCE = /([^\n`"]*? (?:sells from the stock of|shares its stock with) [^\n`"]*? Disconnect it (?:first|there first)[^\n`"]*?, then change it\.)/

/** The guard's sentence when `error` (or one of its causes) carries it; otherwise null. */
export function stockPoolConnectedRefusal(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const message = current instanceof Error ? current.message : typeof current === 'string' ? current : ''
    const match = SENTENCE.exec(message)
    if (match) return match[1].replace(/^.*Message: /, '').trim()
    current = (current as { cause?: unknown }).cause
  }
  return null
}

/** Reply 409 with the sentence; anything else goes to the default handler unchanged. */
export function installStockPoolRefusalReplies(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const refusal = stockPoolConnectedRefusal(error)
    if (refusal) return reply.code(409).send({ error: refusal, code: 'stock_shared' })
    throw error
  })
}
