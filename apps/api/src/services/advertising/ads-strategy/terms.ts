/**
 * ADS AUTONOMY W1-7 — the strategy as the search-term engines and the stop engines read it:
 *
 *   thresholds  when a search term is harvested (graduated to its own keyword or product target) and when it is
 *               negated: the `harvest` and `negate` groups, per ad group (its products resolved together: the stricter
 *               group, fields.ts harvestStricter / negateStricter), or the market's own row for an ad group Nexus does
 *               not know. A group comes WHOLE from one row (a policy, not a patch: harvest-policy.service.ts). A caller
 *               with numbers of its own (a rule's, a person's) never asks here: its numbers win whole (the Owner's
 *               control rule).
 *   protect     the products the Owner protects in a market. No engine, rule or schedule negates their ASIN (the one
 *               negation policy asks here: ads-negation-policy.ts; a person's own add is warned and may be sent
 *               anyway, the write gate's 3A rule), and no optimiser stops them (the bid optimiser's
 *               zero-sales cut and the rules that pause, archive or floor a keyword ask here). Safety stops (stock, Buy
 *               Box, spend caps, a halt) and the Owner's own painted plans (dayparting, Hourly Bids) still apply.
 *
 * "No row → today's behaviour": a market whose strategy sets none of these fields answers empty after one indexed read,
 * and no catalog is read for it. Reads only.
 */
import prisma from '../../../db.js'
import { normalizeMarketplaceCode } from '../../../utils/marketplace-code.js'
import { harvestStricter, type HarvestThresholds, type NegateThresholds } from './fields.js'
import { openStrategy, type EffectiveStrategy, type StrategyView } from './effective.js'
import { loadCatalog, strategyMarkets } from './load.js'
import { resolveProducts, type CatalogProduct, type StrategySource } from './resolve.js'

/** A market code as the strategy keeps it ('IT'). Search-term rows and older campaigns may hold Amazon's marketplace id. */
export function strategyMarketOf(market: string | null | undefined): string | null {
  return normalizeMarketplaceCode(market, '') || null
}

/** Does a row of this market set the field? (A market where none does needs no catalog read.) */
const sets = (view: StrategyView, key: 'harvest' | 'negate') => view.index.rows.some((row) => view.index.settings.get(row.id)?.fields.has(key))
/** Does a row protect? A `false` only opts a product out of its parent's or its category's protection. */
const protects = (view: StrategyView) => view.index.rows.some((row) => view.index.settings.get(row.id)?.fields.get('protect') === true)

/** The row a value came from, as the search-term readers name it. */
export const sourceLabel = (s: StrategySource) => `${s.label}, version ${s.version}${s.product ? `, for ${s.product}` : ''}`

// ── Thresholds ────────────────────────────────────────────────────────────────────────────────────

export interface StrategyTerms {
  harvest: { group: HarvestThresholds; source: StrategySource } | null
  negate: { group: NegateThresholds; source: StrategySource } | null
}

function termsOf(e: EffectiveStrategy): StrategyTerms {
  const harvest = e.values.harvest && e.resolved.fields.get('harvest')?.source
  const negate = e.values.negate && e.resolved.fields.get('negate')?.source
  return {
    harvest: harvest ? { group: e.values.harvest!, source: harvest } : null,
    negate: negate ? { group: e.values.negate!, source: negate } : null,
  }
}

/** The markets whose strategy sets a harvest or a negate group, each opened once, and every window those groups use. */
export interface TermsStrategy {
  views: Map<string, StrategyView>
  windows: number[]
}

/** Null when no market sets a group: every search-term reader keeps its own defaults (one indexed read). */
export async function openTermsStrategy(): Promise<TermsStrategy | null> {
  const views = new Map<string, StrategyView>()
  const windows = new Set<number>()
  for (const market of await strategyMarkets()) {
    const view = await openStrategy(market)
    if (view.empty || !(sets(view, 'harvest') || sets(view, 'negate'))) continue
    views.set(market, view)
    for (const row of view.index.rows) {
      const own = view.index.settings.get(row.id)?.fields
      for (const [key, column] of [['harvest', 'harvestWindowDays'], ['negate', 'negateWindowDays']] as const) {
        const days = (own?.get(key) as Record<string, unknown> | undefined)?.[column]
        if (typeof days === 'number') windows.add(days)
      }
    }
  }
  return views.size ? { views, windows: [...windows].sort((a, b) => a - b) } : null
}

