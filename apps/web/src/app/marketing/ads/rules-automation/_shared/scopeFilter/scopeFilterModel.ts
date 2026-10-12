/**
 * The filter bar of the Bid, Keyword Harvest and Negative Targeting pages (2026-10-12): Portfolio · Campaign · Ad group ·
 * Product, more than one pick in each list — its rules, pure and tested in Node (`scopeFilterModel.vitest.test.ts`). The
 * hook (`useScopeFilter.ts`) reads the address and the lists; the bar (`AdsScopeFilter.tsx`) draws what this file says.
 *
 *   address   `?portfolio=<id,id>&campaign=…&adGroup=…&product=…` — comma lists, each optional; replaced, never pushed.
 *             portfolio = the Amazon portfolio id (`externalPortfolioId`); campaign / ad group / product = Nexus ids (a
 *             product line's parent id, or one product). The Negative Targeting page's old `?scope=pf:|cp:|ag:<id>` is read
 *             once and written again in these params.
 *   meaning   OR inside one list, AND across the lists — the server's rule (`portfolioIds`, `campaignIds`, `adGroupIds`,
 *             `productIds`), so a view the server reads and a view filtered here agree.
 *   lists     from `GET /api/advertising/scope-options`, only what is in the header's market ('all' = every market); each
 *             list narrows to the picks above it (portfolio → campaign → ad group); a product narrows the campaigns and ad
 *             groups to those that advertise it, and the products to those the picks above advertise. A pick that no
 *             longer fits (its parent un-picked, another market) is dropped.
 *   client    the Rules views and Harvest Sources filter here (`ruleInReach`, `placeInReach`): a rule shows when it can act
 *             on anything picked — through the hierarchy portfolio ⊃ campaign ⊃ ad group — or when it covers the whole
 *             market; the brain's row always shows.
 */
import type { FilterBarOption } from '@/design-system/patterns'

// ── the address ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const SCOPE_KEYS = ['portfolio', 'campaign', 'adGroup', 'product'] as const
export type ScopeKey = (typeof SCOPE_KEYS)[number]
export type ScopePicks = Readonly<Record<ScopeKey, readonly string[]>>
export const NO_PICKS: ScopePicks = { portfolio: [], campaign: [], adGroup: [], product: [] }

/** The words on screen. */
export const SCOPE_LABEL: Readonly<Record<ScopeKey, string>> = { portfolio: 'Portfolio', campaign: 'Campaign', adGroup: 'Ad group', product: 'Product' }
/** The server's list params (§API). */
export const API_PARAM = { portfolio: 'portfolioIds', campaign: 'campaignIds', adGroup: 'adGroupIds', product: 'productIds' } as const
export type ScopeApi = Readonly<Partial<Record<(typeof API_PARAM)[ScopeKey], string>>>

/** The server reads at most this many ids per list. */
export const MAX_PICKS = 500
/** The Negative Targeting page's old single scope: `pf:<portfolio>`, `cp:<campaign>`, `ag:<ad group>`. */
export const LEGACY_PARAM = 'scope'
const LEGACY_KEY: Readonly<Record<string, ScopeKey>> = { pf: 'portfolio', cp: 'campaign', ag: 'adGroup' }

/** A comma list → ids: trimmed, empty parts dropped, each once, at most `MAX_PICKS`. */
export function idList(raw: string | null | undefined): string[] {
  const out: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const id = part.trim()
    if (id && !out.includes(id)) out.push(id)
    if (out.length >= MAX_PICKS) break
  }
  return out
}

/** The old `?scope=pf:<id>` as one pick, or null. */
export function legacyPick(raw: string | null | undefined): { key: ScopeKey; id: string } | null {
  const m = /^(pf|cp|ag):(.{1,64})$/.exec((raw ?? '').trim())
  return m ? { key: LEGACY_KEY[m[1]], id: m[2] } : null
}

/** The picks the address holds (the old `?scope=` merged into its list). */
export function readPicks(params: URLSearchParams): ScopePicks {
  const picks = Object.fromEntries(SCOPE_KEYS.map((k) => [k, idList(params.get(k))])) as Record<ScopeKey, string[]>
  const old = legacyPick(params.get(LEGACY_PARAM))
  if (old && !picks[old.key].includes(old.id)) picks[old.key] = [...picks[old.key], old.id].slice(0, MAX_PICKS)
  return picks
}

