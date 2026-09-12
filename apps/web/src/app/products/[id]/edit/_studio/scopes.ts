/**
 * PES.1 — deriving the scope bar's options from the live marketplace table.
 *
 * Pure and side-effect free so it is testable without a browser, and so the frame can never
 * invent a channel, a market or a locale. Every option here exists because a row in
 * `Marketplace` (isActive) says it does.
 */

import { STUDIO_TABS, type StudioScopeId, type StudioTabId } from './types'
import type {
  ChannelOption,
  LocaleOption,
  MarketOption,
  MarketplaceLite,
  StudioScopeOptions,
} from './types'

/**
 * How the API spells a channel vs how an operator reads it.
 *
 * Only casing — no renaming. `EBAY` is written `eBay` because that is the company's own
 * orthography and the console spells it that way everywhere else; anything not listed falls back
 * to Title Case rather than being shown as a database constant.
 */
const CHANNEL_LABELS: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel.charAt(0) + channel.slice(1).toLowerCase()
}

/**
 * `Intl.DisplayNames` turns `IT` into `Italy` and `it` into `Italian` — the browser's own CLDR
 * data, so no country or language list is maintained here.
 *
 * Guarded twice: the constructor is absent in old runtimes, and `of()` throws on anything that is
 * not a well-formed code. `GLOBAL` (the webstore's pseudo-market) is exactly that case, and it
 * must come back as `GLOBAL`, not as an exception that blanks the whole switcher.
 */
function displayName(kind: 'region' | 'language', code: string): string | null {
  const wellFormed = kind === 'region' ? /^[A-Za-z]{2}$/ : /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/
  if (!wellFormed.test(code)) return null
  try {
    const dn = new Intl.DisplayNames(['en'], { type: kind })
    const out = dn.of(kind === 'region' ? code.toUpperCase() : code.toLowerCase())
    // `of()` returns the input unchanged when it has no entry — that is not a name.
    return out && out.toLowerCase() !== code.toLowerCase() ? out : null
  } catch {
    return null
  }
}

export function marketLabel(code: string): string {
  const name = displayName('region', code)
  return name ? `${code} · ${name}` : code
}

export function localeLabel(code: string): string {
  const name = displayName('language', code)
  return name ? `${name} (${code})` : code
}

/** Stable ordering: the channels the console leads with first, then anything else alphabetically. */
const CHANNEL_ORDER = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']

function byChannelOrder(a: string, b: string): number {
  const ia = CHANNEL_ORDER.indexOf(a)
  const ib = CHANNEL_ORDER.indexOf(b)
  if (ia !== -1 && ib !== -1) return ia - ib
  if (ia !== -1) return -1
  if (ib !== -1) return 1
  return a.localeCompare(b)
}

/**
 * `{ AMAZON: [...], EBAY: [...] }` — the shape `GET /api/marketplaces/grouped` returns — flattened
 * to the rows the derivation works on. Tolerant of a missing/!array group so one malformed key
 * cannot empty the bar.
 */
export function flattenGrouped(grouped: unknown): MarketplaceLite[] {
  if (!grouped || typeof grouped !== 'object') return []
  const out: MarketplaceLite[] = []
  for (const [channel, rows] of Object.entries(grouped as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue
      const row = r as Record<string, unknown>
      const code = typeof row.code === 'string' ? row.code : null
      if (!code) continue
      out.push({
        id: typeof row.id === 'string' ? row.id : `${channel}:${code}`,
        channel: typeof row.channel === 'string' ? row.channel : channel,
        code,
        name: typeof row.name === 'string' ? row.name : `${channelLabel(channel)} ${code}`,
        language: typeof row.language === 'string' ? row.language : '',
        languages: Array.isArray(row.languages) ? row.languages.filter((value): value is string => typeof value === 'string') : typeof row.language === 'string' ? [row.language] : [],
      })
    }
  }
  return out
}

export function deriveScopeOptions(marketplaces: MarketplaceLite[]): StudioScopeOptions {
  const channelMarkets = new Map<string, Set<string>>()
  const marketChannels = new Map<string, Set<string>>()
  const languages = new Set<string>()

  for (const m of marketplaces) {
    for (const language of m.languages ?? (m.language ? [m.language] : [])) languages.add(language.toLowerCase())
    if (!marketChannels.has(m.code)) marketChannels.set(m.code, new Set())
    if (m.connected === false) continue
    if (!channelMarkets.has(m.channel)) channelMarkets.set(m.channel, new Set())
    channelMarkets.get(m.channel)!.add(m.code)
    if (!marketChannels.has(m.code)) marketChannels.set(m.code, new Set())
    marketChannels.get(m.code)!.add(m.channel)
    for (const language of m.languages ?? (m.language ? [m.language] : [])) languages.add(language.toLowerCase())
  }

  const channels: ChannelOption[] = [...channelMarkets.keys()]
    .sort(byChannelOrder)
    .map((id) => ({ id, label: channelLabel(id), markets: [...channelMarkets.get(id)!].sort() }))

  const markets: MarketOption[] = [...marketChannels.keys()]
    .sort()
    .map((code) => ({
      code,
      label: marketLabel(code),
      channels: [...marketChannels.get(code)!].sort(byChannelOrder),
    }))

  const locales: LocaleOption[] = [...languages]
    .sort()
    .map((code) => ({ code, label: localeLabel(code) }))

  return { channels, markets, locales }
}

