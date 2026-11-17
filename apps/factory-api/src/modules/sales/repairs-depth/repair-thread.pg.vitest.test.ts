import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor, command } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../../../platform/search/partner/testing/world'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'

/**
 * B-TH-081 (threads plan TH-6, N12; O-SAL-REP.thread, P-CUS-REP.thread; wall tests T09 / W09 and W14; the Owner's rule 2026-11-16:
 * "One brand must not be able to see anything related to any other brand"): the portal repair page has its thread — the
 * RepairOrder partner view (platform/search/partner/views/repair-order.ts; the table was partner-readable already).
 *
 *   brand A (P1)   opens its repair SEED-REP-0001 on GET /portal/threads/RepairOrder/<id>: our number, the stage, our reply (never our
 *                  office note); posts on it (the thread is shared with P1 only); finds it by number in the portal search's Returns
 *                  group; its summary row (B-TH-076) reads through the same view
 *   brand B        404 in neutral words on brand A's repair thread, its post and its summary; no search hit; never listed (T09, W14)
 *   a supplier     opens and finds no repair (a customer's portal only)
 *
 * Base seeds in one namespace (two brands included), the search index built by the indexers, real portal sign-ins. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/repairs-depth`.
 */

let h: Harness
let world: PartnerWorld
let alpha: Browser
let beta: Browser
let supplier: Browser
let repairA = ''
const NS = 'th081rep'

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[]): Promise<T> => {
  const rows = await admin<T>(sql, values)
  expect(rows.length, sql).toBeGreaterThan(0)
  return rows[0]!
}
const thread = (browser: Browser, id: string) => browser.get(`/portal/threads/RepairOrder/${id}`)
const post = (browser: Browser, id: string, body: Json) => browser.send('POST', `/portal/threads/RepairOrder/${id}/messages`, body, { headers: { 'idempotency-key': `th081-${newId()}` } })
const search = async (browser: Browser, text: string): Promise<Json> => {
  const answer = await browser.get(`/portal/search?q=${encodeURIComponent(text)}`)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body
}
const all = (answer: Json): Json[] => answer.groups.flatMap((group: Json) => group.results)

/** A 404 in neutral words: never that the record exists, nor whose it is. */
function neutral404(answer: { status: number; body: Json }, ...names: string[]): void {
  expect(answer.status, JSON.stringify(answer.body)).toBe(404)
  const text = JSON.stringify(answer.body)
  expect(text).toMatch(/not found/i)
  for (const name of names) expect(text).not.toContain(name)
  expect(text).not.toMatch(/another (customer|brand|company)|altro cliente/i)
}

/** The office writes on the repair as the threads seam does: an office note and a reply shared with the customer. */
async function officeWrites(recordId: string): Promise<{ note: string; reply: string }> {
  const office = callerFor(h.database, { audience: 'office', tenantId: world.tenantId, actorId: world.officeId, grants: [], requestId: newId() })
  const { result } = await command(office, { name: 'threads.postReply', input: { recordId } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'RepairOrder', id: recordId }, world.officeId)
    const note = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', id: world.officeId, name: 'Seed Owner' }, bodyText: 'Internal: the seam needs the special thread, cost it first.' })
    const reply = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'PORTAL', author: { kind: 'USER', id: world.officeId, name: 'Seed Owner' }, bodyText: 'Made-up: your jacket arrived, we look at the shoulder seam this week.' })
    return { note: note.id, reply: reply.id }
  })
  return result
}

beforeAll(async () => {
  h = await startHarness('repair_thread_th081')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  const brandB = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [world.tenantId])).id
  const buyerB = await one<{ id: string; email: string; displayName: string }>(`SELECT id, email, "displayName" FROM "User" WHERE "tenantId" = $1 AND "partyId" = $2 AND email LIKE 'buyer.second-brand.%' LIMIT 1`, [world.tenantId, brandB])
  await inTenant(h, world, (client) => client.portalSettings.updateMany({ where: { partyId: brandB }, data: { portalOn: true } }))
  repairA = (await one<{ id: string }>(`SELECT id FROM "RepairOrder" WHERE "tenantId" = $1 AND number = 'SEED-REP-0001' AND "partyId" = $2`, [world.tenantId, world.p1])).id
  alpha = await signIn(h, world, world.people.buyer)
  beta = await signIn(h, world, { id: buyerB.id, email: buyerB.email, name: buyerB.displayName } satisfies Person)
  supplier = await signIn(h, world, world.people.orders)
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('B-TH-081: the portal repair page has its thread', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('brand A opens its repair as it knows it: our number, the stage, our reply — never our office note', async () => {
    const { note, reply } = await officeWrites(repairA)
    const answer = await thread(alpha, repairA)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.record).toMatchObject({ type: 'RepairOrder', id: repairA, theirRef: null, ourRef: 'SEED-REP-0001', status: 'RECEIVED' })
    const ids = answer.body.messages.map((message: Json) => message.id)
    expect(ids).toContain(reply)
    expect(ids).not.toContain(note)
    expect(JSON.stringify(answer.body)).not.toMatch(/Internal: the seam/)
  })

  it('brand A posts on its repair: the thread is shared with brand A only, and the conversation is in its Messages list', async () => {
    const posted = await post(alpha, repairA, { body: 'Made-up: please check the left zip too.' })
    expect(posted.status, JSON.stringify(posted.body)).toBe(201)
    const [row] = await admin<{ partyId: string | null }>(`SELECT "partyId" FROM "Thread" WHERE "tenantId" = $1 AND "recordType" = 'RepairOrder' AND "recordId" = $2`, [world.tenantId, repairA])
    expect(row?.partyId).toBe(world.p1)
    const listed = await alpha.get('/portal/threads')
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.conversations.map((conversation: Json) => conversation.record.id)).toContain(repairA)
  })

  it('brand A finds its repair by number in the Returns group; its summary row reads through the same view', async () => {
    expect(all(await search(alpha, 'SEED-REP-0001')).find((result) => result.recordId === repairA)).toMatchObject({ recordType: 'RepairOrder', group: 'returns', ourRef: 'SEED-REP-0001', match: 'ours' })
    const summary = await alpha.get(`/records/RepairOrder/${repairA}/summary`)
    expect(summary.status, JSON.stringify(summary.body)).toBe(200)
    expect(summary.body.summary).toMatchObject({ recordType: 'RepairOrder', label: 'SEED-REP-0001', state: { code: 'RECEIVED' } })
  })
})

describe('T09 / W14: brand B never opens, finds, lists or writes on brand A’s repair', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('404 in neutral words on the thread, a post and the summary; no search hit; never listed', async () => {
    neutral404(await thread(beta, repairA), 'SEED-REP-0001')
    neutral404(await post(beta, repairA, { body: 'Made-up.' }), 'SEED-REP-0001')
    neutral404(await beta.get(`/records/RepairOrder/${repairA}/summary`), 'SEED-REP-0001')
    const found = await search(beta, 'SEED-REP-0001')
    expect(found.found).toBe(0)
    expect(JSON.stringify(found)).not.toContain(repairA)
    const listed = await beta.get('/portal/threads')
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(JSON.stringify(listed.body)).not.toMatch(new RegExp(`${repairA}|SEED-REP-0001`))
  })

  it('a supplier’s portal opens and finds no repair', async () => {
    neutral404(await thread(supplier, repairA))
    expect(all(await search(supplier, 'SEED-REP-0001')).filter((result) => result.recordType === 'RepairOrder')).toEqual([])
  })
})