export const picksActive = (p: ScopePicks): boolean => SCOPE_KEYS.some((k) => p[k].length > 0)
/** How many lists have a pick (the bar's Clear and its summary). */
export const picksCount = (p: ScopePicks): number => SCOPE_KEYS.filter((k) => p[k].length > 0).length
/** One string per set of picks (an effect's dependency, a read's key). */
export const picksKey = (p: ScopePicks): string => SCOPE_KEYS.map((k) => `${k}=${p[k].join(',')}`).join('&')
export const samePicks = (a: ScopePicks, b: ScopePicks): boolean => picksKey(a) === picksKey(b)

/**
 * The query string with these picks (no '?'): the four params set or removed, the old `?scope=` gone, the `clear` params
 * removed (a page's own, e.g. its pager), everything else kept.
 */
export function withPicks(search: string | URLSearchParams, picks: ScopePicks, clear: readonly string[] = [], extra: Readonly<Record<string, string | null>> = {}): string {
  const next = new URLSearchParams(search)
  next.delete(LEGACY_PARAM)
  for (const k of clear) next.delete(k)
  for (const k of SCOPE_KEYS) {
    if (picks[k].length) next.set(k, picks[k].join(','))
    else next.delete(k)
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v == null || v === '') next.delete(k)
    else next.set(k, v)
  }
  return next.toString()
}

/** The server's params for these picks: only the lists that have a pick. */
export function apiParams(p: ScopePicks): ScopeApi {
  const out: Partial<Record<(typeof API_PARAM)[ScopeKey], string>> = {}
  for (const k of SCOPE_KEYS) if (p[k].length) out[API_PARAM[k]] = p[k].join(',')
  return out
}

/** Put the server's list params on a query. */
export function addApiParams(qs: URLSearchParams, lists: ScopeApi | null | undefined): URLSearchParams {
  for (const [k, v] of Object.entries(lists ?? {})) if (v) qs.set(k, v)
  return qs
}

/**
 * The part of the address the Bid, Keyword Harvest and Negative Targeting tabs carry between them ("portfolio=…&…"), or
 * '' — only the four lists, never the page's own params.
 */
export function carryQuery(params: URLSearchParams | null | undefined): string {
  if (!params) return ''
  const picks = readPicks(params)
  const out = new URLSearchParams()
  for (const k of SCOPE_KEYS) if (picks[k].length) out.set(k, picks[k].join(','))
  return out.toString()
}

/** The Rules & Automation tabs that share this filter bar (their keys). */
export const SCOPE_FILTER_TABS: ReadonlySet<string> = new Set(['bid', 'keyword-harvest', 'negative-targeting'])

/**
 * The tab links with the filter carried: on one of the three pages, the links to the three pages keep its picks; every
 * other link, and every link from another page, is as it was.
 */
export function carryTabs<T extends { id: string; href?: string }>(items: readonly T[], current: string, carry: string): T[] {
  if (!carry || !SCOPE_FILTER_TABS.has(current)) return [...items]
  return items.map((t) => (SCOPE_FILTER_TABS.has(t.id) && t.href ? { ...t, href: `${t.href}${t.href.includes('?') ? '&' : '?'}${carry}` } : t))
}

// ── the lists (GET /api/advertising/scope-options) ──────────────────────────────────────────────────────────────────

export interface ScopeOptionsAnswer {
  campaigns: ReadonlyArray<{ id: string; name: string; marketplace: string | null; portfolioId: string | null; status?: string | null }>
  portfolios: ReadonlyArray<{ externalPortfolioId: string; name: string }>
  productLines: ReadonlyArray<{
    id: string; sku: string; name: string; variations?: number; campaigns: readonly string[]
    children?: ReadonlyArray<{ id: string; sku: string; name: string; campaigns: readonly string[] }>
  }>
  /** §API: every ad group that is not archived. Absent on an older answer: the Ad group list then has nothing to offer. */
  adGroups?: ReadonlyArray<{ id: string; name: string; campaignId: string; status?: string | null }>
}

interface IndexedCampaign { id: string; name: string; portfolioId: string | null; live: boolean }
interface IndexedAdGroup { id: string; name: string; campaignId: string; live: boolean }
interface IndexedProduct {
  id: string
  name: string
  sku: string
  /** A product line (a parent): offered in the list. A variation is only kept when a link names it. */
  line: boolean
  /** Its family: the line and its variations, or the one variation. */
  family: readonly string[]
  /** The campaigns that advertise it, in this market. */
  campaigns: ReadonlySet<string>
}

