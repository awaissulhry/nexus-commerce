import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { alertPhrase } from '@nexus/factory-domain/alerts/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { callerFor, type CommandTx } from '../../../core/command'
import { findFor } from '../../../platform/alerts/evaluators'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { useScanner } from '../../../platform/files/scan/service'
import { systemContext } from '../../../platform/outbox/system'
import { postReleased } from '../../inventory/receiving/tolerance-hold'
import { runChaseReminders } from '../reminders/chase'

/**
 * Approvals and buying follow-ups (B-W2b-377; XF5:02 – XF5:06) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (row-level security, the approvals guards, B-W2b-363's receipt hold and chase guards are real), the real app with
 * office people signed in with two-factor (step-up), the factory-db seeds up to production and the standard reason lists, FAKE
 * file store and mail. Every name, number and document is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/purchasing/compliance-override`.
 *
 *   XF5:02  the compliance override is a PURCHASE_ORDER_COMPLIANCE request of the approval engine (Home › Approvals)
 *   XF5:04  APPROVAL_OVERDUE reads the engine's requests as well as the quotes'
 *   XF5:06  a supplier's document carries a type: the vault and the PO gate match it
 *   XF5:03  a receipt line beyond its tolerance waits for a RECEIPT_OVER_TOLERANCE yes, then is posted for its receiver
 *   XF5:05  chase reminders: by hand and by the daily run (behind the Owner's switch, OFF), the confirm-by hours and cadence
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

let h: Harness
const NS = 'buying-377'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const leather = seedId('product:item:leather')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const protector = seedId('product:item:protector')
const FAKE_VAT = '12345670009'
const people: Record<string, { browser: Browser; secret: string; id: string }> = {}
const log = { info: () => undefined, warn: () => undefined, error: () => undefined }

const sql = async <T = Json>(text: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(text, values)).rows as T[]
/** Moves test data past its own guards (the admin's session only), then back. */
async function force(text: string, values: unknown[] = []): Promise<void> {
  await sql('SET session_replication_role = replica')
  try {
    await sql(text, values)
  } finally {
    await sql('SET session_replication_role = DEFAULT')
  }
}
let counter = 0
const key = () => `buy377-${++counter}-${newId()}`
async function call(name: string, method: Method, url: string, body?: unknown) {
  const answer = await people[name]!.browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  return { status: answer.status, body: answer.body as Json }
}
async function as(name: string, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(name, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const paths = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => String(issue.path))
const codes = (checks: Json[]): string[] => checks.map((check) => check.code).filter((code: string) => code.startsWith('COMPLIANCE_'))
const today = () => businessDate(h.clock.now())
const outbox = async (type: string) => (await sql<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant, type])).map((row) => row.payload)
const system = () => callerFor(h.database, systemContext(tenant, `test-${newId()}`))
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const tokenOf = (outboundId: string): string => {
  const mail = h.ses.mails.find((entry) => entry.outboundId === outboundId)
  return mail ? decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '') : ''
}

