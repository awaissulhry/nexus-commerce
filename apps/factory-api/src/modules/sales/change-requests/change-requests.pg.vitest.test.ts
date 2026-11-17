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
// B-PR-25: the customer's own freeze rule (B-PR-14).
import { createFreezeRule } from '../order-changes/freeze'

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
    expect(saved.inForce).toEqual({ cancelCutoffStatus: 'IN_PRODUCTION', cancelCutoffDays: 365, changeCutoffStatus: 'CONFIRMED', cancelFeePct: null })
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
    // B-W2b-F13b (wave 23): the customer asks to deliver to an address its admin added, which waits for our check.
    const address = { id: newId() }
    await admin(
      `INSERT INTO "PartyAddress" (id, "tenantId", "partyId", kinds, name, line1, "postalCode", city, province, country, "approvalStatus", "requestedAt", "requestedByUserId", "createdAt", "updatedAt", "createdById")
       VALUES ($1, $2, $3, '{SHIP_TO}', 'Seed waiting dock', 'Via Esempio 7', '40100', 'Bologna', 'BO', 'IT', 'WAITING', now() - interval '1 day', $4, now() - interval '1 day', now() - interval '1 day', $4)`,
      [address.id, T, P1, partnerIds.buyer],
    )
    expect((await ok(browsers.buyer, `/portal/sales-orders/${so1.id}/change-requests/rules`)).addresses.map((row: Json) => row.id)).toContain(address.id)
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
    expect(order).toEqual({ requested: wanted, reaccept: true, ship: 'Seed waiting dock' })
    // B-W2b-F13b: accepting the request approved the waiting address in the same command (by the office person).
    expect(await one('SELECT "approvalStatus"::text AS approval, "decidedById" IS NOT NULL AS decided FROM "PartyAddress" WHERE id = $1', [address.id])).toEqual({ approval: 'APPROVED', decided: true })
    expect(await admin('SELECT l.seq, s.size, s.quantity FROM "SalesOrderLineSize" s JOIN "SalesOrderLine" l ON l.id = s."lineId" WHERE l."orderId" = $1 ORDER BY l.seq, s.size', [so1.id])).toEqual([
      { seq: 10, size: '50', quantity: 2 },
      { seq: 10, size: '52', quantity: 6 },
      { seq: 10, size: '54', quantity: 2 },
      { seq: 20, size: '50', quantity: 1 },
      { seq: 20, size: '52', quantity: 2 },
    ])
    expect((await today(office(), { kind: 'ORDER_CHANGE_REQUEST', limit: 50 })).items).toEqual([])
    // ── B-PR-12 (schema wave 2/5): a production ask (HOLD; its own words and people come with B-PR-24 and B-PR-27b) never shows
    // as a change request on Home › Approvals. Planted with the triggers off, then taken away again.
    const ask = newId()
    const planted = async (sql: string, values: unknown[]) => {
      await h.db.admin.query('BEGIN')
      try {
        await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
        await h.db.admin.query(sql, values)
        await h.db.admin.query('COMMIT')
      } catch (error) {
        await h.db.admin.query('ROLLBACK')
        throw error
      }
    }
    await planted(
      `INSERT INTO "OrderChangeRequest" SELECT * FROM jsonb_populate_record(NULL::"OrderChangeRequest", (SELECT to_jsonb(r) || $1::jsonb FROM "OrderChangeRequest" r WHERE r.id = $2::uuid))`,
      [JSON.stringify({ id: ask, kind: 'HOLD', status: 'OPEN', answer: null, answeredAt: null, answeredById: null, amendmentId: null, version: 1 }), request.id],
    )
    expect((await today(office(), { kind: 'ORDER_CHANGE_REQUEST', limit: 50 })).items).toEqual([])
    await planted('DELETE FROM "OrderChangeRequest" WHERE id = $1', [ask])
    // ── end B-PR-12
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

