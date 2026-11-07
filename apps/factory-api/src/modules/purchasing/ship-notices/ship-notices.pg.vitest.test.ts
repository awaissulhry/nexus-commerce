import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { callerFor, command } from '../../../core/command'
import { systemContext } from '../../../platform/outbox/system'
import { packingListImportAdapter } from './importer'

/**
 * Ship notices and the inbound board on the local stack (B-W2b-182; SCM-106, SCM-107, SCM-110): a throwaway PostgreSQL 17
 * database from the migrations (row-level security, the partner role's grants and the …_portal_supply_w2b_guards are real),
 * the real app with an office buyer and a warehouse person, and the supplier's people signed in to the portal by e-mail
 * code (FAKE mailbox). Every name, number and hide is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/purchasing/ship-notices`.
 */

let h: Harness
let buyer: Browser
let dock: Browser
let anna: Browser
let vito: Browser
let otto: Browser
const NS = 'asn-portal'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const P9 = newId()
const leather = seedId('product:item:leather')
const protector = seedId('product:item:protector')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const people = { anna: 'anna.orders@tannery-p2.example', vito: 'vito.viewer@tannery-p2.example', otto: 'otto.orders@other-p9.example' }
const today = () => businessDate(h.clock.now())

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `asn-${label}-${++counter}-${newId()}`

