import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { TAKE_BACK_WORDS } from '@nexus/factory-domain/sales/portal-ordering/take-back'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { acceptRequest, confirmRequest, listOfficeRequests, refuseRequest } from './office'
import { officeCopyLine, officeDraftView, officePutBackLine } from './office-drafts' // po1.3: the office's twins; po2.4: the draft read
import { officeRequestView } from './office' // po2.4: the designer wall on the office reads
import { ordersReader } from '../orders/access'
import { readThread } from '../../../platform/threads/threads'
import { unreadCounts } from '../../../platform/threads/reads'

/**
 * The order as one thing (owb- order workflow, S1 PR po1): "Take it back" (po1.2; design § 5zi; build plan.md § 4 G1) and the ONE
 * lines table's moves — copy, take out, put back, material (po1.3) — on the local stack, through the real app and the
 * real portal sign-in by code: the factory-db seeds up to pricing (the brand SEED-C1 = P1, its own label SEED-JKT-02 sold on the
 * base list), its portal and another customer's on; P1's buyer and designer, the other customer's buyer; the office decides through
 * the module's functions. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs portal-ordering/one-order`.
 *
 *   - send → take it back → change a line → send again: the SAME number; when and who sent it cleared while it is a draft again;
 *     the base's audit action `portalOrdering.takeBack`; the event `portal_order_request.taken_back` (ids only); Incoming drops it
 *   - taken back after the office answered (accepted, refused): 409 "The factory has already answered this order." (EN + IT)
 *   - a style draft made for it (G1 (c2)): 409 "The factory has already started work on this order: ask the factory."
 *   - a Designer (no portal.orderRequests.manage): 403; another customer: 404; a draft taken back is never discarded (G1 (e))
 *   - the office's Confirm of a taken-back draft keeps its number too
 *   - po1.3: a line copied (even the same style and colour), taken out (soft: its choices stay) and put back as it was; a line taken out
 *     counts nowhere (the record's lines and totals, the Send); the office's twins; the Designer copies too (a draft's right)
 *   - po1.5: the accept carries the own columns (uses in place, values by the line map); a line taken out is not copied; the chosen
 *     picture is on both records
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'owb-take-back'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const styleId = (code: string) => one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, code]).then((row) => row.id)
const colourwayId = (style: string, code: string) => one<{ id: string }>('SELECT id FROM "Colourway" WHERE "tenantId" = $1 AND "styleId" = $2 AND code = $3', [T, style, code]).then((row) => row.id)

const people = { buyer: 'bice.buyer@take-back.example.com', designer: 'dora.designer@take-back.example.com', other: 'otto.buyer@take-back-two.example.com' }
const browsers = {} as Record<keyof typeof people, Browser>

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

const call = (browser: Browser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Answer> => browser.send(method as 'POST', url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}))
async function ok(browser: Browser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(browser, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}

const officeId = newId()
const office = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: officeId, requestId: newId(), grants: [{ permissions: ['orders.view', 'orders.manage', 'quotes.view', 'quotes.manage', 'money.price'], companies: 'all', sites: 'all', parties: 'all' }] })

let jkt02: string, blk02: string

/** A sent order with one catalogue line (SEED-JKT-02 black, 2 × 50), its record after the send. */
async function sentOrder(subject: string): Promise<Json> {
  const made = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'PICKER', subject }, 201)
  const url = `/portal/order-requests/${made.request.id}`
  const added = await ok(browsers.buyer, 'POST', `${url}/lines`, { version: made.request.version, lines: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 2 }] }] })
  return (await ok(browsers.buyer, 'POST', `${url}/send`, { version: added.request.version })).request
}