async function draft(lines: readonly { itemId: string; colourId?: string; quantity: string; uom: string; days: number }[]): Promise<Json> {
  let order = (await as('buyer', 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2, incoterms: 'EXW Seedville' }, 201)).order
  for (const line of lines) {
    order = (await as('buyer', 'POST', `/purchasing/orders/${order.id}/lines`, { version: order.version, itemId: line.itemId, ...(line.colourId ? { itemColourId: line.colourId } : {}), quantity: line.quantity, uom: line.uom, needDate: addDays(today(), line.days), unitPrice: '2.500000' }, 201)).order
  }
  return order
}
const leatherOrder = () => draft([{ itemId: leather, colourId: leatherBLK, quantity: '105', uom: 'FT2', days: 30 }])
/** Sent and confirmed as asked by the supplier's link. */
async function sentAndConfirmed(itemId: string, quantity: string): Promise<Json> {
  const made = await draft([{ itemId, quantity, uom: 'PCS', days: 20 }])
  const sent = await as('buyer', 'POST', `/purchasing/orders/${made.id}/send`, { version: made.version })
  const answer = await h.app.inject({ method: 'POST', url: '/link/purchase-order/confirm', headers: { 'x-factory-link': tokenOf(sent.sent.emailId), 'user-agent': 'SeedBrowser/1.0', 'idempotency-key': key() }, payload: { version: sent.order.version, mode: 'ALL_AS_ASKED', typedName: 'Mario Rossi', supplierRef: 'OC-377' } })
  expect(answer.statusCode, answer.body).toBe(200)
  return (await as('buyer', 'GET', `/purchasing/orders/${made.id}`)).order
}
/** A document of P2 in the vault: uploaded on the Party, then tagged with its category and last valid day. */
async function partyDocument(category: string, expiresOn: string | null, name: string): Promise<string> {
  const body = Buffer.from(`%PDF-1.7 made-up ${name}`)
  const { file, upload } = await as('buyer', 'POST', '/files', { companyId: companyA, recordType: 'Party', recordId: P2, kind: 'CERTIFICATE', originalName: `${name}.pdf`, contentType: 'application/pdf', sizeBytes: body.length, sha256: sha256(body) }, 201)
  expect((await h.app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })).statusCode).toBe(200)
  await as('buyer', 'POST', `/files/${file.id}/complete`)
  const version = (await sql<{ version: number }>('SELECT version FROM "StoredFile" WHERE id = $1', [file.id]))[0]!.version
  await as('buyer', 'PUT', `/files/${file.id}/document`, { category, expiresOn, version })
  return file.id
}
const fileVersion = async (fileId: string): Promise<number> => (await sql<{ version: number }>('SELECT version FROM "StoredFile" WHERE id = $1', [fileId]))[0]!.version