describe('the cancel fee (B-W2b-F14, SalesSettings.cancelFeePct): shown, never charged', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const feeOf = (net: number, pct: number) => Math.round((net * pct) / 100)
  const netOf = async (orderId: string) => new Map((await admin<{ id: string; net: number }>('SELECT id, "netAmount" AS net FROM "SalesOrderLine" WHERE "orderId" = $1', [orderId])).map((row) => [row.id, row.net]))

  it('refuses a fee out of range in words; saves 15 %; the cancel pop-up shows the fee per line and for the whole order before the click', async () => {
    const settings = await getCutoffs(office(), {})
    expect(settings).toMatchObject({ inForce: { cancelFeePct: null }, cancelFeeWords: { en: 'Free to cancel' } })
    const base = { version: settings.row!.version, cancelCutoffStatus: null, cancelCutoffDays: null, changeCutoffStatus: null }
    for (const wrong of ['120', '-1', '12.34567', 'fifteen']) {
      const refusal = await thrown(saveCutoffs(office(), { ...base, cancelFeePct: wrong }, undefined, h.clock))
      expect(refusal).toMatchObject({ code: 'validation_failed', message: 'A percentage from 0 to 100, at most 4 decimals, or none (free).', issues: [{ path: 'body/cancelFeePct' }] })
    }
    // Leaving it out changes nothing; naming it saves it.
    const unchanged = await saveCutoffs(office(), base, undefined, h.clock)
    expect(unchanged.inForce.cancelFeePct).toBeNull()
    const saved = await saveCutoffs(office(), { ...base, version: unchanged.row!.version, cancelFeePct: '15' }, undefined, h.clock)
    expect(saved).toMatchObject({ inForce: { cancelFeePct: '15' }, row: { cutoffs: { cancelFeePct: '15' } }, cancelFeeWords: { en: "Fee 15% of the cancelled lines' value", it: 'Penale del 15% sul valore delle righe annullate' } })
    expect((await outbox('sales_settings.changed')).at(-1)!.payload).toMatchObject({ fields: ['cancelFeePct'] })

    const so2 = await orderOf('SEED-SO-0002')
    const net = await netOf(so2.id)
    const rules = await ok(browsers.buyer, `/portal/sales-orders/${so2.id}/change-requests/rules`)
    expect(rules.cancelFee).toMatchObject({ pct: '15', words: { en: "Fee 15% of the cancelled lines' value" }, currency: 'EUR' })
    expect(rules.lines.map((line: Json) => [line.seq, line.cancelFee])).toEqual(rules.lines.map((line: Json) => [line.seq, feeOf(net.get(line.lineId)!, 15)]))
    expect(rules.cancelFee.wholeOrderFee).toBe([...net.values()].reduce((total, value) => total + feeOf(value, 15), 0))
    expect(rules.lines.some((line: Json) => line.cancelFee > 0)).toBe(true)
  })

  it('a waiting cancel shows the fee per line (the amounts only with the price grain); the office’s answer shows it and keeps it on the audit rows', async () => {
    const so2 = await orderOf('SEED-SO-0002')
    const [, free] = await linesOf(so2.id)
    const net = (await netOf(so2.id)).get(free!.id)!
    const made = await browsers.buyer.post(`/portal/sales-orders/${so2.id}/change-requests`, { kind: 'CANCEL', reasonCode: 'PRICE', lineIds: [free!.id] })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const fee = { pct: '15', currency: 'EUR', lines: [{ lineId: free!.id, seq: 20, fee: feeOf(net, 15) }], totalFee: feeOf(net, 15) }
    expect(made.body.request.cancelFee).toMatchObject(fee)
    // The viewer reads the request and the percent, never the amounts (no price grain).
    const seen = (await ok(browsers.viewer, `/portal/sales-orders/${so2.id}/change-requests`)).items[0]
    expect(seen.cancelFee).toEqual({ pct: '15', words: { en: "Fee 15% of the cancelled lines' value", it: 'Penale del 15% sul valore delle righe annullate' }, currency: 'EUR', lines: [{ lineId: free!.id, seq: 20 }] })
    const record = await officeRecord(office(), made.body.request.id, h.clock.now())
    expect(record.request.cancelFee).toMatchObject(fee)
    const accepted = await acceptRequest(office(), made.body.request.id, { version: 1 }, undefined, h.clock)
    expect(accepted).toMatchObject({ orderCancelled: false, request: { status: 'ACCEPTED', cancelFee: null }, cancelFee: fee })
    const audit = await one(`SELECT after FROM "AuditLog" WHERE action = 'orders.acceptChangeRequest' AND "recordId" = $1`, [made.body.request.id])
    expect(audit.after.cancelFee).toEqual({ pct: '15', currency: 'EUR', lines: [{ lineId: free!.id, seq: 20, fee: { $money: 'price', value: feeOf(net, 15) } }], totalFee: { $money: 'price', value: feeOf(net, 15) } })
    // No money moved: no invoice, no credit note for the order.
    expect(await admin('SELECT count(*)::int AS n FROM "Invoice" WHERE "salesOrderId" = $1', [so2.id])).toEqual([{ n: 0 }])
    // A change carries no fee.
    expect((await ok(browsers.buyer, `/portal/sales-orders/${so2.id}/change-requests`)).items.every((row: Json) => row.cancelFee === null)).toBe(true)
  })
})

