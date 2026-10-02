/**
 * MCP full control 08 S9 — a purchase order moves through its workflow exactly once, even when two people (or a person
 * and Claude's approved request) press the same button at the same moment. On a REAL multi-connection PostgreSQL.
 *
 * `transitionPo` read the status, then wrote the next one: two sends of one APPROVED PO both read APPROVED, both wrote
 * SUBMITTED, and both e-mailed the supplier. Now the write is a compare-and-set on the status it read: one wins and
 * e-mails once; the other is told the PO moved on (or, arriving after, finds it already sent).
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL (a throwaway Docker PostgreSQL); SKIPS without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))
const sent = vi.hoisted(() => ({ supplier: [] as string[], approver: [] as string[] }))
vi.mock('../po-supplier-email.service.js', () => ({
  sendPoToSupplier: vi.fn(async (poId: string) => {
    sent.supplier.push(poId)
    // A real send takes a moment (PDF, transport): long enough for a racing transition to land.
    await new Promise((resolve) => setTimeout(resolve, 50))
    return { ok: true, token: 'TEST-TOKEN', ackUrl: 'https://example.test/ack', emailDelivery: { sent: false, dryRun: true } }
  }),
}))
vi.mock('../po-approver-email.service.js', () => ({
  notifyApprover: vi.fn(async (poId: string) => {
    sent.approver.push(poId)
    return { ok: true, token: 'TEST-TOKEN', approveUrl: 'https://example.test/approve', emailDelivery: { sent: false, dryRun: true } }
  }),
}))

const WS = 'nexus_legacy_workspace'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inBusiness = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe.skipIf(!serverUrl)(`08 S9 — one PO transition at a time (needs ${CONCURRENT_PG_ENV})`, () => {
  let workflow: typeof import('../po-workflow.service.js')
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
  const po = async (status: string) => {
    const id = randomUUID()
    await q(`INSERT INTO "PurchaseOrder" (id, "workspaceId", "poNumber", status, "totalCents", "currencyCode", "updatedAt") VALUES ($1,$2,$3,$4,1000,'EUR',now())`, [id, WS, `TEST-PO-${id.slice(0, 6)}`, status])
    return id
  }
  const row = async (id: string) => (await q<{ status: string; version: number }>(`SELECT status, version FROM "PurchaseOrder" WHERE id = $1`, [id]))[0]

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 16 })
    workflow = await import('../po-workflow.service.js')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  it('CONTROL — one send: SUBMITTED, one supplier e-mail, the version moves once', async () => {
    const id = await po('APPROVED')
    sent.supplier.length = 0
    await inBusiness(() => workflow.transitionPo({ poId: id, transition: 'send', userId: 'u-approver' }))
    expect(await row(id)).toEqual({ status: 'SUBMITTED', version: 2 })
    expect(sent.supplier).toEqual([id])
  }, 60_000)

  it('P1 — five sends of one APPROVED PO at the same moment: one SUBMITTED, exactly one supplier e-mail', async () => {
    const id = await po('APPROVED')
    sent.supplier.length = 0
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => inBusiness(() => workflow.transitionPo({ poId: id, transition: 'send', userId: 'u-approver' }))))
    expect(await row(id)).toEqual({ status: 'SUBMITTED', version: 2 })
    expect(sent.supplier).toEqual([id])
    // The others are told the PO moved on, or find it already sent; none fails any other way.
    for (const r of results) if (r.status === 'rejected') expect(String((r.reason as Error).message)).toMatch(/not allowed|moved on/i)
  }, 60_000)

  it('P2 — a cancel and a send racing on one APPROVED PO: exactly one of them happens', async () => {
    const id = await po('APPROVED')
    sent.supplier.length = 0
    await Promise.allSettled([
      inBusiness(() => workflow.transitionPo({ poId: id, transition: 'send', userId: 'u-approver' })),
      inBusiness(() => workflow.transitionPo({ poId: id, transition: 'cancel', userId: 'u-other', cancelReason: 'TEST race' })),
    ])
    const after = await row(id)
    expect(['SUBMITTED', 'CANCELLED']).toContain(after.status)
    expect(after.version).toBe(2)
    expect(sent.supplier.length).toBe(after.status === 'SUBMITTED' ? 1 : 0)
  }, 60_000)
})