/** The lists of one market, indexed. */
export interface ScopeIndex {
  campaigns: ReadonlyMap<string, IndexedCampaign>
  portfolios: ReadonlyMap<string, { id: string; name: string }>
  /** Null when the answer lists no ad groups (an older server). */
  adGroups: ReadonlyMap<string, IndexedAdGroup> | null
  products: ReadonlyMap<string, IndexedProduct>
}

const ARCHIVED = 'ARCHIVED'
const isLive = (status: string | null | undefined) => String(status ?? '').toUpperCase() !== ARCHIVED
const marketOf = (m: string | null | undefined) => {
  const v = (m ?? '').trim().toUpperCase()
  return !v || v === 'ALL' ? null : v
}
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)

/** The lists of the header's market ('all' or empty = every market). Campaigns of every state, so a link and a rule's
 *  archived campaign still resolve; the pickers offer the live ones. */
export function buildIndex(options: ScopeOptionsAnswer, market: string | null | undefined): ScopeIndex {
  const m = marketOf(market)
  const campaigns = new Map<string, IndexedCampaign>()
  for (const c of options.campaigns) {
    if (m && (c.marketplace ?? '').toUpperCase() !== m) continue
    campaigns.set(c.id, { id: c.id, name: c.name, portfolioId: c.portfolioId ?? null, live: isLive(c.status) })
  }
  const withCampaign = new Set([...campaigns.values()].map((c) => c.portfolioId).filter((p): p is string => !!p))
  const portfolios = new Map<string, { id: string; name: string }>()
  for (const p of options.portfolios) if (withCampaign.has(p.externalPortfolioId)) portfolios.set(p.externalPortfolioId, { id: p.externalPortfolioId, name: p.name })
  let adGroups: Map<string, IndexedAdGroup> | null = null
  if (Array.isArray(options.adGroups)) {
    adGroups = new Map()
    for (const g of options.adGroups) if (campaigns.has(g.campaignId)) adGroups.set(g.id, { id: g.id, name: g.name, campaignId: g.campaignId, live: isLive(g.status) })
  }
  const products = new Map<string, IndexedProduct>()
  const inMarket = (ids: readonly string[]) => new Set(ids.filter((id) => campaigns.has(id)))
  for (const l of options.productLines) {
    const kids = l.children ?? []
    const lineCampaigns = inMarket([...l.campaigns, ...kids.flatMap((k) => k.campaigns)])
    if (!lineCampaigns.size) continue
    products.set(l.id, { id: l.id, name: l.name, sku: l.sku, line: true, family: [l.id, ...kids.map((k) => k.id)], campaigns: lineCampaigns })
    for (const k of kids) {
      if (products.has(k.id)) continue
      const own = inMarket(k.campaigns)
      if (own.size) products.set(k.id, { id: k.id, name: k.name, sku: k.sku, line: false, family: [k.id], campaigns: own })
    }
  }
  return { campaigns, portfolios, adGroups, products }
}

/**
 * The market's campaigns that pass the picks of `keys` (each list with a pick narrows; an empty list does not). Ad group
 * picks narrow only when the lists name ad groups.
 */
export function campaignsOf(picks: ScopePicks, index: ScopeIndex, keys: readonly ScopeKey[] = SCOPE_KEYS): Set<string> {
  let ids = [...index.campaigns.keys()]
  for (const k of keys) {
    const want = picks[k]
    if (!want.length) continue
    if (k === 'portfolio') { const s = new Set(want); ids = ids.filter((id) => s.has(index.campaigns.get(id)?.portfolioId ?? '')) }
    if (k === 'campaign') { const s = new Set(want); ids = ids.filter((id) => s.has(id)) }
    if (k === 'adGroup' && index.adGroups) {
      const s = new Set(want.map((g) => index.adGroups?.get(g)?.campaignId).filter((c): c is string => !!c))
      ids = ids.filter((id) => s.has(id))
    }
    if (k === 'product') {
      const s = new Set(want.flatMap((p) => [...(index.products.get(p)?.campaigns ?? [])]))
      ids = ids.filter((id) => s.has(id))
    }
  }
  return new Set(ids)
}

/**
 * The picks that still fit, in the funnel's order: a portfolio with a campaign in this market · a campaign of this
 * market inside the picked portfolios · an ad group of a campaign the picks above allow · a product that a campaign the
 * picks above allow advertises. Nothing else is invented or reordered.
 */
