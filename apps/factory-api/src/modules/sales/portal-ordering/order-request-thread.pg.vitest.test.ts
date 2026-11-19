import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor, command } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { partnerFanOut } from '../../../platform/portal/notifications/fan-out'
import { unsubscribeKeyOf } from '../../../platform/portal/notifications/mail'
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../../../platform/search/partner/testing/world'
import { recordLabelOf } from '../../../platform/threads/labels'
import { ensureThread, readThread, writeMessage } from '../../../platform/threads/threads'
// ---- B-CP-071 (customer page plan D10, K9 reversed): a draft's thread and the office's read-only Drafts.
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { businessDate } from '@nexus/factory-domain/core/time'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { filterForGrains } from '@nexus/factory-domain/money/filter'
import { EVENT_DEFINITIONS } from '@nexus/factory-domain/events/catalogue'
import { actorOf } from '../../../core/context'
import { unreadCounts } from '../../../platform/threads/reads'
import { listWaiting } from '../../../platform/threads/waiting-list'
import { readRecordSummary } from '../../../platform/threads/summary'
import { SOURCES } from '../../insights/sources'
import { listIncoming } from '../incoming/incoming'
import { officeGetContract, officeListContract } from './contract'
import { acceptRequest, listOfficeRequests, officeRequestView, refuseRequest } from './office'
// ---- end B-CP-071

/**
 * B-TH-040 (threads plan TH-3, G16, L2-G04; wall tests T09 and W08; Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand"): a catalogue order has a thread and opens. On the local stack with every base seed and
 * the real portal sign-in by code: the seed's P1 (customer A) sent SEED-RQ-0001 (theirs: PO-SEED-7001) and keeps a draft; the
 * seed's P3 is customer B, with a buyer of its own. Customer A opens its catalogue order's thread, writes in it, finds it by
 * either number; the office reads and answers there; our answer is news for A's people only. Customer B never opens, posts to,
 * lists or finds A's catalogue order (404, as if it did not exist), nor does a supplier.
 * B-CP-071 (customer page plan D10, K9 reversed; REWRITE of B-TH-040's "a draft has no thread for anyone"): a draft has its thread
 * from its first save — its party's people who keep drafts and the office only (A's viewer, who keeps none, never opens it; it is
 * never found by search); the office reads A's drafts per customer, read-only (accept and refuse held), never in Incoming,
 * Approvals or Customer replies; an office person limited to customer B gets an empty list, and 404 on A's draft and its thread
 * (W-CP-2); "as Sales worker / as Production manager" no price, total or "Your price" part reaches the answer (M-CP-1).
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs portal-ordering/order-request-thread`.
 */

let h: Harness
let world: PartnerWorld
let buyerA: Browser
let buyerB: Browser
let supplier: Browser
const NS = 'th040'
const P3 = seedUuid(NS, 'party:P3')
const betaBuyer: Person = { id: newId(), email: `berta.buyer.${NS}@brand-beta.example`, name: 'Berta Buyer' }

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const requestId = async (where: string, values: unknown[]): Promise<string> => (await admin<{ id: string }>(`SELECT id FROM "PortalOrderRequest" WHERE "tenantId" = $1 AND ${where} ORDER BY id LIMIT 1`, [world.tenantId, ...values]))[0]!.id
const office = (permissions = ['threads.read', 'threads.post']) =>
  callerFor(h.database, { audience: 'office', tenantId: world.tenantId, actorId: world.officeId, requestId: newId(), grants: [{ permissions: permissions as never, companies: 'all', sites: 'all', parties: 'all' }] })
const thread = (browser: Browser, id: string) => browser.get(`/portal/threads/PortalOrderRequest/${id}`)
const post = (browser: Browser, id: string, body: string) => browser.send('POST', `/portal/threads/PortalOrderRequest/${id}/messages`, { body }, { headers: { 'idempotency-key': `th040-${newId()}` } })
const search = (browser: Browser, q: string) => browser.get(`/portal/search?q=${encodeURIComponent(q)}`)

let sent = ''
let draft = ''
let officeAnswer = ''

