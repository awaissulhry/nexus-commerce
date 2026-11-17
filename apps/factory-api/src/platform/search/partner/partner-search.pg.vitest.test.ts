import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../../auth/portal/service'
import { freshGuard } from '../../auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../../auth/sessions/testing/harness'
// B-TH-097: the office's message entries never reach a portal search.
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor, command } from '../../../core/command'
import { systemContext } from '../../outbox/system'
import { ensureThread, writeMessage } from '../../threads/threads'
import { indexEvent } from '../indexing'
import { loadIndexers } from '../registry'
import { fileURLToPath } from 'node:url'
import { partnerWorld, signIn, type PartnerWorld } from './testing/world'

/**
 * Portal search (B-W2b-168; SAL-084) on the local stack, through the real app: the base seeds in one namespace, the search
 * index built from them by the indexers (as the worker does), real portal sign-ins by e-mail code. A partner finds its own
 * records by their reference (first) and ours, grouped by its portal (orders, documents, jobs, pos), through the partner
 * role's wall: never another party's record, a record of a kind its portal does not show, a record it does not know yet
 * (a quote never sent, a delivery not shipped, a job not issued), an invoice without the price grain, or a match on a word
 * only the office sees. Run with `node scripts/factory/run-pg-tests.mjs platform/search/partner`.
 */

let h: Harness
let world: PartnerWorld
let buyer: Browser
let viewer: Browser
let orders: Browser
let workshop: Browser
const NS = 'ps168'

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const search = async (browser: Browser, query: string): Promise<Json> => {
  const answer = await browser.get(`/portal/search?${query}`)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body
}
const q = (text: string, more = '') => `q=${encodeURIComponent(text)}${more}`
const all = (answer: Json): Json[] => answer.groups.flatMap((group: Json) => group.results)

