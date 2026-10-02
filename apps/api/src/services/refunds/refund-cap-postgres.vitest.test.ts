import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The refund cap holds under a race (MCP full control 07, lead ruling 2026-10-02), on a REAL PostgreSQL as the
 * restricted runtime login with row security on, as production runs.
 *
 * A refund may not exceed what is still refundable on its order: what the order paid less the active refunds of ALL
 * its returns. The database's Refund_oneActivePerReturn index keeps one refund per RETURN, but two returns of one order
 * are two rows: two refunds at the same moment both read "nothing refunded yet" and both pass. The fix locks the order
 * row (SELECT … FOR UPDATE) for the check and the Refund insert, in one transaction.
 *
 * The race is FORCED, not hoped for: a third connection holds a SHARE lock on "Refund", so no refund row can be
 * written until both callers are blocked (before the fix: both on the insert, each having read the same total; after
 * it: the first on the insert, the second on the order's row lock). Then the lock goes. Every id and name is invented.
 *
 * Run: node scripts/run-real-postgres-tests.mjs (it starts a throwaway PostgreSQL 17 and sets NEXUS_TEST_CONCURRENT_PG_URL).
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`refund-cap-postgres: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../credit-note.service.js', () => ({ assignCreditNoteNumber: vi.fn(async () => null) }))
vi.mock('../audit-log.service.js', () => ({ auditLogService: { write: vi.fn(async () => undefined) } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { issueRefund } from './issue-refund.service.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const log = { warn: () => undefined, error: () => undefined }
const who = { userId: null, ip: null }
const returns: string[] = []
let orderId = ''

/** Runs `calls` at once; nothing can write a Refund until every call is blocked on a lock. */
async function forcedRace<T>(calls: Array<() => Promise<T>>): Promise<T[]> {
  const locker = await state.db.pool.connect()
  let running: Array<Promise<{ value: T } | { error: unknown }>> = []
  let released = false
  try {
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE "Refund" IN SHARE MODE')
    running = calls.map(call => scoped(call).then(value => ({ value }), error => ({ error })))
    let waiting = 0
    const deadline = Date.now() + 40_000
    while (waiting < calls.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      const { rows } = await state.db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [state.db.name])
      waiting = rows[0].n
    }
    const forced = waiting === calls.length
    await locker.query(forced ? 'COMMIT' : 'ROLLBACK')
    released = true
    const settled = await Promise.all(running)
    if (!forced) throw new Error(`The race was not forced: ${waiting} of ${calls.length} refunds were blocked before the lock was released.`)
    for (const outcome of settled) if ('error' in outcome) throw outcome.error
    return settled.map(outcome => (outcome as { value: T }).value)
  } finally {
    if (!released) {
      await locker.query('ROLLBACK').catch(() => undefined)
      await Promise.all(running)
    }
    locker.release()
  }
}

describe.skipIf(!concurrentDatabaseUrl())(`refund cap under a race (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => {
    state.db = await concurrentDatabase()
    await scoped(async () => {
      const order = await prisma.order.create({ data: {
        channel: 'EBAY', channelOrderId: 'TEST-CAP-RACE', marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '100.00',
        customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, purchaseDate: new Date(),
      } as never })
      orderId = order.id
      for (const key of ['A', 'B', 'C']) {
        returns.push((await prisma.return.create({ data: { orderId, channel: 'EBAY', rmaNumber: `TEST-CAP-RMA-${key}`, status: 'RECEIVED' } as never })).id)
      }
    })
  }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)

  it('two refunds of 60.00 on two returns of a 100.00 order at the same moment: one goes through, the other is refused', async () => {
    const answers = await forcedRace(returns.slice(0, 2).map((id) => () => issueRefund(id, { refundCents: 6000, skipChannelPush: true }, null, who, log)))
    expect(answers.map((a) => a.status).sort()).toEqual([200, 400])
    expect(answers.find((a) => a.status === 400)!.body).toMatchObject({ code: 'OVER_REFUNDABLE', refundableCents: 4000 })
    const { rows } = await state.db.pool.query(`SELECT COALESCE(SUM(f."amountCents"), 0)::int AS total, count(*)::int AS n FROM "Refund" f JOIN "Return" r ON r.id = f."returnId" WHERE r."orderId" = $1`, [orderId])
    expect(rows[0]).toEqual({ total: 6000, n: 1 })
  }, 60_000)

  it('what is left can still be refunded, and no more', async () => {
    expect((await scoped(() => issueRefund(returns[2], { refundCents: 4001, skipChannelPush: true }, null, who, log))).status).toBe(400)
    expect((await scoped(() => issueRefund(returns[2], { refundCents: 4000, skipChannelPush: true }, null, who, log))).status).toBe(200)
  }, 60_000)
})