beforeAll(async () => {
  h = await startHarness('th040_order_thread')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  // Customer B: the seed's second customer, its portal on, one buyer who may write.
  await inTenant(h, world, async (client) => {
    await client.portalSettings.upsert({ where: { id: P3 }, create: { id: P3, partyId: P3, portalOn: true }, update: { portalOn: true }, select: { id: true } })
    await client.user.create({ data: { id: betaBuyer.id, email: betaBuyer.email, displayName: betaBuyer.name, status: 'ACTIVE', audience: 'PARTNER', partyId: P3, partnerKind: 'CUSTOMER', locale: 'en' }, select: { id: true } })
    for (const key of ['customer-buyer', 'partner-comment']) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: world.tenantId, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: betaBuyer.id, roleId: role.id, allCompanies: true, partyIds: [P3], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  buyerA = await signIn(h, world, world.people.buyer)
  buyerB = await signIn(h, world, betaBuyer)
  supplier = await signIn(h, world, world.people.orders)
  sent = await requestId('number = $2', ['SEED-RQ-0001'])
  draft = await requestId(`"partyId" = $2 AND status = 'DRAFT'`, [world.p1])
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('B-TH-040: a catalogue order has a thread and opens', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the customer opens its catalogue order’s thread as it knows it and writes in it', async () => {
    const read = await thread(buyerA, sent)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.record).toMatchObject({ type: 'PortalOrderRequest', id: sent, theirRef: 'PO-SEED-7001', ourRef: 'SEED-RQ-0001', subtitle: 'Request sent', status: 'SENT' })
    expect(read.body.composer).toMatchObject({ canPost: true })
    const written = await post(buyerA, sent, 'Made-up: can the black ones come a week earlier?')
    expect(written.status, JSON.stringify(written.body)).toBe(201)
    const [made] = await admin('SELECT "companyId", "partyId", status::text AS status FROM "Thread" WHERE id = $1', [written.body.thread.id])
    expect(made).toEqual({ companyId: world.companyA, partyId: world.p1, status: 'OPEN' })
  })

  it('the office reads it on the record’s thread and answers there; the customer reads the answer', async () => {
    const page = await readThread(office(), { type: 'PortalOrderRequest', id: sent }, { limit: 50 })
    expect(page.messages.map((message) => message.body)).toContain('Made-up: can the black ones come a week earlier?')
    const { result } = await command(office(), { name: 'test.answer', input: { sent } }, async (tools) => {
      const { thread: row } = await ensureThread(tools, { type: 'PortalOrderRequest', id: sent }, world.officeId)
      const message = await writeMessage(tools, row, { direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'USER', id: world.officeId, name: 'Seed Owner' }, bodyText: 'Made-up: yes, a week earlier is fine.' })
      return message.id
    })
    officeAnswer = result
    const read = await thread(buyerA, sent)
    expect(read.body.messages.map((message: Json) => message.body)).toContain('Made-up: yes, a week earlier is fine.')
    expect(await inTenant(h, world, (client) => recordLabelOf(client, 'PortalOrderRequest', sent))).toBe('SEED-RQ-0001')
    // Without threads.read the office person reads nothing of it.
    await expect(readThread(office(['orders.view']), { type: 'PortalOrderRequest', id: sent }, { limit: 50 })).rejects.toThrow(/Record not found/)
  })

  it('our answer is news for the customer’s people only (W06): the bell names the catalogue order', async () => {
    const [event] = await admin(`SELECT id, type, "companyId", payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND payload->>'messageId' = $2`, [world.tenantId, officeAnswer])
    await partnerFanOut(callerFor(h.database, systemContext(world.tenantId, `th040-${newId()}`)), { eventId: event!.id, type: event!.type, tenantId: world.tenantId, companyId: event!.companyId, siteId: null, payload: event!.payload } as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
    const news = await admin<{ partyId: string; recordLabel: string; messageKey: string }>(`SELECT "partyId", "recordLabel", "messageKey" FROM "Notification" WHERE "recordType" = 'PortalOrderRequest' AND "recordId" = $1`, [sent])
    expect(news.length).toBeGreaterThan(0)
    for (const row of news) expect(row).toEqual({ partyId: world.p1, recordLabel: 'SEED-RQ-0001', messageKey: 'portal.message.posted' })
    const bell = await buyerA.get('/portal/notifications')
    expect(bell.body.items.map((item: Json) => item.record)).toContainEqual({ type: 'PortalOrderRequest', id: sent, label: 'SEED-RQ-0001' })
    expect(JSON.stringify((await buyerB.get('/portal/notifications')).body)).not.toContain(sent)
  })

  it('the customer finds it by our number or theirs in the portal search (the Orders group)', async () => {
    for (const q of ['SEED-RQ-0001', 'PO-SEED-7001']) {
      const answer = await search(buyerA, q)
      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
      const found = answer.body.groups.flatMap((group: Json) => group.results.map((result: Json) => ({ group: group.group, type: result.recordType, id: result.recordId })))
      expect(found, q).toContainEqual({ group: 'orders', type: 'PortalOrderRequest', id: sent })
    }
  })

  it('T09: another customer never opens, posts to, lists or finds it; nor does a supplier', async () => {
    const opened = await thread(buyerB, sent)
    expect(opened.status).toBe(404)
    expect(JSON.stringify(opened.body)).not.toMatch(/SEED-RQ-0001|PO-SEED-7001|another/i)
    expect((await post(buyerB, sent, 'Made-up: not mine.')).status).toBe(404)
    expect((await thread(supplier, sent)).status).toBe(404)
    // The generic thread route (partner audience): nothing.
    const generic = await buyerB.get(`/threads/PortalOrderRequest/${sent}`)
    expect(generic.status).toBe(200)
    expect(generic.body).toMatchObject({ thread: null, messages: [] })
    const listed = await buyerB.get('/portal/threads')
    expect(JSON.stringify(listed.body)).not.toContain(sent)
    for (const q of ['SEED-RQ-0001', 'PO-SEED-7001', 'week earlier']) {
      const answer = await search(buyerB, q)
      expect(answer.status).toBe(200)
      // B's own records may come (words alike); never A's catalogue order.
      expect(JSON.stringify(answer.body.groups), q).not.toContain(sent)
      expect(answer.body.groups.flatMap((group: Json) => group.results).filter((result: Json) => result.recordType === 'PortalOrderRequest'), q).toEqual([])
    }
    expect((await admin('SELECT count(*)::int AS n FROM "Message" WHERE "partyId" = $1', [P3]))[0]!.n).toBe(0)
  })
})