beforeAll(async () => {
  h = await startHarness('portal_search')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  buyer = await signIn(h, world, world.people.buyer)
  viewer = await signIn(h, world, world.people.viewer)
  orders = await signIn(h, world, world.people.orders)
  workshop = await signIn(h, world, world.people.workshop)
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('SAL-084: a customer finds its records by its references and ours', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('their PO number typed whole finds their order first, as theirs', async () => {
    const answer = await search(buyer, q('SEED-PO-77'))
    expect(answer.groups[0].group).toBe('orders')
    // th2-backend step 7 (threads plan §0.5): "ours" is the customer's own order number ("#1"), never the office's SO-… series.
    expect(all(answer)[0]).toMatchObject({ recordType: 'SalesOrder', theirRef: 'SEED-PO-77', ourRef: expect.stringMatching(/^#\d+$/), group: 'orders', match: 'theirs', status: expect.any(String) })
    // Part of it finds it too (every word inside the partner's fields).
    expect(all(await search(buyer, q('po-77'))).find((result) => result.theirRef === 'SEED-PO-77')).toMatchObject({ match: 'words' })
  })

  it('our office number (printed on the confirmation it holds) still finds it, shown by its own number; Enter opens the one reference typed whole', async () => {
    const answer = await search(buyer, q('seed-so-0001'))
    expect(all(answer)[0]).toMatchObject({ recordType: 'SalesOrder', ourRef: expect.stringMatching(/^#\d+$/), match: 'words' })
    // th2-backend step 7: the order's hit never names the office's series (a delivery note — a legal document — keeps its own).
    expect(JSON.stringify(answer.groups.find((group: { group: string }) => group.group === 'orders'))).not.toMatch(/SEED-SO-/)
    const quote = await search(buyer, q('SEED-RFQ-12'))
    expect(quote.single).toMatchObject({ recordType: 'Quote', ourRef: expect.stringMatching(/^#\d+$/), theirRef: 'SEED-RFQ-12', match: 'theirs' })
  })

  it('finds a delivery once shipped and its documents, grouped as the portal shows them', async () => {
    expect(all(await search(buyer, q('SEED-SH-0001')))[0]).toMatchObject({ recordType: 'Shipment', group: 'orders', match: 'ours', status: 'SHIPPED' })
    // The draft delivery is the office's.
    expect((await search(buyer, q('SEED-SH-0002'))).found).toBe(0)
    const [ddt] = await admin<{ number: string }>('SELECT number FROM "Ddt" WHERE "tenantId" = $1 AND "partyId" = $2 ORDER BY number LIMIT 1', [world.tenantId, world.p1])
    const documents = await search(buyer, q(ddt!.number, '&group=documents'))
    expect(documents.groups.map((group: Json) => group.group)).toEqual(['documents'])
    expect(all(documents).find((result) => result.recordType === 'Ddt')).toMatchObject({ ourRef: ddt!.number, group: 'documents' })
  })

  it('an invoice only with the price grain (a buyer yes, a viewer no), never an amount', async () => {
    const [invoice] = await admin<{ number: string }>('SELECT number FROM "Invoice" WHERE "tenantId" = $1 AND "partyId" = $2 AND number IS NOT NULL ORDER BY number LIMIT 1', [world.tenantId, world.p1])
    const found = await search(buyer, q(invoice!.number))
    const result = all(found).find((entry) => entry.recordType === 'Invoice')
    expect(result).toMatchObject({ ourRef: invoice!.number, group: 'documents', match: 'ours' })
    expect(Object.keys(result!).sort()).toEqual(['date', 'group', 'match', 'ourRef', 'recordId', 'recordType', 'status', 'subtitle', 'theirRef'])
    expect(all(await search(viewer, q(invoice!.number))).find((entry) => entry.recordType === 'Invoice')).toBeUndefined()
  })

  it('never another party’s record, a quote never sent, or a word only the office sees', async () => {
    expect((await search(buyer, q('SEED-PO-0001'))).found).toBe(0)
    expect((await search(buyer, q('SEED-OC-2201'))).found).toBe(0)
    expect((await search(buyer, q('SEED-Q-0002'))).found).toBe(0)
    // The index holds the customer's name in its orders' text; the partner fields do not: nothing is found by it.
    const [party] = await admin<{ legalName: string }>('SELECT "legalName" FROM "Party" WHERE id = $1', [world.p1])
    const indexed = await admin(`SELECT 1 FROM "SearchEntry" WHERE "tenantId" = $1 AND "partyId" = $2 AND "recordType" = 'SalesOrder' AND strpos("searchText", lower($3)) > 0`, [world.tenantId, world.p1, party!.legalName.split(' ')[0]])
    expect(indexed.length).toBeGreaterThan(0)
    expect(all(await search(buyer, q(party!.legalName))).filter((result) => result.recordType === 'SalesOrder')).toEqual([])
  })

  it('reads a short query as too short and refuses a person without search', async () => {
    expect(await search(buyer, q('S'))).toMatchObject({ tooShort: true, groups: [], found: 0 })
    const commentOnly = await signIn(h, world, world.people.commentOnly)
    expect((await commentOnly.get(`/portal/search?${q('SEED-PO-77')}`)).status).toBe(403)
    expect((await h.app.inject({ method: 'GET', url: `/portal/search?${q('SEED-PO-77')}` })).statusCode).toBe(401)
  })
})

describe('SAL-084: a supplier and a workshop find what their portal shows', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a supplier finds its PO by its confirmation number, by its article code and by our number', async () => {
    const confirmation = await search(orders, q('SEED-OC-2201'))
    expect(confirmation.groups[0].group).toBe('pos')
    expect(confirmation.single).toMatchObject({ recordType: 'PurchaseOrder', ourRef: 'SEED-PO-0001', theirRef: 'SEED-OC-2201', match: 'theirs' })
    // Their article code is not in the office index: the PO's own lines find it.
    expect(all(await search(orders, q('SEED-ART-300')))[0]).toMatchObject({ recordType: 'PurchaseOrder', ourRef: 'SEED-PO-0001', match: 'words' })
    expect(all(await search(orders, q('SEED-PO-0001')))[0]).toMatchObject({ recordType: 'PurchaseOrder', match: 'ours' })
    // A customer's order is not on a supplier's portal.
    expect((await search(orders, q('SEED-SO-0001'))).found).toBe(0)
  })

  it('a workshop does not find a job not issued to it yet, nor the supplier side of its party', async () => {
    expect((await search(workshop, q('SEED-SC-0001'))).found).toBe(0)
    expect((await search(workshop, q('SEED-PO-0001'))).found).toBe(0)
  })
})

// ---- B-TH-097 (threads plan TH-9, G11; wall test T28): message text is in the office's search index; a portal session never
// searches messages — not another customer's, not its own, never an office note.
describe('B-TH-097: the portal search never reaches a message', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a word only in messages finds nothing in any portal, though the office index holds it', async () => {
    const [order] = await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [world.tenantId, 'SEED-SO-0001'])
    const system = () => callerFor(h.database, systemContext(world.tenantId, `ps097-${newId()}`))
    await command(system(), { name: 'test.messages', input: { order: order!.id } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: order!.id }, world.officeId)
      await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'USER', id: world.officeId, name: 'Seed Owner' }, bodyText: 'Made-up: the qwyxblorf lining arrives on Friday.' })
      await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', id: world.officeId, name: 'Seed Owner' }, bodyText: 'Made-up office note: qwyxblorf is late at the supplier.' })
      return null
    })
    const indexers = await loadIndexers(fileURLToPath(new URL('../../..', import.meta.url)))
    for (const row of await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND subject = $2`, [world.tenantId, order!.id])) {
      await indexEvent(system(), indexers, { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload })
    }
    const entries = await admin<{ partyId: string | null }>(`SELECT "partyId" FROM "SearchEntry" WHERE "tenantId" = $1 AND "recordType" = 'Message' AND "searchText" LIKE '%qwyxblorf%'`, [world.tenantId])
    expect(entries.length).toBe(2)
    for (const browser of [buyer, viewer, orders, workshop]) {
      const answer = await search(browser, q('qwyxblorf'))
      expect(answer.found).toBe(0)
      expect(JSON.stringify(answer.groups)).not.toMatch(/Message|qwyxblorf/)
    }
  })
})
// ---- end B-TH-097