beforeAll(async () => {
  h = await startHarness('owb_take_back')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedPricing({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    if (!(await client.portalSettings.findUnique({ where: { id: P1 }, select: { id: true } }))) await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.buyer, P1, ['customer-buyer'])
  await partnerPerson(people.designer, P1, ['customer-designer'])
  await partnerPerson(people.other, world.partyId, ['customer-buyer'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
  // The office's commands (callerFor) run on the real clock: the harness just behind it (a decision is never before the send).
  h.clock.set(new Date(Date.now() - 2_000))
  jkt02 = await styleId('SEED-JKT-02')
  blk02 = await colourwayId(jkt02, 'BLK')
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('Take it back (owb- po1.2)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('send → take it back → change a line → send again keeps the number; Incoming drops it meanwhile', async () => {
    const sent = await sentOrder('Made-up spring jackets')
    const url = `/portal/order-requests/${sent.id}`
    const number = sent.number as string
    expect(number).toMatch(/^RQ-\d{4}$/)
    expect(sent.may.takeBack).toBe(true)
    const back = await ok(browsers.buyer, 'POST', `${url}/take-back`, { version: sent.version })
    expect(back.request).toMatchObject({ status: 'DRAFT', number, sentAt: null })
    expect(back.request.may).toMatchObject({ send: true, takeBack: false, discard: false })
    expect(await one('SELECT status::text AS status, "sentAt", "sentById", number FROM "PortalOrderRequest" WHERE id = $1', [sent.id])).toEqual({ status: 'DRAFT', sentAt: null, sentById: null, number })
    // The base's audit action and the event (ids only).
    expect((await admin('SELECT 1 FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [sent.id, 'portalOrdering.takeBack'])).length).toBe(1)
    const events = await admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['portal_order_request.taken_back', sent.id])
    expect(events.map((row) => Object.keys(row.payload).sort())).toEqual([['partyId', 'requestId']])
    // The office's Incoming lists no draft: the request is out of it now.
    expect((await listOfficeRequests(office(), { status: 'OPEN' })).requests.map((entry) => entry.id)).not.toContain(sent.id)
    // A draft again: its line changes as before.
    const line = back.request.lines[0]
    const changed = await ok(browsers.buyer, 'PUT', `${url}/lines/${line.id}`, { version: back.request.version, sizes: [{ size: '50', quantity: 3 }] })
    expect(changed.request.summary.pieces).toBe(3)
    // Sent again: the SAME number, never a new one.
    const again = await ok(browsers.buyer, 'POST', `${url}/send`, { version: changed.request.version })
    expect(again.request).toMatchObject({ status: 'SENT', number })
    expect(again.sent.number).toBe(number)
    expect((await listOfficeRequests(office(), { status: 'OPEN' })).requests.map((entry) => entry.id)).toContain(sent.id)
  })

  it('after the office answered: 409 in the customer’s words (accepted, refused)', async () => {
    const accepted = await sentOrder('Made-up accepted order')
    const decided = await acceptRequest(office(), accepted.id, { version: accepted.version, as: 'ORDER' })
    expect(decided.request.status).toBe('ACCEPTED')
    const late = await call(browsers.buyer, 'POST', `/portal/order-requests/${accepted.id}/take-back`, { version: decided.request.version })
    expect(late.status).toBe(409)
    expect(late.body.error).toMatchObject({ code: 'conflict', message: TAKE_BACK_WORDS.ANSWERED.en })
    const refused = await sentOrder('Made-up refused order')
    const no = await refuseRequest(office(), refused.id, { version: refused.version, reason: 'Made-up reason' })
    const after = await call(browsers.buyer, 'POST', `/portal/order-requests/${refused.id}/take-back`, { version: no.request.version })
    expect(after.status).toBe(409)
    expect(after.body.error.message).toBe(TAKE_BACK_WORDS.ANSWERED.en)
  })

  it('a style draft made for it (the factory started work): 409 "ask the factory"; never a draft again', async () => {
    const sent = await sentOrder('Made-up design started')
    await admin(`UPDATE "PortalOrderRequest" SET "styleIds" = ARRAY[$2]::uuid[], version = version + 1 WHERE id = $1`, [sent.id, jkt02])
    const read = await ok(browsers.buyer, 'GET', `/portal/order-requests/${sent.id}`)
    expect(read.request.may.takeBack).toBe(false)
    const started = await call(browsers.buyer, 'POST', `/portal/order-requests/${sent.id}/take-back`, { version: read.request.version })
    expect(started.status).toBe(409)
    expect(started.body.error).toMatchObject({ code: 'conflict', message: TAKE_BACK_WORDS.STARTED.en })
    expect((await one('SELECT status::text AS status FROM "PortalOrderRequest" WHERE id = $1', [sent.id])).status).toBe('SENT')
  })

  it('a Designer may not (403), another customer finds nothing (404), a stale version is a 409, a draft has nothing to take back', async () => {
    const sent = await sentOrder('Made-up rights order')
    expect((await call(browsers.designer, 'POST', `/portal/order-requests/${sent.id}/take-back`, { version: sent.version })).status).toBe(403)
    expect((await call(browsers.other, 'POST', `/portal/order-requests/${sent.id}/take-back`, { version: sent.version })).status).toBe(404)
    expect((await call(browsers.buyer, 'POST', `/portal/order-requests/${sent.id}/take-back`, { version: sent.version - 1 })).status).toBe(409)
    const draft = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'PICKER', subject: 'Made-up still a draft' }, 201)
    const none = await call(browsers.buyer, 'POST', `/portal/order-requests/${draft.request.id}/take-back`, { version: draft.request.version })
    expect(none.status).toBe(409)
    expect(none.body.error.message).toBe(TAKE_BACK_WORDS.NOT_SENT.en)
  })

  // owb- po2.1 (pin moved from po1.2): "Delete" of a draft taken back withdraws it (G1 (e)) — its number kept; the office's Confirm of
  // another taken-back draft keeps the number too.
  it('a draft taken back keeps its number: Delete withdraws it (G1 (e)); the office’s Confirm keeps the number too', async () => {
    const sent = await sentOrder('Made-up keeps its number')
    const back = await ok(browsers.buyer, 'POST', `/portal/order-requests/${sent.id}/take-back`, { version: sent.version })
    expect(back.request.may.discard).toBe(true)
    const deleted = await ok(browsers.buyer, 'DELETE', `/portal/order-requests/${sent.id}?version=${back.request.version}`)
    expect(deleted).toEqual({ discarded: true, withdrawn: true })
    expect(await one('SELECT status::text AS status, number, "withdrawnAt" IS NOT NULL AS gone FROM "PortalOrderRequest" WHERE id = $1', [sent.id])).toEqual({ status: 'WITHDRAWN', number: sent.number, gone: true })
    expect((await admin('SELECT 1 FROM "PortalOrderRequestLine" WHERE "requestId" = $1', [sent.id])).length).toBe(1)
    const other = await sentOrder('Made-up confirmed after take back')
    const again = await ok(browsers.buyer, 'POST', `/portal/order-requests/${other.id}/take-back`, { version: other.version })
    const confirmed = await confirmRequest(office(), other.id, { version: again.request.version, as: 'ORDER' })
    expect(confirmed.request).toMatchObject({ status: 'ACCEPTED', number: other.number })
  })
})

describe('the ONE lines table: copy, take out, put back, material (owb- po1.3)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const material = [{ topic: 'Material', options: ['Cowhide', 'Kangaroo'], picked: 'Kangaroo' }]

  /** A draft with a catalogue line (SEED-JKT-02 black, 2 × 50) and a described line (3 pieces, its material a choice). */
  async function twoLines(subject: string): Promise<{ id: string; record: Json; catalogueId: string; describedId: string }> {
    const made = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'PICKER', subject }, 201)
    const url = `/portal/order-requests/${made.request.id}`
    const added = await ok(browsers.buyer, 'POST', `${url}/lines`, { version: made.request.version, lines: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 2 }] }] })
    const record = await ok(browsers.buyer, 'POST', `${url}/custom-lines`, { version: added.request.version, line: { description: 'Made-up race suit', quantity: 3, choices: material } })
    return { id: made.request.id, record, catalogueId: record.request.lines[0].id, describedId: record.request.customLines[0].id }
  }

  it('material: the "Material" choice, else the colourway’s name', async () => {
    const draft = await twoLines('Made-up material')
    expect(draft.record.request.customLines[0].material).toBe('Kangaroo')
    expect(draft.record.request.lines[0].material).toBe(draft.record.request.lines[0].colourway.name)
  })

  it('a line is copied whole at the end — the same style and colour too; the picker still refuses a second one', async () => {
    const draft = await twoLines('Made-up copies')
    const url = `/portal/order-requests/${draft.id}`
    const copied = await ok(browsers.buyer, 'POST', `${url}/lines/${draft.catalogueId}/copy`, { version: draft.record.request.version })
    expect(copied.request.lines).toHaveLength(2)
    const [first, copy] = copied.request.lines
    expect(copy).toMatchObject({ style: first.style, colourway: first.colourway, pieces: 2, seq: 3 })
    expect(copy.id).not.toBe(first.id)
    const copiedCustom = await ok(browsers.buyer, 'POST', `${url}/lines/${draft.describedId}/copy`, { version: copied.request.version })
    expect(copiedCustom.request.customLines.map((line: Json) => [line.description, line.material, line.pieces])).toEqual([['Made-up race suit', 'Kangaroo', 3], ['Made-up race suit', 'Kangaroo', 3]])
    expect(copiedCustom.request.summary).toMatchObject({ lines: 4, pieces: 10 })
    // The picker (where merging is the point) still refuses the same style and colour.
    expect((await call(browsers.buyer, 'POST', `${url}/lines`, { version: copiedCustom.request.version, lines: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '52', quantity: 1 }] }] })).status).toBe(400)
    // The Designer keeps drafts too: it copies (no price in its answer).
    const byDesigner = await ok(browsers.designer, 'POST', `${url}/lines/${draft.describedId}/copy`, { version: copiedCustom.request.version })
    expect(byDesigner.request.customLines).toHaveLength(3)
    expect(JSON.stringify(byDesigner.request.lines)).not.toContain('unitPriceShown')
  })

  it('take out is soft: the line counts nowhere, keeps its choices, and comes back as it was with Put it back', async () => {
    const draft = await twoLines('Made-up take out')
    const url = `/portal/order-requests/${draft.id}`
    const out = await ok(browsers.buyer, 'DELETE', `${url}/lines/${draft.describedId}?version=${draft.record.request.version}`)
    expect(out.request.customLines).toEqual([])
    expect(out.request.summary).toMatchObject({ lines: 1, pieces: 2 })
    expect(out.request.removedLines).toEqual([expect.objectContaining({ id: draft.describedId, seq: 2, words: 'Made-up race suit' })])
    const row = await one('SELECT "removedAt", "removedById", choices FROM "PortalOrderRequestLine" WHERE id = $1', [draft.describedId])
    expect(row.removedAt).not.toBeNull()
    expect(row.choices).toEqual(material)
    // A line taken out is not changed, copied or taken out again: not found.
    expect((await call(browsers.buyer, 'POST', `${url}/lines/${draft.describedId}/copy`, { version: out.request.version })).status).toBe(404)
    expect((await call(browsers.buyer, 'DELETE', `${url}/lines/${draft.describedId}?version=${out.request.version}`)).status).toBe(404)
    // Put it back: in its own place, as it was.
    const back = await ok(browsers.buyer, 'POST', `${url}/lines/${draft.describedId}/put-back`, { version: out.request.version })
    expect(back.request.removedLines).toEqual([])
    expect(back.request.customLines[0]).toMatchObject({ id: draft.describedId, seq: 2, material: 'Kangaroo', pieces: 3 })
    // A line on the draft has nothing to put back (409 in words); another customer finds nothing.
    expect((await call(browsers.buyer, 'POST', `${url}/lines/${draft.describedId}/put-back`, { version: back.request.version })).status).toBe(409)
    expect((await call(browsers.other, 'POST', `${url}/lines/${draft.describedId}/put-back`, { version: back.request.version })).status).toBe(404)
  })

  it('"A new design: <kind>": a described line takes a garment type of the list only (400 in words otherwise)', async () => {
    const made = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'PICKER', subject: 'Made-up new design' }, 201)
    const refused = await call(browsers.buyer, 'POST', `/portal/order-requests/${made.request.id}/custom-lines`, { version: made.request.version, line: { description: 'A made-up new design', garmentType: 'MADE-UP-NONE', quantity: 1 } })
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toBe('Not a garment type we make.')
  })

  it('the Send ignores a line taken out: the request goes with its live lines only', async () => {
    const draft = await twoLines('Made-up send without it')
    const url = `/portal/order-requests/${draft.id}`
    const out = await ok(browsers.buyer, 'DELETE', `${url}/lines/${draft.describedId}?version=${draft.record.request.version}`)
    const sent = await ok(browsers.buyer, 'POST', `${url}/send`, { version: out.request.version })
    expect(sent.request).toMatchObject({ status: 'SENT', summary: { lines: 1, pieces: 2 }, customLines: [], removedLines: [] })
    const event = await one<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['portal_order_request.sent', draft.id])
    expect(event.payload).toMatchObject({ lines: 1, pieces: 2 })
  })

  it('the office’s twins copy and put back the same way (orders.manage over that customer)', async () => {
    const draft = await twoLines('Made-up office twins')
    const out = await ok(browsers.buyer, 'DELETE', `/portal/order-requests/${draft.id}/lines/${draft.describedId}?version=${draft.record.request.version}`)
    const copied = await officeCopyLine(h.app, office() as never, draft.id, draft.catalogueId, out.request.version)
    expect(copied.request.lines).toHaveLength(2)
    const back = await officePutBackLine(h.app, office() as never, draft.id, draft.describedId, copied.request.version)
    expect(back.request.customLines.map((line) => line.id)).toEqual([draft.describedId])
  })
})