export function normalizePicks(picks: ScopePicks, index: ScopeIndex): ScopePicks {
  const portfolio = picks.portfolio.filter((id) => index.portfolios.has(id))
  const after1 = { ...picks, portfolio }
  const campaign = picks.campaign.filter((id) => index.campaigns.has(id) && campaignsOf(after1, index, ['portfolio']).has(id))
  const after2 = { ...after1, campaign }
  const allowed = campaignsOf(after2, index, ['portfolio', 'campaign'])
  // An older answer names no ad groups: the server checks them (a link keeps them).
  const adGroup = index.adGroups ? picks.adGroup.filter((id) => allowed.has(index.adGroups?.get(id)?.campaignId ?? '')) : [...picks.adGroup]
  const after3 = { ...after2, adGroup }
  const above = campaignsOf(after3, index, ['portfolio', 'campaign', 'adGroup'])
  const product = picks.product.filter((id) => [...(index.products.get(id)?.campaigns ?? [])].some((c) => above.has(c)))
  return { portfolio, campaign, adGroup, product }
}

// ── the bar's lists ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ScopeListsState = 'reading' | 'ready' | 'failed'

/** One list of the bar, before the page adds its `onChange`. */
export interface ScopeDimension {
  key: ScopeKey
  label: string
  options: FilterBarOption[]
  value: string[]
  placeholder: string
  /** Why nothing can be picked here now (the list is read, failed, or has nothing in this market); null = it can. */
  heldReason: string | null
}

const EMPTY_WHY: Readonly<Record<ScopeKey, string>> = {
  portfolio: 'No portfolio in this market',
  campaign: 'No campaign fits the picks above',
  adGroup: 'No ad group fits the picks above',
  product: 'No advertised product fits the picks above',
}

/** A product's name for the list: its name, else its SKU. */
const productName = (p: { name: string; sku: string }) => (p.name.trim() || p.sku)

/**
 * The four lists of the bar: each narrowed by the picks above it, with a small count (campaigns in a portfolio, ad groups
 * in a campaign, campaigns that advertise a product), the picks always among the options (a pick never hides from its own
 * list), sorted by name. Every option has a `searchText`, so the search finds a name and, for an ad group, its campaign.
 */