// ── B-PR-23 (production plan, schema wave 4/5): a production ask is read in words everywhere and answered only in Approvals ────
describe('B-PR-23: a production ask ("Urgent – asked") on the order is read in words, never answered by Sales', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the customer and the office read it; Sales neither accepts nor refuses it; the order page does not withdraw it; it holds no change or cancel', async () => {
    const so3 = await orderOf('SEED-SO-0003')
    const rush = newId()
    const at = h.clock.now()
    const needBy = addDays(TODAY(), 14)
    // Asked in the customer's own scope, as the portal's ask writes it (the portal route takes RUSH from B-PR-25 on).
    await h.database.withScope({ audience: 'partner', tenantId: T, actorId: partnerIds.buyer, partyId: P1 }, (client) =>
      client.orderChangeRequest.create({ data: { id: rush, companyId: companyA, partyId: P1, orderId: so3.id, kind: 'RUSH', reason: 'Our season opens early.', requestedDate: new Date(`${needBy}T00:00:00.000Z`), createdAt: at, updatedAt: at, createdById: partnerIds.buyer }, select: { id: true } }),
    )
    // The customer reads it in words (both roles), with its need-by date; no size, no fee.
    for (const browser of [browsers.buyer, browsers.viewer]) {
      const seen = (await ok(browser, `/portal/sales-orders/${so3.id}/change-requests`)).items.find((row: Json) => row.id === rush)
      expect(seen).toMatchObject({ kind: 'RUSH', kindWords: { en: 'Urgent – asked', it: 'Urgente – richiesto' }, status: 'OPEN', words: { en: 'Waiting for our answer' }, cells: [], wholeOrder: false, requestedDate: needBy, cancelFee: null })
    }
    // The office reads it in its list and record, but answers it in Home › Approvals, not here.
    const list = await officeList(office(), { status: 'OPEN', orderId: so3.id, limit: 50, offset: 0 }, h.clock.now())
    expect(list.items.find((row) => row.id === rush)).toMatchObject({ kind: 'RUSH', kindWords: { en: 'Urgent – asked' }, mayAnswer: false, party: { id: P1 } })
    expect(list.counts).toMatchObject({ OPEN: 1, COUNTERED: 0 })
    expect((await officeRecord(office(), rush, h.clock.now())).preview).toBeNull()
    expect((await thrown(acceptRequest(office(), rush, { version: 1 }, undefined, h.clock))).issues[0].path).toBe('request/PRODUCTION_ASK')
    expect((await thrown(refuseRequest(office(), rush, { version: 1, answer: 'No.' }, undefined, h.clock))).issues[0].path).toBe('request/PRODUCTION_ASK')
    expect((await admin('SELECT status::text AS status FROM "OrderChangeRequest" WHERE id = $1', [rush]))[0]).toEqual({ status: 'OPEN' })
    // It holds no change or cancel of the order: the rules show none waiting, and a cancel is asked beside it…
    expect((await ok(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests/rules`)).openRequestId).toBeNull()
    const cancel = await browsers.buyer.post(`/portal/sales-orders/${so3.id}/change-requests`, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(201)
    // … and one change or cancel still waits at a time, as before.
    expect((await ok(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests/rules`)).openRequestId).toBe(cancel.body.request.id)
    const second = await browsers.buyer.post(`/portal/sales-orders/${so3.id}/change-requests`, { kind: 'CANCEL', reasonCode: 'LEAD_TIME' })
    expect(second.status).toBe(409)
    expect(second.body.error.issues[0].path).toBe('body/OPEN_REQUEST')
    // A production ask is not Sales' row on Home › Approvals (B-PR-26: it goes to the people who answer it, production.brand.manage).
    expect((await today(office(), { kind: 'ORDER_CHANGE_REQUEST', limit: 50 })).items.map((item: Json) => item.record.id ?? item.id)).not.toContain(rush)
    // B-PR-25: a production ask is withdrawn from the order page too while it waits (B-PR-23 sent it to the thread until then).
    const withdraw = await browsers.buyer.post(`/portal/sales-orders/${so3.id}/change-requests/${rush}/withdraw`, { version: 1 })
    expect(withdraw.status, JSON.stringify(withdraw.body)).toBe(200)
    expect(withdraw.body.request).toMatchObject({ id: rush, kind: 'RUSH', status: 'WITHDRAWN' })
    expect((await outbox('order_change_request.withdrawn')).map((row) => row.payload).find((payload) => payload.requestId === rush)).toEqual({ requestId: rush, orderId: so3.id, partyId: P1, kind: 'RUSH' })
  })
})