async function call(browser: Browser, method: Method, url: string, body?: unknown) {
  return browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
}
async function as(browser: Browser, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(browser, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

/** Every price-looking key or an office-only field in a JSON answer (none may reach a supplier). */
function priceTraces(body: unknown): string[] {
  const text = JSON.stringify(body)
  return [/price"\s*:/i, /unitPrice/i, /amount/i, /cost/i, /internalNote/, /dockNote/, /createdById/].filter((pattern) => pattern.test(text)).map(String)
}

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'SUPPLIER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant, key: roleKey } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

/** An order for P2 at A1: 105 ft² of black leather (grade A, 1.10–1.30 mm, one dye batch, ±5 %, about 5 hides) and 24 protectors, sent. */
async function sentOrder(): Promise<Json> {
  let draft = (await as(buyer, 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2, incoterms: 'EXW Seedville' }, 201)).order
  draft = (await as(buyer, 'POST', `/purchasing/orders/${draft.id}/lines`, { version: draft.version, itemId: leather, itemColourId: leatherBLK, quantity: '105', uom: 'FT2', needDate: addDays(today(), 10), areaTolerancePct: '5', oneDyeBatch: true, grade: 'A' }, 201)).order
  draft = (await as(buyer, 'POST', `/purchasing/orders/${draft.id}/lines`, { version: draft.version, itemId: protector, quantity: '24', needDate: addDays(today(), 10) }, 201)).order
  return (await as(buyer, 'POST', `/purchasing/orders/${draft.id}/send`, { version: draft.version })).order
}

/** The same, confirmed by the supplier in the portal (all as asked). */
async function confirmedOrder(): Promise<Json> {
  const order = await sentOrder()
  const page = await as(anna, 'GET', `/portal/purchase-orders/${order.id}`)
  await as(anna, 'POST', `/portal/purchase-orders/${order.id}/confirm`, { version: page.order.version, mode: 'ALL_AS_ASKED' })
  return order
}

const outboxOf = (subject: string, type: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 AND type = $2 ORDER BY "occurredAt", id', [subject, type])
const csv = (lines: string[]): string => Buffer.from(lines.join('\r\n'), 'utf8').toString('base64')
const hidesRows = (grades: string[]) => grades.map((grade, index) => ({ hideNumber: `2231-${String(index + 1).padStart(3, '0')}`, area: '21', unit: 'FT2', grade, thicknessMm: '1.2', dyeBatch: '2231' }))

beforeAll(async () => {
  h = await startHarness('asn_portal')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  await portalWorld(h, seedTenant)
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => {
    await client.portalSettings.create({ data: { id: P2, partyId: P2, portalOn: true }, select: { id: true } })
    await client.party.create({ data: { id: P9, code: `P${P9.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Other Supplier S.r.l.', roles: ['SUPPLIER'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: P9, partyId: P9, portalOn: true }, select: { id: true } })
  })
  await partnerPerson(people.anna, P2, ['supplier-orders', 'partner-approve', 'partner-upload'])
  await partnerPerson(people.vito, P2, ['supplier-orders'])
  await partnerPerson(people.otto, P9, ['supplier-orders', 'partner-approve', 'partner-upload'])
  const buyerUser = await addUser(h, seedTenant, { email: 'bianca.buyer@seed-a.example.com', role: 'buyer' })
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)
  const dockUser = await addUser(h, seedTenant, { email: 'dario.dock@seed-a.example.com', role: 'warehouse' })
  dock = new Browser(h.app)
  expect((await dock.signIn(NS, dockUser.email, dockUser.password)).status).toBe(200)
  await enrolTotp(h, dock)
  freshGuard(h)
  anna = await signedIn(people.anna)
  vito = await signedIn(people.vito)
  otto = await signedIn(people.otto)
}, 240_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
}, 60_000)

describe('a supplier announces a delivery from a confirmed order (SCM-106) with its packing list checked per hide (SCM-107)', () => {
  let order: Json
  let notice: Json
  let leatherLine: Json
  let protectorLine: Json

  it('offers the open lines of confirmed orders only, never a price', async () => {
    const unconfirmed = await sentOrder()
    order = await confirmedOrder()
    const shippable = await as(anna, 'GET', '/portal/ship-notices/shippable')
    expect(shippable.mayWrite).toBe(true)
    expect(shippable.orders.map((entry: Json) => entry.id)).toContain(order.id)
    expect(shippable.orders.map((entry: Json) => entry.id)).not.toContain(unconfirmed.id)
    const lines = shippable.orders.find((entry: Json) => entry.id === order.id).lines
    leatherLine = lines.find((line: Json) => line.seq === 10)
    protectorLine = lines.find((line: Json) => line.seq === 20)
    expect(leatherLine).toMatchObject({ item: { leather: true }, uom: 'FT2', open: '105.0000', grade: 'A', oneDyeBatch: true, tolerancePct: '5', requiresCrViTest: true })
    expect(protectorLine).toMatchObject({ item: { leather: false }, uom: 'PCS', open: '24.0000' })
    expect(priceTraces(shippable)).toEqual([])
    // An order still waiting for the supplier's confirmation takes no notice.
    const refused = await call(anna, 'POST', '/portal/ship-notices', { purchaseOrderId: unconfirmed.id, lines: [{ purchaseOrderLineId: newId(), quantity: '1' }] })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/not confirmed/)
  })

  it('makes a draft with its lines, dye batch and transport; a viewer and another supplier cannot', async () => {
    const body = {
      purchaseOrderId: order.id,
      lines: [
        { purchaseOrderLineId: leatherLine.purchaseOrderLineId, quantity: '105', dyeBatch: '2231', supplierLot: 'L-77' },
        { purchaseOrderLineId: protectorLine.purchaseOrderLineId, quantity: '24', supplierLot: 'PR-12' },
      ],
      shipDate: addDays(today(), 1),
      expectedDate: addDays(today(), 3),
      carrier: 'Made-up Freight',
      trackingNumber: 'MF-000123',
      parcels: 2,
      ddtNumber: 'DDT-45',
      ddtDate: addDays(today(), 1),
    }
    expect((await call(vito, 'POST', '/portal/ship-notices', body)).status).toBe(403)
    const page = await as(anna, 'POST', '/portal/ship-notices', body, 201)
    notice = page.notice
    expect(notice).toMatchObject({ status: 'DRAFT', state: 'DRAFT', number: null, carrier: 'Made-up Freight', parcels: 2, purchaseOrder: { id: order.id, number: order.number } })
    expect(notice.lines.map((line: Json) => [line.orderSeq, line.quantity, line.dyeBatch, line.verdict])).toEqual([
      [10, '105.0000', '2231', 'CHECK'],
      [20, '24.0000', null, 'OK'],
    ])
    // No packing list yet, and no Cr VI test report on file: worth a look, never a hold.
    expect(notice.lines[0].reasons.map((reason: Json) => reason.code)).toEqual(['NO_PACKING_LIST', 'CR_VI'])
    expect(page.canSend).toBe(true)
    expect(priceTraces(page)).toEqual([])
    // Another supplier does not see it; a wrong date order is refused in words.
    expect((await call(otto, 'GET', `/portal/ship-notices/${notice.id}`)).status).toBe(404)
    const wrong = await call(anna, 'PATCH', `/portal/ship-notices/${notice.id}`, { version: notice.version, expectedDate: addDays(today(), 0) })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.issues.map((issue: Json) => issue.path)).toContain('body/expectedDate')
  })

  it('judges the packing list typed by hand per hide: a grade B hide is not as ordered', async () => {
    const page = await as(anna, 'PUT', `/portal/ship-notices/${notice.id}/packing-list`, { version: notice.version, rows: hidesRows(['A', 'A', 'B', 'A', 'A']) })
    notice = page.notice
    const line = notice.lines[0]
    expect(line.hides).toHaveLength(5)
    expect(line.hides[2]).toMatchObject({ hideNumber: '2231-003', verdict: 'NOT_AS_ORDERED', reasons: [expect.objectContaining({ code: 'GRADE', words: { it: 'Scelta B: l’ordine chiede A.', en: 'Grade B: the order asks A.' } })] })
    expect(line.figures).toMatchObject({ hides: 5, area: '105', expected: '105', openAfter: '0' })
    expect(notice.verdict).toBe('NOT_AS_ORDERED')
    // Twice the same hide number is refused at its row, nothing kept.
    const twice = await call(anna, 'PUT', `/portal/ship-notices/${notice.id}/packing-list`, { version: notice.version, rows: [...hidesRows(['A']), ...hidesRows(['A'])] })
    expect(twice.status).toBe(400)
    expect(twice.body.error.issues[0].path).toBe('body/rows/1/hideNumber')
  })

  it('reads the tannery’s sheet with a verdict per row before anything is kept, then keeps it', async () => {
    const header = 'Numero pelle;Superficie;UM;Riga;Scelta;Spessore;Bagno'
    const bad = await as(anna, 'POST', `/portal/ship-notices/${notice.id}/packing-list/sheet`, { version: notice.version, fileName: 'distinta.csv', content: csv([header, '2231-001;21;FT2;10;A;1,2;2231', '2231-002;21x;FT2;10;A;1,2;2231']), numberFormat: 'it', apply: true })
    expect(bad).toMatchObject({ applied: false, unreadable: 1, verdict: null })
    expect(bad.rows[1]).toMatchObject({ rowNumber: 3, errors: [expect.objectContaining({ column: 'area' })] })
    expect(bad.rows[0]).toMatchObject({ rowNumber: 2, hideNumber: '2231-001', verdict: 'OK' })
    const rows = ['2231-001;21;FT2;10;A;1,2;2231', '2231-002;21;FT2;10;A;1,25;2231', '2231-003;21;FT2;10;A;1,2;2231', '2231-004;21;FT2;10;B;1,2;2231', '2231-005;21;FT2;10;A;1,2;2231']
    const dry = await as(anna, 'POST', `/portal/ship-notices/${notice.id}/packing-list/sheet`, { version: notice.version, fileName: 'distinta.csv', content: csv([header, ...rows]), numberFormat: 'it', apply: false })
    expect(dry).toMatchObject({ applied: false, unreadable: 0, verdict: 'NOT_AS_ORDERED', page: null })
    expect(dry.rows.map((row: Json) => row.verdict)).toEqual(['OK', 'OK', 'OK', 'NOT_AS_ORDERED', 'OK'])
    // Nothing of the dry run was kept: the list typed by hand is still there.
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM "ShipNoticeHide" WHERE "shipNoticeId" = $1 AND grade = $2', [notice.id, 'B'])).n).toBe(1)
    expect((await one<{ hide: string }>('SELECT "hideNumber" AS hide FROM "ShipNoticeHide" WHERE "shipNoticeId" = $1 AND grade = $2', [notice.id, 'B'])).hide).toBe('2231-003')
    const kept = await as(anna, 'POST', `/portal/ship-notices/${notice.id}/packing-list/sheet`, { version: notice.version, fileName: 'distinta.csv', content: csv([header, ...rows]), numberFormat: 'it', apply: true })
    expect(kept.applied).toBe(true)
    notice = kept.page.notice
    expect(notice.lines[0].hides.map((hide: Json) => [hide.hideNumber, hide.thicknessMm, hide.verdict])).toContainEqual(['2231-004', '1.2', 'NOT_AS_ORDERED'])
    // The template is the same list without the notice column.
    const template = await anna.send('GET', '/portal/ship-notices/template?format=csv&numberFormat=it')
    expect(template.status).toBe(200)
    expect(template.response.headers['content-type']).toMatch(/^text\/csv/)
    expect(String(template.response.body).split('\r\n')[0]).not.toMatch(/notice/i)
  })

  it('sends it only with a note for what is not as ordered, numbered from the ASN series', async () => {
    const held = await call(anna, 'POST', `/portal/ship-notices/${notice.id}/send`, { version: notice.version })
    expect(held.status).toBe(400)
    expect(held.body.error.issues.map((issue: Json) => issue.path)).toContain('body/note')
    expect((await call(vito, 'POST', `/portal/ship-notices/${notice.id}/send`, { version: notice.version, note: 'x' })).status).toBe(403)
    const sent = await as(anna, 'POST', `/portal/ship-notices/${notice.id}/send`, { version: notice.version, note: 'Hide 2231-004 is grade B, as agreed by phone.' })
    notice = sent.notice
    expect(notice).toMatchObject({ status: 'SENT', state: 'ANNOUNCED', number: expect.stringMatching(/^ASN-\d{4}-\d{4}$/), note: 'Hide 2231-004 is grade B, as agreed by phone.' })
    expect(sent.done.en).toMatch(new RegExp(`Delivery announced as ${notice.number}\\. We expect it on ${addDays(today(), 3)} at `))
    const events = await outboxOf(notice.id, 'ship_notice.sent')
    expect(events).toEqual([expect.objectContaining({ payload: expect.objectContaining({ number: notice.number, partyId: P2, lines: 2, hides: 5, verdict: 'NOT_AS_ORDERED' }) })])
    const audit = await one<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.shipNoticeSend'`, [notice.id])
    expect(audit.after).toMatchObject({ byPartner: true, byName: 'anna orders', number: notice.number })
    // Sent, its lines are no longer open for another notice.
    const shippable = await as(anna, 'GET', `/portal/ship-notices/shippable?purchaseOrderId=${order.id}`)
    expect(shippable.orders).toEqual([])
    const list = await as(anna, 'GET', '/portal/ship-notices')
    expect(list.items).toContainEqual(expect.objectContaining({ id: notice.id, state: 'ANNOUNCED', lines: 2, hides: 5, carrier: 'Made-up Freight' }))
    const home = await as(anna, 'GET', '/portal/home')
    expect(home.counts).toContainEqual(expect.objectContaining({ key: 'deliveries.on_the_way', value: 1 }))
  })

  it('puts it on the inbound board on its day, and gives the dock the receipt prefilled with each hide’s declared area', async () => {
    const board = await as(dock, 'GET', `/inventory/receiving/inbound?siteId=${siteA1}`)
    expect(board.days).toHaveLength(7)
    const card = board.cards.find((entry: Json) => entry.id === `asn:${notice.id}`)
    expect(card).toMatchObject({ kind: 'SHIP_NOTICE', day: addDays(today(), 3), late: false, purchaseOrder: { id: order.id }, lines: 2, shipNotice: { number: notice.number, state: 'ANNOUNCED', carrier: 'Made-up Freight', trackingNumber: 'MF-000123', hides: 5, verdict: 'NOT_AS_ORDERED' } })
    // The order's lines are on the notice's card, not on an order card of their own.
    expect(board.cards.filter((entry: Json) => entry.kind === 'ORDER' && entry.purchaseOrder.id === order.id)).toEqual([])
    const noted = await as(dock, 'PATCH', `/inventory/receiving/ship-notices/${notice.id}`, { version: notice.version, dockNote: 'Bay 2, forklift needed' })
    expect(noted.dockNote).toBe('Bay 2, forklift needed')
    const read = await as(dock, 'GET', `/inventory/receiving/ship-notices/${notice.id}`)
    expect(read).toMatchObject({ canReceive: true, receiveHeld: null, notice: { dockNote: 'Bay 2, forklift needed', supplier: { id: P2 } } })
    const leatherPrefill = read.prefill.lines.find((line: Json) => line.purchaseOrderLineId === leatherLine.purchaseOrderLineId)
    expect(leatherPrefill).toMatchObject({ quantity: null, lots: [{ supplierLotRef: 'L-77', dyeBatch: '2231', hides: expect.arrayContaining([{ supplierCode: '2231-002', area: '21.0000', areaUom: 'FT2', grade: 'A', thicknessMm: '1.25' }]) }] })
    expect(read.prefill.lines.find((line: Json) => line.purchaseOrderLineId === protectorLine.purchaseOrderLineId)).toMatchObject({ quantity: null, lots: [{ supplierLotRef: 'PR-12', quantity: '24.0000', hides: [] }] })
    // The supplier never reads our dock note.
    expect(priceTraces(await as(anna, 'GET', `/portal/ship-notices/${notice.id}`))).toEqual([])
  })

  let receiptId: string
  it('receives from it: the notice is RECEIVED in the receipt’s own command, with the lines that differ', async () => {
    const read = await as(dock, 'GET', `/inventory/receiving/ship-notices/${notice.id}`)
    const lines = read.prefill.lines.map((line: Json) => ({
      purchaseOrderLineId: line.purchaseOrderLineId,
      ...(line.quantity ? { quantity: line.quantity } : {}),
      lots: line.lots.map((lot: Json) => ({
        ...(lot.supplierLotRef ? { supplierLotRef: lot.supplierLotRef } : {}),
        ...(lot.dyeBatch ? { dyeBatch: lot.dyeBatch } : {}),
        ...(lot.quantity ? { quantity: lot.quantity } : {}),
        // One hide did not come: four of five.
        ...(lot.hides.length > 0 ? { hides: lot.hides.slice(0, 4).map((hide: Json) => ({ supplierCode: hide.supplierCode, area: hide.area, areaUom: hide.areaUom, ...(hide.grade ? { grade: hide.grade } : {}), ...(hide.thicknessMm ? { thicknessMm: hide.thicknessMm } : {}) })) } : {}),
      })),
    }))
    const answer = await as(dock, 'POST', '/inventory/receipts', { purchaseOrderId: order.id, shipNoticeId: notice.id, supplierDdtNumber: read.prefill.supplierDdtNumber, supplierDdtDate: read.prefill.supplierDdtDate, lines }, 201)
    receiptId = answer.receipt.id
    expect(answer.receipt.status).toBe('POSTED')
    expect(await one(`SELECT status, "receivedAt" IS NOT NULL AS received FROM "ShipNotice" WHERE id = $1`, [notice.id])).toEqual({ status: 'RECEIVED', received: true })
    expect(await admin(`SELECT seq, "receivedQuantity"::text AS got FROM "ShipNoticeLine" WHERE "shipNoticeId" = $1 ORDER BY seq`, [notice.id])).toEqual([
      { seq: 10, got: '84.0000' },
      { seq: 20, got: '24.0000' },
    ])
    expect(await one(`SELECT "shipNoticeId" FROM "GoodsReceipt" WHERE id = $1`, [receiptId])).toEqual({ shipNoticeId: notice.id })
    expect(await outboxOf(notice.id, 'ship_notice.received')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ receiptId, lines: 2, differing: 1 }) })])
    const page = await as(anna, 'GET', `/portal/ship-notices/${notice.id}`)
    expect(page.notice).toMatchObject({ status: 'RECEIVED', state: 'RECEIVED_WITH_DIFFERENCES', words: { en: 'Received with differences' } })
    expect(page.notice.differing).toHaveLength(1)
    expect(page.canEdit).toBe(false)
    // A received notice takes no second receipt, and changes no more.
    const again = await call(dock, 'POST', '/inventory/receipts', { purchaseOrderId: order.id, shipNoticeId: notice.id, lines: [{ purchaseOrderLineId: protectorLine.purchaseOrderLineId, lots: [{ quantity: '1' }] }] })
    expect(again.status).toBe(409)
    expect(again.body.error.message).toMatch(/received already/)
    expect((await call(anna, 'PATCH', `/portal/ship-notices/${notice.id}`, { version: page.notice.version, carrier: 'Other' })).status).toBe(409)
    // Off the board once received.
    expect((await as(dock, 'GET', `/inventory/receiving/inbound?siteId=${siteA1}`)).cards.some((entry: Json) => entry.id === `asn:${notice.id}`)).toBe(false)
  })

  it('waits for the goods again when that receipt is reversed, and the supplier may then cancel it', async () => {
    const receipt = await as(dock, 'GET', `/inventory/receipts/${receiptId}`)
    await as(dock, 'POST', `/inventory/receipts/${receiptId}/reverse`, { version: receipt.receipt.version, reason: 'Booked on the wrong order' }, 201)
    expect(await one(`SELECT status, "receivedAt" FROM "ShipNotice" WHERE id = $1`, [notice.id])).toEqual({ status: 'SENT', receivedAt: null })
    expect((await admin(`SELECT "receivedQuantity" FROM "ShipNoticeLine" WHERE "shipNoticeId" = $1`, [notice.id])).every((line) => line.receivedQuantity === null)).toBe(true)
    expect(await outboxOf(notice.id, 'ship_notice.reopened')).toHaveLength(1)
    const page = await as(anna, 'GET', `/portal/ship-notices/${notice.id}`)
    expect(page.notice.status).toBe('SENT')
    expect((await call(anna, 'POST', `/portal/ship-notices/${notice.id}/cancel`, { version: page.notice.version })).status).toBe(400)
    const cancelled = await as(anna, 'POST', `/portal/ship-notices/${notice.id}/cancel`, { version: page.notice.version, reason: 'The truck broke down; we announce it again.' })
    expect(cancelled).toMatchObject({ removed: false, page: { notice: { status: 'CANCELLED', state: 'CANCELLED', cancelReason: 'The truck broke down; we announce it again.' } } })
    expect(await outboxOf(notice.id, 'ship_notice.cancelled')).toHaveLength(1)
    // Its lines are open again.
    const shippable = await as(anna, 'GET', `/portal/ship-notices/shippable?purchaseOrderId=${order.id}`)
    expect(shippable.orders[0].lines.find((line: Json) => line.seq === 10).open).toBe('105.0000')
  })

  it('removes a draft on cancel, and refuses the send while a required document is missing (B-W2b-177)', async () => {
    const page = await as(anna, 'POST', '/portal/ship-notices', { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: protectorLine.purchaseOrderLineId, quantity: '24' }], shipDate: addDays(today(), 2), expectedDate: addDays(today(), 4) }, 201)
    const rule = newId()
    await admin(`INSERT INTO "RequiredDocumentRule" (id, "tenantId", "companyId", "recordType", category, "beforeStatus", level) VALUES ($1, $2, $3, 'ShipNotice', 'TEST_REPORT', 'SENT', 'BLOCK')`, [rule, tenant, companyA])
    const view = await as(anna, 'GET', `/portal/ship-notices/${page.notice.id}`)
    expect(view.canSend).toBe(false)
    expect(view.sendHeld.join(' ')).toMatch(/test report/i)
    const blocked = await call(anna, 'POST', `/portal/ship-notices/${page.notice.id}/send`, { version: page.notice.version })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.message).toMatch(/cannot move to/)
    await admin(`DELETE FROM "RequiredDocumentRule" WHERE id = $1`, [rule])
    const removed = await as(anna, 'POST', `/portal/ship-notices/${page.notice.id}/cancel`, { version: page.notice.version })
    expect(removed).toEqual({ removed: true, page: null })
    expect(await admin(`SELECT id FROM "ShipNotice" WHERE id = $1`, [page.notice.id])).toEqual([])
  })
})