/**
 * Each ad group's harvest and negate groups, keyed `market|externalAdGroupId` (search-term rows name Amazon's ad-group
 * id). An ad group Nexus does not know takes its market's own row. Left out: ad groups whose strategy sets neither group
 * (the caller's defaults apply there).
 */
export async function termsForAdGroups(
  strategy: TermsStrategy,
  rows: ReadonlyArray<{ market: string | null; externalAdGroupId: string }>,
): Promise<Map<string, StrategyTerms>> {
  const out = new Map<string, StrategyTerms>()
  const byMarket = new Map<string, Set<string>>()
  for (const row of rows) {
    const market = strategyMarketOf(row.market)
    if (!market || !strategy.views.has(market)) continue
    byMarket.set(market, (byMarket.get(market) ?? new Set()).add(row.externalAdGroupId))
  }
  for (const [market, externals] of byMarket) {
    const view = strategy.views.get(market)!
    const local = await prisma.adGroup.findMany({ where: { externalAdGroupId: { in: [...externals] } }, select: { id: true, externalAdGroupId: true } })
    const localOf = new Map(local.map((g) => [g.externalAdGroupId!, g.id]))
    const resolved = await view.forAdGroups(local.map((g) => g.id))
    const atMarket = termsOf(view.forMarket())
    for (const external of externals) {
      const id = localOf.get(external)
      const terms = id && resolved.has(id) ? termsOf(resolved.get(id)!) : atMarket
      if (terms.harvest || terms.negate) out.set(`${market}|${external}`, terms)
    }
  }
  return out
}

/**
 * The harvest group for ONE subject of one market, for a page that applies one set of criteria: an ad group, a
 * campaign, several campaigns (a portfolio: the stricter group across them), a set of products (a product line,
 * resolved together), or else the market's own row. Null: the strategy sets no harvest group there.
 */
export async function harvestForScope(
  market: string,
  subject: { adGroupId?: string | null; campaignIds?: readonly string[] | null; productIds?: readonly string[] | null },
): Promise<{ group: HarvestThresholds; source: StrategySource } | null> {
  const code = strategyMarketOf(market)
  if (!code) return null
  const view = await openStrategy(code)
  if (view.empty || !sets(view, 'harvest')) return null
  let subjects: EffectiveStrategy[] = []
  if (subject.adGroupId) subjects = [...(await view.forAdGroups([subject.adGroupId])).values()]
  else if (subject.campaignIds) subjects = [...(await view.forCampaigns(subject.campaignIds)).values()]
  else if (subject.productIds?.length) subjects = [await view.forProducts(subject.productIds)]
  if (!subjects.length) subjects = [view.forMarket()]
  let picked: { group: HarvestThresholds; source: StrategySource } | null = null
  for (const s of subjects) {
    const h = termsOf(s).harvest
    if (h && (!picked || harvestStricter(h.group, picked.group))) picked = h
  }
  return picked
}

// ── Protection ────────────────────────────────────────────────────────────────────────────────────

export interface ProtectedProduct {
  asin: string
  /** The product the strategy protects (the one that made it protected, when several share the ASIN). */
  sku: string
  market: string
  source: StrategySource
}

const ASIN = /^B0[A-Z0-9]{8}$/

/** ASIN → the live products it names: a product's own ASIN in the catalog, and the ASIN its ads advertise. */
async function productsByAsin(asins: readonly string[]): Promise<Map<string, string[]>> {
  const forms = [...new Set(asins.flatMap((a) => [a, a.toLowerCase()]))]
  const [own, ads] = await Promise.all([
    prisma.product.findMany({ where: { deletedAt: null, amazonAsin: { in: forms } }, select: { id: true, amazonAsin: true } }),
    prisma.adProductAd.findMany({ where: { asin: { in: forms }, productId: { not: null }, product: { deletedAt: null } }, select: { asin: true, productId: true } }),
  ])
  const out = new Map<string, Set<string>>()
  const add = (asin: string | null, id: string | null) => {
    if (!asin || !id) return
    const key = asin.trim().toUpperCase()
    out.set(key, (out.get(key) ?? new Set()).add(id))
  }
  for (const p of own) add(p.amazonAsin, p.id)
  for (const a of ads) add(a.asin, a.productId)
  return new Map([...out].map(([asin, ids]) => [asin, [...ids].sort()]))
}