// ---- B-CP-071 (customer page plan D10, K9 reversed; walls W-CP-1, W-CP-2; money M-CP-1) -----------------------------------------
describe('B-CP-071: a draft has its thread from its first save — its party’s draft keepers and the office only', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const persona = (key: string, parties: 'all' | string[] = 'all') => {
    const template = templateOf(key)!
    const permissions = [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
    return callerFor(h.database, { audience: 'office', tenantId: world.tenantId, actorId: world.officeId, requestId: newId(), grants: [{ permissions, companies: 'all', sites: 'all', parties }] })
  }
  const PRICE_KEYS = /"(unitPriceShown|listPriceNow|amountShown|netShown|draftValueAmount|priceDiff|priceMatch|brandPrice)"/
  let draftAnswer = ''

  it('the customer’s buyer opens and writes in its draft’s thread; the office reads it and answers; A’s viewer (no drafts) never opens it', async () => {
    const read = await thread(buyerA, draft)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.record).toMatchObject({ type: 'PortalOrderRequest', id: draft, theirRef: 'PO-SEED-7004', ourRef: null, subtitle: 'Draft', status: 'DRAFT' })
    const written = await post(buyerA, draft, 'Made-up: can the logo go on the left sleeve?')
    expect(written.status, JSON.stringify(written.body)).toBe(201)
    const [made] = await admin('SELECT "companyId", "partyId" FROM "Thread" WHERE "recordType" = $1 AND "recordId" = $2', ['PortalOrderRequest', draft])
    expect(made).toEqual({ companyId: world.companyA, partyId: world.p1 })
    const page = await readThread(office(), { type: 'PortalOrderRequest', id: draft }, { limit: 50 })
    expect(page.messages.map((message) => message.body)).toContain('Made-up: can the logo go on the left sleeve?')
    const { result } = await command(office(), { name: 'test.answerDraft', input: { draft } }, async (tools) => {
      const { thread: row } = await ensureThread(tools, { type: 'PortalOrderRequest', id: draft }, world.officeId)
      return (await writeMessage(tools, row, { direction: 'OUTBOUND', channel: 'PORTAL', author: { kind: 'USER', id: world.officeId, name: 'Seed Owner' }, bodyText: 'Made-up: yes, the left sleeve works.' })).id
    })
    draftAnswer = result
    expect((await thread(buyerA, draft)).body.messages.map((message: Json) => message.body)).toContain('Made-up: yes, the left sleeve works.')
    // A's viewer keeps no drafts: the draft and its thread are not there for them (neutral 404), nor in their Messages.
    const viewer = await signIn(h, world, world.people.viewer)
    expect((await thread(viewer, draft)).status).toBe(404)
    // Step 0 (end-check red of PA1): a Viewer holds no portal.comment, so the post route itself refuses (403) — the same answer for
    // an id that does not exist, so it tells nothing of the draft. A viewer who may comment still keeps no drafts: 404, as if absent.
    expect((await post(viewer, draft, 'Made-up: not my draft.')).status).toBe(403)
    expect((await post(viewer, newId(), 'Made-up: no such record.')).status).toBe(403)
    const commenter: Person = { id: newId(), email: `vera.viewer.${NS}@studio-alpha.example`, name: 'Vera Viewer' }
    await inTenant(h, world, async (client) => {
      await client.user.create({ data: { id: commenter.id, email: commenter.email, displayName: commenter.name, status: 'ACTIVE', audience: 'PARTNER', partyId: world.p1, partnerKind: 'CUSTOMER', locale: 'en' }, select: { id: true } })
      for (const key of ['customer-viewer', 'partner-comment']) {
        const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: world.tenantId, key } }, select: { id: true } })
        await client.roleAssignment.create({ data: { id: newId(), userId: commenter.id, roleId: role.id, allCompanies: true, partyIds: [world.p1], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
      }
    })
    const viewerWhoComments = await signIn(h, world, commenter)
    expect((await thread(viewerWhoComments, draft)).status).toBe(404)
    expect((await post(viewerWhoComments, draft, 'Made-up: not my draft.')).status).toBe(404)
    expect(JSON.stringify((await viewer.get('/portal/threads')).body)).not.toContain(draft)
    // Lead addition 5 (PA1 residual): the unread read leaves a record the reader cannot open out exactly like an unknown id — the
    // draft's thread holds the buyer's message and our answer (both shared), yet A's viewer reads no count and no hint of it.
    const unknown = newId()
    const counted = await viewer.post('/threads/unread', { records: [{ recordType: 'PortalOrderRequest', recordId: draft }, { recordType: 'PortalOrderRequest', recordId: unknown }], readable: true })
    expect(counted.status, JSON.stringify(counted.body)).toBe(200)
    expect(counted.body.counts).toEqual([
      { recordType: 'PortalOrderRequest', recordId: draft, newCount: 0, lastAt: null, readable: false },
      { recordType: 'PortalOrderRequest', recordId: unknown, newCount: 0, lastAt: null, readable: false },
    ])
    const plain = await viewer.post('/threads/unread', { records: [{ recordType: 'PortalOrderRequest', recordId: draft }] })
    expect(plain.body.counts).toEqual([{ recordType: 'PortalOrderRequest', recordId: draft, newCount: 0, lastAt: null }])
    // The buyer, who keeps the party's drafts, does count it (our answer is new to them).
    const theirs = await buyerA.post('/threads/unread', { records: [{ recordType: 'PortalOrderRequest', recordId: draft }], readable: true })
    expect(theirs.body.counts).toEqual([expect.objectContaining({ recordId: draft, readable: true })])
    // The summary row: the office and the buyer read "Draft"; another customer never.
    expect((await readRecordSummary(office(), { type: 'PortalOrderRequest', id: draft })).summary.state?.code).toBe('DRAFT')
    expect((await buyerA.get(`/records/PortalOrderRequest/${draft}/summary`)).body.summary).toMatchObject({ state: { code: 'DRAFT' }, theirRef: 'PO-SEED-7004' })
    expect((await buyerB.get(`/records/PortalOrderRequest/${draft}/summary`)).status).toBe(404)
  })

  it('our answer on a draft is news for A’s people who keep drafts only (never A’s viewer, never B); the label is their own PO', async () => {
    const [event] = await admin(`SELECT id, type, "companyId", payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND payload->>'messageId' = $2`, [world.tenantId, draftAnswer])
    await partnerFanOut(callerFor(h.database, systemContext(world.tenantId, `cp071-${newId()}`)), { eventId: event!.id, type: event!.type, tenantId: world.tenantId, companyId: event!.companyId, siteId: null, payload: event!.payload } as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
    const news = await admin<{ userId: string; partyId: string; recordLabel: string }>(`SELECT "userId", "partyId", "recordLabel" FROM "Notification" WHERE "recordType" = 'PortalOrderRequest' AND "recordId" = $1`, [draft])
    expect(news.map((row) => row.userId)).toContain(world.people.buyer.id)
    expect(news.map((row) => row.userId)).not.toContain(world.people.viewer.id)
    for (const row of news) expect(row).toMatchObject({ partyId: world.p1, recordLabel: 'PO-SEED-7004' })
    expect(JSON.stringify((await buyerB.get('/portal/notifications')).body)).not.toContain(draft)
  })

  it('W-CP-1: customer B (and a supplier) never opens, posts to, lists, counts or finds A’s draft; search never finds a draft', async () => {
    const opened = await thread(buyerB, draft)
    expect(opened.status).toBe(404)
    expect(JSON.stringify(opened.body)).not.toMatch(/PO-SEED-7004|left sleeve|another/i)
    expect((await post(buyerB, draft, 'Made-up: not mine.')).status).toBe(404)
    expect((await thread(supplier, draft)).status).toBe(404)
    expect(JSON.stringify((await buyerB.get('/portal/threads')).body)).not.toContain(draft)
    const unread = await buyerB.post('/threads/unread', { records: [{ recordType: 'PortalOrderRequest', recordId: draft }] })
    expect(unread.status, JSON.stringify(unread.body)).toBe(200)
    expect(unread.body.counts).toEqual([expect.objectContaining({ recordType: 'PortalOrderRequest', recordId: draft, newCount: 0, lastAt: null })])
    for (const browser of [buyerA, buyerB]) {
      const answer = await search(browser, 'PO-SEED-7004')
      expect(answer.status).toBe(200)
      expect(JSON.stringify(answer.body.groups)).not.toContain(draft)
    }
  })

  it('the office reads A’s drafts per customer, read-only: listed with who and the checklist; the decision held; never in Incoming, Approvals or Customer replies', async () => {
    await expect(listOfficeRequests(persona('sales'), { status: 'DRAFT' })).rejects.toThrow(/Drafts are listed per customer/)
    const drafts = await listOfficeRequests(persona('sales'), { status: 'DRAFT', partyId: world.p1 })
    const row = drafts.requests.find((entry) => entry.id === draft)!
    expect(row).toMatchObject({ status: 'DRAFT', number: null, customerRef: 'PO-SEED-7004', lines: expect.any(Number) })
    expect(row.draft).toMatchObject({ title: expect.stringMatching(/^SEED-JKT/), people: 0, later: [], thread: { messages: 2, designerAsked: false } })
    expect(row.draft!.readiness.parts.map((part) => part.part)).toEqual(expect.arrayContaining(['NEED', 'LOGOS', 'REFERENCES', 'PEOPLE', 'DATE', 'NOTES']))
    expect(row.draft!.readiness.parts.find((part) => part.part === 'NOTES')?.state).toBe('READY')
    expect(row.draft!.lastEditedAt).toEqual(expect.any(String))
    // OPEN and ALL never hold a draft.
    for (const status of ['OPEN', 'ALL'] as const) expect((await listOfficeRequests(persona('sales'), { status })).requests.map((entry) => entry.id)).not.toContain(draft)
    const view = await officeRequestView(persona('sales'), draft)
    expect(view.request).toMatchObject({ status: 'DRAFT', draft: expect.objectContaining({ title: row.draft!.title }) })
    expect(view.may).toEqual({ order: false, quote: false, refuse: false })
    await expect(acceptRequest(office(['orders.view', 'orders.manage', 'quotes.manage', 'money.price']), draft, { version: view.request.version, as: 'ORDER' })).rejects.toThrow("This is still the customer's draft: it is decided once they send it.")
    await expect(refuseRequest(office(['orders.view', 'orders.manage']), draft, { version: view.request.version, reason: 'Made-up' })).rejects.toThrow(/still the customer's draft/)
    // Never in Incoming, Home › Approvals or "Customer replies" (the customer's message on it waits there for nobody).
    const incoming = await listIncoming(persona('sales'), { tile: 'ALL', partyId: world.p1 } as never)
    expect(incoming.rows.map((entry) => entry.id)).not.toContain(draft)
    const caller = persona('sales')
    const approvals = await SOURCES.PORTAL_ORDER_REQUEST({ caller, viewer: { actor: actorOf(caller.factoryContext!), personId: world.officeId, today: businessDate(new Date()), now: h.clock.now() } })
    expect(approvals.candidates.map((candidate) => candidate.record.id)).not.toContain(draft)
    const replies = await listWaiting(persona('sales'), { side: 'CUSTOMER', partyId: world.p1 })
    expect(replies.rows.map((entry) => entry.recordId)).not.toContain(draft)
  })

  it('W-CP-2: an office person limited to customer B gets an empty Drafts list, 404 on A’s list, draft and thread, and an unreadable count', async () => {
    const limited = () => persona('sales', [P3])
    expect((await listOfficeRequests(limited(), { status: 'DRAFT', partyId: P3 })).requests).toEqual([])
    await expect(listOfficeRequests(limited(), { status: 'DRAFT', partyId: world.p1 })).rejects.toThrow('Customer not found.')
    await expect(listOfficeRequests(limited(), { status: 'DRAFT', partyId: newId() })).rejects.toThrow('Customer not found.')
    await expect(officeRequestView(limited(), draft)).rejects.toThrow(/not found/)
    await expect(readThread(limited(), { type: 'PortalOrderRequest', id: draft }, { limit: 50 })).rejects.toThrow(/Record not found/)
    expect((await unreadCounts(limited(), [{ type: 'PortalOrderRequest', id: draft }], { readable: true })).counts).toEqual([expect.objectContaining({ newCount: 0, readable: false })])
    expect((await listWaiting(limited(), { side: 'CUSTOMER' })).rows.map((entry) => entry.recordId)).not.toContain(draft)
  })

  it('M-CP-1: the office draft read and list “as Sales worker / as Production manager”: no price, total, difference, ≠ or “Your price” part', async () => {
    for (const key of ['sales', 'production_manager']) {
      const template = templateOf(key)!
      // The money wall (plan O1): neither persona holds the price grain.
      expect(template.grains, key).not.toContain('price')
      const caller = persona(key)
      const held = heldGrains(actorOf(caller.factoryContext!))
      const view = filterForGrains(officeGetContract.response[200], await officeRequestView(caller, draft), held)
      expect(JSON.stringify(view), key).not.toMatch(PRICE_KEYS)
      const list = filterForGrains(officeListContract.response[200], await listOfficeRequests(caller, { status: 'DRAFT', partyId: world.p1 }), held)
      expect(JSON.stringify(list), key).not.toMatch(PRICE_KEYS)
      const row = (list as Json).requests.find((entry: Json) => entry.id === draft)
      expect(row.draft.readiness.of, key).toBe(6)
      expect(row.draft.readiness.parts.map((part: Json) => part.part), key).not.toContain('PRICE')
    }
    // A price holder counts part 6 "Your price" (seven parts).
    const owner = office(['orders.view', 'threads.read', 'money.price'])
    const priced = (await listOfficeRequests(owner, { status: 'DRAFT', partyId: world.p1 })).requests.find((entry) => entry.id === draft)!
    expect(priced.draft!.readiness.of).toBe(7)
  })

  it('every change of a draft is portal_order_request.draft_changed with ids only: the party routes, never a live field (review C2)', async () => {
    const made = await buyerA.send('POST', '/portal/order-requests', {}, { headers: { 'idempotency-key': `cp071-${newId()}` } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.request.id as string
    const changed = await buyerA.send('PATCH', `/portal/order-requests/${id}`, { version: made.body.request.version, note: 'Made-up: a note' }, { headers: { 'idempotency-key': `cp071-${newId()}` } })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
    const gone = await buyerA.send('DELETE', `/portal/order-requests/${id}?version=${changed.body.request.version}`, undefined, { headers: { 'idempotency-key': `cp071-${newId()}` } })
    expect(gone.status, JSON.stringify(gone.body)).toBe(200)
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'portal_order_request.draft_changed' AND subject = $2 ORDER BY "occurredAt", id`, [world.tenantId, id])
    expect(events.map((row) => row.payload)).toEqual([{ requestId: id, partyId: world.p1 }, { requestId: id, partyId: world.p1 }, { requestId: id, partyId: world.p1 }])
    expect(EVENT_DEFINITIONS.find((definition) => definition.type === 'portal_order_request.draft_changed')?.live).toEqual({ permission: 'orders.view', floor: null, fields: ['requestId'] })
  })
})
// ---- end B-CP-071
