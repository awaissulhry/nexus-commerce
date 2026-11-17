import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../../auth/portal/service'
import { freshGuard } from '../../auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../../auth/sessions/testing/harness'
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from './testing/world'

/**
 * B-TH-073 (threads plan TH-5, PROJ-G16; wall tests T09 and T12; the Owner's rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand"): a brand discusses ONE style or ONE sample round in the portal, on that record's own
 * thread, through the partner views ./views/style.ts and ./views/sample-round.ts (the portal record route GET
 * /portal/threads/<type>/<id> and the portal search's Samples group).
 *
 *   brand A (P1, the seeds' customer and brand)  opens and finds its own private-label style SEED-JKT-01 and its own rounds
 *                                                (SEED-SR-0001 …), and posts on them; never an internal round on its own style
 *                                                (SEED-SR-0002: no customer), never an open-range style (its thread has no party)
 *   brand B (Seed Brand Two, SEED-C2B)           gets 404 — neutral words — on brand A's style and round, finds neither, never
 *                                                lists brand A's conversation, cannot post there (T09); none of its answers
 *                                                names brand A's style (T12), and brand A's answers name nothing of brand B's
 *   a supplier (P2's order desk)                 opens and finds no style and no round (a customer's portal only)
 *
 * The base seeds in one namespace (two-brands included), the search index built by the indexers, real portal sign-ins by e-mail
 * code. Run with `node scripts/factory/run-pg-tests.mjs platform/search/partner`.
 */

let h: Harness
let world: PartnerWorld
let alpha: Browser
let beta: Browser
let supplier: Browser
let brandB = ''
let styleA = ''
let styleB = ''
let openRange = ''
let roundA = ''
let internalRound = ''
const NS = 'th073sr'

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const thread = (browser: Browser, type: string, id: string) => browser.get(`/portal/threads/${type}/${id}`)
const post = (browser: Browser, type: string, id: string, body: Json) => browser.send('POST', `/portal/threads/${type}/${id}/messages`, body, { headers: { 'idempotency-key': `th073-${newId()}` } })
const search = async (browser: Browser, text: string, more = ''): Promise<Json> => {
  const answer = await browser.get(`/portal/search?q=${encodeURIComponent(text)}${more}`)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body
}
const all = (answer: Json): Json[] => answer.groups.flatMap((group: Json) => group.results)
const one = async <T = Json>(sql: string, values: unknown[]): Promise<T> => {
  const rows = await admin<T>(sql, values)
  expect(rows.length, sql).toBeGreaterThan(0)
  return rows[0]!
}

/** A 404 in neutral words: it never says that the record exists, nor whose it is. */
function neutral404(answer: { status: number; body: Json }, ...names: string[]): void {
  expect(answer.status, JSON.stringify(answer.body)).toBe(404)
  const text = JSON.stringify(answer.body)
  expect(text).toMatch(/not found/i)
  for (const name of names) expect(text).not.toContain(name)
  expect(text).not.toMatch(/another (customer|brand|company)|altro cliente/i)
}

