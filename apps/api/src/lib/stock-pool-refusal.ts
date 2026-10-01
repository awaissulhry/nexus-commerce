/**
 * Shared stock by SKU, Owner D1 (2026-10-01): while a product shares stock with another business, neither
 * business may rename its SKU, delete it or move it — "Disconnect it first". The database refuses it
 * (stock-pool.sql, nexus_stock_pool_product_guard), whichever writer tries: the product studio, a bulk edit,
 * an import, a script. The same for a fixed number on a listing of a product that sells from another business's
 * stock (nexus_stock_pool_quantity_guard: its quantity is changed only in the lender). This turns those refusals
 * into a 409 with the guard's own sentence, so the person reads what to do instead of a database error. Every
 * other error is left to the next handler exactly as it was.
 */
import type { FastifyInstance } from 'fastify'

// The guards' three sentences (stock-pool.sql); the SKU and the business name are in them.
const SENTENCE = /([^\n`"]*? (?:(?:sells from the stock of|shares its stock with) [^\n`"]*? Disconnect it (?:first|there first)[^\n`"]*?, then change it\.|sells from the stock of [^\n`"]*?, so its quantity follows that stock\. Change the stock in [^\n`"]*?, or disconnect it first \(Matrix, Stock source\)\.))/

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

/**
 * Reply 409 with the sentence, both ways a route can end: it throws (the error handler), or it catches and
 * answers 5xx with the error's text itself, as many routes do (the onSend hook rewrites only such a reply, and
 * only when it carries the guard's sentence). Anything else goes on unchanged.
 */
export function installStockPoolRefusalReplies(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const refusal = stockPoolConnectedRefusal(error)
    if (refusal) return reply.code(409).send({ error: refusal, code: 'stock_shared' })
    throw error
  })
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode < 500 || typeof payload !== 'string') return payload
    const refusal = stockPoolConnectedRefusal(payload)
    if (!refusal) return payload
    reply.code(409).header('content-type', 'application/json; charset=utf-8')
    return JSON.stringify({ error: refusal, code: 'stock_shared' })
  })
}
