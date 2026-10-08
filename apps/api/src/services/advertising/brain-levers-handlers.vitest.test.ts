/**
 * ONE BRAIN AB-6 — the rule actions that write several campaigns leave, campaign by campaign, a lever a product's brain owns
 * (or the Owner holds), in a dry run too, and report `brainSkips` counts (automation-action-handlers.ts):
 *   sync_negatives_across_campaigns   a held campaign gets no negative; all held → a named skip, not a failure
 *   harvest_and_negate                a term whose source campaign's negatives / harvest is held is left out of the plan
 *   promote_to_exact                  a held destination gets no keyword; a held source gets no isolation negative
 *   add_negative_* (mapped)           a held destination gets no negative
 *   dayparting_apply                  a bid brain campaign and one whose ad-group default bids are held are left whole
 * And for each: nothing enrolled (production today) → exactly as before, no `brainSkips` key, no extra query.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createKeywordLocal: vi.fn(),
  pushExistingKeyword: vi.fn(),
  createTargetLocal: vi.fn(),
  createNegative: vi.fn(),
  writeNegativeKeyword: vi.fn(),
  writeNegativeProductTarget: vi.fn(),
  campaignLeverOwners: vi.fn(),
  anyBrainEnrolled: vi.fn(),
  brainOwned: new Set<string>(),
  suppressCampaignBids: vi.fn(),
  restoreCampaignBids: vi.fn(),
  previewHarvest: vi.fn(),
  planRuleHarvest: vi.fn(),
  applyHarvest: vi.fn(),
}))

vi.mock('../automation-rule.service.js', () => ({ ACTION_HANDLERS: {} as Record<string, unknown>, getFieldPath: vi.fn() }))
vi.mock('./ads-mutation.service.js', () => ({ updateCampaignWithSync: vi.fn(), updateAdGroupWithSync: vi.fn(), updateAdTargetWithSync: vi.fn() }))
vi.mock('./ads-negative-kw.service.js', () => ({ createNegative: h.createNegative, writeNegativeKeyword: h.writeNegativeKeyword, writeNegativeProductTarget: h.writeNegativeProductTarget }))
vi.mock('./ads-create.service.js', () => ({
  createKeywordLocal: h.createKeywordLocal, pushExistingKeyword: h.pushExistingKeyword, createTargetLocal: h.createTargetLocal,
  mirrorNegativeKeywordLocal: vi.fn(async () => ({ created: true, id: 'n-local' })), createNegativeKeywordCampaignLocal: vi.fn(async () => ({ created: true, id: 'n-camp' })),
}))
vi.mock('./ads-bid-suppression.service.js', () => ({ suppressCampaignBids: h.suppressCampaignBids, restoreCampaignBids: h.restoreCampaignBids }))
vi.mock('./ads-protect-converting.js', () => ({
  checkProtectConverting: vi.fn(async () => new Map()), protectConvertingConfig: () => ({}), normaliseNegTerm: (t: string) => t.trim().toLowerCase(),
}))
vi.mock('./ads-profile-resolver.js', () => ({ adsClientContextFor: vi.fn(async () => ({ profileId: 'P-IT' })) }))
vi.mock('./ads-harvest.service.js', () => ({
  previewHarvest: h.previewHarvest, planRuleHarvest: h.planRuleHarvest, applyHarvest: h.applyHarvest,
  harvestItemKey: (i: { kind: string; query: string; externalAdGroupId: string }) => `${i.kind}|${i.query}|${i.externalAdGroupId}`,
  planList: () => ['EXACT'], homeWinners: vi.fn(async () => new Set()), winnerKey: (t: string, g: string) => `${t}|${g}`,
}))
vi.mock('./brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))
vi.mock('./bid-brain/live.js', () => ({
  BRAIN_ACTOR: 'automation:bid-brain',
  brainLiveCeiling: () => (process.env.NEXUS_BID_BRAIN_MODE ?? '').trim().toLowerCase() === 'live',
  brainOwnedCampaignIds: vi.fn(async (ids?: readonly string[]) => new Set((ids ?? []).filter((id) => h.brainOwned.has(id)))),
}))
vi.mock('../../db.js', () => ({
  default: {
    amazonAdsSearchTerm: { groupBy: vi.fn() },
    amazonAdsConnection: { findFirst: vi.fn() },
    campaign: { findMany: vi.fn(), findFirst: vi.fn() },
    automationRule: { findUnique: vi.fn() },
    automationRuleExecution: { findMany: vi.fn() },
    adGroup: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    adTarget: { findFirst: vi.fn(), findMany: vi.fn() },
    adProductAd: { count: vi.fn(), findMany: vi.fn() },
    product: { findMany: vi.fn() },
    adsStrategy: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { ACTION_HANDLERS } from '../automation-rule.service.js'
import './automation-action-handlers.js'

type Result = { ok: boolean; error?: string; output?: Record<string, any> }
const db = vi.mocked(prisma, true)
const run = (type: string, action: Record<string, unknown>, context: unknown, meta: Record<string, unknown> = {}) =>
  (ACTION_HANDLERS[type] as (a: unknown, c: unknown, m: unknown) => Promise<Result>)({ type, ...action }, context, { dryRun: false, ruleId: 'rule-ab6', ...meta })

const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }
const LOCKED = { kind: 'locked', productId: 'gale', market: 'IT', why: 'locked by the Owner\'s campaign override' }
const holds = (byCampaign: Record<string, Record<string, unknown>>) =>
  new Map(Object.entries(byCampaign).map(([campaignId, levers]) => [campaignId, { campaignId, name: `GALE ${campaignId}`, market: 'IT', levers }]))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.brainOwned.clear()
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
  db.automationRule.findUnique.mockResolvedValue(null as never) // no drag binding: the sweep is the marketplace
  db.automationRuleExecution.findMany.mockResolvedValue([] as never)
  db.adTarget.findFirst.mockResolvedValue(null as never)
  db.adTarget.findMany.mockResolvedValue([] as never)
  db.adProductAd.count.mockResolvedValue(0 as never)
  db.adProductAd.findMany.mockResolvedValue([] as never)
  db.product.findMany.mockResolvedValue([] as never)
  db.adsStrategy.findMany.mockResolvedValue([] as never)
  db.adsStrategy.findFirst.mockResolvedValue(null as never)
  h.createNegative.mockResolvedValue({ denied: null, alreadyExisted: false, mode: 'live', externalNegativeKeywordId: 'neg-1' })
  h.createKeywordLocal.mockResolvedValue({ id: 't1', externalTargetId: 'ext-k1' })
  h.writeNegativeKeyword.mockResolvedValue({ outcome: 'created', mode: 'live', externalTargetId: 'neg-1', reachedAmazon: true, adTargetId: 'n1', refusal: null, error: null })
  h.suppressCampaignBids.mockResolvedValue(3)
  h.restoreCampaignBids.mockResolvedValue(3)
})
afterEach(() => vi.unstubAllEnvs())

describe('sync_negatives_across_campaigns', () => {
  const CAMPAIGNS = [{ id: 'c-gale', externalCampaignId: 'EXT-gale' }, { id: 'c-misano', externalCampaignId: 'EXT-misano' }]
  const ctx = { marketplace: 'IT', searchTerm: { query: 'cheap jacket' } }
  beforeEach(() => { db.campaign.findMany.mockResolvedValue(CAMPAIGNS as never) })

  it('a campaign whose negatives a product\'s brain owns gets none; the rest as before; counted', async () => {
    h.campaignLeverOwners.mockResolvedValue(holds({ 'c-gale': { negatives: OWNED } }))
    const r = await run('sync_negatives_across_campaigns', {}, ctx)
    expect(h.createNegative).toHaveBeenCalledTimes(1)
    expect(h.createNegative.mock.calls[0][0]).toMatchObject({ externalCampaignId: 'EXT-misano' })
    expect(r).toMatchObject({ ok: true, output: { added: 1, attempted: 1, brainSkips: { counts: { negatives: 1 }, sample: [{ lever: 'negatives', campaignId: 'c-gale' }] } } })
    const dry = await run('sync_negatives_across_campaigns', {}, ctx, { dryRun: true })
    expect(dry.output).toMatchObject({ dryRun: true, wouldNegateIn: 1, brainSkips: { counts: { negatives: 1 } } })
  })

  it('every campaign held: a named skip, not a failure, and nothing asked', async () => {
    h.campaignLeverOwners.mockResolvedValue(holds({ 'c-gale': { negatives: OWNED }, 'c-misano': { negatives: LOCKED } }))
    const r = await run('sync_negatives_across_campaigns', {}, ctx)
    expect(h.createNegative).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: true, output: { skipped: 'brain-lever', brainSkips: { counts: { negatives: 2 } } } })
    expect(r.output!.why).toContain('every campaign it would negate in is held')
  })

  it('nothing enrolled (production today): exactly as before — every campaign, no brainSkips', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    h.campaignLeverOwners.mockResolvedValue(new Map())
    const r = await run('sync_negatives_across_campaigns', {}, ctx)
    expect(h.createNegative).toHaveBeenCalledTimes(2)
    expect(r.output).toEqual({ keyword: 'cheap jacket', marketplace: 'IT', added: 2, denied: 0, attempted: 2, errors: [] })
  })

  it('the ceiling not live: nothing read', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    await run('sync_negatives_across_campaigns', {}, ctx)
    expect(h.campaignLeverOwners).not.toHaveBeenCalled()
    expect(h.createNegative).toHaveBeenCalledTimes(2)
  })
})

describe('harvest_and_negate', () => {
  const neg = (query: string, ext: string) => ({ query, externalAdGroupId: ext, externalCampaignId: `C-${ext}`, costCents: 900 })
  const grad = (query: string, ext: string) => ({ query, externalAdGroupId: ext, externalCampaignId: `C-${ext}`, orders: 3 })
  beforeEach(() => {
    h.previewHarvest.mockResolvedValue({
      negatives: [neg('waste a', 'EXT-gale'), neg('waste b', 'EXT-misano')],
      graduations: [grad('winner a', 'EXT-gale'), grad('winner b', 'EXT-misano')],
      productNegatives: [], productGraduations: [],
      criteria: { strategy: [] }, protectedAsins: [],
    })
    h.planRuleHarvest.mockImplementation(async (a: { negatives: unknown[]; graduations: unknown[] }) => ({
      items: [...a.negatives.map((n: any) => ({ kind: 'negative', step: 'negate', ...n })), ...a.graduations.map((g: any) => ({ kind: 'graduation', step: 'create', ...g }))],
      negatives: a.negatives, graduations: a.graduations, keptHome: [], blockedOwnKeyword: [], alreadyStanding: 0,
    }))
    h.applyHarvest.mockImplementation(async (a: { negatives: unknown[]; graduations: unknown[] }) => ({
      negativesAdded: a.negatives.length, keywordsGraduated: a.graduations.length, isolationNegativesAdded: 0, productsGraduated: 0, productNegativesAdded: 0,
      negativesProtected: 0, protectedTerms: [], outcomes: [], negativeOutcomes: [], errors: [],
    }))
    db.adGroup.findMany.mockResolvedValue([{ id: 'g-gale', externalAdGroupId: 'EXT-gale', campaignId: 'c-gale' }, { id: 'g-misano', externalAdGroupId: 'EXT-misano', campaignId: 'c-misano' }] as never)
  })

  it('the negate half and the harvest half each leave a source campaign whose lever is held', async () => {
    h.campaignLeverOwners.mockResolvedValue(holds({ 'c-gale': { negatives: OWNED, harvest: LOCKED } }))
    const r = await run('harvest_and_negate', {}, {})
    const applied = h.applyHarvest.mock.calls[0][0] as { negatives: Array<{ query: string }>; graduations: Array<{ query: string }> }
    expect(applied.negatives.map((n) => n.query)).toEqual(['waste b'])
    expect(applied.graduations.map((g) => g.query)).toEqual(['winner b'])
    expect(r.output).toMatchObject({ negativesAdded: 1, keywordsGraduated: 1, brainSkips: { counts: { negatives: 1, harvest: 1 } } })
  })

  it('a dry run plans without them, so the card never offers them', async () => {
    h.campaignLeverOwners.mockResolvedValue(holds({ 'c-gale': { negatives: OWNED, harvest: OWNED } }))
    const r = await run('harvest_and_negate', {}, {}, { dryRun: true })
    expect(r.output).toMatchObject({ dryRun: true, wouldNegate: 1, wouldGraduate: 1, brainSkips: { counts: { negatives: 1, harvest: 1 } } })
    expect(h.applyHarvest).not.toHaveBeenCalled()
  })

  it('nothing enrolled: every term as before, no ad group query, no brainSkips', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await run('harvest_and_negate', {}, {})
    const applied = h.applyHarvest.mock.calls[0][0] as { negatives: unknown[]; graduations: unknown[] }
    expect(applied.negatives).toHaveLength(2)
    expect(applied.graduations).toHaveLength(2)
    expect(db.adGroup.findMany).not.toHaveBeenCalled()
    expect(r.output).not.toHaveProperty('brainSkips')
  })
})

describe('promote_to_exact — its destinations and its isolation negative', () => {
  const CTX = { marketplace: 'IT', searchTerm: { query: 'giacca moto uomo', externalAdGroupId: 'EXT-SRC', clicks: 10, spendCents: 500, orders: 3 } }
  const WIRE = { blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['EXACT'] }, { adGroupId: 'dst2', types: ['EXACT'] }] }], filters: { containsAny: [], notContains: [], brandExclude: [], competitorOnly: false }, dedupe: false }
  const ACT = { bid: { mode: 'cpc', value: null }, harvest: WIRE, negateInSource: true }
  beforeEach(() => {
    db.adGroup.findFirst.mockResolvedValue({ id: 'src1', campaignId: 'c-src', campaign: { marketplace: 'IT', portfolioId: null, targetingType: 'AUTO', adProduct: 'SPONSORED_PRODUCTS', type: 'SP' } } as never)
    db.adGroup.findMany.mockResolvedValue([
      { id: 'src1', externalAdGroupId: 'EXT-SRC', campaignId: 'c-src' },
      { id: 'dst1', externalAdGroupId: 'EXT-D1', campaignId: 'c-gale-exact' },
      { id: 'dst2', externalAdGroupId: 'EXT-D2', campaignId: 'c-misano-exact' },
    ] as never)
    db.adGroup.findUnique.mockResolvedValue({ defaultBidCents: 35 } as never)
  })

  it('a destination whose harvest a product\'s brain owns gets no keyword; the other as before', async () => {
    h.campaignLeverOwners.mockResolvedValue(holds({ 'c-gale-exact': { harvest: OWNED } }))
    const r = await run('promote_to_exact', ACT, CTX)
    expect(h.createKeywordLocal).toHaveBeenCalledTimes(1)
    expect(h.createKeywordLocal.mock.calls[0][0]).toMatchObject({ adGroupId: 'dst2' })
    expect(r.output!.outcomes).toContainEqual(expect.objectContaining({ adGroupId: 'dst1', skipped: 'brain-lever' }))
    expect(r.output!.brainSkips).toMatchObject({ counts: { harvest: 1 } })
  })

  it('the source\'s negatives held: no isolation negative, said', async () => {
    h.campaignLeverOwners.mockResolvedValue(holds({ 'c-src': { negatives: LOCKED } }))
    const r = await run('promote_to_exact', ACT, CTX)
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.output!.isolation).toMatchObject({ adGroupId: 'src1', attempted: false, skipped: 'brain-lever' })
    expect(r.output!.brainSkips).toMatchObject({ counts: { negatives: 1 } })
  })

  it('nothing enrolled: both destinations as before, no brainSkips', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await run('promote_to_exact', ACT, CTX)
    expect(h.createKeywordLocal).toHaveBeenCalledTimes(2)
    expect(r.output).not.toHaveProperty('brainSkips')
  })
})

describe('add_negative_* with a mapping — per destination', () => {
  const CTX = { marketplace: 'IT', searchTerm: { query: 'cheap jacket', externalAdGroupId: 'EXT-SRC', externalCampaignId: 'EXT-C' } }
  const WIRE = { blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['EXACT'] }, { adGroupId: 'dst2', types: ['EXACT'] }] }], filters: { containsAny: [], notContains: [], brandExclude: [], competitorOnly: false }, dedupe: false }
  beforeEach(() => {
    db.adGroup.findFirst.mockImplementation((async (args: { where: { id?: string; externalAdGroupId?: string } }) => {
      if (args.where.externalAdGroupId === 'EXT-SRC') return { id: 'src1' }
      const id = args.where.id!
      return { id, externalAdGroupId: `EXT-${id}`, campaignId: id === 'dst1' ? 'c-gale' : 'c-misano', campaign: { externalCampaignId: `EXT-C-${id}` } }
    }) as never)
    db.adGroup.findMany.mockResolvedValue([{ id: 'dst1', externalAdGroupId: 'EXT-dst1', campaignId: 'c-gale' }, { id: 'dst2', externalAdGroupId: 'EXT-dst2', campaignId: 'c-misano' }] as never)
  })

  it('a held destination gets none; the other as before', async () => {
    h.campaignLeverOwners.mockResolvedValue(holds({ 'c-gale': { negatives: OWNED } }))
    const r = await run('add_negative_exact', { negative: WIRE }, CTX)
    expect(h.createNegative).toHaveBeenCalledTimes(1)
    expect(h.createNegative.mock.calls[0][0]).toMatchObject({ externalAdGroupId: 'EXT-dst2' })
    expect(r.output!.outcomes).toContainEqual(expect.objectContaining({ adGroupId: 'dst1', skipped: 'brain-lever' }))
    expect(r.output!.brainSkips).toMatchObject({ counts: { negatives: 1 } })
  })

  it('nothing enrolled: both, as before', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await run('add_negative_exact', { negative: WIRE }, CTX)
    expect(h.createNegative).toHaveBeenCalledTimes(2)
    expect(r.output).not.toHaveProperty('brainSkips')
  })
})

describe('dayparting_apply — a campaign is left whole', () => {
  const WINDOWS = Array.from({ length: 7 }, (_, day) => ({ day, start: '00:00', end: '00:00', adj: 'pause' }))
  const ACT = { windows: WINDOWS, campaignIds: ['c-bb', 'c-gale', 'c-misano'], timezone: 'Europe/Rome' }
  beforeEach(() => {
    db.campaign.findMany.mockResolvedValue([
      { id: 'c-bb', name: 'bid brain', bidsSuppressedAt: null, bidsSuppressedBy: null },
      { id: 'c-gale', name: 'GALE', bidsSuppressedAt: null, bidsSuppressedBy: null },
      { id: 'c-misano', name: 'MISANO', bidsSuppressedAt: null, bidsSuppressedBy: null },
    ] as never)
  })

  it('the bid brain\'s campaign (bids) and one whose ad-group default bids are held: no floor, counted', async () => {
    h.brainOwned.add('c-bb')
    h.campaignLeverOwners.mockResolvedValue(holds({ 'c-gale': { adGroupBids: LOCKED } }))
    const r = await run('dayparting_apply', ACT, { marketplace: 'IT' })
    expect(h.suppressCampaignBids).toHaveBeenCalledTimes(1)
    expect(h.suppressCampaignBids.mock.calls[0][0]).toBe('c-misano')
    expect(r.output).toMatchObject({ changed: 1, brainSkips: { counts: { bids: 1, adGroupBids: 1 } } })
  })

  it('nothing owned or enrolled: every campaign as before', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await run('dayparting_apply', ACT, { marketplace: 'IT' })
    expect(h.suppressCampaignBids).toHaveBeenCalledTimes(3)
    expect(r.output).not.toHaveProperty('brainSkips')
  })
})
