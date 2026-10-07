/**
 * W4-11 — a Sponsored Brands / Display write, from the mutation layer to the Amazon client.
 *
 *   · Only a caller that may change SB/SD (`allowSbSd`: Claude's requests) gets past the mutation layer; the engines,
 *     rules and the screens' routes pass none and stay Sponsored Products only (6a, unchanged — ads-sbsd-refuse pins it).
 *   · A write let through is marked on its queue row (`sbSd`); the worker describes it to the gate (`write`) and sends it
 *     to the ad product's own endpoint (ads-api-client.ts sendSbSdUpdate): SB 4.0 /sb/v4/campaigns, SD /sd/campaigns, SB
 *     /sb/keywords and /sb/targets, SD /sd/targets, and the archive of an SB negative keyword / SD negative product target.
 *   · A row without the mark is not described, so the gate keeps refusing an SB/SD row any other path queued (its 6a
 *     door on the live path, ads-write-gate-sbsd.vitest.test.ts), and it is not routed to the SB/SD endpoints.
 *
 * PGlite with the production schema. The gate is a stand-in that records its input and allows (live); the Amazon client
 * is a recorder. Nothing leaves the process. All ids are made up (numeric, as Amazon's are).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import type { GateContext, GateDecision } from '../services/advertising/ads-write-gate.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
const gate = vi.hoisted(() => ({ seen: [] as GateContext[] }))
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()),
  checkAdsWriteGate: async (ctx: GateContext): Promise<GateDecision> => {
    gate.seen.push(ctx)
    return { allowed: true, mode: 'live', profileId: 'P-SBSD' }
  },
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
const amazon = vi.hoisted(() => ({ sp: [] as string[], sbsd: [] as Array<{ method: string; path: string; body: unknown }> }))
vi.mock('../services/advertising/ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/advertising/ads-api-client.js')>()
  const sp = (fn: string) => async () => { amazon.sp.push(fn); return { ok: true, rawResponse: {}, error: null } }
  return {
    ...real,
    adsMode: () => 'live',
    updateCampaign: sp('updateCampaign'), updateAdGroup: sp('updateAdGroup'), updateTarget: sp('updateTarget'),
    updateProductAd: sp('updateProductAd'), archiveSpEntity: sp('archiveSpEntity'),
    sendSbSdUpdate: async (_ctx: unknown, request: { method: string; path: string; body?: unknown }) => {
      amazon.sbsd.push({ method: request.method, path: request.path, body: request.body })
      return { ok: true, mode: 'live', rawResponse: {}, error: null }
    },
  }
})

const { drainAdsSyncOnce } = await import('./ads-sync.worker.js')
const { updateCampaignWithSync, updateAdTargetWithSync, updateAdGroupWithSync } = await import('../services/advertising/ads-mutation.service.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const CLAUDE = 'user:sbsd-approver' as const
const ENGINE = 'automation:tstrule-sbsd' as const
const drain = () => inside(() => drainAdsSyncOnce(50))
const queueJson = async (id: string) => ((await inside(() => database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id } }))).payload as Record<string, unknown>)

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    const campaign = (id: string, ext: string, adProduct: string, type: string, extra: Record<string, unknown> = {}) => db.campaign.create({
      data: { id, name: `Test ${id}`, type, adProduct, marketplace: 'IT', externalCampaignId: ext, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, costType: 'cpc', ...extra } as never,
    })
    await campaign('w-sb', '100000000001', 'SPONSORED_BRANDS', 'SB', { budgetJson: { budgetType: 'DAILY' } })
    await campaign('w-sd', '100000000002', 'SPONSORED_DISPLAY', 'SD')
    await campaign('w-sp', '100000000003', 'SPONSORED_PRODUCTS', 'SP')
    for (const [g, c, ext] of [['wg-sb', 'w-sb', '200000000001'], ['wg-sd', 'w-sd', '200000000002'], ['wg-sp', 'w-sp', '200000000003']]) {
      await db.adGroup.create({ data: { id: g, campaignId: c, name: `group ${g}`, externalAdGroupId: ext } })
    }
    const target = (id: string, adGroupId: string, kind: string, ext: string, extra: Record<string, unknown> = {}) => db.adTarget.create({
      data: { id, adGroupId, kind, expressionType: kind === 'KEYWORD' ? 'EXACT' : 'ASIN', expressionValue: `term ${id}`, bidCents: 40, externalTargetId: ext, ...extra },
    })
    await target('wt-sb-kw', 'wg-sb', 'KEYWORD', '300000000001')
    await target('wt-sb-pt', 'wg-sb', 'PRODUCT', '300000000002')
    await target('wt-sd-pt', 'wg-sd', 'PRODUCT', '300000000003')
    await target('wt-sb-neg', 'wg-sb', 'KEYWORD', '400000000001', { isNegative: true, negativeLevel: 'AD_GROUP', expressionType: 'NEGATIVE_EXACT', bidCents: 0 })
    await target('wt-sd-neg', 'wg-sd', 'PRODUCT', '400000000002', { isNegative: true, negativeLevel: 'AD_GROUP', bidCents: 0 })
    await target('wt-sp', 'wg-sp', 'KEYWORD', '300000000009')
    await db.amazonAdsConnection.create({ data: { profileId: 'P-SBSD', marketplace: 'IT', mode: 'production', isActive: true } as never })
  })
}, 180_000)
afterAll(async () => { await database?.close() })
beforeEach(async () => {
  await drain() // nothing from an earlier test is left due
  gate.seen = []; amazon.sp = []; amazon.sbsd = []
})

describe('the mutation layer: only a caller that may change SB/SD', () => {
  it('an engine (no allowSbSd) is refused with the 6a sentence and nothing is queued, as before', async () => {
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'w-sb', patch: { dailyBudget: 25 }, actor: ENGINE }))
    expect(r).toMatchObject({ ok: false, outboundQueueId: null, error: expect.stringMatching(/is not a Sponsored Products campaign \(it is Sponsored Brands\)/) })
  })

  it('a Claude request (allowSbSd) is queued and marked; a write Nexus does not send for SB/SD is still refused, by name', async () => {
    const ok = await inside(() => updateCampaignWithSync({ campaignId: 'w-sb', patch: { dailyBudget: 25 }, actor: CLAUDE, allowSbSd: true, applyImmediately: true }))
    expect(ok).toMatchObject({ ok: true, error: null })
    expect(await queueJson(ok.outboundQueueId!)).toMatchObject({ entityType: 'CAMPAIGN', sbSd: true })
    const no = await inside(() => updateCampaignWithSync({ campaignId: 'w-sb', patch: { biddingStrategy: 'MANUAL' }, actor: CLAUDE, allowSbSd: true }))
    expect(no).toMatchObject({ ok: false, outboundQueueId: null, error: expect.stringMatching(/^Test w-sb is a Sponsored Brands campaign\. .* — not the campaign's biddingStrategy —/) })
    // An ad group takes no SB/SD write from Nexus (no allowSbSd there at all): the 6a sentence.
    const group = await inside(() => updateAdGroupWithSync({ adGroupId: 'wg-sd', patch: { defaultBidCents: 60 }, actor: CLAUDE }))
    expect(group).toMatchObject({ ok: false, error: expect.stringMatching(/it is Sponsored Display/) })
  })

  it('an SP write through the same path is not marked', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'wt-sp', patch: { bidCents: 44 }, actor: CLAUDE, allowSbSd: true, applyImmediately: true }))
    expect(await queueJson(r.outboundQueueId!)).not.toHaveProperty('sbSd')
    await drain()
    expect(amazon.sp).toEqual(['updateTarget'])
    expect(amazon.sbsd).toEqual([])
    expect(gate.seen[0].write).toBeUndefined()
  })
})

describe('the worker routes a marked row to its ad product\'s own endpoint, and describes it to the gate', () => {
  it('SB campaign budget → PUT /sb/v4/campaigns; SD campaign pause → PUT /sd/campaigns', async () => {
    await inside(() => updateCampaignWithSync({ campaignId: 'w-sb', patch: { dailyBudget: 30 }, actor: CLAUDE, allowSbSd: true, applyImmediately: true }))
    await inside(() => updateCampaignWithSync({ campaignId: 'w-sd', patch: { status: 'PAUSED' }, actor: CLAUDE, allowSbSd: true, applyImmediately: true, manual: true }))
    await drain()
    expect(amazon.sp).toEqual([])
    expect(amazon.sbsd).toEqual(expect.arrayContaining([
      { method: 'PUT', path: '/sb/v4/campaigns', body: { campaigns: [{ campaignId: '100000000001', budget: 30 }] } },
      { method: 'PUT', path: '/sd/campaigns', body: [{ campaignId: 100000000002, state: 'paused' }] },
    ]))
    expect(gate.seen.map((g) => g.write)).toEqual(expect.arrayContaining([
      { entity: 'CAMPAIGN', fields: ['dailyBudget'], toStatus: null, kind: null, isNegative: false, negativeLevel: null },
      { entity: 'CAMPAIGN', fields: ['status'], toStatus: 'PAUSED', kind: null, isNegative: false, negativeLevel: null },
    ]))
  })

  it('an SB keyword bid → PUT /sb/keywords (with its ad group and campaign); an SB product target → /sb/targets; an SD target → /sd/targets', async () => {
    for (const id of ['wt-sb-kw', 'wt-sb-pt', 'wt-sd-pt']) {
      const r = await inside(() => updateAdTargetWithSync({ adTargetId: id, patch: { bidCents: 55 }, actor: CLAUDE, allowSbSd: true, applyImmediately: true, manual: true }))
      expect(r.ok, r.error ?? '').toBe(true)
    }
    await drain()
    expect(amazon.sbsd).toEqual(expect.arrayContaining([
      { method: 'PUT', path: '/sb/keywords', body: [{ keywordId: 300000000001, adGroupId: 200000000001, campaignId: 100000000001, bid: 0.55 }] },
      { method: 'PUT', path: '/sb/targets', body: { targets: [{ targetId: 300000000002, adGroupId: 200000000001, campaignId: 100000000001, bid: 0.55 }] } },
      { method: 'PUT', path: '/sd/targets', body: [{ targetId: 300000000003, bid: 0.55 }] },
    ]))
    expect(amazon.sp).toEqual([])
    expect(gate.seen.find((g) => g.write?.kind === 'PRODUCT' && g.write.entity === 'AD_TARGET')).toBeTruthy()
  })

  it('retiring an SB negative keyword and an SD negative product target → their DELETE (archive)', async () => {
    for (const id of ['wt-sb-neg', 'wt-sd-neg']) {
      const r = await inside(() => updateAdTargetWithSync({ adTargetId: id, patch: { status: 'ARCHIVED' }, actor: CLAUDE, allowSbSd: true, applyImmediately: true }))
      expect(r.ok, r.error ?? '').toBe(true)
    }
    await drain()
    expect(amazon.sbsd).toEqual(expect.arrayContaining([
      { method: 'DELETE', path: '/sb/negativeKeywords/400000000001', body: undefined },
      { method: 'DELETE', path: '/sd/negativeTargets/400000000002', body: undefined },
    ]))
    // A negative is only retired from Nexus: a pause of an SB negative is refused before anything is queued.
    const paused = await inside(() => updateAdTargetWithSync({ adTargetId: 'wt-sd-pt', patch: { status: 'ARCHIVED' }, actor: CLAUDE, allowSbSd: true }))
    expect(paused).toMatchObject({ ok: false, error: expect.stringContaining('not archiving a target') })
  })

  it('🔴 an SD row queued WITHOUT the mark is not described to the gate (whose 6a door then refuses it live) and is not routed to SD', async () => {
    // As if some other path queued it: the mutation layer's own row, with its mark taken off.
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'w-sd', patch: { dailyBudget: 21 }, actor: CLAUDE, allowSbSd: true, applyImmediately: true }))
    const row = await inside(() => database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id: r.outboundQueueId! } }))
    const { sbSd: _mark, ...unmarked } = row.payload as Record<string, unknown>
    await inside(() => database.client.outboundSyncQueue.update({ where: { id: row.id }, data: { payload: unmarked as never } }))
    await drain()
    // The real gate refuses an undescribed SB/SD write on the live path (ads-write-gate-adproduct / -sbsd); here it is
    // the recorder: the worker handed it no description and no SB/SD route.
    expect(gate.seen.at(-1)?.write).toBeUndefined()
    expect(amazon.sbsd).toEqual([])
  })
})