describe('the accept carries the own columns; the picture on both records (owb- po1.5)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('uses and values go to the order lines by the line map; a line taken out is not copied', async () => {
    const made = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'PICKER', subject: 'Made-up carried columns' }, 201)
    const url = `/portal/order-requests/${made.request.id}`
    const added = await ok(browsers.buyer, 'POST', `${url}/lines`, { version: made.request.version, lines: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 2 }] }] })
    const kept = added.request.lines[0].id as string
    const copied = await ok(browsers.buyer, 'POST', `${url}/lines/${kept}/copy`, { version: added.request.version })
    const gone = copied.request.lines.find((line: Json) => line.id !== kept).id as string
    const column = await ok(browsers.buyer, 'POST', '/portal/own-columns', { name: 'Remake of (made up)', kind: 'TEXT' }, 201)
    const used = await ok(browsers.buyer, 'PUT', `${url}/own-columns`, { version: copied.request.version, columnIds: [column.id] })
    await ok(browsers.buyer, 'PUT', '/portal/own-values', { line: { kind: 'REQUEST_LINE', id: kept }, columnId: column.id, value: 'Made-up kept' })
    await ok(browsers.buyer, 'PUT', '/portal/own-values', { line: { kind: 'REQUEST_LINE', id: gone }, columnId: column.id, value: 'Made-up gone' })
    const out = await ok(browsers.buyer, 'DELETE', `${url}/lines/${gone}?version=${used.request.version}`)
    expect(out.request.picture).toEqual({ fileId: null, setAt: null, contentType: null })
    const sent = await ok(browsers.buyer, 'POST', `${url}/send`, { version: out.request.version })
    const accepted = await acceptRequest(office(), made.request.id, { version: sent.request.version, as: 'ORDER' })
    const orderId = accepted.made.salesOrderId as string
    const orderLines = await admin<{ id: string }>('SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq', [orderId])
    expect(orderLines).toHaveLength(1)
    expect(await admin('SELECT "columnId", seq FROM "OrderLineColumnUse" WHERE "salesOrderId" = $1', [orderId])).toEqual([{ columnId: column.id, seq: 1 }])
    expect(await admin('SELECT "valueText" FROM "OrderLineOwnValue" WHERE "salesOrderLineId" = $1', [orderLines[0]!.id])).toEqual([{ valueText: 'Made-up kept' }])
    // The customer reads them on its order, with the order's picture (none chosen: the first line's design).
    const record = await ok(browsers.buyer, 'GET', `/portal/sales-orders/${orderId}`)
    expect(record.ownColumns.used.map((entry: Json) => entry.id)).toEqual([column.id])
    expect(record.ownColumns.values[orderLines[0]!.id][column.id].value).toBe('Made-up kept')
    expect(record.picture).toEqual({ fileId: null, setAt: null, contentType: null })
    expect(JSON.stringify(record)).not.toContain('Made-up gone')
  })
})

