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

/**
 * B-TH-040 (threads plan TH-3, G16, L2-G04; wall tests T09 and W08; Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand"): a catalogue order has a thread and opens. On the local stack with every base seed and
 * the real portal sign-in by code: the seed's P1 (customer A) sent SEED-RQ-0001 (theirs: PO-SEED-7001) and keeps a draft; the
 * seed's P3 is customer B, with a buyer of its own. Customer A opens its catalogue order's thread, writes in it, finds it by
 * either number; the office reads and answers there; our answer is news for A's people only. A draft has no thread for anyone.
 * Customer B never opens, posts to, lists or finds A's catalogue order (404, as if it did not exist), nor does a supplier.
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

  it('a draft has no thread for anyone: the customer’s own, the office', async () => {
    expect((await thread(buyerA, draft)).status).toBe(404)
    expect((await post(buyerA, draft, 'Made-up: a question on my draft.')).status).toBe(404)
    await expect(readThread(office(), { type: 'PortalOrderRequest', id: draft }, { limit: 50 })).rejects.toThrow(/Record not found/)
    expect((await admin('SELECT id FROM "Thread" WHERE "recordType" = $1 AND "recordId" = $2', ['PortalOrderRequest', draft])).length).toBe(0)
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