/**
 * Which of these ASINs belong to a product the Owner protects in this market. Several products sharing one ASIN (an FBA
 * and an FBM offer) are resolved together: one protected product protects the ASIN. No market (a write Nexus cannot
 * place): every market with a strategy binds — a protection is never skipped because a write could not say where it
 * lands (the protected terms' rule, ads-negation-policy.ts).
 */
export async function protectedAsins(market: string | null, asins: readonly string[]): Promise<Map<string, ProtectedProduct>> {
  const out = new Map<string, ProtectedProduct>()
  const wanted = [...new Set(asins.map((a) => a.trim().toUpperCase()).filter((a) => ASIN.test(a)))]
  if (!wanted.length) return out
  const code = strategyMarketOf(market)
  const markets = code ? [code] : await strategyMarkets()
  let owners: Map<string, string[]> | null = null
  let catalog: Awaited<ReturnType<typeof loadCatalog>>['catalog'] | null = null
  for (const m of markets) {
    const view = await openStrategy(m)
    if (view.empty || !protects(view)) continue
    owners ??= await productsByAsin(wanted)
    if (!owners.size) break
    catalog ??= (await loadCatalog([...new Set([...owners.values()].flat())])).catalog
    for (const asin of wanted) {
      if (out.has(asin)) continue
      const products = (owners.get(asin) ?? []).map((id) => catalog!.products.get(id)).filter((p): p is CatalogProduct => !!p)
      if (!products.length) continue
      const protect = resolveProducts(view.index, products, catalog).fields.get('protect')
      if (protect?.value === true && protect.source) out.set(asin, { asin, sku: protect.source.product ?? products[0].sku, market: m, source: protect.source })
    }
  }
  return out
}

/**
 * Why negating this ASIN here meets a protected product, or null. `reason` is the refusal an engine, a rule or a
 * schedule gets; `warning` is what a person reads when it is his own add (or a Claude request he approved): the
 * protection is his own setting, so he is warned and may send it anyway (the write gate decides which).
 */
export async function protectedAsinRefusal(asin: string, market: string | null): Promise<{ reason: string; warning: string; sku: string } | null> {
  const hit = (await protectedAsins(market, [asin])).get(asin.trim().toUpperCase())
  return hit
    ? {
      reason: `"${asin.trim()}" cannot be negated: it is the ASIN of ${hit.sku}, a product the ads strategy protects in ${hit.market} (${sourceLabel(hit.source)}).`,
      warning: `"${asin.trim()}" is the ASIN of ${hit.sku}, which your ads strategy protects in ${hit.market} (${sourceLabel(hit.source)}); a negative stops your ads showing on its page`,
      sku: hit.sku,
    }
    : null
}

/**
 * The ad groups that advertise a product the Owner protects (one protected product protects its ad group: the safer
 * rule), each with the row that protects it. An ad group without a market (its campaign names none) is judged against
 * every market with a strategy.
 */
export async function protectedAdGroups(adGroups: ReadonlyArray<{ id: string; market: string | null }>): Promise<Map<string, StrategySource>> {
  const out = new Map<string, StrategySource>()
  if (!adGroups.length) return out
  const byMarket = new Map<string, Set<string>>()
  let everyMarket: string[] | null = null
  for (const g of adGroups) {
    const code = strategyMarketOf(g.market)
    for (const m of code ? [code] : (everyMarket ??= await strategyMarkets())) byMarket.set(m, (byMarket.get(m) ?? new Set()).add(g.id))
  }
  for (const [market, ids] of byMarket) {
    const view = await openStrategy(market)
    if (view.empty || !protects(view)) continue
    for (const [id, e] of await view.forAdGroups([...ids])) {
      const protect = e.resolved.fields.get('protect')
      if (protect?.value === true && protect.source && !out.has(id)) out.set(id, protect.source)
    }
  }
  return out
}

/** Why an optimiser leaves a protected product's keyword or target alone, as one sentence. */
export const protectedStopWhy = (source: StrategySource) =>
  `The ads strategy protects a product this ad group advertises (${sourceLabel(source)}): no optimiser stops it. `
  + 'Safety stops (stock, spend caps, a halt) and your own schedules still apply.'
