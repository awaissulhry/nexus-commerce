/**
 * KAPI-B (2026-10-10, Bid page "keyword Auto + goal + max bid") — POST /api/advertising/bids/:targetId/mode and the
 * BidRow fields it drives (goal, auto, autoWhy on GET /api/advertising/bids), on a real PostgreSQL (PGlite), business
 * profiles ON, the bid brain's server switch live:
 *
 *   manual    MANUAL = a person's hold with no end; a second click changes nothing; his later bid keeps it without end
 *   auto      AUTO = hand back: his holds end, a hand-back mark is stored, his bid of the last 60 days no longer holds the
 *             keyword (the row reads AUTO); a newer bid of his holds it again
 *   refused   Auto under the campaign's pinned bids or the Owner's lock of the keyword's bid (409, with what lifts it); a
 *             campaign the bid brain does not run (409: no engine runs it); another business's keyword (404); a bad body (400)
 *   rows      auto / autoWhy per row: AUTO, MANUAL with why, NONE with who sets the bid instead; goal = the keyword's own
 *             target ACoS, share target and max, who set the newest and when; the max and the goal's ACoS are money keys;
 *             brainProductId = the enrolled product whose brain runs the campaign (the productId a goal is saved under)
 *
 * Values are made up (public repo).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { seedAdsFixture } from '../test-support/ads-fixtures.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const A = 'kapib_mode_alpha'
const B = 'kapib_mode_beta'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const NOW = Date.now()
const DAY = 86_400_000
const ago = (ms: number) => new Date(NOW - ms)
let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: true, permissions: new Set() }
const inA = <T>(work: () => Promise<T>) => withWorkspace(business(A), work)
const c = () => database.client as any

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  for (const w of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [w])
  }
  await inA(async () => {
    const db = c()
    await seedAdsFixture(db)
    const campaign = (id: string, extra: Record<string, unknown> = {}) => db.campaign.create({
      data: { id, name: `Italy ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra },
    })
    const group = (campaignId: string) => db.adGroup.create({ data: { id: `g-${campaignId}`, campaignId, name: `group ${campaignId}`, externalAdGroupId: `EXT-g-${campaignId}` } })
    const target = (id: string, campaignId: string, text: string, bidCents: number) => db.adTarget.create({
      data: { id, adGroupId: `g-${campaignId}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents, externalTargetId: `EXT-${id}` },
    })
    // c-brain: the bid brain owns it LIVE.
    await campaign('c-brain')
    await group('c-brain')
    await target('t-auto', 'c-brain', 'jacket men', 30)
    await target('t-person', 'c-brain', 'jacket women', 25)
    await target('t-lock', 'c-brain', 'jacket kids', 20)
    await db.bidBrainEnrollment.create({ data: { campaignId: 'c-brain', marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:u1' } })
    // t-person: a person's own bid two days ago (the brain leaves it for 60 days).
    await db.advertisingActionLog.create({ data: { userId: 'user:u1', actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: 't-person', payloadBefore: { bidCents: 30 }, payloadAfter: { bidCents: 25 }, createdAt: ago(2 * DAY), amazonResponseStatus: 'SUCCESS' } })
    // t-lock: the Owner's lock of its bid (set-ads-brain lock bids, ref target:t-lock).
    await db.adsBrainOverride.create({ data: { productId: 'p-x', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-brain', kind: 'LOCK', key: 'bids', ref: 'target:t-lock', by: 'user:u1' } })
    // c-pin: the bid brain owns it, every bid pinned.
    await campaign('c-pin2', { pinBids: true, pinnedBy: 'user:u1' })
    await group('c-pin2')
    await target('t-pinned', 'c-pin2', 'jacket pinned', 22)
    await db.bidBrainEnrollment.create({ data: { campaignId: 'c-pin2', marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:u1' } })
    // c-shadow: under the bid brain in shadow only.
    await campaign('c-shadow')
    await group('c-shadow')
    await target('t-shadow', 'c-shadow', 'jacket shadow', 18)
    await db.bidBrainEnrollment.create({ data: { campaignId: 'c-shadow', marketplace: 'IT', mode: 'SHADOW', enrolledBy: 'user:u1' } })
    // brainProductId: c-brain advertises one product, enrolled in the brain in IT; c-shadow one that is not enrolled.
    await db.product.create({ data: { id: 'kapib-jacket', sku: 'KAPIB-JACKET', name: 'Jacket', basePrice: '80.00', isParent: true } })
    await db.product.create({ data: { id: 'kapib-boots', sku: 'KAPIB-BOOTS', name: 'Boots', basePrice: '60.00', isParent: true } })
    await db.adProductAd.create({ data: { adGroupId: 'g-c-brain', productId: 'kapib-jacket', sku: 'KAPIB-JACKET', asin: 'KAPIBASIN01' } })
    await db.adProductAd.create({ data: { adGroupId: 'g-c-shadow', productId: 'kapib-boots', sku: 'KAPIB-BOOTS', asin: 'KAPIBASIN02' } })
    await db.adsBrainEnrollment.create({ data: { productId: 'kapib-jacket', marketplace: 'IT', enrolledBy: 'user:u1', updatedBy: 'user:u1' } })
  })
  await withWorkspace(business(B), async () => {
    const db = c()
    await db.campaign.create({ data: { id: 'b-camp', name: 'Other business', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-b-camp', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
    await db.adGroup.create({ data: { id: 'b-group', campaignId: 'b-camp', name: 'other group', externalAdGroupId: 'EXT-b-group' } })
    await db.adTarget.create({ data: { id: 'b-target', adGroupId: 'b-group', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'other jacket', bidCents: 40, externalTargetId: 'EXT-b-target' } })
    await db.bidBrainEnrollment.create({ data: { campaignId: 'b-camp', marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:u9' } })
  })
  const [{ default: modeRoutes }, { default: bidsRoutes }] = await Promise.all([import('./advertising-bid-mode.routes.js'), import('./advertising-bids.routes.js')])
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    request.__rbacResolved = permissions
    withWorkspace(business(A), done)
  })
  await app.register(modeRoutes, { prefix: '/api' })
  await app.register(bidsRoutes, { prefix: '/api' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

const mode = (targetId: string, body: unknown) => app.inject({ method: 'POST', url: `/api/advertising/bids/${targetId}/mode`, headers: { 'x-actor-id': 'u-owner' }, payload: body as object })
const rows = async () => new Map(((await app.inject({ method: 'GET', url: '/api/advertising/bids' })).json().rows as Array<Record<string, any>>).map((r) => [r.targetId, r]))
const holds = (targetId: string) => inA(() => c().bidHold.findMany({ where: { targetId }, orderBy: { createdAt: 'asc' } })) as Promise<Array<Record<string, any>>>

describe('POST /api/advertising/bids/:targetId/mode — one keyword\'s Auto / Manual', () => {
  it('the rows before any switch: AUTO, MANUAL with why, NONE with who sets the bid instead', async () => {
    const r = await rows()
    expect(r.get('t-auto')).toMatchObject({ auto: 'AUTO', autoWhy: null, goal: null })
    expect(r.get('t-person')).toMatchObject({ auto: 'MANUAL', autoWhy: 'You set this bid in the last 60 days: the brain leaves it' })
    // R2 — the Owner's lock is the person's ("You", as the owner chip says), never a raw actor.
    expect(r.get('t-lock')).toMatchObject({ auto: 'MANUAL', autoWhy: 'You locked this keyword\'s bid: the brain leaves it', owner: { kind: 'PERSON', id: 'you' } })
    expect(r.get('t-pinned')).toMatchObject({ auto: 'MANUAL', autoWhy: 'Every bid of this campaign is locked (pinned bids)' })
    // R2 — NONE names the row's own owner (here nobody), and never says "shadow".
    expect(r.get('t-shadow')).toMatchObject({ auto: 'NONE', autoWhy: 'Nobody sets this bid: the brain only watches this campaign', owner: { kind: 'NONE' } })
    expect(r.get('t-it')).toMatchObject({ auto: 'NONE', autoWhy: 'No engine runs this campaign', owner: { kind: 'NONE' } })
  })

  it('brainProductId: the enrolled product whose brain runs the keyword\'s campaign; null for a product not enrolled or a campaign tied to none', async () => {
    const r = await rows()
    expect(r.get('t-auto')!.brainProductId).toBe('kapib-jacket')
    expect(r.get('t-lock')!.brainProductId).toBe('kapib-jacket')
    expect(r.get('t-shadow')!.brainProductId).toBeNull()
    expect(r.get('t-pinned')!.brainProductId).toBeNull()
  })

  it('MANUAL: a person\'s hold with no end; a second click changes nothing; his later bid keeps it without end', async () => {
    const res = await mode('t-auto', { mode: 'MANUAL' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).toMatchObject({ targetId: 't-auto', campaignId: 'c-brain', mode: 'MANUAL', before: 'AUTO', changed: true, holdId: expect.any(String), ended: [], undo: { mode: 'AUTO' } })
    expect(await holds('t-auto')).toEqual([expect.objectContaining({ kind: 'PERSON', until: null, endedAt: null, by: 'user:u-owner' })])
    // The owner chip says You (the brain leaves it), as auto-bid's and the brain's one read of a person's bid does.
    expect((await rows()).get('t-auto')).toMatchObject({ auto: 'MANUAL', autoWhy: 'You hold this bid (Manual)', owner: { kind: 'PERSON', id: 'you' } })
    const { personBidTargetIds } = await import('../services/advertising/bid-grid.service.js')
    expect(await inA(async () => [...await personBidTargetIds({ targetIds: ['t-auto'] })])).toEqual(['t-auto'])
    const again = await mode('t-auto', { mode: 'MANUAL' })
    expect(again.json()).toMatchObject({ changed: false, before: 'MANUAL', holdId: res.json().holdId })
    expect(await holds('t-auto')).toHaveLength(1)
    // His own bid on it (the write path's recordBrainHold) keeps it Manual: the new hold has no end either.
    const { recordBrainHold } = await import('../services/advertising/bid-brain/brain-holds.js')
    expect(await inA(() => recordBrainHold({ campaignId: 'c-brain', targetId: 't-auto', actor: 'user:u-owner', manual: true }))).toBe('held')
    const after = await holds('t-auto')
    expect(after.filter((h) => !h.endedAt)).toEqual([expect.objectContaining({ kind: 'PERSON', until: null })])
  })

  it('AUTO: his holds end, the hand-back mark is stored, the row reads AUTO; the undo is MANUAL', async () => {
    const res = await mode('t-auto', { mode: 'AUTO' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ mode: 'AUTO', before: 'MANUAL', changed: true, ended: [expect.objectContaining({ kind: 'PERSON', until: null })], undo: { mode: 'MANUAL' } })
    const all = await holds('t-auto')
    expect(all.filter((h) => !h.endedAt)).toEqual([])
    expect(all.filter((h) => h.kind === 'HANDBACK')).toEqual([expect.objectContaining({ endedAt: expect.any(Date), by: 'user:u-owner' })])
    expect((await rows()).get('t-auto')).toMatchObject({ auto: 'AUTO', autoWhy: null, owner: { kind: 'BRAIN' } })
    expect((await mode('t-auto', { mode: 'AUTO' })).json()).toMatchObject({ changed: false, before: 'AUTO' })
  })

  it('AUTO on a keyword held by his bid of the last 60 days: released for the brain; a newer bid of his holds it again', async () => {
    const res = await mode('t-person', { mode: 'AUTO' })
    expect(res.json()).toMatchObject({ before: 'MANUAL', changed: true })
    expect((await rows()).get('t-person')).toMatchObject({ auto: 'AUTO' })
    const { personBidTargetIds } = await import('../services/advertising/bid-grid.service.js')
    // The one read of a person's bid (the brain's, auto-bid's, the owner chip's) leaves it after the hand-back.
    expect(await inA(async () => [...await personBidTargetIds({ targetIds: ['t-person'] })])).toEqual([])
    expect((await rows()).get('t-person')!.owner).toMatchObject({ kind: 'BRAIN' })
    await inA(() => c().advertisingActionLog.create({ data: { userId: 'user:u1', actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: 't-person', payloadBefore: { bidCents: 25 }, payloadAfter: { bidCents: 27 }, createdAt: new Date(Date.now() + 1000), amazonResponseStatus: 'SUCCESS' } }))
    expect((await rows()).get('t-person')).toMatchObject({ auto: 'MANUAL' })
  })

  it('refused: Auto under the Owner\'s lock or the campaign\'s pinned bids (what lifts it said); a campaign the brain does not run; another business; a bad body', async () => {
    const lock = await mode('t-lock', { mode: 'AUTO' })
    expect(lock.statusCode).toBe(409)
    expect(lock.json().error).toMatch(/^This keyword's bid locked by the Owner's campaign override .*: unlock it/)
    const pinned = await mode('t-pinned', { mode: 'AUTO' })
    expect([pinned.statusCode, pinned.json().error]).toEqual([409, expect.stringMatching(/^Every bid of this campaign is locked \(pinned bids by user:u1\): unlock the campaign's bids/)])
    const shadow = await mode('t-shadow', { mode: 'MANUAL' })
    expect([shadow.statusCode, shadow.json().error]).toEqual([409, expect.stringMatching(/^No engine runs this campaign/)])
    expect((await mode('b-target', { mode: 'MANUAL' })).statusCode).toBe(404)
    expect((await mode('no-such', { mode: 'AUTO' })).statusCode).toBe(404)
    expect((await mode('t-auto', { mode: 'SOMETIMES' })).statusCode).toBe(400)
    expect((await mode('t-auto', { mode: 'AUTO', extra: 1 })).statusCode).toBe(400)
    // Nothing held by a refusal.
    expect((await holds('t-lock')).length).toBe(0)
  })

  it('a Manual hold outlives the brain (the campaign back in shadow): Auto still ends the keyword\'s own hold, never stuck', async () => {
    await inA(() => c().bidHold.create({ data: { campaignId: 'c-shadow', targetId: 't-shadow', kind: 'PERSON', until: null, by: 'user:u-owner' } }))
    const back = await mode('t-shadow', { mode: 'AUTO' })
    expect(back.statusCode).toBe(200)
    expect(back.json()).toMatchObject({ mode: 'AUTO', before: 'MANUAL', changed: true, words: expect.stringMatching(/^Your hold on this keyword ended\. No engine runs this campaign now/) })
    expect((await holds('t-shadow')).every((h) => h.endedAt != null)).toBe(true)
    // With no hold of its own left, Auto there is refused again (no engine runs it).
    const again = await mode('t-shadow', { mode: 'AUTO' })
    expect([again.statusCode, again.json().error]).toEqual([409, expect.stringMatching(/^No engine runs this campaign/)])
  })
})

describe('GET /api/advertising/bids — the keyword\'s own goal', () => {
  it('its own target ACoS, share target and max, who set the newest and when; the max and the goal\'s ACoS are money', async () => {
    await inA(async () => {
      await c().adsBrainOverride.create({ data: { productId: 'p-x', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-brain', kind: 'VALUE', key: 'maxBidCents', ref: 'target:t-auto', value: 40, by: 'user:u-owner', createdAt: ago(DAY) } })
      await c().adsBrainOverride.create({ data: { productId: 'p-x', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-brain', kind: 'VALUE', key: 'targetAcosPct', ref: 'target:t-auto', value: 25, by: 'user:u-owner', createdAt: ago(1000) } })
    })
    const row = (await rows()).get('t-auto')
    expect(row!.goal).toEqual({ acosPct: 25, tosPct: null, maxCents: 40, by: { kind: 'PERSON', name: 'You', id: 'you' }, at: ago(1000).toISOString() })
    permissions = { isOwner: false, permissions: new Set([FIELDS.financialsAdspendView].filter(() => false)) }
    const hidden = (await rows()).get('t-auto')
    permissions = { isOwner: true, permissions: new Set() }
    expect(hidden!.goal).toEqual({ tosPct: null, by: { kind: 'PERSON', name: 'You', id: 'you' }, at: ago(1000).toISOString() })
  })
})

describe('personBidTargetIds — the one read of a person\'s bid (the brain, auto-bid, the owner chip) knows Manual and Auto', () => {
  it('an open person\'s hold with no end (Manual) holds a keyword auto-bid would move; its end releases it; the kinds match the brain\'s', async () => {
    const { personBidTargetIds, PERSON_HOLD_KINDS, HANDBACK_HOLD_KIND } = await import('../services/advertising/bid-grid.service.js')
    const brain = await import('../services/advertising/bid-brain/brain-holds.js')
    expect([...PERSON_HOLD_KINDS]).toEqual([...brain.PERSON_HOLD_KINDS])
    expect(HANDBACK_HOLD_KIND).toBe(brain.HANDBACK_KIND)
    const hold = await inA(() => c().bidHold.create({ data: { campaignId: 'c-it', targetId: 't-it', kind: 'PERSON', until: null, by: 'user:u1' } }))
    expect(await inA(async () => [...await personBidTargetIds({ targetIds: ['t-it'] })])).toEqual(['t-it'])
    expect(await inA(async () => (await personBidTargetIds()).has('t-it'))).toBe(true)
    await inA(() => c().bidHold.update({ where: { id: hold.id }, data: { endedAt: new Date(), endedBy: 'user:u1' } }))
    expect(await inA(async () => [...await personBidTargetIds({ targetIds: ['t-it'] })])).toEqual([])
  })
})

describe('set-ads-brain set-value of a keyword\'s own goal or max — the productId resolved from the keyword (target:<id>)', () => {
  it('no productId: the keyword\'s campaign names its enrolled product; the max\'s bounds and the tool\'s words say the new settings', async () => {
    const { previewControl } = await import('../services/advertising/brain/control.js')
    const { ADS_BRAIN_CONTROL_TOOLS } = await import('../services/agents/tools/ads-brain-control.tools.js')
    const ok = await inA(() => previewControl({ op: 'set-value', productId: '', market: 'IT', key: 'maxBidCents', value: 60, ref: 'target:t-auto' }))
    expect('refusal' in ok ? ok.refusal : null).toBeNull()
    if ('preview' in ok) {
      expect(ok.preview.brain).toMatchObject({ productId: 'kapib-jacket', market: 'IT', enrolled: true })
      expect(ok.preview.needsCode).toBe(false)
      expect(ok.preview.change).toMatchObject({ kind: 'VALUE', key: 'maxBidCents', ref: 'target:t-auto' })
    }
    // A max under the brain's 5¢ engine floor, a keyword of a campaign tied to no product, no ref at all: refused, said.
    expect(await inA(() => previewControl({ op: 'set-value', productId: '', market: 'IT', key: 'maxBidCents', value: 4, ref: 'target:t-auto' }))).toEqual({ ok: false, refusal: expect.stringMatching(/from 5 to 100000/) })
    expect(await inA(() => previewControl({ op: 'set-value', productId: '', market: 'IT', key: 'targetAcosPct', value: 25, ref: 'target:t-pinned' }))).toEqual({ ok: false, refusal: expect.stringMatching(/^Nexus ties the campaign of target:t-pinned to no product: name the product/) })
    expect(await inA(() => previewControl({ op: 'set-value', productId: '', market: 'DE', key: 'targetAcosPct', value: 25, ref: 'target:t-auto' }))).toEqual({ ok: false, refusal: 'target:t-auto runs in IT, not in DE' })
    expect(await inA(() => previewControl({ op: 'set-level', productId: '', market: 'IT', lever: 'bids', level: 'AUTO' }))).toEqual({ ok: false, refusal: expect.stringMatching(/^productId names the product/) })
    // productId stays accepted.
    expect('preview' in await inA(() => previewControl({ op: 'set-value', productId: 'kapib-jacket', market: 'IT', key: 'targetAcosPct', value: 25, ref: 'target:t-auto' }))).toBe(true)
    // The tool takes no productId for it, and its words name the new settings and their ranges.
    const tool = ADS_BRAIN_CONTROL_TOOLS.find((t) => t.name === 'set-ads-brain')!
    expect(tool.input.safeParse({ op: 'set-value', market: 'IT', key: 'maxBidCents', value: 60, ref: 'target:t-auto' }).success).toBe(true)
    expect(tool.description).toMatch(/targetAcosPct \(the keyword's own target ACoS, a whole percent 1–200/)
    expect(tool.description).toMatch(/maxBidCents \(the keyword's own max bid in cents, a whole number from 5/)
    expect(tool.planEntities!({ op: 'set-value', market: 'IT', ref: 'target:t-auto' }, { brain: { productId: 'kapib-jacket' } })).toEqual({ reads: ['ads-brain:kapib-jacket@IT'], writes: ['ads-brain:kapib-jacket@IT'] })
  })
})