beforeAll(async () => {
  h = await startHarness('buying_377')
  // The guards refuse a time more than 5 minutes ahead of the database (sign-ins and step-ups move the clock on, about three
  // minutes in all), and a supplier's answer closes partner tasks the database dated: the app's clock starts a minute behind it.
  h.clock.set(new Date(Date.now() - 60_000))
  useScanner(null)
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await sql(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await sql(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await sql(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  await sql(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  for (const [name, role] of [['buyer', 'buyer'], ['quality', 'quality_inspector'], ['owner', 'owner'], ['receiver', 'warehouse']] as const) {
    const user = await addUser(h, seedTenant, { email: `${name}.377@seed-a.example.com`, role })
    const browser = new Browser(h.app)
    expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
    people[name] = { browser, secret: await enrolTotp(h, browser), id: user.id }
  }
  const profile = (await as('buyer', 'GET', `/purchasing/suppliers/${P2}/profile`)).supplier
  // A tannery: its leathers ask a chromium VI test report at Send (its protectors are not checked: not a protector maker).
  await as('buyer', 'PATCH', `/purchasing/suppliers/${P2}/profile`, { version: profile.version, kinds: ['TANNERY'] })
}, 300_000)

afterAll(async () => {
  useScanner(undefined)
  await h?.close()
}, 60_000)

describe('XF5:02 — a send without a valid document is a PURCHASE_ORDER_COMPLIANCE request of the approval engine', () => {
  let order: Json
  let taskId: string

  it('asks it of the role that decides overrides when no rule is switched on, and lists it in Home › Approvals', async () => {
    order = await leatherOrder()
    expect(codes((await as('buyer', 'GET', `/purchasing/orders/${order.id}/send-check`)).checks)).toEqual(['COMPLIANCE_DOCUMENT_MISSING'])
    const asked = await as('buyer', 'POST', `/purchasing/orders/${order.id}/compliance-override`, { version: order.version, reason: 'The renewed report comes next week; the lot is tested at receipt.' })
    expect(asked.request).toMatchObject({ state: 'WAITING', askedBy: { id: people.buyer!.id, me: true }, current: true, taskId: expect.any(String) })
    taskId = asked.request.taskId
    const task = (await sql<Json>(`SELECT kind::text AS kind, "recordType", "recordId", "ruleIds", "requireStepUp", "approverRoleId" FROM "ApprovalTask" WHERE id = $1`, [taskId]))[0]!
    expect(task).toMatchObject({ kind: 'PURCHASE_ORDER_COMPLIANCE', recordType: 'PurchaseOrder', recordId: order.id, ruleIds: [], requireStepUp: true })
    expect((await sql<{ key: string }>('SELECT key FROM "Role" WHERE id = $1', [task.approverRoleId]))[0]!.key).toBe('quality_inspector')
    const inbox = await as('quality', 'GET', '/approvals/tasks?tile=WAITING_FOR_ME')
    const row = inbox.rows.find((entry: Json) => entry.id === taskId)
    expect(row).toMatchObject({ kind: 'PURCHASE_ORDER_COMPLIANCE', kindLabel: { en: 'Send without a valid document' }, record: { type: 'PurchaseOrder', id: order.id, label: expect.stringContaining(order.number), parent: null }, approver: { kind: 'ROLE', me: true } })
    expect((await as('quality', 'GET', '/purchasing/compliance-overrides')).requests.find((entry: Json) => entry.order.id === order.id)).toMatchObject({ mayDecide: true, request: { taskId } })
  })

  it('is never decided by who asked (the engine and the order’s route), and the yes asks a fresh code', async () => {
    const own = await call('buyer', 'POST', `/approvals/tasks/${taskId}/approve`, { version: 1, comment: null })
    expect(own.status).toBe(403)
    expect(paths(own.body)).toEqual(['refusal/OWN_REQUEST'])
    expect(paths((await call('quality', 'POST', `/approvals/tasks/${taskId}/approve`, { version: 1, comment: null })).body)).toEqual(['stepUp'])
    await stepUp(h, people.quality!.browser, people.quality!.secret)
    const decided = await as('quality', 'POST', `/purchasing/orders/${order.id}/compliance-override/decide`, { decision: 'APPROVED', words: 'Yes: the lot waits at receipt for its test.' })
    expect(decided).toMatchObject({ ready: true, overridden: true, request: { state: 'APPROVED', taskId, decidedBy: { id: people.quality!.id } } })
    expect((await sql<Json>(`SELECT status::text AS status, "decidedById", "stepUpAt" FROM "ApprovalTask" WHERE id = $1`, [taskId]))[0]).toMatchObject({ status: 'APPROVED', decidedById: people.quality!.id, stepUpAt: expect.any(Date) })
    expect((await outbox('purchase_order.compliance_override_decided')).at(-1)).toMatchObject({ purchaseOrderId: order.id, decision: 'APPROVED' })
    expect(codes((await as('buyer', 'GET', `/purchasing/orders/${order.id}/send-check`)).checks)).toEqual(['COMPLIANCE_OVERRIDDEN'])
    expect((await as('buyer', 'POST', `/purchasing/orders/${order.id}/send`, { version: order.version })).order.status).toBe('SENT')
  })

  it('is found changed, never approved, when what holds the order changed since it was asked', async () => {
    const second = await leatherOrder()
    const asked = await as('buyer', 'POST', `/purchasing/orders/${second.id}/compliance-override`, { version: second.version, reason: 'Sent before the report, as agreed.' })
    // Another leather line: what holds the order is not what was asked.
    await as('buyer', 'POST', `/purchasing/orders/${second.id}/lines`, { version: second.version, itemId: leather, itemColourId: leatherBLK, quantity: '20', uom: 'FT2', needDate: addDays(today(), 25), unitPrice: '2.500000' }, 201)
    const stale = await call('quality', 'POST', `/purchasing/orders/${second.id}/compliance-override/decide`, { decision: 'APPROVED' })
    expect(stale.status).toBe(409)
    expect(paths(stale.body)).toEqual(['refusal/STALE'])
    const gate = await as('buyer', 'GET', `/purchasing/orders/${second.id}/compliance`)
    expect(gate).toMatchObject({ ready: false, overridden: false, request: { taskId: asked.request.taskId, state: 'WITHDRAWN', current: false }, may: { ask: true } })
  })
})

describe('XF5:04 — APPROVAL_OVERDUE reads the engine’s requests', () => {
  it('raises one finding per request still waiting past the hours, its record in words; a recheck reads only the request named', async () => {
    const order = await leatherOrder()
    const asked = await as('buyer', 'POST', `/purchasing/orders/${order.id}/compliance-override`, { version: order.version, reason: 'Waiting for the report.' })
    const later = new Date(h.clock.now().getTime() + 3 * 3_600_000)
    const findings = await system().withClient((client) => findFor('APPROVAL_OVERDUE', client as unknown as CommandTx, { companyId: null, siteId: null, threshold: { hours: 2 } }, later))
    const found = findings.find((entry) => entry.recordId === asked.request.taskId)
    expect(found).toMatchObject({ recordType: 'ApprovalTask', label: expect.stringContaining(order.number), scope: { companyId: companyA, siteId: siteA1 }, facts: { task: true, kind: 'PURCHASE_ORDER_COMPLIANCE', threshold: 2 } })
    expect(found!.facts.hours).toBeGreaterThanOrEqual(2)
    expect(alertPhrase('APPROVAL_OVERDUE', found!.label, found!.facts)).toEqual({ key: 'alerts.APPROVAL_OVERDUE.TASK', params: { label: found!.label, hours: found!.facts.hours } })
    const notYet = await system().withClient((client) => findFor('APPROVAL_OVERDUE', client as unknown as CommandTx, { companyId: null, siteId: null, threshold: { hours: 4 } }, later))
    expect(notYet.some((entry) => entry.recordId === asked.request.taskId)).toBe(false)
    const other = await system().withClient((client) => findFor('APPROVAL_OVERDUE', client as unknown as CommandTx, { companyId: null, siteId: null, threshold: { hours: 2 } }, later, [newId()]))
    expect(other.some((entry) => entry.recordType === 'ApprovalTask')).toBe(false)
    await as('buyer', 'POST', `/purchasing/orders/${order.id}/compliance-override/withdraw`)
  })
})

describe('XF5:06 — a supplier’s document carries its type; the vault and the PO gate read it', () => {
  it('takes no azo-dye test report for the chromium VI one; typed right, the leather goes', async () => {
    const report = await partyDocument('TEST_REPORT', addDays(today(), 200), 'Azo dyes test report SEED-LEA-100')
    const typed = await as('buyer', 'PUT', `/purchasing/suppliers/${P2}/documents/${report}/type`, { version: await fileVersion(report), documentTypeCode: 'AZO_TEST_REPORT' })
    expect(typed).toMatchObject({ fileId: report, documentTypeCode: 'AZO_TEST_REPORT', category: 'TEST_REPORT' })
    expect((await outbox('supplier_document.typed')).at(-1)).toEqual({ fileId: report, partyId: P2, documentTypeCode: 'AZO_TEST_REPORT' })
    const order = await leatherOrder()
    expect(codes((await as('buyer', 'GET', `/purchasing/orders/${order.id}/send-check`)).checks)).toEqual(['COMPLIANCE_DOCUMENT_MISSING'])
    const vault = await as('buyer', 'GET', `/purchasing/suppliers/${P2}/documents`)
    expect(vault.documents.find((doc: Json) => doc.fileId === report)).toMatchObject({ documentTypeCode: 'AZO_TEST_REPORT' })
    // B-W2b-383 (B-W2b-382's gap): the vault answers the file's version, the one the type's change sends.
    expect(vault.documents.find((doc: Json) => doc.fileId === report).version).toBe(await fileVersion(report))
    expect(vault.materials.find((row: Json) => row.needs === 'CR_VI_TEST_REPORT')).toMatchObject({ state: 'MISSING', heldAtSend: true })
    // Not a type of the list; an old version.
    expect(paths((await call('buyer', 'PUT', `/purchasing/suppliers/${P2}/documents/${report}/type`, { version: await fileVersion(report), documentTypeCode: 'NOT_A_TYPE' })).body)).toEqual(['body/documentTypeCode'])
    expect((await call('buyer', 'PUT', `/purchasing/suppliers/${P2}/documents/${report}/type`, { version: 1, documentTypeCode: 'CR_VI_TEST_REPORT' })).status).toBe(409)
    await as('buyer', 'PUT', `/purchasing/suppliers/${P2}/documents/${report}/type`, { version: await fileVersion(report), documentTypeCode: 'CR_VI_TEST_REPORT' })
    expect(codes((await as('buyer', 'GET', `/purchasing/orders/${order.id}/send-check`)).checks)).toEqual([])
    // A file of the supplier that is no vault document says no type; another supplier's file is not found here.
    expect((await call('buyer', 'PUT', `/purchasing/suppliers/${seedId('party:P1')}/documents/${report}/type`, { version: await fileVersion(report), documentTypeCode: null })).status).toBe(404)
  })

  it('meets an ask by its type: an ISO 9001 certificate meets the LWG ask, a DURC does not', async () => {
    const certificate = await partyDocument('SUPPLIER_CERTIFICATE', addDays(today(), 300), 'Made-up certificate')
    await as('buyer', 'PUT', `/purchasing/suppliers/${P2}/documents/${certificate}/type`, { version: await fileVersion(certificate), documentTypeCode: 'DURC' })
    const asked = async () => (await as('buyer', 'GET', `/purchasing/suppliers/${P2}/documents`)).asked.find((entry: Json) => entry.category === 'SUPPLIER_CERTIFICATE')
    expect(await asked()).toMatchObject({ state: 'MISSING', fileId: null })
    await as('buyer', 'PUT', `/purchasing/suppliers/${P2}/documents/${certificate}/type`, { version: await fileVersion(certificate), documentTypeCode: 'ISO_9001' })
    expect(await asked()).toMatchObject({ state: 'MET', fileId: certificate })
  })
})

describe('XF5:03 — a receipt line beyond its tolerance waits for a RECEIPT_OVER_TOLERANCE yes', () => {
  let order: Json
  let receipt: Json
  let held: Json

  it('holds the receipt OPEN (no move, the order not moved) and asks the buyer’s role; posting it answers 409 in words', async () => {
    await as('buyer', 'POST', '/purchasing/tolerances', { companyId: null, supplierId: null, itemId: protector, itemKind: null, overPct: '10', underPct: '5', whenBeyond: 'APPROVAL' }, 201)
    order = await sentAndConfirmed(protector, '10')
    const noReason = await call('receiver', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: order.lines[0].id, lots: [{ quantity: '13' }] }] })
    expect(noReason.status).toBe(409)
    expect(paths(noReason.body)).toEqual(['body/lines/0/differenceReason'])
    const answer = await as('receiver', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, supplierDdtNumber: 'DDT-377-1', supplierDdtDate: today(), lines: [{ purchaseOrderLineId: order.lines[0].id, differenceReason: 'Three spares sent with the lot', lots: [{ quantity: '13' }] }] }, 202)
    receipt = answer.receipt
    held = answer.held[0]
    expect(receipt.status).toBe('OPEN')
    expect(answer.moves).toEqual([])
    expect(receipt.lines[0].heldForApprovalAt).toEqual(expect.any(String))
    expect(answer.held).toEqual([{ lineId: receipt.lines[0].id, seq: receipt.lines[0].seq, taskId: expect.any(String) }])
    expect((await as('buyer', 'GET', `/purchasing/orders/${order.id}`)).order.status).toBe('CONFIRMED')
    expect((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM "StockMove" WHERE "receiptLineId" = $1`, [receipt.lines[0].id]))[0]!.n).toBe(0)
    expect((await outbox('inventory.receipt_held')).at(-1)).toEqual({ receiptId: receipt.id, number: receipt.number, purchaseOrderId: order.id, lines: 1 })
    const post = await call('receiver', 'POST', `/inventory/receipts/${receipt.id}/post`)
    expect(post.status).toBe(409)
    expect(post.body.error.message).toMatch(/A line waits for a yes/)
    // Home › Approvals: the buyer's role decides it; the receipt is the page it opens.
    const row = (await as('buyer', 'GET', '/approvals/tasks?tile=WAITING_FOR_ME')).rows.find((entry: Json) => entry.id === held.taskId)
    expect(row).toMatchObject({ kind: 'RECEIPT_OVER_TOLERANCE', record: { type: 'GoodsReceiptLine', id: receipt.lines[0].id, label: expect.stringContaining(receipt.number), parent: { type: 'GoodsReceipt', id: receipt.id } } })
    // B-W2b-383 (B-W2b-382's gap): the label is codes only, in no language (the receipt/its line · the material).
    expect(row.record.label).toMatch(new RegExp(`^${receipt.number}/${receipt.lines[0].seq} · \\S+$`))
    // The line's note holds the receiver's words only: no English label before the reason.
    expect(receipt.lines[0].note).toBe('Three spares sent with the lot')
    expect(row.facts.find((fact: Json) => fact.field === 'overPct')).toMatchObject({ value: '30' })
  })

  it('is never approved by its receiver; the buyer’s yes releases it and the worker posts it for the receiver', async () => {
    const own = await call('receiver', 'POST', `/approvals/tasks/${held.taskId}/approve`, { version: 1, comment: null })
    expect(own.status).toBe(403)
    await as('buyer', 'POST', `/approvals/tasks/${held.taskId}/approve`, { version: 1, comment: 'The spares are welcome.' })
    expect((await sql<Json>(`SELECT "heldForApprovalAt" FROM "GoodsReceiptLine" WHERE id = $1`, [held.lineId]))[0]!.heldForApprovalAt).toBeNull()
    const released = await sql<{ id: string; payload: Json }>(`SELECT id, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'inventory.receipt_released'`, [tenant])
    expect(released.map((event) => event.payload)).toEqual([{ receiptId: receipt.id, number: receipt.number, purchaseOrderId: order.id }])
    expect(await postReleased(system(), { eventId: released[0]!.id, payload: released[0]!.payload })).toBe('POSTED')
    // A second delivery of the event changes nothing.
    expect(await postReleased(system(), { eventId: released[0]!.id, payload: released[0]!.payload })).toBe('SETTLED')
    const posted = (await as('receiver', 'GET', `/inventory/receipts/${receipt.id}`)).receipt
    expect(posted).toMatchObject({ status: 'POSTED', number: receipt.number })
    expect(posted.lines.map((line: Json) => line.id)).toEqual([held.lineId])
    expect((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM "StockMove" WHERE "receiptLineId" = $1`, [held.lineId]))[0]!.n).toBe(1)
    expect((await sql<{ createdById: string; postedById: string }>(`SELECT "createdById", "postedById" FROM "GoodsReceipt" WHERE id = $1`, [receipt.id]))[0]).toEqual({ createdById: people.receiver!.id, postedById: people.receiver!.id })
    expect((await as('buyer', 'GET', `/purchasing/orders/${order.id}`)).order.status).toBe('RECEIVED')
  })

  it('a receipt still waiting is cancelled by the receiver: its request is withdrawn', async () => {
    const other = await sentAndConfirmed(protector, '10')
    const answer = await as('receiver', 'POST', '/inventory/receipts', { purchaseOrderId: other.id, lines: [{ purchaseOrderLineId: other.lines[0].id, differenceReason: 'Two more than asked', lots: [{ quantity: '12' }] }] }, 202)
    const cancelled = await as('receiver', 'POST', `/inventory/receipts/${answer.receipt.id}/cancel`, { reason: 'Received again within the tolerance.' })
    expect(cancelled.receipt.status).toBe('CANCELLED')
    expect((await sql<Json>(`SELECT status::text AS status, "withdrawnById" FROM "ApprovalTask" WHERE id = $1`, [answer.held[0].taskId]))[0]).toEqual({ status: 'WITHDRAWN', withdrawnById: people.receiver!.id })
    expect((await call('receiver', 'POST', `/inventory/receipts/${answer.receipt.id}/cancel`, { reason: 'Again' })).status).toBe(409)
    expect((await as('receiver', 'POST', '/inventory/receipts', { purchaseOrderId: other.id, lines: [{ purchaseOrderLineId: other.lines[0].id, differenceReason: 'One spare', lots: [{ quantity: '11' }] }] }, 201)).receipt.status).toBe('POSTED')
  })
})

