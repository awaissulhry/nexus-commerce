/**
 * ADS AUTONOMY final test — what the end-to-end suites start from (ads-playbook/e2e-autonomy-*.vitest.test.ts), and the
 * flow they share. Values are made up (public repo).
 *
 *   seedBusinessA   the Amazon IT account; product B — the established product, its five live campaigns as Amazon's sync
 *                   wrote them (Auto, Broad | Category, Exact | Category, Exact | Brand, PAT) and their hourly plans; it
 *                   buys "test jacket". Product A — the new product, no campaign yet. `isolation` adds the cross-negatives
 *                   B's set carries, so the template captured from it keeps its isolation switches on.
 *   seedBusinessB   the same Owner's second business: its own Amazon account, a product with the SAME SKU as A's product
 *                   A, one campaign, its own market strategy.
 *   throughStart    steps 1, 2 and 4 through the door, briefly checked (part 1 checks each in full): the market strategy,
 *                   the template captured from B, the market row, A enrolled, A's build approved and run, A's START
 *                   approved with the code, its queued bid writes drained to Amazon.
 */
import { expect, vi } from 'vitest'
import { amazon } from './ads-autonomy-e2e-amazon.js'
import { A, type Door } from './ads-autonomy-e2e.js'

type Json = Record<string, any>
type Db = Record<string, any>
type Ad = { productId: string; asin: string; sku: string }

/** A campaign as Amazon's sync wrote it: one ad group advertising these children, its targets and placements. */
export async function liveCampaign(db: Db, name: string, opts: { targeting?: 'AUTO' | 'MANUAL'; budget: string; ads: Ad[]; targets: Array<{ kind?: string; match: string; text: string; bidCents: number; negative?: boolean }>; placements?: Array<{ placement: string; percentage: number }> }) {
  const c = await db.campaign.create({ data: {
    name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', targetingType: opts.targeting ?? 'MANUAL', dailyBudget: opts.budget, startDate: new Date('2026-01-01T00:00:00Z'),
    externalCampaignId: `EXT-${name}`, liveBidWritesEnabled: true, biddingStrategy: 'LEGACY_FOR_SALES',
    ...(opts.placements ? { dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: opts.placements } } : {}),
  } })
  const g = await db.adGroup.create({ data: { campaignId: c.id, name, externalAdGroupId: `EXT-G-${name}`, defaultBidCents: 35 } })
  for (const ad of opts.ads) await db.adProductAd.create({ data: { adGroupId: g.id, productId: ad.productId, asin: ad.asin, sku: ad.sku, externalAdId: `EXT-AD-${name}-${ad.sku}` } })
  let n = 0
  for (const t of opts.targets) {
    await db.adTarget.create({ data: {
      adGroupId: g.id, kind: t.kind ?? 'KEYWORD', expressionType: t.negative ? `NEGATIVE_${t.match}` : t.match, expressionValue: t.text, bidCents: t.negative ? 0 : t.bidCents,
      isNegative: !!t.negative, negativeLevel: t.negative ? 'AD_GROUP' : null, externalTargetId: `EXT-T-${name}-${++n}`,
    } })
  }
  return { campaignId: c.id, adGroupId: g.id, externalCampaignId: `EXT-${name}`, externalAdGroupId: `EXT-G-${name}` }
}

/** The business's Amazon market row: the one place a market's currency is stated (Marketplace.currency). */
async function marketRow(db: Db, market: string) {
  await db.marketplace.create({ data: { channel: 'AMAZON', code: market, name: `Amazon ${market}`, region: 'EU', currency: 'EUR', language: 'it' } })
}