describe('the inbound board shows confirmed orders without a notice (SCM-110)', () => {
  it('draws an order card on its expected day, nothing for a day without deliveries, never a price', async () => {
    const order = await confirmedOrder()
    const board = await as(dock, 'GET', `/inventory/receiving/inbound?siteId=${siteA1}&days=14`)
    const cards = board.cards.filter((entry: Json) => entry.purchaseOrder.id === order.id)
    expect(cards).toEqual([expect.objectContaining({ kind: 'ORDER', day: addDays(today(), 10), shipNotice: null, lines: 2, dockNote: null })])
    expect(cards[0].items.map((item: Json) => [item.quantity, item.uom])).toEqual([
      ['105.0000', 'FT2'],
      ['24.0000', 'PCS'],
    ])
    expect(JSON.stringify(board)).not.toMatch(/price|amount|cost/i)
    // A buyer without inventory.receive reads the board; a supplier never reaches it.
    expect((await call(buyer, 'GET', '/inventory/receiving/inbound')).status).toBe(200)
    expect((await call(anna, 'GET', '/inventory/receiving/inbound')).status).toBe(401)
  })
})

describe('a packing list mailed to our dock: the imports registry\u2019s packing list onto a sent notice (SCM-107)', () => {
  const actor = (permissions: string[]) => ({ audience: 'office' as const, tenantId: tenant, grants: [{ permissions: permissions as never[], companies: 'all' as const, sites: 'all' as const, parties: 'all' as const }] })
  const office = <T>(work: (client: any) => Promise<T>) => h.database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, work)

  it('checks each row against its notice, writes a hide once, and refuses a draft or a person without inventory.receive', async () => {
    const order = await confirmedOrder()
    const shippable = await as(anna, 'GET', `/portal/ship-notices/shippable?purchaseOrderId=${order.id}`)
    const line = shippable.orders[0].lines.find((entry: Json) => entry.seq === 10)
    const draft = await as(anna, 'POST', '/portal/ship-notices', { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: line.purchaseOrderLineId, quantity: '40', dyeBatch: '3001' }], shipDate: addDays(today(), 1), expectedDate: addDays(today(), 2) }, 201)
    const sent = await as(anna, 'POST', `/portal/ship-notices/${draft.notice.id}/send`, { version: draft.notice.version })
    const number = sent.notice.number as string
    const row = { rowNumber: 2, key: { notice: number, hideNumber: 'M-001' }, values: { notice: number, hideNumber: 'M-001', area: '20.5', unit: 'FT2', grade: 'A', dyeBatch: '3001' } }
    const scope = { companyId: companyA }
    expect(await office((client) => packingListImportAdapter.check!(client, [row], scope, actor(['inventory.receive'])))).toEqual([[]])
    const noRight = await office((client) => packingListImportAdapter.check!(client, [row], scope, actor(['inventory.stock.view'])))
    expect(noRight[0]![0]!.message).toMatch(/inventory.receive/)
    const other = await office((client) => packingListImportAdapter.check!(client, [{ ...row, key: { notice: 'ASN-1999-0001', hideNumber: 'X' } }], scope, actor(['inventory.receive'])))
    expect(other[0]![0]!.message).toMatch(/not a notice of this company/)
    expect(packingListImportAdapter.authorize!(actor(['inventory.receive']) as never, { companyId: null }, [])).toHaveLength(1)
    await command(callerFor(h.database, systemContext(tenant, newId())), { name: 'test.importPackingList', input: { number } }, async (tools) =>
      packingListImportAdapter.write(tools, { action: 'CREATE', key: row.key, recordId: null, before: {}, values: row.values }, scope),
    )
    const loaded = await office((client) => packingListImportAdapter.load(client, [row.key], scope))
    expect(loaded).toEqual([expect.objectContaining({ values: expect.objectContaining({ notice: number, hideNumber: 'M-001', area: '20.5', unit: 'FT2', line: 10 }) })])
    expect(await outboxOf(draft.notice.id, 'ship_notice.changed')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ what: 'PACKING_LIST' }) })])
    // The supplier sees the hide on its notice, judged like any other.
    const page = await as(anna, 'GET', `/portal/ship-notices/${draft.notice.id}`)
    expect(page.notice.lines[0].hides.map((hide: Json) => hide.hideNumber)).toEqual(['M-001'])
  })
})
