import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { RECHECK_EVENTS } from '@nexus/factory-domain/alerts/kinds'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../packages/factory-db/seed/roles'
import { seed as seedCompliance } from '../../../../../packages/factory-db/seed/compliance'
import { seed as seedHolds } from '../../../../../packages/factory-db/seed/holds'
import { seed as seedAlerts } from '../../../../../packages/factory-db/seed/alerts'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../core/command'
import type { Log } from '../../core/queue'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { systemContext } from '../outbox/system'
import { alertsRecheckHandler, runAlertEvaluation } from './engine'

/**
 * B-W2a-69 (follow-up of #976): the PO_NOT_CONFIRMED rule follows a purchase order's CURRENT confirm-by — the time B-W2a-52's
 * send asks the supplier to answer by, which the office may move — instead of counting the rule's days from the send. An
 * order sent without a confirm-by (before B-W2a-52) still waits the rule's days. Moving the deadline is checked again at once
 * (purchase_order.confirm_by_moved is a recheck event). On a throwaway PostgreSQL 17 database from the migrations, the
 * runtime login, the factory-db seeds; the engine runs as the scheduler and the worker would, on a clock the test moves.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/alerts/po-confirm-by`.
 */

let h: Harness

const NS = 'alerts-po-confirm-by'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const HOUR = 3_600_000
const DAY = 24 * HOUR

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
/** Moves test data past its own guards (the admin's session only), then back. */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}

let at = new Date()
const clock = { now: () => at }
const errors: string[] = []
const log: Log = { info: () => undefined, warn: () => undefined, error: (fields, message) => errors.push(`${message} ${JSON.stringify(fields)}`) }
const system = () => callerFor(h.database, systemContext(T, `test-${newId()}`))
const evaluate = () => runAlertEvaluation({ database: h.database, log, clock })
/** The unresolved PO_NOT_CONFIRMED alert of an order, or null. */
const openAlertOf = async (purchaseOrderId: string): Promise<Json | null> =>
  (await admin(`SELECT * FROM "Alert" WHERE "ruleKind" = 'PO_NOT_CONFIRMED' AND "recordId" = $1 AND state <> 'RESOLVED' ORDER BY occurrence DESC LIMIT 1`, [purchaseOrderId]))[0] ?? null
const sent = (id: string, sentAt: Date, confirmBy: Date | null) => force(`UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = $2, "confirmBy" = $3 WHERE id = $1`, [id, sentAt, confirmBy])

const ids = {} as { po1: string; po2: string }

beforeAll(async () => {
  h = await startHarness('alerts_po_confirm_by')
  at = new Date()
  h.clock.set(at)
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS })
  await seedHolds({ db: h.database, namespace: NS })
  await seedAlerts({ db: h.database, namespace: NS })
  const order = async (number: string) => (await one<{ id: string }>(`SELECT id FROM "PurchaseOrder" WHERE "tenantId" = $1 AND number = $2`, [T, number])).id
  ids.po1 = await order('SEED-PO-0001')
  ids.po2 = await order('SEED-PO-0002')
  // The seed's own alerts of this kind are not this test's.
  await force(`DELETE FROM "Alert" WHERE "tenantId" = $1 AND "ruleKind" = 'PO_NOT_CONFIRMED'`, [T])
}, 180_000)

afterAll(async () => {
  await h?.close()
})

describe('PO_NOT_CONFIRMED follows the order’s current confirm-by', () => {
  it('raises once the confirm-by passed, even before the rule’s days; not before it', async () => {
    // Sent a day ago (the rule's 2 days not reached), asked to answer within the next hour: nothing yet.
    await sent(ids.po1, new Date(at.getTime() - DAY), new Date(at.getTime() + HOUR))
    // A W1 order sent without a confirm-by a day ago: the rule's 2 days not reached either.
    await sent(ids.po2, new Date(at.getTime() - DAY), null)
    await evaluate()
    expect(errors).toEqual([])
    expect(await openAlertOf(ids.po1)).toBeNull()
    expect(await openAlertOf(ids.po2)).toBeNull()
    // Two hours later the confirm-by has passed: the buyer is told, a day after the send (the rule's days do not count).
    at = new Date(at.getTime() + 2 * HOUR)
    await evaluate()
    const alert = await openAlertOf(ids.po1)
    expect(alert).toMatchObject({ state: 'OPEN', recordLabel: 'SEED-PO-0001', companyId: companyA })
    expect(alert!.facts).toMatchObject({ days: 1, threshold: 2, confirmBy: new Date(at.getTime() - HOUR).toISOString() })
    expect(await openAlertOf(ids.po2)).toBeNull()
  })

  it('a confirm-by moved later clears the open alert at once (the recheck), and the order waits for the new time', async () => {
    expect(RECHECK_EVENTS).toContain('purchase_order.confirm_by_moved')
    const later = new Date(at.getTime() + 3 * DAY)
    await force(`UPDATE "PurchaseOrder" SET "confirmBy" = $2 WHERE id = $1`, [ids.po1, later])
    const handler = alertsRecheckHandler(clock)
    const event = {
      eventId: newId(),
      type: 'purchase_order.confirm_by_moved',
      version: 1,
      context: 'purchasing',
      tenantId: T,
      companyId: companyA,
      siteId: null,
      subject: ids.po1,
      correlationId: 'test',
      causationId: null,
      source: 'test',
      occurredAt: at.toISOString(),
      payload: { purchaseOrderId: ids.po1, number: 'SEED-PO-0001', confirmBy: later.toISOString() },
    }
    await handler.handle(event as never, { caller: system(), attempt: 1 })
    expect(await one(`SELECT state, resolution FROM "Alert" WHERE "ruleKind" = 'PO_NOT_CONFIRMED' AND "recordId" = $1 ORDER BY occurrence DESC LIMIT 1`, [ids.po1])).toEqual({ state: 'RESOLVED', resolution: 'CLEARED' })
    // Two more days: past the rule's days from the send, but not past the moved confirm-by: still nothing.
    at = new Date(at.getTime() + 2 * DAY)
    await evaluate()
    expect(await openAlertOf(ids.po1)).toBeNull()
    // The W1 order without a confirm-by is now past the rule's 2 days: its alert counts from the send.
    const w1 = await openAlertOf(ids.po2)
    expect(w1).toMatchObject({ state: 'OPEN', recordLabel: 'SEED-PO-0002' })
    expect(w1!.facts).toMatchObject({ days: 3, threshold: 2, confirmBy: null })
    // Past the moved time (and the rule's cooldown): the buyer is told again.
    at = new Date(later.getTime() + HOUR)
    await evaluate()
    expect(await openAlertOf(ids.po1)).toMatchObject({ state: 'OPEN', occurrence: 2 })
    expect(errors).toEqual([])
  })
})