// ── B-PR-25 (production plan §3 "Brand asks, we decide", "Money"; lead picks L4, L18; review fixes R-09, R-14, R-50; wall test
// PW-P06; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the
// production unit, should be able to see it all. And manage it all as well."): the customer asks the kinds its limits open,
// reads the impact before Send (kept on the request at Send), and the Production role reads no fee. ─────────────────────────
describe('B-PR-25: the asks its limits open, the impact before Send, kept at Send; no fee for the Production role', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const PRODUCTION = 'pia.production@seed-racing.example'
  let production: Browser
  /** Every number anywhere in a value (the impact holds none: never an amount, never a load). */
  const numbersIn = (value: unknown): unknown[] => (typeof value === 'number' ? [value] : Array.isArray(value) ? value.flatMap(numbersIn) : value !== null && typeof value === 'object' ? Object.values(value).flatMap(numbersIn) : [])
  const post = (browser: Browser, url: string, body: unknown) => browser.post(url, body, { headers: { 'idempotency-key': `pr3e-${newId()}` } })
  const replica = async (sql: string, values: unknown[]) => {
    await h.db.admin.query('BEGIN')
    try {
      await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
      await h.db.admin.query(sql, values)
      await h.db.admin.query('COMMIT')
    } catch (error) {
      await h.db.admin.query('ROLLBACK')
      throw error
    }
  }

  beforeAll(async () => {
    await partnerPerson(PRODUCTION, P1, ['customer-production', 'partner-approve'])
    production = await signedIn(PRODUCTION)
  }, 120_000)

  it('RUSH is refused while the urgency switch is off, in neutral words; the list of asks never opens it (R-50); the switch does', async () => {
    const so3 = await orderOf('SEED-SO-0003')
    const closed = await ok(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests/rules`)
    expect(closed.asks.map((ask: Json) => [ask.kind, ask.open, ask.verdict.code])).toEqual([
      ['RUSH', false, 'NOT_OPEN'],
      ['HOLD', false, 'NOT_OPEN'],
      ['RESUME', false, 'NOT_OPEN'],
      ['SPLIT_SHIPMENT', false, 'NOT_OPEN'],
      ['SAMPLE_ROUND', false, 'NOT_OPEN'],
    ])
    const words = { en: "This ask is not open for your orders. Write to us in the order's thread.", it: "Questa richiesta non è disponibile per i vostri ordini. Scriveteci nella conversazione dell'ordine." }
    expect(closed.asks[0].verdict.words).toEqual(words)
    const refused = await post(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests`, { kind: 'RUSH', note: 'Our season opens early.' })
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(refused.body.error.issues).toEqual([{ path: 'body/NOT_OPEN', message: `${words.en}.` }])
    // The asks the limits list are open; RUSH still is not (it follows the urgency switch only).
    await admin(`UPDATE "PortalSettings" SET "productionAskKinds" = '{HOLD,RESUME,SPLIT_SHIPMENT,SAMPLE_ROUND}', version = version + 1 WHERE id = $1`, [P1])
    const listed = await ok(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests/rules`)
    expect(listed.asks.map((ask: Json) => [ask.kind, ask.open])).toEqual([['RUSH', false], ['HOLD', true], ['RESUME', true], ['SPLIT_SHIPMENT', true], ['SAMPLE_ROUND', true]])
    expect((await post(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests/impact`, { kind: 'RUSH' })).status).toBe(409)
    await admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = true, version = version + 1 WHERE id = $1`, [P1])
    const open = await ok(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests/rules`)
    expect(open.asks.map((ask: Json) => [ask.kind, ask.open])).toEqual([['RUSH', true], ['HOLD', true], ['RESUME', true], ['SPLIT_SHIPMENT', true], ['SAMPLE_ROUND', true]])
    // What each kind's own state says: a resume needs a pause; ship what is ready needs an order that ships complete.
    expect(Object.fromEntries(open.asks.map((ask: Json) => [ask.kind, ask.verdict.code]))).toMatchObject({ RUSH: 'FREE', HOLD: 'FREE', RESUME: 'NOT_PAUSED', SAMPLE_ROUND: 'FREE' })
    // Every line says whether it ships first and takes each kind of sample round; every size what its freeze says.
    for (const line of open.lines as Json[]) {
      expect(line.samples.map((entry: Json) => entry.sampleKind)).toEqual(['PRE_PRODUCTION', 'SIZE_SET', 'TOP_OF_PRODUCTION', 'BRAND'])
      for (const entry of line.frozen as Json[]) {
        expect(line.sizes.map((size: Json) => size.size)).toContain(entry.size)
        expect(['OPEN', 'CHANGE_REQUEST', 'BLOCKED']).toContain(entry.freeze.state)
      }
    }
    expect(open.frozen).toMatchObject({ deliveryDate: { state: expect.any(String) }, shipTo: { state: expect.any(String) } })
  })

  it('the impact before Send (PW-P06): the customer’s own freeze rule, priced yes or no, a date only; kept at Send as shown; one per kind', async () => {
    const so3 = await orderOf('SEED-SO-0003')
    // The seeds' WO-0003 makes SEED-SO-0003 and is released: the order's date is past RELEASED.
    expect((await one<{ released: boolean }>(`SELECT bool_or(w."releasedAt" IS NOT NULL) AS released FROM "WorkOrderSize" c JOIN "WorkOrder" w ON w.id = c."workOrderId" JOIN "SalesOrderLine" l ON l.id = c."salesOrderLineId" WHERE l."orderId" = $1 AND w.status <> 'CANCELLED' AND w.kind <> 'REPAIR'`, [so3.id])).released).toBe(true)
    // The customer's own rule (B-PR-14): its delivery date frozen from release as a priced change request.
    await createFreezeRule(office(), { companyId: companyA, partyId: P1, field: 'DELIVERY_DATE', frozenFrom: 'RELEASED', action: 'CHANGE_REQUEST', note: 'Made-up: our own rule for this customer.' })
    // A promise well ahead, so a need-by date can be earlier (planted: the promise route is planning's).
    const promise = addDays(TODAY(), 90)
    await replica('UPDATE "SalesOrder" SET "promiseDate" = $2::date WHERE id = $1', [so3.id, promise])
    const needBy = addDays(TODAY(), 30)
    const asked = { kind: 'RUSH', requestedDate: needBy, note: 'Our season opens early.' }
    const read = await post(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests/impact`, asked)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    const impact = read.body.impact
    expect(impact).toMatchObject({ kind: 'RUSH', blocked: false, priced: false, pricedWords: null, notes: [{ en: 'We look at the date again and confirm it to you' }] })
    expect(impact.frozen).toEqual([{ field: 'DELIVERY_DATE', lineId: null, line: null, size: null, state: 'CHANGE_REQUEST', words: expect.objectContaining({ en: expect.any(String), it: expect.any(String) }) }])
    // The wall: a date only (its three facts and their words), nothing of planning's load; no number anywhere; no cancel fee.
    expect(Object.keys(impact.earliest).sort()).toEqual(['date', 'meetsWanted', 'partial', 'words'])
    expect(numbersIn(impact)).toEqual([])
    expect('cancelFee' in read.body).toBe(false)
    expect(JSON.stringify(read.body)).not.toMatch(/\bminutes\b|\blanes?\b|\bload\b|capacity|workOrder|\bWO-|oli\.buyer|Brand Alpha/i)

    // Sent: the impact kept as shown (never an amount: the database checks it), the order's event names the kind.
    const sent = await post(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests`, asked)
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(sent.body.request).toMatchObject({ kind: 'RUSH', kindWords: { en: 'Urgent – asked' }, status: 'OPEN', requestedDate: needBy, note: 'Our season opens early.', cells: [], sampleKind: null })
    expect(sent.body.request.impact).toMatchObject({ kind: 'RUSH', frozen: impact.frozen, priced: false, notes: impact.notes, words: impact.words })
    const kept = await one<{ impact: Json; numbers: boolean }>(`SELECT impact, jsonb_path_exists(impact, 'strict $.** ? (@.type() == "number")') AS numbers FROM "OrderChangeRequest" WHERE id = $1`, [sent.body.request.id])
    expect(kept.numbers).toBe(false)
    expect(kept.impact.frozen).toEqual(impact.frozen)
    expect((await outbox('order_change_request.asked')).map((row) => row.payload).find((payload) => payload.requestId === sent.body.request.id)).toEqual({ requestId: sent.body.request.id, orderId: so3.id, partyId: P1, kind: 'RUSH', lines: 0, wholeOrder: false })
    // One that waits per order and kind (R-14): a second rush waits; a pause beside it is asked; the open cancel stays.
    const again = await post(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests`, { kind: 'RUSH' })
    expect(again.status).toBe(409)
    expect(again.body.error.issues[0].path).toBe('body/WAITING')
    const rules = await ok(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests/rules`)
    expect(rules.asks.find((ask: Json) => ask.kind === 'RUSH')).toMatchObject({ waitingRequestId: sent.body.request.id, verdict: { code: 'WAITING' } })
    // The Production role asks too (every kind its limits open): a pause says why; it withdraws its pause while it waits.
    const noWhy = await post(production, `/portal/sales-orders/${so3.id}/change-requests`, { kind: 'HOLD' })
    expect(noWhy.status, JSON.stringify(noWhy.body)).toBe(400)
    expect(noWhy.body.error.issues).toEqual([{ path: 'body/note', message: 'Say why you want to pause, in a few words.' }])
    const pause = await post(production, `/portal/sales-orders/${so3.id}/change-requests`, { kind: 'HOLD', note: 'Our store opening moved.' })
    expect(pause.status, JSON.stringify(pause.body)).toBe(201)
    expect(pause.body.request).toMatchObject({ kind: 'HOLD', status: 'OPEN', note: 'Our store opening moved.', requestedDate: null, mine: true })
    const withdrawn = await post(production, `/portal/sales-orders/${so3.id}/change-requests/${pause.body.request.id}/withdraw`, { version: 1 })
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200)
    expect(withdrawn.body.request.status).toBe('WITHDRAWN')
    // A pause asks no date, a rush no sizes; a sample round names a line of THIS order (a foreign one is not named).
    expect((await post(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests/impact`, { kind: 'HOLD', note: 'x', requestedDate: needBy })).body.error.issues[0].path).toBe('body/requestedDate')
    const foreign = await post(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests/impact`, { kind: 'SAMPLE_ROUND', lineId: newId(), sampleKind: 'BRAND' })
    expect(foreign.status).toBe(400)
    expect(foreign.body.error.issues).toEqual([{ path: 'body/lineId', message: 'Pick the line of this order the sample is of.' }])
  })

  it('wall (PW-P06): another customer reads neither the rules, the impact nor the asks of the order (404), and asks nothing on it', async () => {
    const so3 = await orderOf('SEED-SO-0003')
    expect((await browsers.other.get(`/portal/sales-orders/${so3.id}/change-requests/rules`)).status).toBe(404)
    expect((await post(browsers.other, `/portal/sales-orders/${so3.id}/change-requests/impact`, { kind: 'RUSH' })).status).toBe(404)
    expect((await post(browsers.other, `/portal/sales-orders/${so3.id}/change-requests`, { kind: 'RUSH' })).status).toBe(404)
    expect((await browsers.other.get(`/portal/sales-orders/${so3.id}/change-requests`)).status).toBe(404)
    // The viewer reads the asks but asks nothing (no portal.salesOrders.ask): the impact is an ask's read.
    expect((await post(browsers.viewer, `/portal/sales-orders/${so3.id}/change-requests/impact`, { kind: 'RUSH' })).status).toBe(403)
  })

  it('a change that adds pieces asks planning for a date only; the Production role reads no cancel fee in the rules, the impact or a request', async () => {
    const so1 = await orderOf('SEED-SO-0001')
    const [blk] = await linesOf(so1.id)
    const change = await post(browsers.buyer, `/portal/sales-orders/${so1.id}/change-requests/impact`, { kind: 'CHANGE', cells: [{ lineId: blk!.id, size: '50', quantity: 3 }], requestedDate: addDays(TODAY(), 40) })
    expect(change.status, JSON.stringify(change.body)).toBe(200)
    // Nothing of the order is in production: nothing frozen, not priced; the earliest date a date only.
    expect(change.body.impact).toMatchObject({ kind: 'CHANGE', frozen: [], blocked: false, priced: false, pricedWords: null })
    expect(Object.keys(change.body.impact.earliest).sort()).toEqual(['date', 'meetsWanted', 'partial', 'words'])
    expect(numbersIn(change.body.impact)).toEqual([])

    // The cancel fee (15 %, the settings of the fee tests): the buyer reads it (prices); the Production role reads that a price
    // may apply, never the fee — neither the amounts nor the percent — in the rules, the impact or a request.
    const cancel = { kind: 'CANCEL', reasonCode: 'PRICE', lineIds: [blk!.id] }
    const buyerRead = await post(browsers.buyer, `/portal/sales-orders/${so1.id}/change-requests/impact`, cancel)
    expect(buyerRead.status, JSON.stringify(buyerRead.body)).toBe(200)
    expect(buyerRead.body.impact).toMatchObject({ kind: 'CANCEL', priced: true, pricedWords: { en: 'A price may apply: we will tell you' } })
    expect(buyerRead.body.cancelFee).toMatchObject({ pct: '15', currency: 'EUR', lines: [{ lineId: blk!.id, seq: 10, fee: expect.any(Number) }] })
    const productionRead = await post(production, `/portal/sales-orders/${so1.id}/change-requests/impact`, cancel)
    expect(productionRead.status, JSON.stringify(productionRead.body)).toBe(200)
    expect(productionRead.body.impact).toMatchObject({ kind: 'CANCEL', priced: true, pricedWords: { en: 'A price may apply: we will tell you', it: 'Può essere previsto un costo: ve lo diciamo noi' } })
    expect('cancelFee' in productionRead.body).toBe(false)
    const productionRules = await ok(production, `/portal/sales-orders/${so1.id}/change-requests/rules`)
    expect('cancelFee' in productionRules).toBe(false)
    expect((productionRules.lines as Json[]).every((line) => !('cancelFee' in line))).toBe(true)
    expect('cancelFee' in (await ok(browsers.buyer, `/portal/sales-orders/${so1.id}/change-requests/rules`))).toBe(true)
    // A waiting cancel (SEED-SO-0003's, asked in the B-PR-23 block): the buyer reads its fee, the Production role none.
    const so3 = await orderOf('SEED-SO-0003')
    const waiting = (rows: Json) => (rows.items as Json[]).find((row) => row.kind === 'CANCEL' && row.status === 'OPEN')!
    expect(waiting(await ok(browsers.buyer, `/portal/sales-orders/${so3.id}/change-requests`)).cancelFee).toMatchObject({ pct: '15' })
    expect(waiting(await ok(production, `/portal/sales-orders/${so3.id}/change-requests`)).cancelFee).toBeNull()
    expect(JSON.stringify(await ok(production, `/portal/sales-orders/${so3.id}/change-requests`))).not.toMatch(/"pct"|totalFee|"fee"/)
  })
})
// ── end B-PR-25
