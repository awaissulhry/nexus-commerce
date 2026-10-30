import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedReturns, type ReturnsSeed } from '../../../../../../packages/factory-db/seed/returns'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Customer returns (B-W2a-43; SAL-333, SAL-335, SAL-340, SAL-341, SAL-352, SAL-362, LOG-114, QHS-117) on the local stack:
 * a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the floor's column
 * grants and the …_sales_w2a_guards triggers are real), the real app with test sessions, the files platform on its
 * FAKE R2 (a local file store). One made-up tenant from the factory-db seeds up to returns, reasons and the finished-goods
 * place: P1 was invoiced two sample jackets on FT-2026-00001 (SEED-RMA-0001 takes one back), and SEED-SO-0002's SH-0001
 * shipped one BLK 50 (SEED-RMA-0002 took it back, INSPECTED) and one RED 52 of SEED-JKT-02 (a PPE garment, 400.00); the
 * return policy is 30 / 15 days, BY_CAUSE. Every name, price and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/returns`.
 */

let h: Harness
let app: FastifyInstance
let seeded: ReturnsSeed

const NS = 'w2a43-returns-a'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const siteA = idIn('site:A1')
const P1 = idIn('party:P1')
const RED_LINE = idIn('production:sales-order:SO-0002:20')
const BLK_LINE = idIn('production:sales-order:SO-0002:10')
const SAMPLE_LINE = idIn('money:line:FT-2026-00001:1')
const TODAY = businessDate(new Date())
const YEAR = TODAY.slice(0, 4)

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const key = (label = 'k'): string => `returns-${label}-${++counter}-${newId()}`
const sha = (body: Buffer): string => createHash('sha256').update(body).digest('hex')

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[], actorId = newId()): (() => SessionContext) => () => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions)] })
const SALES: Permission[] = ['sales.returns.view', 'sales.returns.manage', 'sales.returns.decide', 'sales.returns.receive', 'sales.returns.inspect', 'orders.view', 'orders.manage', 'files.upload', 'files.read', 'money.price']
const OTHER_SITE = newId()
const floorSession = (siteId: string, permissions: Permission[]) => () => ({ audience: 'floor' as const, tenantId: T, actorId: newId(), siteId, deviceId: newId(), grants: [{ permissions: ['floor.work' as Permission, ...permissions], companies: [companyA], sites: [siteId], parties: 'all' as const }] })
const SESSIONS: Record<string, () => SessionContext> = {
  sales: office(SALES),
  noPrice: office(SALES.filter((permission) => permission !== 'money.price')),
  viewer: office(['sales.returns.view']),
  settings: office(['sales.returns.view', 'sales.settings.manage']),
  dock: floorSession(siteA, ['sales.returns.receive', 'sales.returns.inspect']),
  dockElsewhere: floorSession(OTHER_SITE, ['sales.returns.receive', 'sales.returns.inspect']),
  dockReceiveOnly: floorSession(siteA, ['sales.returns.receive']),
}

async function call(session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, idempotencyKey = key(session)) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': idempotencyKey }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body.error
}
const events = (type: string, subject: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])
const recordOf = async (returnId: string, session = 'sales') => (await ok(session, 'GET', `/sales/returns/${returnId}`)).return

async function photo(session: string, url: string, name: string): Promise<Json> {
  const body = Buffer.from(`made-up jpeg bytes ${name} ${newId()}`)
  const announced = await ok(session, 'POST', url, { originalName: name, contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha(body) }, 201)
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  return (await ok(session, 'POST', `${url}/${announced.file.id}/complete`)).file
}

beforeAll(async () => {
  h = await startHarness('sales_returns')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  seeded = await seedReturns({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedSchedule({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the return policy (design ssettings.returns)', () => {
  it('reads the tenant’s policy in force and keeps it with the sales settings’ permission', async () => {
    const read = await ok('viewer', 'GET', `/sales/returns/policy?companyId=${companyA}`)
    expect(read.policy).toMatchObject({ inForce: { windowDays: 30, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE', restockingFeePct: '10' }, followsTenant: true, canManage: false })
    const tenant = read.policy.tenant
    const saved = await ok('settings', 'PUT', '/sales/returns/policy', { version: tenant.version, windowDays: 30, goodsDueDays: 20, freightPaidBy: 'BY_CAUSE', restockingFeePct: '10', conditions: tenant.conditions })
    expect(saved.policy).toMatchObject({ goodsDueDays: 20, version: tenant.version + 1 })
    expect((await events('return_policy.changed', saved.policy.id)).at(-1)?.payload).toEqual({ companyId: null, fields: ['goodsDueDays'] })
    // A company that follows the tenant's sales settings is changed there; a stale version and a bad range are refused.
    expect((await refused('settings', 'PUT', '/sales/returns/policy', { companyId: companyA, windowDays: 14, goodsDueDays: 10, freightPaidBy: null, restockingFeePct: null, conditions: null }, 400)).issues).toEqual([{ path: 'body/companyId', message: 'No sales settings of its own.' }])
    expect((await refused('settings', 'PUT', '/sales/returns/policy', { version: tenant.version, windowDays: 30, goodsDueDays: 20, freightPaidBy: null, restockingFeePct: null, conditions: null }, 409)).code).toBe('conflict')
    expect((await refused('viewer', 'PUT', '/sales/returns/policy', { windowDays: 30, goodsDueDays: 20, freightPaidBy: null, restockingFeePct: null, conditions: null }, 403)).code).toBe('forbidden')
  })
})

let rma1: Json
let rma2: Json

describe('an RMA from what the customer was invoiced or shipped (SAL-333, SAL-335, SAL-340)', () => {
  it('lists what may come back: sold, already on other returns, left', async () => {
    const { lines } = await ok('sales', 'GET', `/sales/returns/returnable?companyId=${companyA}&partyId=${P1}`)
    const sample = lines.find((line: Json) => line.invoiceLineId === SAMPLE_LINE)
    expect(sample).toMatchObject({ kind: 'INVOICED', sold: 2, taken: 1, left: 1, unitPrice: '250', pieceValue: 25_000, ppe: false })
    const red = lines.find((line: Json) => line.salesOrderLineId === RED_LINE)
    expect(red).toMatchObject({ kind: 'SHIPPED', size: '52', sold: 1, taken: 0, left: 1, ppe: true, batchNumbers: ['SEED-BT-0001'], siteId: siteA, pieceValue: 40_000 })
    expect(lines.find((line: Json) => line.salesOrderLineId === BLK_LINE && line.size === '50')).toMatchObject({ sold: 1, taken: 1, left: 0 })
    // Prices only with the price grain.
    const blind = (await ok('noPrice', 'GET', `/sales/returns/returnable?companyId=${companyA}&partyId=${P1}`)).lines.find((line: Json) => line.salesOrderLineId === RED_LINE)
    expect(blind).not.toHaveProperty('unitPrice')
    expect(blind).not.toHaveProperty('pieceValue')
  })

  it('refuses more than was sold, with the sold number, at the cell', async () => {
    const body = { companyId: companyA, partyId: P1, lines: [{ salesOrderLineId: RED_LINE, size: '52', quantity: 2, reasonCode: 'DEFECT' }] }
    const preview = await ok('sales', 'POST', '/sales/returns/preview', body)
    expect(preview).toMatchObject({ ok: false, problems: [{ path: 'body/lines/0/quantity', message: 'At most 1 can come back: 1 sold.' }] })
    expect((await refused('sales', 'POST', '/sales/returns', body, 409)).issues).toEqual([{ path: 'body/lines/0/quantity', message: 'At most 1 can come back: 1 sold.' }])
    const taken = await refused('sales', 'POST', '/sales/returns', { companyId: companyA, partyId: P1, lines: [{ salesOrderLineId: BLK_LINE, size: '50', quantity: 1, reasonCode: 'DEFECT' }] }, 409)
    expect(taken.message).toBe('Nothing of it can come back: 1 sold, 1 already on other returns.')
    expect((await refused('sales', 'POST', '/sales/returns', { companyId: companyA, partyId: P1, lines: [{ salesOrderLineId: RED_LINE, size: '52', quantity: 1, reasonCode: 'NOT_A_REASON' }] }, 400)).issues).toEqual([{ path: 'body/lines/0/reasonCode', message: 'Pick an active reason of the return list.' }])
    expect((await refused('sales', 'POST', '/sales/returns', { companyId: companyA, partyId: P1, lines: [{ salesOrderLineId: RED_LINE, size: '52', quantity: 1, reasonCode: 'OTHER' }] }, 400)).issues).toEqual([{ path: 'body/lines/0/reasonNote', message: 'Other needs a note: say what is wrong.' }])
    expect((await refused('viewer', 'POST', '/sales/returns', body, 403)).code).toBe('forbidden')
  })

  it('makes it AUTHORISED and numbered, due by the policy, and opens the PPE register entry of a protective garment returned for a defect', async () => {
    const body = { companyId: companyA, partyId: P1, customerRef: 'P1-RET-9', lines: [{ salesOrderLineId: RED_LINE, size: '52', quantity: 1, reasonCode: 'DEFECT', reasonNote: 'The zip pulled out of the seam.' }] }
    const idem = key('create')
    const first = await call('sales', 'POST', '/sales/returns', body, idem)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    rma1 = first.body.return
    expect(rma1).toMatchObject({ number: `RMA-${YEAR}-0001`, status: 'AUTHORISED', siteId: siteA, goodsDueBy: addDays(TODAY, 20), salesOrder: { number: 'SEED-SO-0002' }, customerRef: 'P1-RET-9', version: 1 })
    expect(rma1.lines).toMatchObject([{ seq: 10, size: '52', quantity: 1, ppe: true, safety: true, batchNumber: 'SEED-BT-0001', unitPrice: '400', reason: { code: 'DEFECT', labelEn: 'Defect' } }])
    expect(rma1.tracking.map((row: Json) => [row.step, row.state])).toEqual([['REQUESTED', 'DONE'], ['AUTHORISED', 'DONE'], ['GOODS_BACK', 'CURRENT'], ['INSPECTED', 'WAITING'], ['OUTCOME', 'WAITING']])
    expect(first.body.registerEntries).toMatchObject([{ seq: 10, opened: true }])
    const [entry] = await admin(`SELECT kind, "sourceType", "partyId", "styleId" FROM "PpeRegisterEntry" WHERE id = $1`, [first.body.registerEntries[0].entryId])
    expect(entry).toMatchObject({ kind: 'COMPLAINT', sourceType: 'Shipment', partyId: P1 })
    // The same key answers the same RMA; the next one takes nothing more.
    expect((await call('sales', 'POST', '/sales/returns', body, idem)).body.return.id).toBe(rma1.id)
    expect((await refused('sales', 'POST', '/sales/returns', body, 409)).message).toBe('Nothing of it can come back: 1 sold, 1 already on other returns.')
    expect((await events('return.authorised', rma1.id))[0]?.payload).toMatchObject({ number: rma1.number, partyId: P1, lineIds: [rma1.lines[0].id], goodsDueBy: addDays(TODAY, 20) })
    expect(await admin(`SELECT "recordType" FROM "NumberAllocation" WHERE "recordId" = $1`, [rma1.id])).toEqual([{ recordType: 'ReturnAuthorisation' }])
  })

  it('changes what comes back only before the goods arrive, never above sold, never the last line', async () => {
    const made = await ok('sales', 'POST', '/sales/returns', { companyId: companyA, partyId: P1, siteId: siteA, lines: [{ invoiceLineId: SAMPLE_LINE, quantity: 1, reasonCode: 'WRONG_ITEM' }] }, 201)
    rma2 = made.return
    const line = rma2.lines[0]
    expect(line).toMatchObject({ invoice: { number: 'FT-2026-00001' }, ppe: false, receivedValue: 0 })
    expect((await refused('sales', 'PATCH', `/sales/returns/${rma2.id}/lines/${line.id}`, { version: rma2.version, quantity: 2 }, 409)).issues).toEqual([{ path: 'body/quantity', message: 'At most 1 can come back: 2 sold, 1 already on other returns.' }])
    const changed = await ok('sales', 'PATCH', `/sales/returns/${rma2.id}/lines/${line.id}`, { version: rma2.version, reasonCode: 'WRONG_SIZE', serial: 'S-0042' })
    expect(changed.return.lines[0]).toMatchObject({ reasonCode: 'WRONG_SIZE', serial: 'S-0042' })
    expect(changed.return.version).toBe(rma2.version + 1)
    expect((await refused('sales', 'PATCH', `/sales/returns/${rma2.id}/lines/${line.id}`, { version: rma2.version, reasonCode: 'DEFECT' }, 409)).code).toBe('conflict')
    expect((await refused('sales', 'DELETE', `/sales/returns/${rma2.id}/lines/${line.id}?version=${changed.return.version}`, undefined, 409)).message).toBe("Line 10 is the return's only line: cancel the return instead.")
    rma2 = changed.return
  })
})

describe('the dock: find, receive with photos, grade (LOG-114, QHS-117)', () => {
  it('finds the open RMA by its number at the device’s site only, in the design’s words', async () => {
    const found = await ok('dock', 'GET', `/sales/returns/dock?code=${encodeURIComponent(rma1.number.toLowerCase())}`)
    expect(found.return).toMatchObject({ id: rma1.id, status: 'AUTHORISED', lines: [{ seq: 10, expected: 1, receivedQuantity: 0, ppe: true }], places: { inspection: { code: 'A1-QUA' }, finishedGoods: { code: 'A1-FG' } } })
    expect(JSON.stringify(found)).not.toMatch(/unitPrice|creditAmount|discountPct|internalNote/)
    expect((await refused('dockElsewhere', 'GET', `/sales/returns/dock?code=${rma1.number}`, undefined, 404)).message).toBe('No open return with this code. Put the parcel aside and tell customer service.')
    expect((await refused('dock', 'GET', '/sales/returns/dock?code=RMA-NOPE', undefined, 404)).message).toBe('No open return with this code. Put the parcel aside and tell customer service.')
  })

  it('records the receipt and the pieces on the tablet, and refuses more than the line expects', async () => {
    const received = await ok('dock', 'POST', `/sales/returns/${rma1.id}/receipts`, { version: rma1.version, parcels: 1, parcelCondition: 'DAMAGED', carrierName: 'Made-up Express', customerDdtNumber: 'P1-DDT-77', customerDdtDate: TODAY, lines: [{ lineId: rma1.lines[0].id, quantity: 1 }] }, 201)
    expect(received.return).toMatchObject({ status: 'RECEIVED', lines: [{ receivedQuantity: 1, expected: 0, place: 'A1-QUA' }], receipts: [{ parcels: 1, parcelCondition: 'DAMAGED', customerDdtNumber: 'P1-DDT-77' }] })
    const [receipt] = await admin(`SELECT "requestId", "createdById" FROM "ReturnReceipt" WHERE id = $1`, [received.receiptId])
    expect(receipt?.requestId).toBeTruthy()
    expect((await events('return.received', rma1.id))[0]?.payload).toMatchObject({ receiptId: received.receiptId, pieces: 1, first: true })
    expect((await events('return.status_changed', rma1.id))[0]?.payload).toMatchObject({ from: 'AUTHORISED', to: 'RECEIVED' })
    const again = await refused('dock', 'POST', `/sales/returns/${rma1.id}/receipts`, { version: received.return.version, parcels: 1, parcelCondition: 'INTACT', lines: [{ lineId: rma1.lines[0].id, quantity: 1 }] }, 400)
    expect(again.message).toBe('Every piece of line 10 arrived already.')
    // The parcel's photo from the tablet (OFFICE + FLOOR at the site), and the garment's.
    const file = await photo('dock', `/sales/returns/${rma1.id}/receipts/${received.receiptId}/photos`, 'parcel.jpg')
    expect(file).toMatchObject({ status: 'AVAILABLE', kind: 'PHOTO' })
    const [stored] = await admin(`SELECT visibility::text[] AS visibility, "floorSiteId", "recordType" FROM "StoredFile" WHERE id = $1`, [file.id])
    expect(stored).toEqual({ visibility: ['OFFICE', 'FLOOR'], floorSiteId: siteA, recordType: 'ReturnReceipt' })
    await photo('dock', `/sales/returns/${rma1.id}/lines/${rma1.lines[0].id}/photos`, 'zip.jpg')
    await refused('dockReceiveOnly', 'POST', `/sales/returns/${rma1.id}/lines/${rma1.lines[0].id}/photos`, { originalName: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 3, sha256: 'a'.repeat(64) }, 403)
  })

  it('grades the garment: the suggested outcome and why it is held from restock', async () => {
    const current = (await ok('dock', 'GET', `/sales/returns/${rma1.id}/dock`)).return
    const graded = await ok('dock', 'POST', `/sales/returns/${rma1.id}/grades`, { version: current.version, lines: [{ lineId: rma1.lines[0].id, grade: 'DAMAGED', cause: 'OUR_DEFECT', conditionNote: 'Zip tape torn out of the left front seam.' }] })
    expect(graded.return.lines[0]).toMatchObject({ grade: 'DAMAGED', cause: 'OUR_DEFECT', suggestedOutcome: 'REPAIR', photos: 1, restockHeld: expect.stringMatching(/safety check/) })
    const [line] = await admin(`SELECT "inspectedById", "inspectedAt" FROM "ReturnLine" WHERE id = $1`, [rma1.lines[0].id])
    expect(line?.inspectedById).toBeTruthy()
    expect((await events('return.graded', rma1.id)).length).toBe(1)
    // The floor decides nothing.
    expect((await refused('dock', 'POST', `/sales/returns/${rma1.id}/decisions`, { version: graded.return.version, lines: [{ lineId: rma1.lines[0].id, disposition: 'REPAIR' }] }, 403)).code).toBe('forbidden')
  })
})

describe('the decision: money, stock and work in one step (SAL-341), the replacement order (SAL-352)', () => {
  it('previews each line: the effect in words, every disposition with its held outcomes', async () => {
    const record = await recordOf(rma1.id)
    const preview = await ok('sales', 'POST', `/sales/returns/${rma1.id}/decisions/preview`, { lines: [{ lineId: record.lines[0].id, disposition: 'REPLACE', goodsOutcome: 'SECOND_QUALITY' }] })
    expect(preview.ok).toBe(false)
    expect(preview.lines[0].problems.map((problem: Json) => problem.path)).toEqual(expect.arrayContaining(['body/lines/0/goodsOutcome']))
    const replace = preview.lines[0].options.find((option: Json) => option.disposition === 'REPLACE')
    expect(replace.outcomes.find((entry: Json) => entry.outcome === 'QUARANTINE').held).toBeNull()
    expect(replace.outcomes.find((entry: Json) => entry.outcome === 'RESTOCK').held).toMatch(/safety check/)
    expect(preview.lines[0].options.map((option: Json) => option.disposition)).not.toContain('REMAKE')
  })

  it('decides REPLACE with the goods to quarantine: the stock move, INSPECTED, then the replacement order', async () => {
    const record = await recordOf(rma1.id)
    const decided = await ok('sales', 'POST', `/sales/returns/${rma1.id}/decisions`, { version: record.version, lines: [{ lineId: record.lines[0].id, disposition: 'REPLACE', goodsOutcome: 'QUARANTINE' }] })
    expect(decided.return).toMatchObject({ status: 'INSPECTED', lines: [{ disposition: 'REPLACE', goodsOutcome: 'QUARANTINE', creditAmount: 0, followUp: 'REPLACEMENT_ORDER', stock: [{ locationCode: 'A1-QUA', quantity: '1' }] }] })
    expect(decided.return.lines[0].effect).toBe('No credit; goods are held in quarantine at A1-QUA; on the replacement order')
    const [move] = await admin(`SELECT m.reason, m.quantity::text, m.reference, i.code, i.kind FROM "StockMove" m JOIN "Item" i ON i.id = m."itemId" WHERE m.id = $1`, [decided.moves[0].moveId])
    expect(move).toEqual({ reason: 'ADJUSTMENT', quantity: '1.0000', reference: rma1.number, code: 'SEED-JKT-02-RED-52', kind: 'FINISHED' })
    expect((await events('return.decided', rma1.id))[0]?.payload).toMatchObject({ inspected: true, moveIds: [decided.moves[0].moveId] })
    expect(await events('return.credit_due', rma1.id)).toEqual([])
    // Decided lines are final; closing waits for nothing but says what the outcome still lacks.
    expect((await refused('sales', 'POST', `/sales/returns/${rma1.id}/decisions`, { version: decided.return.version, lines: [{ lineId: record.lines[0].id, disposition: 'SCRAP' }] }, 400)).issues[0].message).toBe('Line 10 is decided already (REPLACE).')

    const made = await ok('sales', 'POST', `/sales/returns/${rma1.id}/replacement-order`, { version: decided.return.version }, 201)
    expect(made.order.number).toBe(`SO-${YEAR}-0001`)
    expect(made.return).toMatchObject({ replacementOrder: { id: made.order.id, number: made.order.number, status: 'CONFIRMED' } })
    const [orderLine] = await admin(`SELECT l.quantity, l."unitPrice"::text AS "unitPrice", l.description, o."customerRef", o."depositRequired" FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE l.id = $1`, [made.return.lines[0].replacementLineId])
    expect(orderLine).toMatchObject({ quantity: 1, unitPrice: '0.000000', customerRef: rma1.number, depositRequired: false })
    expect(orderLine?.description).toMatch(new RegExp(`^Replacement for ${rma1.number} line 10`))
    expect((await events('return.replacement_ordered', rma1.id))[0]?.payload).toMatchObject({ orderId: made.order.id, orderNumber: made.order.number })
    expect((await refused('sales', 'POST', `/sales/returns/${rma1.id}/replacement-order`, { version: made.return.version }, 409)).message).toBe(`Return ${rma1.number} has its replacement order already.`)

    const closed = await ok('sales', 'POST', `/sales/returns/${rma1.id}/close`, { version: made.return.version, reason: 'Replaced; the torn jacket waits in quarantine for the NCR.' })
    expect(closed).toMatchObject({ return: { status: 'CLOSED', statusReason: 'Replaced; the torn jacket waits in quarantine for the NCR.' }, warnings: [] })
    expect(closed.return.tracking.at(-1)).toMatchObject({ step: 'OUTCOME', state: 'DONE' })
  })

  it('credits a line with no style only to scrap or repair, and emits the credit due', async () => {
    const received = await ok('sales', 'POST', `/sales/returns/${rma2.id}/receipts`, { version: rma2.version, parcels: 1, parcelCondition: 'INTACT', lines: [{ lineId: rma2.lines[0].id, quantity: 1 }] }, 201)
    const graded = await ok('sales', 'POST', `/sales/returns/${rma2.id}/grades`, { version: received.return.version, lines: [{ lineId: rma2.lines[0].id, grade: 'NEW', cause: 'NO_FAULT' }] })
    const stock = await refused('sales', 'POST', `/sales/returns/${rma2.id}/decisions`, { version: graded.return.version, lines: [{ lineId: rma2.lines[0].id, disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK' }] }, 400)
    expect(stock.issues).toEqual([{ path: 'body/lines/0/goodsOutcome', message: 'Line 10 names no style, colour and size, so it cannot go into stock: repair, scrap or send it back.' }])
    expect((await refused('sales', 'POST', `/sales/returns/${rma2.id}/decisions`, { version: graded.return.version, lines: [{ lineId: rma2.lines[0].id, disposition: 'CREDIT_ONLY', goodsOutcome: 'SCRAP', creditAmount: 25_001 }] }, 400)).issues).toEqual([{ path: 'body/lines/0/creditAmount', message: 'Never more than what came back is worth.' }])
    // A caller without the price grain cannot send a credit value.
    await refused('noPrice', 'POST', `/sales/returns/${rma2.id}/decisions`, { version: graded.return.version, lines: [{ lineId: rma2.lines[0].id, disposition: 'CREDIT_ONLY', goodsOutcome: 'SCRAP', creditAmount: 100 }] }, 403)
    const decided = await ok('sales', 'POST', `/sales/returns/${rma2.id}/decisions`, { version: graded.return.version, lines: [{ lineId: rma2.lines[0].id, disposition: 'CREDIT_ONLY', goodsOutcome: 'SCRAP' }] })
    expect(decided.return).toMatchObject({ status: 'INSPECTED', creditTotal: 25_000, lines: [{ creditAmount: 25_000, receivedValue: 25_000, followUp: 'CREDIT_NOTE', stock: [], effectWithAmount: 'Credit 250.00 EUR; goods are scrapped; a credit note to make (Finance)' }] })
    expect((await events('return.credit_due', rma2.id))[0]?.payload).toEqual({ returnId: rma2.id, number: rma2.number, partyId: P1, lineIds: [rma2.lines[0].id] })
    // Without the price grain the record shows the effect without its amount.
    const blind = await recordOf(rma2.id, 'noPrice')
    expect(blind).not.toHaveProperty('creditTotal')
    expect(blind.lines[0]).not.toHaveProperty('creditAmount')
    expect(blind.lines[0].effect).toBe('A credit; goods are scrapped; a credit note to make (Finance)')
  })
})

describe('status, cancel, close and the list (SAL-362)', () => {
  it('cancels an RMA before the goods arrive (its pieces free again) and refuses to cancel one whose goods came', async () => {
    const waiting = await recordOf(seeded.waitingReturnId)
    const cancelled = await ok('sales', 'POST', `/sales/returns/${waiting.id}/cancel`, { version: waiting.version, reason: 'The customer kept the jacket.' })
    expect(cancelled.return).toMatchObject({ status: 'CANCELLED', statusReason: 'The customer kept the jacket.' })
    const sample = (await ok('sales', 'GET', `/sales/returns/returnable?companyId=${companyA}&partyId=${P1}`)).lines.find((line: Json) => line.invoiceLineId === SAMPLE_LINE)
    expect(sample).toMatchObject({ sold: 2, taken: 1, left: 1 })
    const inspected = await recordOf(rma2.id)
    expect((await refused('sales', 'POST', `/sales/returns/${rma2.id}/cancel`, { version: inspected.version, reason: 'x' }, 409)).message).toMatch(/inspected: it is cancelled \(the goods arrived: close it instead\)/)
  })

  it('closes only once every received line is decided, with its finish reason', async () => {
    // A third return of the sample piece freed by the cancel: received, not decided.
    const made = await ok('sales', 'POST', `/sales/returns`, { companyId: companyA, partyId: P1, siteId: siteA, lines: [{ invoiceLineId: SAMPLE_LINE, quantity: 1, reasonCode: 'WRONG_SIZE' }] }, 201)
    const received = await ok('sales', 'POST', `/sales/returns/${made.return.id}/receipts`, { version: made.return.version, parcels: 1, parcelCondition: 'OPENED', lines: [{ lineId: made.return.lines[0].id, quantity: 1 }] }, 201)
    expect((await refused('sales', 'POST', `/sales/returns/${made.return.id}/close`, { version: received.return.version, reason: 'Done.' }, 409)).message).toBe('Decide every received line first (line 10).')
    expect((await refused('sales', 'POST', `/sales/returns/${made.return.id}/close`, { version: received.return.version, reason: ' ' }, 400)).issues[0].path).toBe('body/reason')
    const record = await recordOf(made.return.id)
    expect(record.actions.find((entry: Json) => entry.action === 'close')).toEqual({ action: 'close', allowed: false, held: 'Decide the 1 received line(s) first.' })
    expect(record.statusWords).toBe('Received: 0 of 1 lines decided')
  })

  it('lists returns with their status words and counts the tiles', async () => {
    const open = await ok('viewer', 'GET', '/sales/returns')
    expect(open.returns.map((row: Json) => row.number)).toEqual(expect.arrayContaining([rma2.number, 'SEED-RMA-0002']))
    expect(open.returns.map((row: Json) => row.number)).not.toContain(rma1.number)
    expect(open.returns[0]).not.toHaveProperty('creditTotal')
    const closed = await ok('sales', 'GET', '/sales/returns?view=closed')
    expect(closed.returns.find((row: Json) => row.number === rma1.number)).toMatchObject({ status: 'CLOSED', dispositions: ['REPLACE'], replacementOrder: { number: `SO-${YEAR}-0001` }, units: 1, receivedUnits: 1 })
    const counts = await ok('viewer', 'GET', '/sales/returns/counts')
    expect(counts.counts).toMatchObject({ waiting: 0, toInspect: 1, toDecide: 1, replacement: 0 })
    expect(counts.counts.open).toBeGreaterThanOrEqual(3)
    expect((await ok('viewer', 'GET', `/sales/returns?q=${encodeURIComponent('P1-RET-9')}&view=all`)).returns.map((row: Json) => row.number)).toEqual([rma1.number])
  })
})