/**
 * The market a session lands on the FIRST time, before it has an operator's own choice to restore.
 *
 * The one served by the most channels; `GLOBAL` (the webstore's seeded pseudo-market) is never a
 * landing choice while a real country market exists — it has three channels and would otherwise win
 * every time.
 *
 * ⚠ Ties are broken ALPHABETICALLY, and the tiebreak is stated HERE on purpose.
 *
 * Several markets share the top channel count (five, at the last measurement), so the tiebreak
 * decides the winner far more often than the count does. It used to be inherited rather than
 * stated: this reduced with a strict `>` and no tiebreak, which keeps the FIRST element, and the
 * first element was alphabetical only because `deriveScopeOptions` happens to `.sort()` the market
 * keys. Correct, but true at a distance — nothing here said so, and a change to that sort, or one
 * caller building `StudioScopeOptions` by hand, would have made this order-dependent in silence.
 *
 * ⚠ To be explicit, because a review lane reached the opposite conclusion: making this self-
 * contained did NOT fix the "unpinned deep link resolves to a different market per load" defect,
 * and nobody should stop looking for that cause. Two facts disprove the link. `deriveScopeOptions`
 * already normalised the order, so the old code was order-invariant too — mutation-tested: the
 * pre-fix implementation passes every order-permutation test in the suite. And the two markets
 * reported (DE and PL) cannot BOTH come from here at all: PL is served by one channel and DE by
 * two, so PL loses the count outright and is unreachable by this function on that data.
 *
 * Better still would be the market with the most LISTINGS — channel count is a proxy for "where
 * this catalogue actually sells", and a weak one. `MarketOption` carries no listing count today;
 * that needs a field from PES.5 first.
 *
 * This is the fallback ONLY: `lastMarket.ts` restores what the operator actually chose, and that
 * is what a returning session lands on.
 */
export function defaultMarket(options: StudioScopeOptions): string | null {
  const real = options.markets.filter((m) => m.code !== 'GLOBAL')
  const pool = real.length ? real : options.markets
  if (!pool.length) return null
  // Copy before sorting: in the fallback branch `pool` IS `options.markets`, and the caller's
  // option list must not be reordered underneath it.
  return [...pool].sort(
    (a, b) => b.channels.length - a.channels.length || a.code.localeCompare(b.code),
  )[0].code
}

/**
 * The content locale a market implies: the language its marketplaces are configured with.
 *
 * Locale is still its OWN control — master content is stored per language and an operator can
 * legitimately edit the French copy while scoped to market IT — but the market's own language is
 * where a session starts, and it is the only defensible default.
 */
export function defaultLocaleFor(market: string, marketplaces: MarketplaceLite[], channel?: string): string | null {
  const selectedChannel = channel ?? deriveScopeOptions(marketplaces).markets.find(option => option.code === market)?.channels[0]
  const row = marketplaces.find(m => m.channel === selectedChannel && m.code === market)
  return row?.languages?.[0] ?? row?.language ?? null
}

/** Is this channel actually sold in this market? A chip outside its markets is disabled, not hidden. */
export function channelServesMarket(
  channel: string,
  market: string,
  options: StudioScopeOptions,
): boolean {
  return options.channels.find((c) => c.id === channel)?.markets.includes(market) ?? false
}

/* ── which tabs a scope offers ───────────────────────────────────────────────────────────── */

/**
 * The tabs available in a given scope.
 *
 * Presentation uses eBay's existing services. The product sidebar and URL reader share this
 * availability so a scope change cannot strand the session on an inapplicable task.
 *
 * 🔴 `variants` is offered on EVERY scope, and deliberately: the Variants page is one page re-projected by
 * the scope bar (variants spec §1.1), so a channel reaches its projection through its scope chip, never
 * through a second navigation item (§1.2).
 */
export function visibleTabs(scope: StudioScopeId): StudioTabId[] {
  // The sidebar and URL reader share availability. Presentation uses eBay’s existing services.
  return STUDIO_TABS.filter(tab => ['shopify-family', 'shopify-metafields'].includes(tab) ? scope === 'SHOPIFY' : !['presentation', 'variation-order'].includes(tab) || scope === 'EBAY')
}

/** Is this tab offered in this scope? */
export function tabAvailable(tab: StudioTabId, scope: StudioScopeId): boolean {
  return visibleTabs(scope).includes(tab)
}

/**
 * Does this history state carry Next's own navigation markers?
 *
 * 🔴 A state with `__NA` (or the legacy `_N`) makes Next's patched `history.pushState` take an
 * early return — `app-router.js`: `if (data?.__NA || data?._N) return originalPushState(...)` —
 * which skips `applyUrlFromHistoryPushReplace`, the only call that updates `usePathname` and
 * `useSearchParams`. The URL then moves and NOTHING re-renders.
 *
 * Next sets `__NA: true` on every entry it writes, so `window.history.state` always carries it
 * after the first navigation. That makes "preserve the existing state" — the intuitive, careful-
 * looking choice — the one that breaks the page, and it breaks it somewhere else: the URL is
 * correct, so the defect presents as a broken consumer.
 *
 * Typed `unknown` because it guards a value that comes from the browser, not from our own code.
 */
export function historyStateIsInternal(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false
  const s = state as Record<string, unknown>
  return Boolean(s.__NA) || Boolean(s._N)
}