describe('many drafts at once (owb- po2.1)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a mix of own drafts and another customer’s: theirs is "not found", nothing leaks; each item its own answer', async () => {
    const mine = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'PICKER', subject: 'Made-up bulk one' }, 201)
    const theirs = await ok(browsers.other, 'POST', '/portal/order-requests', { source: 'PICKER', subject: 'Made-up bulk theirs' }, 201)
    const answer = await ok(browsers.buyer, 'POST', '/portal/order-requests/bulk-delete', { items: [{ id: mine.request.id, version: mine.request.version }, { id: theirs.request.id, version: theirs.request.version }] })
    expect(answer.results).toEqual([
      { id: mine.request.id, ok: true, words: null },
      { id: theirs.request.id, ok: false, words: { en: 'Order not found.', it: 'Ordine non trovato.' } },
    ])
    expect(JSON.stringify(answer)).not.toContain('Made-up bulk theirs')
    expect((await one('SELECT count(*)::int AS n FROM "PortalOrderRequest" WHERE id = $1', [theirs.request.id])).n).toBe(1)
    expect((await one('SELECT count(*)::int AS n FROM "PortalOrderRequest" WHERE id = $1', [mine.request.id])).n).toBe(0)
  })

  it('a taken-back draft in a bulk delete is withdrawn (number kept); send many sends each; a Designer may not send', async () => {
    const sent = await sentOrder('Made-up bulk taken back')
    const back = await ok(browsers.buyer, 'POST', `/portal/order-requests/${sent.id}/take-back`, { version: sent.version })
    const deleted = await ok(browsers.buyer, 'POST', '/portal/order-requests/bulk-delete', { items: [{ id: sent.id, version: back.request.version }] })
    expect(deleted.results).toEqual([{ id: sent.id, ok: true, words: null }])
    expect(await one('SELECT status::text AS status, number FROM "PortalOrderRequest" WHERE id = $1', [sent.id])).toEqual({ status: 'WITHDRAWN', number: sent.number })
    const a = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'PICKER', subject: 'Made-up send many A' }, 201)
    const b = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'PICKER', subject: 'Made-up send many B' }, 201)
    const sentMany = await ok(browsers.buyer, 'POST', '/portal/order-requests/bulk-send', { items: [{ id: a.request.id, version: a.request.version }, { id: b.request.id, version: b.request.version + 5 }] })
    expect(sentMany.results[0]).toEqual({ id: a.request.id, ok: true, words: null })
    expect(sentMany.results[1]).toMatchObject({ id: b.request.id, ok: false })
    expect((await one('SELECT status::text AS status FROM "PortalOrderRequest" WHERE id = $1', [a.request.id])).status).toBe('SENT')
    expect((await call(browsers.designer, 'POST', '/portal/order-requests/bulk-send', { items: [{ id: b.request.id, version: b.request.version }] })).status).toBe(403)
    expect((await call(browsers.buyer, 'POST', '/portal/order-requests/bulk-delete', { items: [] })).status).toBe(400)
  })
})