beforeAll(async () => {
  h = await startHarness('style_round_views')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  // Brand B: the two-brands seed's second customer and brand, its own private-label style, its portal buyer (portal switched on).
  brandB = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [world.tenantId])).id
  const buyerB = await one<{ id: string; email: string; displayName: string }>(`SELECT id, email, "displayName" FROM "User" WHERE "tenantId" = $1 AND "partyId" = $2 AND email LIKE 'buyer.second-brand.%' LIMIT 1`, [world.tenantId, brandB])
  await inTenant(h, world, (client) => client.portalSettings.updateMany({ where: { partyId: brandB }, data: { portalOn: true } }))
  styleA = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01' AND "brandPartyId" = $2`, [world.tenantId, world.p1])).id
  styleB = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-B2' AND "brandPartyId" = $2`, [world.tenantId, brandB])).id
  openRange = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND "brandPartyId" IS NULL ORDER BY code LIMIT 1`, [world.tenantId])).id
  roundA = (await one<{ id: string }>(`SELECT id FROM "SampleRound" WHERE "tenantId" = $1 AND number = 'SEED-SR-0001' AND "partyId" = $2`, [world.tenantId, world.p1])).id
  internalRound = (await one<{ id: string }>(`SELECT id FROM "SampleRound" WHERE "tenantId" = $1 AND number = 'SEED-SR-0002' AND "partyId" IS NULL AND "styleId" = $2`, [world.tenantId, styleA])).id
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

describe('B-TH-073: a brand discusses one of its own styles or sample rounds in the portal', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('opens its own private-label style on its thread and finds it by code in Samples', async () => {
    const answer = await thread(alpha, 'Style', styleA)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.record).toMatchObject({ type: 'Style', id: styleA, theirRef: null, ourRef: 'SEED-JKT-01' })
    const found = await search(alpha, 'SEED-JKT-01')
    expect(all(found).find((result) => result.recordType === 'Style')).toMatchObject({ recordId: styleA, group: 'samples', ourRef: 'SEED-JKT-01', match: 'ours' })
    expect((await search(alpha, 'SEED-JKT-01', '&group=samples')).groups.map((group: Json) => group.group)).toEqual(['samples'])
  })

  it('opens its own round on its thread, by number and in words; never an internal round, even on its own style', async () => {
    const answer = await thread(alpha, 'SampleRound', roundA)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.record).toMatchObject({ type: 'SampleRound', id: roundA, ourRef: 'SEED-SR-0001', subtitle: 'Fit · round 1' })
    expect(all(await search(alpha, 'SEED-SR-0001')).find((result) => result.recordType === 'SampleRound')).toMatchObject({ recordId: roundA, group: 'samples', match: 'ours' })
    // The internal round (no customer) on brand A's own private style is in the office index under brand A, yet never brand A's.
    const indexed = await admin(`SELECT 1 FROM "SearchEntry" WHERE "tenantId" = $1 AND "recordType" = 'SampleRound' AND "recordId" = $2 AND "partyId" = $3`, [world.tenantId, internalRound, world.p1])
    expect(indexed.length).toBe(1)
    neutral404(await thread(alpha, 'SampleRound', internalRound))
    expect(all(await search(alpha, 'SEED-SR-0002')).filter((result) => result.recordId === internalRound)).toEqual([])
  })

  it('posts on its style and on its round; an open-range style has no conversation for a brand', async () => {
    const onStyle = await post(alpha, 'Style', styleA, { body: 'Made-up: can the collar lining be the 2027 red?' })
    expect(onStyle.status, JSON.stringify(onStyle.body)).toBe(201)
    const onRound = await post(alpha, 'SampleRound', roundA, { body: 'Made-up: the fit round arrived, sleeves are long.' })
    expect(onRound.status, JSON.stringify(onRound.body)).toBe(201)
    // Both threads are shared with brand A only (the record's own party).
    const threads = await admin<{ recordType: string; partyId: string | null }>(`SELECT "recordType", "partyId" FROM "Thread" WHERE "tenantId" = $1 AND "recordId" = ANY($2::uuid[])`, [world.tenantId, [styleA, roundA]])
    expect(threads.map((row) => row.partyId)).toEqual([world.p1, world.p1])
    const listed = await alpha.get('/portal/threads')
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.conversations.map((conversation: Json) => conversation.record.id)).toEqual(expect.arrayContaining([styleA, roundA]))
    // A style of nobody's private label (the open range): its thread names no party, so no brand reads or writes it here.
    neutral404(await thread(alpha, 'Style', openRange))
    neutral404(await post(alpha, 'Style', openRange, { body: 'Made-up question.' }))
  })
})

describe('T09: brand B never opens, finds, lists or writes on brand A’s style or round', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('404 in neutral words on brand A’s style and round, and no search hit', async () => {
    neutral404(await thread(beta, 'Style', styleA), 'SEED-JKT-01', 'SEED-SR-0001')
    neutral404(await thread(beta, 'SampleRound', roundA), 'SEED-JKT-01', 'SEED-SR-0001')
    neutral404(await post(beta, 'Style', styleA, { body: 'Made-up.' }))
    neutral404(await post(beta, 'SampleRound', roundA, { body: 'Made-up.' }))
    for (const text of ['SEED-JKT-01', 'SEED-SR-0001', 'SEED-SR-0002']) {
      const answer = await search(beta, text)
      expect(answer.found, text).toBe(0)
      expect(JSON.stringify(answer), text).not.toMatch(new RegExp(`${styleA}|${roundA}|${internalRound}`))
    }
    const listed = await beta.get('/portal/threads')
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(JSON.stringify(listed.body)).not.toMatch(new RegExp(`${styleA}|${roundA}|SEED-JKT-01|SEED-SR-0001`))
  })

  it('brand B opens and finds its own private-label style; brand A never does', async () => {
    const own = await thread(beta, 'Style', styleB)
    expect(own.status, JSON.stringify(own.body)).toBe(200)
    expect(own.body.record).toMatchObject({ type: 'Style', id: styleB, ourRef: 'SEED-JKT-B2' })
    expect(all(await search(beta, 'SEED-JKT-B2')).find((result) => result.recordId === styleB)).toMatchObject({ recordType: 'Style', group: 'samples' })
    neutral404(await thread(alpha, 'Style', styleB), 'SEED-JKT-B2')
    expect((await search(alpha, 'SEED-JKT-B2')).found).toBe(0)
  })

  it('a supplier’s portal opens and finds no style and no round', async () => {
    neutral404(await thread(supplier, 'Style', styleA))
    neutral404(await thread(supplier, 'SampleRound', roundA))
    const answer = await search(supplier, 'SEED-JKT-01')
    expect(all(answer).filter((result) => result.recordType === 'Style' || result.recordType === 'SampleRound')).toEqual([])
  })
})

describe('T12: no round answer names another brand’s style', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('brand A’s round and style answers hold nothing of brand B; brand B’s hold nothing of brand A', async () => {
    const [brandBRow] = await admin<{ legalName: string; tradeName: string | null }>('SELECT "legalName", "tradeName" FROM "Party" WHERE id = $1', [brandB])
    const [brandARow] = await admin<{ legalName: string }>('SELECT "legalName" FROM "Party" WHERE id = $1', [world.p1])
    const markersB = ['SEED-JKT-B2', 'SEED-C2B', brandBRow!.legalName, ...(brandBRow!.tradeName ? [brandBRow!.tradeName] : []), styleB, brandB]
    const markersA = ['SEED-JKT-01', 'SEED-SR-0001', brandARow!.legalName, styleA, roundA, world.p1]
    const seenByA = [await thread(alpha, 'SampleRound', roundA), await thread(alpha, 'Style', styleA)].map((answer) => JSON.stringify(answer.body))
    seenByA.push(JSON.stringify(await search(alpha, 'SEED-SR')), JSON.stringify(await search(alpha, 'SEED-JKT')), JSON.stringify((await alpha.get('/portal/threads')).body))
    for (const text of seenByA) for (const marker of markersB) expect(text, marker).not.toContain(marker)
    const seenByB = [JSON.stringify(await search(beta, 'SEED-SR')), JSON.stringify(await search(beta, 'SEED-JKT')), JSON.stringify((await beta.get('/portal/threads')).body)]
    for (const text of seenByB) for (const marker of markersA) expect(text, marker).not.toContain(marker)
  })

  it('a round answer names its round in words only, never a style code', async () => {
    const answer = await thread(alpha, 'SampleRound', roundA)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(JSON.stringify(answer.body.record)).not.toMatch(/SEED-JKT-/)
    for (const result of all(await search(alpha, 'SEED-SR')).filter((entry) => entry.recordType === 'SampleRound')) expect(JSON.stringify(result)).not.toMatch(/SEED-JKT-/)
  })
})