describe('XF5:05 — chase reminders, the confirm-by hours and the cadence', () => {
  let order: Json

  it('keeps the company’s confirm-by hours and cadence (the Owner’s) and the send asks the supplier by them', async () => {
    expect((await call('buyer', 'PUT', '/purchasing/reminders/settings/timing', { companyId: companyA, confirmByHours: 72, reminderCadenceDays: 2 })).status).toBe(403)
    expect((await call('owner', 'PUT', '/purchasing/reminders/settings/timing', { companyId: companyA, confirmByHours: 0, reminderCadenceDays: 2 })).status).toBe(400)
    const set = await as('owner', 'PUT', '/purchasing/reminders/settings/timing', { companyId: companyA, confirmByHours: 72, reminderCadenceDays: 2 })
    expect(set).toMatchObject({ on: false, timing: { confirmByHours: 72, cadenceDays: 2, source: { confirmByHours: 'COMPANY', cadenceDays: 'COMPANY' } }, company: { confirmationRemindersEnabled: false, confirmByHours: 72, reminderCadenceDays: 2 } })
    const made = await draft([{ itemId: protector, quantity: '4', uom: 'PCS', days: 10 }])
    const check = await as('buyer', 'GET', `/purchasing/orders/${made.id}/send-check`)
    expect(Math.abs(new Date(check.confirmBy).getTime() - (Date.now() + 72 * 3_600_000))).toBeLessThan(20 * 60_000)
  })

  it('writes a CHASE reminder for a chase by hand; the daily run chases late lines only while the switch is on, by the cadence', async () => {
    order = await sentAndConfirmed(protector, '6')
    // The line is late: its day passed (test data past the guards).
    await force(`UPDATE "PurchaseOrderLine" SET "needDate" = $2::date, "confirmedDate" = $2::date WHERE "purchaseOrderId" = $1`, [order.id, addDays(today(), -4)])
    // Only this order is late (11-14): the other orders' passed days (the seeded PO was due 2026-11-13) move a month on, so the
    // run's totals count this order alone whatever today is.
    const moved = [order.id, today(), addDays(today(), 30)]
    await force(`UPDATE "PurchaseOrderLine" SET "needDate" = CASE WHEN "needDate" < $2::date THEN $3::date ELSE "needDate" END, "confirmedDate" = CASE WHEN "confirmedDate" < $2::date THEN $3::date ELSE "confirmedDate" END WHERE "purchaseOrderId" <> $1`, moved)
    await force(`UPDATE "PurchaseOrderLineDelivery" SET "needDate" = CASE WHEN "needDate" < $2::date THEN $3::date ELSE "needDate" END, "confirmedDate" = CASE WHEN "confirmedDate" < $2::date THEN $3::date ELSE "confirmedDate" END WHERE "purchaseOrderLineId" IN (SELECT id FROM "PurchaseOrderLine" WHERE "purchaseOrderId" <> $1)`, moved)
    const fresh = (await as('buyer', 'GET', `/purchasing/orders/${order.id}`)).order
    await as('buyer', 'POST', `/purchasing/orders/${order.id}/chase`, { version: fresh.version })
    const rows = async () => sql<Json>(`SELECT kind::text AS kind, "sentById", revision FROM "PurchaseOrderReminder" WHERE "purchaseOrderId" = $1 ORDER BY "sentAt", id`, [order.id])
    expect(await rows()).toEqual([{ kind: 'CHASE', sentById: people.buyer!.id, revision: 1 }])
    expect((await outbox('purchase_order.chase_recorded')).at(-1)).toMatchObject({ purchaseOrderId: order.id, revision: 1, automatic: false })
    // The record's reminders list the chase; the confirmation count is the confirmations'.
    const reminders = await as('buyer', 'GET', `/purchasing/orders/${order.id}/reminders`)
    expect(reminders).toMatchObject({ sentForRevision: 0, reminders: [{ kind: 'CHASE', automatic: false }] })
    // Right after the chase by hand: the cadence (2 days) holds the next one.
    expect(await runChaseReminders({ database: h.database, log, clock: h.clock })).toMatchObject({ due: 0, sent: 0 })
    // The chase by hand three days ago (test data past the append-only guard): due, but the company's automatic reminders are off.
    await force(`UPDATE "PurchaseOrderReminder" SET "sentAt" = "sentAt" - interval '3 days' WHERE "purchaseOrderId" = $1`, [order.id])
    expect(await runChaseReminders({ database: h.database, log, clock: h.clock })).toMatchObject({ due: 1, sent: 0, switchedOff: 1 })
    expect(await rows()).toHaveLength(1)
    // Switched on (for the test): the run chases the late line, once.
    expect(await runChaseReminders({ database: h.database, log, clock: h.clock, switchOn: () => true })).toMatchObject({ due: 1, sent: 1, failed: 0 })
    expect(await rows()).toEqual([{ kind: 'CHASE', sentById: people.buyer!.id, revision: 1 }, { kind: 'CHASE', sentById: null, revision: 1 }])
    expect((await outbox('purchase_order.chase_recorded')).at(-1)).toMatchObject({ purchaseOrderId: order.id, automatic: true })
    expect(await runChaseReminders({ database: h.database, log, clock: h.clock, switchOn: () => true })).toMatchObject({ due: 0, sent: 0 })
  })

  it('refuses a chase of an order that waits for no goods (the database’s rule, said by the API first)', async () => {
    const made = await draft([{ itemId: protector, quantity: '2', uom: 'PCS', days: 10 }])
    expect((await call('buyer', 'POST', `/purchasing/orders/${made.id}/chase`, { version: made.version })).status).toBe(409)
  })
})