describe('the designer wall: the office Draft/Sent reads and the order threads; factory people (owb- po2.4)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const designerId = newId()
  const otherOfficeId = newId()
  const designer = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: designerId, requestId: newId(), grants: [{ permissions: ['orders.view.own', 'threads.read'], companies: 'all', sites: 'all', parties: 'all' }] })
  const noRight = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: newId(), requestId: newId(), grants: [{ permissions: ['threads.read'], companies: 'all', sites: 'all', parties: 'all' }] })

  beforeAll(async () => {
    await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
      await client.user.create({ data: { id: designerId, email: 'dea.designer@owb-wall.example.com', displayName: 'Made-up Dea Designer', locale: 'en', status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
      await client.user.create({ data: { id: otherOfficeId, email: 'otto.office@owb-wall.example.com', displayName: 'Made-up Otto Office', locale: 'en', status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
    })
  })

  it('factory people: the office people of THIS customer’s pool only — names, role words, letters; never an e-mail', async () => {
    await admin(`INSERT INTO "PartyOfficePerson" (id, "tenantId", "companyId", "partyId", "userId", version, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, 1, now(), now()), ($6, $2, $3, $7, $8, 1, now(), now())`, [newId(), T, companyA, P1, designerId, newId(), world.partyId, otherOfficeId])
    const mine = await ok(browsers.buyer, 'GET', '/portal/factory-people')
    expect(mine.people.map((person: Json) => person.name)).toEqual(['Made-up Dea Designer'])
    expect(mine.people[0].picture).toEqual({ kind: 'LETTERS', icon: null, colour: null })
    const text = JSON.stringify(mine)
    for (const word of ['owb-wall.example.com', 'Made-up Otto Office']) expect(text, word).not.toContain(word)
    const theirs = await ok(browsers.other, 'GET', '/portal/factory-people')
    expect(theirs.people.map((person: Json) => person.name)).toEqual(['Made-up Otto Office'])
  })
})
