/**
 * ADS AUTONOMY W1-2 — the strategy as an engine reads it: open ONE market once per run, then ask for the market, a
 * category, products, ad groups or campaigns, in batches. Nothing here writes. The readers come one by one (W1-5 bids
 * and the target chain — through ads-strategy/bids.ts —, W1-6 spend, W1-7 search terms and protection — terms.ts, W1-8
 * Claude's door), each adding itself to the field's `readBy` (fields.ts).
 *
 * "No row → today's behaviour": with no usable strategy row in the market (`empty`), every answer is empty and no
 * catalog is read, so an engine that opens a market without a strategy pays one indexed query.
 *
 * The W0 target resolver's slot (ads-target-acos-resolver.ts: explicit → campaign → [strategy] → account → profit →
 * flat): `targetAcosByAdGroup` gives each ad group its strategy ACoS target as a FRACTION, with its source — the
 * value the `strategy` source between `campaign` and `account` reads (W1-5, via ads-strategy/bids.ts).
 */
import { DEFAULT_STOP_BID_CENTS, pctToFraction, type StrategyFieldKey } from './fields.js'
import { loadAdGroups, loadCampaigns, loadCatalog, loadIndex, loadAncestry, loadMarketRows } from './load.js'
import {
  indexStrategy,
  resolveCategory,
  resolveMarket,
  resolveProducts,
  valuesOf,
  type Orphan,
  type ResolvedStrategy,
  type StrategyIndex,
  type StrategySource,
  type StrategyValues,
} from './resolve.js'

export interface EffectiveStrategy {
  /** The typed numbers to act on (null: the strategy says nothing; keep today's behaviour). */
  values: StrategyValues
  /** Every value with the row it came from, for evidence and refusals. */
  resolved: ResolvedStrategy
}

export interface StrategyView {
  market: string
  channel: string
  /** No usable strategy row in this market: engines keep today's behaviour and need read nothing more. */
  empty: boolean
  index: StrategyIndex
  /** Rows whose category or product is gone: never applied. */
  orphans: Orphan[]
  forMarket(): EffectiveStrategy
  forCategory(categoryId: string): Promise<EffectiveStrategy>
  /** Several products as one subject (the safer value per field); `unknownAds`: ads whose product Nexus does not know. */
  forProducts(productIds: readonly string[], unknownAds?: number): Promise<EffectiveStrategy>
  /** W1-6b — each product on its own (not merged): one catalog read for all of them. Products Nexus does not know are left out. */
  forEachProduct(productIds: readonly string[]): Promise<Map<string, EffectiveStrategy>>
  /** Each ad group: its products resolved together (the safer value per field). One catalog read for all of them. */
  forAdGroups(adGroupIds: readonly string[]): Promise<Map<string, EffectiveStrategy>>
  /** Each campaign: every product of every ad group of it, resolved together. */
  forCampaigns(campaignIds: readonly string[]): Promise<Map<string, EffectiveStrategy>>
  /** Each ad group's strategy ACoS target as a FRACTION, with its source; ad groups without one are left out. */
  targetAcosByAdGroup(adGroupIds: readonly string[]): Promise<Map<string, { targetAcos: number; targetAcosPct: number; source: StrategySource }>>
}

const effective = (resolved: ResolvedStrategy): EffectiveStrategy => ({ values: valuesOf(resolved), resolved })

/** One market's strategy, opened once for a run. */
export async function openStrategy(market: string, channel = 'AMAZON'): Promise<StrategyView> {
  const { index, orphans } = await loadIndex(market, channel)
  const empty = index.rows.length === 0
  const atMarket = effective(resolveMarket(index))

  /** Products resolved together, from one catalog read shared by every subject of the call. */
  async function resolveSubjects(subjects: Array<{ key: string; productIds: string[]; unknownAds: number }>): Promise<Map<string, EffectiveStrategy>> {
    const out = new Map<string, EffectiveStrategy>()
    if (empty) {
      for (const s of subjects) out.set(s.key, atMarket)
      return out
    }
    const { catalog } = await loadCatalog(subjects.flatMap((s) => s.productIds))
    for (const s of subjects) {
      const known = s.productIds.map((id) => catalog.products.get(id)).filter((p): p is NonNullable<typeof p> => !!p)
      out.set(s.key, effective(resolveProducts(index, known, catalog, s.unknownAds + (s.productIds.length - known.length))))
    }
    return out
  }

  async function forAdGroups(adGroupIds: readonly string[]): Promise<Map<string, EffectiveStrategy>> {
    if (empty) return new Map(adGroupIds.map((id) => [id, atMarket]))
    const groups = await loadAdGroups(adGroupIds)
    return resolveSubjects([...groups.values()].map((g) => ({ key: g.id, productIds: g.productIds, unknownAds: g.unknownAds })))
  }

  return {
    market,
    channel,
    empty,
    index,
    orphans,
    forMarket: () => atMarket,
    async forCategory(categoryId) {
      if (empty) return atMarket
      const { ancestry } = await loadAncestry([categoryId])
      return effective(resolveCategory(index, categoryId, { ancestry }))
    },
    async forProducts(productIds, unknownAds = 0) {
      return (await resolveSubjects([{ key: 'products', productIds: [...productIds], unknownAds }])).get('products')!
    },
    async forEachProduct(productIds) {
      if (empty) return new Map([...new Set(productIds)].map((id) => [id, atMarket]))
      const { catalog } = await loadCatalog(productIds)
      const out = new Map<string, EffectiveStrategy>()
      for (const id of new Set(productIds)) {
        const product = catalog.products.get(id)
        if (product) out.set(id, effective(resolveProducts(index, [product], catalog)))
      }
      return out
    },
    forAdGroups,
    async forCampaigns(campaignIds) {
      if (empty) return new Map(campaignIds.map((id) => [id, atMarket]))
      const campaigns = await loadCampaigns(campaignIds)
      return resolveSubjects([...campaigns.values()].map((c) => ({
        key: c.id,
        productIds: [...new Set(c.adGroups.flatMap((g) => g.productIds))],
        unknownAds: c.adGroups.reduce((n, g) => n + g.unknownAds, 0),
      })))
    },
    async targetAcosByAdGroup(adGroupIds) {
      const out = new Map<string, { targetAcos: number; targetAcosPct: number; source: StrategySource }>()
      if (empty) return out
      for (const [id, e] of await forAdGroups(adGroupIds)) {
        const field = e.resolved.fields.get('targetAcosPct')
        const fraction = pctToFraction(field?.value)
        if (fraction != null && field?.source) out.set(id, { targetAcos: fraction, targetAcosPct: field.value as number, source: field.source })
      }
      return out
    },
  }
}

