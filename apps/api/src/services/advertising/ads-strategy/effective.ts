/**
 * ADS AUTONOMY W1-2 — the strategy as an engine reads it: open ONE market once per run, then ask for the market, a
 * category, products, ad groups or campaigns, in batches. Nothing here writes, and in W1-2 no engine calls it yet: the
 * readers come one by one (W1-5 bids and the target chain, W1-6 spend, W1-7 search terms, W1-8 Claude's door), each
 * adding itself to the field's `readBy` (fields.ts).
 *
 * "No row → today's behaviour": with no usable strategy row in the market (`empty`), every answer is empty and no
 * catalog is read, so an engine that opens a market without a strategy pays one indexed query.
 *
 * The W0 target resolver's slot (ads-target-acos-resolver.ts: explicit → campaign → [strategy] → account → profit →
 * flat): `targetAcosByAdGroup` gives each ad group its strategy ACoS target as a FRACTION, with its source — the
 * value a `strategy` source between `campaign` and `account` reads (W1-5).
 */
import { pctToFraction } from './fields.js'
import { loadAdGroups, loadCampaigns, loadCatalog, loadIndex, loadAncestry } from './load.js'
import {
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