/** A parent with two FBA children, listed on Amazon IT. */
export async function family(db: Db, token: string, asin: string) {
  const sku = (s: string) => `TEST-${token}-${s}`
  const parent = await db.product.create({ data: { sku: sku('PARENT'), name: `${token} parent`, basePrice: '60.00', isParent: true, amazonAsin: `${asin}P0` } })
  const v1 = await db.product.create({ data: { sku: sku('V1'), name: `${token} v1`, basePrice: '60.00', parentId: parent.id, amazonAsin: `${asin}01`, fulfillmentMethod: 'FBA' } })
  const v2 = await db.product.create({ data: { sku: sku('V2'), name: `${token} v2`, basePrice: '60.00', parentId: parent.id, amazonAsin: `${asin}02`, fulfillmentMethod: 'FBA' } })
  for (const p of [parent, v1, v2]) await db.channelListing.create({ data: { productId: p.id, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', listingStatus: 'ACTIVE' } })
  return { parent: parent.id, v1: v1.id, v2: v2.id, ads: [{ productId: v1.id, asin: `${asin}01`, sku: sku('V1') }, { productId: v2.id, asin: `${asin}02`, sku: sku('V2') }] as Ad[], sku }
}

export async function seedBusinessA(db: Db, opts: { isolation?: boolean } = {}) {
  const ids: Record<string, string> = {}
  await marketRow(db, 'IT')
  await db.amazonAdsConnection.create({ data: { profileId: 'P-IT-E2E-A', marketplace: 'IT', region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true } })
  const b = await family(db, 'TESTE2EB', 'B0TESTEB')
  Object.assign(ids, { bParent: b.parent, bV1: b.v1, bV2: b.v2 })
  const camp = (parts: string, o: Parameters<typeof liveCampaign>[2]) => liveCampaign(db, `TESTE2EB | IT | ${parts}`, o)
  const neg = { match: 'PHRASE', text: 'test kids', bidCents: 0, negative: true }
  // Optionally the isolation B's set already carries: its exact keyword negated in its Auto, its brand phrase in a category slot.
  const isoAuto = opts.isolation ? [{ match: 'EXACT', text: 'test jacket', bidCents: 0, negative: true }] : []
  const isoBroad = opts.isolation ? [{ match: 'PHRASE', text: 'teste2eb jacket', bidCents: 0, negative: true }] : []
  const bAuto = await camp('Auto', { targeting: 'AUTO', budget: '6.00', ads: b.ads, targets: [{ kind: 'AUTO', match: 'QUERY_HIGH_REL_MATCHES', text: '', bidCents: 35 }, { kind: 'AUTO', match: 'QUERY_BROAD_REL_MATCHES', text: '', bidCents: 30 }, neg, ...isoAuto] })
  const bBroad = await camp('Broad | Category', { budget: '8.00', ads: b.ads, targets: [{ match: 'BROAD', text: 'test jacket', bidCents: 32 }, { match: 'BROAD', text: 'test coat', bidCents: 32 }, neg, ...isoBroad] })
  const bExact = await camp('Exact | Category', { budget: '14.00', ads: b.ads, targets: [{ match: 'EXACT', text: 'test jacket', bidCents: 46 }, neg], placements: [{ placement: 'PLACEMENT_TOP', percentage: 25 }] })
  const bBrand = await camp('Exact | Brand', { budget: '4.00', ads: b.ads, targets: [{ match: 'EXACT', text: 'teste2eb jacket', bidCents: 40 }, neg] })
  const bPat = await camp('PAT', { budget: '8.00', ads: b.ads, targets: [{ kind: 'PRODUCT', match: 'ASIN_SAME_AS', text: 'B0TESTRIV1', bidCents: 38 }], placements: [{ placement: 'PLACEMENT_TOP', percentage: 10 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 15 }] })
  Object.assign(ids, { bAuto: bAuto.adGroupId, bBroad: bBroad.adGroupId, bExact: bExact.adGroupId, bBrand: bBrand.adGroupId, bPat: bPat.adGroupId, bExactCampaign: bExact.campaignId, bExactExt: bExact.externalAdGroupId, bExactExtCampaign: bExact.externalCampaignId })
  // B's hourly plans (the capture reads them as rank roles): the performance slots hold the top by day, the research
  // slots sit at the floor by night.
  await db.rankTarget.create({ data: { key: 'test-own-top', name: 'Test own top', placement: 'PLACEMENT_TOP', targetISPct: 30 } })
  await db.rankTarget.create({ data: { key: 'test-rest', name: 'Test rest', placement: 'PLACEMENT_REST_OF_SEARCH' } })
  await db.rankTarget.create({ data: { key: 'test-min-bid', name: 'Test min bid', pause: true } })
  const performance = { windows: [{ days: [1, 2, 3, 4, 5], startHour: 8, endHour: 21, targetKey: 'test-own-top' }], defaultTargetKey: 'test-rest' }
  const research = { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 7, targetKey: 'test-min-bid' }], defaultTargetKey: 'test-rest' }
  for (const [c, plan] of [[bExact, performance], [bBrand, performance], [bPat, performance], [bAuto, research], [bBroad, research]] as const) {
    await db.adSchedule.create({ data: { campaignId: c.campaignId, name: `test plan ${c.campaignId}`, ...plan, enabled: true } })
  }
  // Product A: the new product; no campaign yet.
  const a = await family(db, 'TESTE2EA', 'B0TESTEA')
  Object.assign(ids, { aParent: a.parent, aV1: a.v1, aV2: a.v2 })
  return ids
}

export async function seedBusinessB(db: Db) {
  await marketRow(db, 'IT')
  await db.amazonAdsConnection.create({ data: { profileId: 'P-IT-E2E-B', marketplace: 'IT', region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true } })
  const twin = await db.product.create({ data: { sku: 'TEST-TESTE2EA-PARENT', name: 'Bravo twin parent', basePrice: '50.00', isParent: true, amazonAsin: 'B0TESTBRP0' } })
  const c = await db.campaign.create({ data: { name: 'BRAVO | IT | Exact', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date('2026-01-01T00:00:00Z'), externalCampaignId: 'EXT-BRAVO-1', liveBidWritesEnabled: true } })
  const g = await db.adGroup.create({ data: { campaignId: c.id, name: 'BRAVO group', externalAdGroupId: 'EXT-G-BRAVO-1', defaultBidCents: 30 } })
  await db.adTarget.create({ data: { adGroupId: g.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test jacket', bidCents: 30, externalTargetId: 'EXT-T-BRAVO-1' } })
  await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Bravo strategy (IT)', maxBidCents: 80, targetKind: 'ACOS', targetPct: 20, updatedBy: 'user:test' } })
  return { bizBProduct: twin.id, bizBCampaign: c.id, bizBAdGroup: g.id }
}

/** The product terms A is enrolled with: B's category keyword "test jacket" among them. */
export const A_TERMS = {
  brand: ['teste2ea jacket'], category: [{ text: 'test jacket', exactAtStart: true }, { text: 'test coat' }], competitor: [], competitorAsins: ['B0TESTRIV1'],
  negatives: [{ text: 'test kids', match: 'PHRASE' }],
}

/** The ads sync worker's own drain, as its cron runs it: every queued ad write goes to Amazon through the write gate. */
export async function drainAdWrites(door: Door, biz: string = A) {
  const { drainAdsSyncOnce } = await import('../workers/ads-sync.worker.js')
  const out = await door.inside(() => drainAdsSyncOnce(500), biz as never)
  expect(out.results.filter((r) => r.status !== 'SUCCESS'), JSON.stringify(out.results)).toEqual([])
  return out
}

/** What Amazon now holds for one campaign: its ad group's default bid, each positive's bid, its placements. */
export function atAmazon(externalCampaignId: string) {
  const st = amazon.store
  const group = [...st.adGroups.values()].find((g) => g.campaignId === externalCampaignId)!
  const positives = [...st.keywords.values(), ...st.targets.values()].filter((t) => t.adGroupId === group.adGroupId)
  return { defaultBid: group.defaultBid, bids: positives.map((t) => t.bid), placements: st.campaigns.get(externalCampaignId)!.dynamicBidding.placementBidding }
}

/** Steps 1, 2 and 4 of part 1, through the door, briefly checked; returns what later steps name. */
export async function throughStart(door: Door, db: () => Db, ids: Record<string, string>, opts: { goal?: string; strategy?: Record<string, unknown> } = {}) {
  const ok = async (approvalId: string, code: boolean) => {
    const out = await door.approve(approvalId, { code })
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, status: 'executed' })
    return out as Json
  }
  const strategy = await door.call('set-ads-strategy', {
    channel: 'AMAZON', market: 'IT', level: 'market',
    values: { goal: opts.goal ?? 'PROFIT', target: { kind: 'ACOS', pct: 30 }, maxBidCents: 100, monthlySpendCapCents: 10_000_000, claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 100_000, ...(opts.strategy ?? {}) },
  })
  await ok(strategy.answer.approvalId, true)
  const capture = await door.call('set-ads-playbook', { channel: 'AMAZON', kind: 'template', op: 'capture', name: 'Test funnel', market: 'IT', productToken: 'TESTE2EB', namePrefix: 'TESTE2EB | IT' })
  await ok(capture.answer.approvalId, !!capture.answer.preview?.stepUp)
  const template = await door.inside<Json>(() => db().adsPlaybookTemplate.findFirstOrThrow({ where: { name: 'Test funnel' } }))
  const market = await door.call('set-ads-playbook', { channel: 'AMAZON', kind: 'playbook', market: 'IT', level: 'market', values: { templateId: template.id } })
  await ok(market.answer.approvalId, !!market.answer.preview?.stepUp)
  const enroll = await door.call('set-ads-playbook', { channel: 'AMAZON', kind: 'playbook', market: 'IT', level: 'product', productId: ids.aParent, op: 'enroll', values: { nameToken: 'TESTE2EA', dailyBudgetCents: 2000, baseBidCents: 40, terms: A_TERMS } })
  await ok(enroll.answer.approvalId, true)
  const build = await door.call('apply-ads-playbook', { op: 'build', market: 'IT', productId: ids.aParent })
  expect(build.answer.status, JSON.stringify(build.answer).slice(0, 800)).toBe('waiting_for_approval')
  const built = await ok(build.answer.approvalId, false)
  const applicationId = built.result.applicationId as string
  await vi.waitFor(async () => {
    const row = await door.inside<Json>(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId }, select: { status: true } }))
    if (row.status === 'RUNNING') throw new Error('still running')
  }, { timeout: 30_000, interval: 100 })
  const start = await door.call('apply-ads-playbook', { op: 'start', market: 'IT', productId: ids.aParent })
  await ok(start.answer.approvalId, true)
  await drainAdWrites(door)
  const row = await door.inside<Json>(() => db().adsPlaybook.findFirstOrThrow({ where: { market: 'IT', level: 'PRODUCT', scopeId: ids.aParent } }))
  expect(row.state).toBe('RUNNING')
  const campaigns = await door.inside<Json[]>(() => db().campaign.findMany({ where: { name: { startsWith: 'TESTE2EA | IT |' } }, include: { adGroups: true } }))
  const slots = Object.fromEntries((await door.inside<Json[]>(() => db().adsPlaybookLink.findMany({ where: { playbookId: row.id, kind: 'slot' } }))).map((l: Json) => {
    const c = campaigns.find((x: Json) => x.id === l.refId)
    return [l.key, { campaignId: l.refId, adGroupId: l.adGroupId, externalCampaignId: c.externalCampaignId, externalAdGroupId: c.adGroups[0].externalAdGroupId, name: c.name }]
  })) as Record<string, { campaignId: string; adGroupId: string; externalCampaignId: string; externalAdGroupId: string; name: string }>
  return { rowId: row.id as string, templateId: template.id as string, buildApproval: build.answer.approvalId as string, startApproval: start.answer.approvalId as string, applicationId, slots }
}