// ── Market limits every engine run reads at once (W1-6) ──────────────────────────────────────────

/** A strategy row named the way a run line, a refusal or an action-log reason names it: "ads strategy: Italy (IT) v3". */
export function strategySourceWords(source: StrategySource): string {
  return `ads strategy: ${source.label} v${source.version}`
}

/** One market field of every market that sets it, each read and checked by the resolver (a value it cannot read is left out). */
async function marketValues(key: StrategyFieldKey, columns: Parameters<typeof loadMarketRows>[0], channel: string): Promise<Map<string, { value: number; source: StrategySource }>> {
  const out = new Map<string, { value: number; source: StrategySource }>()
  for (const row of await loadMarketRows(columns, channel)) {
    const field = resolveMarket(indexStrategy(row.market, [row], undefined, channel).index).fields.get(key)
    if (typeof field?.value === 'number' && field.source) out.set(row.market, { value: field.value, source: field.source })
  }
  return out
}

/**
 * W1-6 — each market's "most actions per run" (the market row only), for the engines' guard (ads-engine-guard.ts):
 * one read per run for every market. A market without one is not in the map.
 */
export async function marketActionCaps(channel = 'AMAZON'): Promise<Map<string, { perRun: number; source: StrategySource }>> {
  const values = await marketValues('maxActionsPerRun', ['maxActionsPerRun'], channel)
  return new Map([...values].map(([market, v]) => [market, { perRun: v.value, source: v.source }]))
}

/** W1-6 — the bid a stop lowers one campaign to, and the strategy row it comes from (null: the 2¢ floor, no row). */
export interface StopBid { cents: number; source: StrategySource | null }

/**
 * W1-6 — the stop bid of each campaign in ONE opened market: the strategy's (the lower across the campaign's products),
 * else the 2¢ floor. Read as a BID only: every W1 reader stops with low bids, whatever stop method is set.
 */
export async function stopBidsIn(view: StrategyView | null, campaignIds: readonly string[]): Promise<Map<string, StopBid>> {
  const out = new Map<string, StopBid>()
  const byCampaign = view && !view.empty && campaignIds.length ? await view.forCampaigns(campaignIds) : new Map<string, EffectiveStrategy>()
  for (const id of campaignIds) {
    const e = byCampaign.get(id)
    const source = e?.resolved.fields.get('stop')?.source ?? null
    out.set(id, e?.values.stop && source ? { cents: e.values.stop.bidCents, source } : { cents: DEFAULT_STOP_BID_CENTS, source: null })
  }
  return out
}

/** W1-6 — the stop bid of campaigns in any markets: each market opened once. A campaign without a market: the 2¢ floor. */
export async function stopBidsFor(campaigns: ReadonlyArray<{ id: string; marketplace: string | null }>, channel = 'AMAZON'): Promise<Map<string, StopBid>> {
  const out = new Map<string, StopBid>()
  const byMarket = new Map<string, string[]>()
  for (const c of campaigns) {
    if (!c.marketplace) { out.set(c.id, { cents: DEFAULT_STOP_BID_CENTS, source: null }); continue }
    byMarket.set(c.marketplace, [...(byMarket.get(c.marketplace) ?? []), c.id])
  }
  for (const [market, ids] of byMarket) {
    for (const [id, stop] of await stopBidsIn(await openStrategy(market, channel), ids)) out.set(id, stop)
  }
  return out
}