export function scopeDimensions(picks: ScopePicks, index: ScopeIndex | null, state: ScopeListsState, error?: string | null): ScopeDimension[] {
  const base = (key: ScopeKey, options: FilterBarOption[], heldReason: string | null): ScopeDimension => ({
    key, label: SCOPE_LABEL[key], options, value: [...picks[key]], placeholder: 'All', heldReason,
  })
  if (!index) {
    const why = state === 'failed' ? `Not read${error ? `: ${error}` : ''}` : 'Reading the list'
    // The picks a link carries stay on screen (by id until the lists come).
    return SCOPE_KEYS.map((k) => base(k, picks[k].map((id) => ({ value: id, label: id })), why))
  }
  const keep = (key: ScopeKey, offered: FilterBarOption[], named: (id: string) => FilterBarOption | null) => {
    const have = new Set(offered.map((o) => o.value))
    const extra = picks[key].filter((id) => !have.has(id)).map((id) => named(id) ?? { value: id, label: id })
    return [...extra, ...offered]
  }

  // Portfolio: those with a live campaign in this market; the count is its live campaigns.
  const liveCampaigns = [...index.campaigns.values()].filter((c) => c.live)
  const pfCount = new Map<string, number>()
  for (const c of liveCampaigns) if (c.portfolioId) pfCount.set(c.portfolioId, (pfCount.get(c.portfolioId) ?? 0) + 1)
  const pfOptions = [...index.portfolios.values()].filter((p) => pfCount.has(p.id)).sort(byName)
    .map((p) => ({ value: p.id, label: p.name, count: pfCount.get(p.id), searchText: p.name }))
  const portfolio = keep('portfolio', pfOptions, (id) => { const p = index.portfolios.get(id); return p ? { value: id, label: p.name, searchText: p.name } : null })

  // Campaign: the live ones inside the picked portfolios, advertising the picked products; the count is its ad groups.
  const campAllowed = campaignsOf(picks, index, ['portfolio', 'product'])
  const agCount = new Map<string, number>()
  for (const g of index.adGroups?.values() ?? []) if (g.live) agCount.set(g.campaignId, (agCount.get(g.campaignId) ?? 0) + 1)
  const campOptions = liveCampaigns.filter((c) => campAllowed.has(c.id)).sort(byName)
    .map((c) => ({ value: c.id, label: c.name, ...(index.adGroups ? { count: agCount.get(c.id) ?? 0 } : {}), searchText: c.name }))
  const campaign = keep('campaign', campOptions, (id) => { const c = index.campaigns.get(id); return c ? { value: id, label: c.name, searchText: c.name } : null })

  // Ad group: the live ones of the campaigns the picks above (and the products) allow; named with its campaign.
  const agAllowed = campaignsOf(picks, index, ['portfolio', 'campaign', 'product'])
  const agLabel = (g: IndexedAdGroup) => `${g.name} · ${index.campaigns.get(g.campaignId)?.name ?? ''}`
  const agOptions = [...(index.adGroups?.values() ?? [])].filter((g) => g.live && agAllowed.has(g.campaignId))
    .sort((a, b) => (index.campaigns.get(a.campaignId)?.name ?? '').localeCompare(index.campaigns.get(b.campaignId)?.name ?? '') || a.name.localeCompare(b.name))
    .map((g) => ({ value: g.id, label: agLabel(g), searchText: agLabel(g) }))
  const adGroup = keep('adGroup', agOptions, (id) => { const g = index.adGroups?.get(id); return g ? { value: id, label: agLabel(g), searchText: agLabel(g) } : null })

  // Product: the lines a campaign the picks above allow advertises; the count is those campaigns.
  const prAllowed = campaignsOf(picks, index, ['portfolio', 'campaign', 'adGroup'])
  const prOptions = [...index.products.values()].filter((p) => p.line)
    .map((p) => ({ p, n: [...p.campaigns].filter((c) => prAllowed.has(c)).length }))
    .filter(({ n }) => n > 0)
    .sort((a, b) => productName(a.p).localeCompare(productName(b.p)))
    .map(({ p, n }) => ({ value: p.id, label: productName(p), count: n, searchText: `${productName(p)} ${p.sku}` }))
  const product = keep('product', prOptions, (id) => { const p = index.products.get(id); return p ? { value: id, label: productName(p), searchText: `${productName(p)} ${p.sku}` } : null })

  const held = (key: ScopeKey, options: FilterBarOption[]) => (options.length ? null : EMPTY_WHY[key])
  return [
    base('portfolio', portfolio, held('portfolio', portfolio)),
    base('campaign', campaign, held('campaign', campaign)),
    base('adGroup', adGroup, held('adGroup', adGroup)),
    base('product', product, held('product', product)),
  ]
}

// ── what the picks reach (the views filtered here) ─────────────────────────────────────────────────────────────────

export interface ScopeReach {
  /** The market's campaigns every pick allows (AND across the lists). */
  campaigns: ReadonlySet<string>
  /** The picked ad groups inside those campaigns; null = every ad group of them. */
  adGroups: ReadonlySet<string> | null
  /** The picked products with their families; null = no product picked. */
  products: ReadonlySet<string> | null
  /** An ad group's campaign, from the lists (empty on an older answer). */
  campaignOfAdGroup: ReadonlyMap<string, string>
  /** A campaign's portfolio. */
  portfolioOfCampaign: ReadonlyMap<string, string | null>
}

/** What the picks reach in this market; null when nothing is picked (every row stays). */
export function reachOf(picks: ScopePicks, index: ScopeIndex): ScopeReach | null {
  if (!picksActive(picks)) return null
  const campaigns = campaignsOf(picks, index)
  const campaignOfAdGroup = new Map([...(index.adGroups?.values() ?? [])].map((g) => [g.id, g.campaignId]))
  const adGroups = picks.adGroup.length
    ? new Set(picks.adGroup.filter((g) => !index.adGroups || campaigns.has(campaignOfAdGroup.get(g) ?? '')))
    : null
  const products = picks.product.length ? new Set(picks.product.flatMap((p) => index.products.get(p)?.family ?? [p])) : null
  const portfolioOfCampaign = new Map([...index.campaigns.values()].map((c) => [c.id, c.portfolioId]))
  return { campaigns, adGroups, products, campaignOfAdGroup, portfolioOfCampaign }
}

interface IdRef { id: string }
/** What a rule row says it works on (the Bid, Harvest and Negative Targeting rules answers share this shape). */
export interface ScopedRule {
  scope: {
    all: boolean
    product?: IdRef | null
    portfolios: readonly IdRef[]
    campaigns: readonly IdRef[]
    adGroups: readonly IdRef[]
    /** The Negative Targeting rule's one ad group. */
    adGroup?: IdRef | null
    /** The true totals (the lists stop at 100). */
    counts?: { portfolios?: number; campaigns?: number; adGroups?: number }
  }
}

