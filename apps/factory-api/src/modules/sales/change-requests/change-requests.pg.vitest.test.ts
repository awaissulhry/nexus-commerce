import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { partnerFanOut } from '../../../platform/portal/notifications/fan-out'
import { unsubscribeKeyOf } from '../../../platform/portal/notifications/mail'
import { today } from '../../insights/today'
import { acceptRequest, officeList, officeRecord, refuseRequest } from './office'
import { getCutoffs, saveCutoffs } from './settings'

/**
 * Change and cancel requests from the portal on the local stack (B-W2b-183; SAL-077, SAL-078), the customer through the real
 * app and portal sign-in by code, the office through its functions (the routes' manifest is the live check's): the factory-db
 * seeds up to shipping and the reason lists (SEED-SO-0001 two free lines; SEED-SO-0002 whose BLK line had leather cut on
 * 30 Oct (WO-0001); SEED-SO-0003 in work order WO-0003 with its shipment SH-0002 still a DRAFT), the customer's portal and
 * another customer's switched on; the customer's buyer and viewer, the other customer's buyer; an office person. Every name,
 * number and price is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/change-requests`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'change-requests-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const orderOf = (number: string) => one<{ id: string; version: number; status: string }>('SELECT id, version, status::text AS status FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, number])
const linesOf = (orderId: string) => admin<{ id: string; seq: number }>('SELECT id, seq FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq', [orderId])

const people = { buyer: 'bea.buyer@seed-racing.example', viewer: 'vic.viewer@seed-racing.example', other: 'oli.buyer@brand-alpha.example' }
const browsers = {} as Record<keyof typeof people, Browser>
const partnerIds = {} as Record<keyof typeof people, string>
let officeId: string

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
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

async function ok(browser: Browser, url: string): Promise<Json> {
  const answer = await browser.get(url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}

const office = (permissions: Permission[] = ['orders.view', 'orders.manage', 'home.view', 'sales.settings.manage']) =>
  callerFor(h.database, { audience: 'office', tenantId: T, actorId: officeId, requestId: newId(), grants: [{ permissions, companies: 'all', sites: 'all', parties: 'all' }] })
const viewOnly = () => office(['orders.view', 'home.view'])
const thrown = async (work: Promise<unknown>): Promise<Json> => {
  try {
    await work
  } catch (error) {
    return error as Json
  }
  throw new Error('expected a refusal')
}
const outbox = (type: string) => admin<{ id: string; type: string; payload: Json; companyId: string | null }>('SELECT id, type, payload, "companyId" FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])
const TODAY = () => businessDate(h.clock.now())

beforeAll(async () => {
  h = await startHarness('order_changes')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  officeId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    await client.user.create({ data: { id: officeId, email: 'otto.office@seed-a.example', displayName: 'Otto Office', status: 'ACTIVE' }, select: { id: true } })
    // The portal's mail sender (as tenant set-up makes it): a FAKE SES account and company A's NOTIFICATION identity.
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  world = await portalWorld(h, tenant)
  freshGuard(h)
  partnerIds.buyer = await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-comment', 'partner-upload', 'partner-approve'])
  partnerIds.viewer = await partnerPerson(people.viewer, P1, ['customer-viewer'])
  partnerIds.other = await partnerPerson(people.other, world.partyId, ['customer-buyer'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
}, 240_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('the rules before the click (SAL-078)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('shows per line what may change or be cancelled, and holds the line whose leather was cut', async () => {
    const so2 = await orderOf('SEED-SO-0002')
    const rules = await ok(browsers.buyer, `/portal/sales-orders/${so2.id}/change-requests/rules`)
    expect(rules.order).toMatchObject({ number: 'SEED-SO-0002', status: 'CONFIRMED' })
    expect(rules.change.code).toBe('FREE')
    // A cancel after cutting started is refused for the whole order, with the day of the first cut.
    expect(rules.cancel).toMatchObject({ possible: false, code: 'LEATHER_CUT', day: '2026-10-30', words: { en: 'Not possible: the leather was cut on 30 Oct', it: 'Non possibile: la pelle è stata tagliata il 30 ott' } })
    expect(rules.lines.map((line: Json) => [line.seq, line.change.code, line.cancel.code])).toEqual([
      [10, 'LEATHER_CUT', 'LEATHER_CUT'],
      [20, 'FREE', 'FREE'],
    ])
    expect(rules.lines[0].style).toMatchObject({ code: 'SEED-JKT-02' })
    expect(rules.lines[0].sizes.map((size: Json) => [size.size, size.quantity, size.offered])).toEqual([
      ['50', 1, true],
      ['52', 2, true],
      ['54', 1, true],
    ])
    expect(rules.reasons.map((reason: Json) => reason.code)).toContain('LEAD_TIME')
    expect(rules.addresses.map((address: Json) => address.label)).toEqual([expect.stringContaining('Seed Racing workshop')])
    expect(rules).toMatchObject({ noWithdrawal: null, openRequestId: null })
  })

  it('is the buyer’s only: the viewer cannot ask (403), another customer does not see the order (404)', async () => {
    const so1 = await orderOf('SEED-SO-0001')
    expect((await browsers.viewer.get(`/portal/sales-orders/${so1.id}/change-requests/rules`)).status).toBe(403)
    expect((await browsers.other.get(`/portal/sales-orders/${so1.id}/change-requests/rules`)).status).toBe(404)
    expect((await browsers.other.post(`/portal/sales-orders/${so1.id}/change-requests`, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })).status).toBe(404)
  })

  it('applies the cut-off settings the office saves (whole row of the tenant here)', async () => {
    const settings = await getCutoffs(office(), {})
    expect(settings).toMatchObject({ source: 'TENANT', inForce: { cancelCutoffStatus: null, cancelCutoffDays: null, changeCutoffStatus: null } })
    expect((await thrown(saveCutoffs(viewOnly(), { version: settings.row!.version, cancelCutoffStatus: 'IN_PRODUCTION', cancelCutoffDays: 365, changeCutoffStatus: 'CONFIRMED' }, undefined, h.clock))).code).toBe('forbidden')
    const saved = await saveCutoffs(office(), { version: settings.row!.version, cancelCutoffStatus: 'IN_PRODUCTION', cancelCutoffDays: 365, changeCutoffStatus: 'CONFIRMED' }, undefined, h.clock)
    expect(saved.inForce).toEqual({ cancelCutoffStatus: 'IN_PRODUCTION', cancelCutoffDays: 365, changeCutoffStatus: 'CONFIRMED' })
    const so1 = await orderOf('SEED-SO-0001')
    const rules = await ok(browsers.buyer, `/portal/sales-orders/${so1.id}/change-requests/rules`)
    expect(rules.change).toMatchObject({ code: 'STATUS', words: { en: 'Not possible from the portal: write to us on the order' } })
    expect(rules.cancel).toMatchObject({ code: 'DAYS', words: { en: expect.stringContaining('Not possible within 365 days of the delivery date') } })
    // At the click too, in words (409, the rule's code in the path).
    const refused = await browsers.buyer.post(`/portal/sales-orders/${so1.id}/change-requests`, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('body/DAYS')
    // Back to no rule for the flows below.
    expect((await thrown(saveCutoffs(office(), { version: saved.row!.version - 1, cancelCutoffStatus: null, cancelCutoffDays: null, changeCutoffStatus: null }, undefined, h.clock))).code).toBe('conflict')
    await saveCutoffs(office(), { version: saved.row!.version, cancelCutoffStatus: null, cancelCutoffDays: null, changeCutoffStatus: null }, undefined, h.clock)
  })
})

describe('a change asked, seen in Approvals and accepted as an amendment (SAL-077)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('refuses in words what the rules hold, a size the style does not make, a second open request', async () => {
    const so2 = await orderOf('SEED-SO-0002')
    const [blk] = await linesOf(so2.id)
    const held = await browsers.buyer.post(`/portal/sales-orders/${so2.id}/change-requests`, { kind: 'CHANGE', cells: [{ lineId: blk!.id, size: '52', quantity: 3 }] })
    expect(held.status).toBe(409)
    expect(held.body.error.issues).toEqual([{ path: 'body/cells/0/LEATHER_CUT', message: 'Not possible: the leather was cut on 30 Oct.' }])
    const so1 = await orderOf('SEED-SO-0001')
    const [line10] = await linesOf(so1.id)
    const size = await browsers.buyer.post(`/portal/sales-orders/${so1.id}/change-requests`, { kind: 'CHANGE', cells: [{ lineId: line10!.id, size: '56', quantity: 1 }] })
    expect(size.status).toBe(400)
    expect(size.body.error.issues[0].path).toBe('body/cells/0/size')
    const mixed = await browsers.buyer.post(`/portal/sales-orders/${so1.id}/change-requests`, { kind: 'CHANGE', reasonCode: 'LEAD_TIME', cells: [] })
    expect(mixed.status).toBe(400)
  })

  it('takes the change, shows it to both customer roles and in the office’s Approvals, then the amendment applies it', async () => {
    const so1 = await orderOf('SEED-SO-0001')
    const [blk, red] = await linesOf(so1.id)
    const address = (await ok(browsers.buyer, `/portal/sales-orders/${so1.id}/change-requests/rules`)).addresses[0]
    const wanted = addDays(TODAY(), 50)
    const asked = await browsers.buyer.post(`/portal/sales-orders/${so1.id}/change-requests`, { kind: 'CHANGE', cells: [{ lineId: blk!.id, size: '52', quantity: 6 }, { lineId: red!.id, size: '54', quantity: 0 }], requestedDate: wanted, shipToAddressId: address.id, note: 'Our season starts earlier.' }, { headers: { 'idempotency-key': 'change-request-so1-1' } })
    expect(asked.status, JSON.stringify(asked.body)).toBe(201)
    const request = asked.body.request
    expect(request).toMatchObject({ kind: 'CHANGE', status: 'OPEN', words: { en: 'Waiting for our answer' }, orderNumber: 'SEED-SO-0001', requestedDate: wanted, mine: true, wholeOrder: false, note: 'Our season starts earlier.' })
    expect(request.cells.map((cell: Json) => [cell.seq, cell.size, cell.before, cell.asked])).toEqual([
      [10, '52', 4, 6],
      [20, '54', 1, 0],
    ])
    // A repeated key answers the same; a second request while one waits is refused.
    const again = await browsers.buyer.post(`/portal/sales-orders/${so1.id}/change-requests`, { kind: 'CHANGE', cells: [{ lineId: blk!.id, size: '52', quantity: 6 }, { lineId: red!.id, size: '54', quantity: 0 }], requestedDate: wanted, shipToAddressId: address.id, note: 'Our season starts earlier.' }, { headers: { 'idempotency-key': 'change-request-so1-1' } })
    expect(again.body.request.id).toBe(request.id)
    const second = await browsers.buyer.post(`/portal/sales-orders/${so1.id}/change-requests`, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })
    expect(second.status).toBe(409)
    expect(second.body.error.issues[0].path).toBe('body/OPEN_REQUEST')
    expect((await ok(browsers.viewer, `/portal/sales-orders/${so1.id}/change-requests`)).items.map((row: Json) => [row.id, row.mine])).toEqual([[request.id, false]])
    expect((await outbox('order_change_request.asked')).map((row) => row.payload)).toEqual([{ requestId: request.id, orderId: so1.id, partyId: P1, kind: 'CHANGE', lines: 2, wholeOrder: false }])
    // The order's timeline: an audit row on the order.
    expect((await admin('SELECT action FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2', ['SalesOrder', so1.id])).map((row) => row.action)).toContain('orders.changeRequestAsked')

    // Home › Approvals: the office person who manages the customer's orders; not one who only reads them.
    const approvals = await today(office(), { kind: 'ORDER_CHANGE_REQUEST', limit: 50 })
    expect(approvals.items.map((item: Json) => [item.record.label, item.category, item.decide])).toEqual([['SEED-SO-0001', 'APPROVAL', 'OPEN']])
    expect(JSON.stringify(approvals.items[0])).toContain('asks to change 2 sizes of order SEED-SO-0001.')
    expect((await today(viewOnly(), { kind: 'ORDER_CHANGE_REQUEST', limit: 50 })).items).toEqual([])

    const list = await officeList(office(), { status: 'OPEN', limit: 50, offset: 0 }, h.clock.now())
    expect(list.counts).toMatchObject({ OPEN: 1 })
    expect(list.items[0]).toMatchObject({ id: request.id, askedBy: 'bea.buyer', mayAnswer: true, party: { id: P1 } })
    const record = await officeRecord(office(), request.id, h.clock.now())
    expect(record.preview).toMatchObject({ ok: true, problems: [], cancel: null })
    expect(record.preview!.amendment!.reacceptanceNeeded).toBe(true)
    expect(record.preview!.amendment!.lines.map((line: Json) => [line.seq, line.piecesBefore, line.piecesAfter])).toEqual([
      [10, 8, 10],
      [20, 4, 3],
    ])
    expect((await officeRecord(viewOnly(), request.id, h.clock.now())).preview).toBeNull()

    // Accept: a stale version is refused; then the amendment, the new date and address, the request ACCEPTED naming it.
    expect((await thrown(acceptRequest(office(), request.id, { version: 2 }, undefined, h.clock))).code).toBe('conflict')
    expect((await thrown(acceptRequest(viewOnly(), request.id, { version: 1 }, undefined, h.clock))).code).toBe('forbidden')
    const accepted = await acceptRequest(office(), request.id, { version: 1, answer: 'Done: the new date holds.' }, undefined, h.clock)
    expect(accepted.request).toMatchObject({ status: 'ACCEPTED', answer: 'Done: the new date holds.', answeredBy: 'Otto Office', amendment: { revision: 1 }, mayAnswer: false })
    const order = await one('SELECT "requestedDate"::text AS requested, "reapprovalNeededAt" IS NOT NULL AS reaccept, "shipTo"->>\'name\' AS ship FROM "SalesOrder" WHERE id = $1', [so1.id])
    expect(order).toEqual({ requested: wanted, reaccept: true, ship: 'Seed Racing workshop' })
    expect(await admin('SELECT l.seq, s.size, s.quantity FROM "SalesOrderLineSize" s JOIN "SalesOrderLine" l ON l.id = s."lineId" WHERE l."orderId" = $1 ORDER BY l.seq, s.size', [so1.id])).toEqual([
      { seq: 10, size: '50', quantity: 2 },
      { seq: 10, size: '52', quantity: 6 },
      { seq: 10, size: '54', quantity: 2 },
      { seq: 20, size: '50', quantity: 1 },
      { seq: 20, size: '52', quantity: 2 },
    ])
    expect((await today(office(), { kind: 'ORDER_CHANGE_REQUEST', limit: 50 })).items).toEqual([])
    expect((await thrown(acceptRequest(office(), request.id, { version: 2 }, undefined, h.clock))).issues[0].path).toBe('request/ACCEPTED')

    // The customer reads the answer (never who answered) and is told by e-mail.
    const seen = (await ok(browsers.buyer, `/portal/sales-orders/${so1.id}/change-requests`)).items[0]
    expect(seen).toMatchObject({ status: 'ACCEPTED', words: { en: 'Accepted' }, answer: 'Done: the new date holds.' })
    expect('answeredBy' in seen).toBe(false)
    const [event] = await outbox('order_change_request.answered')
    expect(event!.payload).toMatchObject({ answer: 'ACCEPTED', orderCancelled: false, kind: 'CHANGE' })
    const made = await partnerFanOut(callerFor(h.database, systemContext(T, `test-${newId()}`)), { eventId: event!.id, type: event!.type, tenantId: T, companyId: event!.companyId, siteId: null, payload: event!.payload } as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
    expect(made).toBe(2)
    expect((await admin('SELECT "userId", "messageKey" FROM "Notification" WHERE "partyId" = $1 ORDER BY "userId"', [P1])).map((row) => row.messageKey)).toEqual(['portal.order.change_accepted', 'portal.order.change_accepted'])
    expect(h.ses.mails.filter((mail) => mail.templateKey === 'portal.notification' && mail.to[0] === people.buyer)).toHaveLength(1)
    expect(h.ses.mails.filter((mail) => mail.templateKey === 'portal.notification' && mail.to[0] === people.other)).toHaveLength(0)
  })
})

describe('a cancel asked, withdrawn, refused (SAL-078)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lets the buyer withdraw it while it waits; the office can no longer answer it', async () => {
    const so3 = await orderOf('SEED-SO-0003')
    const asked = await browsers.buyer.post(`/portal/sales-orders/${so3.id}/change-requests`, { kind: 'CANCEL', reasonCode: 'OTHER' })
    expect(asked.status).toBe(400)
    expect(asked.body.error.issues[0]).toEqual({ path: 'body/note', message: 'Say why in a few words.' })
    const made = await browsers.buyer.post(`/portal/sales-orders/${so3.id}/change-requests`, { kind: 'CANCEL', reasonCode: 'OTHER', note: 'The event was called off.' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.request).toMatchObject({ kind: 'CANCEL', wholeOrder: true, reasonCode: 'OTHER', cells: [] })
    const id = made.body.request.id
    expect((await browsers.viewer.post(`/portal/sales-orders/${so3.id}/change-requests/${id}/withdraw`, { version: 1 })).status).toBe(403)
    const withdrawn = await browsers.buyer.post(`/portal/sales-orders/${so3.id}/change-requests/${id}/withdraw`, { version: 1 })
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200)
    expect(withdrawn.body.request).toMatchObject({ status: 'WITHDRAWN', words: { en: 'Withdrawn' } })
    expect((await thrown(refuseRequest(office(), id, { version: 2, answer: 'No.' }, undefined, h.clock))).issues[0].path).toBe('request/WITHDRAWN')
  })

  it('stops a whole-order cancel the order’s own cancel refuses (a shipment drafted), and refuses it with words', async () => {
    const so3 = await orderOf('SEED-SO-0003')
    const made = await browsers.buyer.post(`/portal/sales-orders/${so3.id}/change-requests`, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.request.id
    const record = await officeRecord(office(), id, h.clock.now())
    expect(record.preview!.ok).toBe(false)
    expect(record.preview!.cancel!.cancellable).toBe(false)
    const blocked = await thrown(acceptRequest(office(), id, { version: 1 }, undefined, h.clock))
    expect(blocked.code).toBe('invalid_state')
    // Nothing moved: the order and the request as they were.
    expect((await orderOf('SEED-SO-0003')).status).toBe('CONFIRMED')
    expect((await thrown(refuseRequest(office(), id, { version: 1, answer: '  ' }, undefined, h.clock))).code).toBe('validation_failed')
    const refused = await refuseRequest(office(), id, { version: 1, answer: 'The goods are packed for you already.' }, undefined, h.clock)
    expect(refused.request).toMatchObject({ status: 'REFUSED', answer: 'The goods are packed for you already.' })
    const seen = (await ok(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests`)).items
    expect(seen.map((row: Json) => row.status)).toEqual(['REFUSED', 'WITHDRAWN'])
  })

  it('accepts a cancel of one free line by closing it short with the reason asked; the line stays, nothing more of it is made', async () => {
    const so1 = await orderOf('SEED-SO-0001')
    const [, red] = await linesOf(so1.id)
    const made = await browsers.buyer.post(`/portal/sales-orders/${so1.id}/change-requests`, { kind: 'CANCEL', reasonCode: 'PRICE', lineIds: [red!.id] })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.request.cells).toEqual([expect.objectContaining({ seq: 20, size: null, before: 3, asked: 0 })])
    const record = await officeRecord(office(), made.body.request.id, h.clock.now())
    expect(record.preview).toMatchObject({ ok: true, amendment: null, cancel: null, closes: [{ lineId: red!.id, seq: 20, closedShortQuantity: 3 }] })
    const accepted = await acceptRequest(office(), made.body.request.id, { version: 1 }, undefined, h.clock)
    expect(accepted).toMatchObject({ orderCancelled: false, request: { status: 'ACCEPTED', amendment: null } })
    expect(await admin('SELECT seq, "closedShortQuantity" AS closed, "closedShortReasonCode" AS code FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq', [so1.id])).toEqual([
      { seq: 10, closed: null, code: null },
      { seq: 20, closed: 3, code: 'PRICE' },
    ])
    // A closed line is not asked to be cancelled again.
    const rules = await ok(browsers.buyer, `/portal/sales-orders/${so1.id}/change-requests/rules`)
    expect(rules.lines[1].cancel.code).toBe('CLOSED_SHORT')
  })
})