const complete = (list: readonly IdRef[], counted: number | undefined) => typeof counted !== 'number' || !Number.isFinite(counted) || counted <= list.length

/**
 * Can this rule act on anything picked? A rule over the whole market can; a rule bound to ad groups when one of them is
 * picked (or, with no ad group picked, sits in a reached campaign); any other rule when one of its campaigns is reached.
 * A list the answer cut at 100 is judged by the portfolios it spans, so a rule is never hidden for a name it did not send.
 * `reach` null (nothing picked) keeps every rule. The caller keeps its own always-shown rows (the brain) before asking.
 */
export function ruleInReach(rule: ScopedRule, reach: ScopeReach | null): boolean {
  if (!reach) return true
  const s = rule.scope
  if (s.all && !s.product) return true
  const groups = [...s.adGroups, ...(s.adGroup && !s.adGroups.some((g) => g.id === s.adGroup?.id) ? [s.adGroup] : [])]
  if (groups.length && complete(s.adGroups, s.counts?.adGroups)) {
    const known = groups.filter((g) => reach.campaignOfAdGroup.has(g.id))
    if (reach.adGroups) return groups.some((g) => reach.adGroups?.has(g.id))
    // No ad group picked: one of its ad groups sits in a reached campaign (an ad group the lists do not know: its campaigns).
    if (known.length === groups.length) return known.some((g) => reach.campaigns.has(reach.campaignOfAdGroup.get(g.id) ?? ''))
  }
  if (s.campaigns.some((c) => reach.campaigns.has(c.id))) return true
  if (complete(s.campaigns, s.counts?.campaigns)) return false
  // Its campaigns were cut at 100: a reached campaign in one of its portfolios may be among the rest.
  if (!complete(s.portfolios, s.counts?.portfolios)) return true
  const pfs = new Set(s.portfolios.map((p) => p.id))
  return [...reach.campaigns].some((c) => pfs.has(reach.portfolioOfCampaign.get(c) ?? ''))
}

/** A row that sits in one place (a Harvest source: an ad group, its campaign, its product): is it among the picks? */
export function placeInReach(place: { campaign: IdRef; adGroup?: IdRef | null; product?: IdRef | null }, reach: ScopeReach | null): boolean {
  if (!reach) return true
  if (!reach.campaigns.has(place.campaign.id)) return false
  if (reach.adGroups && place.adGroup && !reach.adGroups.has(place.adGroup.id)) return false
  if (reach.products && place.product && !reach.products.has(place.product.id)) return false
  return true
}

/**
 * A rules answer narrowed to what the filter reaches: the rows `always` names (the brain, read-only rows) stay, every
 * other rule shows when it can act on a pick; `rules`, `on`, `waiting` and `archived` are counted again over what shows
 * (the toolbar's "N rules", the Archived button, the tiles). Every other number is the answer's own. `reach` null: the
 * answer as read.
 */
/** A rules answer's row, as `narrowRules` reads it. */
export type NarrowedRule = ScopedRule & { archived: boolean; waiting: number; mode: { set: string } }

export function narrowRules<A extends { rules: readonly NarrowedRule[]; totals: { rules: number; on: number; waiting: number; archived: number } }>(
  answer: A, reach: ScopeReach | null, always: (row: A['rules'][number]) => boolean,
): A {
  if (!reach) return answer
  const rules = answer.rules.filter((r) => always(r) || ruleInReach(r, reach))
  const counted = rules.filter((r) => !always(r))
  const active = counted.filter((r) => !r.archived)
  return {
    ...answer,
    rules,
    totals: {
      ...answer.totals,
      rules: active.length,
      on: active.filter((r) => r.mode.set !== 'OFF').length,
      waiting: active.reduce((n, r) => n + Math.max(0, r.waiting), 0),
      archived: counted.length - active.length,
    },
  } as A
}

// ── an empty table ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The words of a table the filter emptied, and its one action. */
export const FILTER_EMPTY = { title: 'Nothing matches the filter', clear: 'Clear filter' } as const
/** A rule's detail opened while the filter hides the rule: its Try again clears the filter. */
export const FILTER_HIDES_RULE = 'This rule is outside the filter: Try again clears the filter'
