/**
 * P2 (2026-09-30, I4-2) — what the studio can read from its URL alone, started the moment the page mounts.
 *
 * The frame validates the URL against the markets and accounts it reads first, and only then asks for the destination
 * and the sheet. Those two reads start here instead, in parallel with the frame's own; the hooks adopt them only when
 * they resolve exactly the same read (`prefetchStore.ts`). When the frame resolves something else, the destination wins
 * and the sheet reads again. The rules below mirror `StudioStateProvider` (contracts.tsx) and must stay a subset of it:
 * anything that cannot be resolved (no account, no language, another tab) is not guessed, it is simply not prefetched.
 *
 * Audit B03 — the app's own links into the studio name nothing (`/products/<id>/edit/studio`, from the product list,
 * the catalog, the listings, search). The frame then opens on the market and languages this operator last chose, else
 * the business's default market and language, and a channel's primary account. So the provider remembers the
 * business's choices here (`rememberStudioEntry`, per business) and a URL that names less is completed from them and
 * from the same remembered choices before the plan is made (`studioEntrySearch`).
 */
import { languageSelection } from './sheet/languages'
import { channelScopeUrl, compactSheetUrl, destinationUrl, masterSheetUrl } from './sheetUrls'
import { startPrefetch } from './prefetchStore'
import { languagesKey, languagesPatch, readLastLanguages } from './lastLanguages'
import { readLastMarket } from './lastMarket'
import { primaryStudioAccount } from './accountScope'
import { defaultMarket, deriveScopeOptions, scopeLanguages } from './scopes'
import type { MarketplaceLite } from './types'
import { browserWorkspaceId } from '@/lib/workspaces/paths'

export interface StudioPrefetchPlan {
  destination: string | null
  sheet: string | null
}

type Params = Pick<URLSearchParams, 'get'>

export function studioPrefetchPlan(productId: string, search: Params): StudioPrefetchPlan {
  const none = { destination: null, sheet: null }
  const market = search.get('market')
  if (!productId || !market) return none
  const tab = search.get('tab')
  const sheetTab = !tab || tab === 'sheet'
  const locales = languageSelection(search.get('locales'))
  if (locales && !locales.length) return none
  const locale = locales?.[0] ?? search.get('locale')
  const scope = search.get('scope')
  const listing = search.get('listing') ?? undefined

  if (!scope || scope === 'master') {
    // A listing on master is a scope error: nothing loads.
    if (listing) return none
    return { destination: null, sheet: sheetTab && locale ? compactSheetUrl(masterSheetUrl(productId, market, locale, locales)) : null }
  }
  const account = search.get('account') ?? undefined
  return {
    destination: account !== undefined || listing !== undefined ? destinationUrl(productId, scope, market, account, listing) : null,
    // The sheet reads with the account the URL names; without one it waits for the destination to name it.
    sheet: sheetTab && account && locale ? compactSheetUrl(channelScopeUrl({ productId, channel: scope, marketplace: market, accountId: account, locale, locales })) : null,
  }
}

/** What a URL-silent link resolves against: the business's markets, languages and primary accounts (audit B03). */
export interface StudioEntryChoices {
  /** Every market the scope bar offers. */
  markets: string[]
  /** `defaultMarket` — where a session lands with nothing remembered. */
  market: string | null
  primaryLanguage: string | null
  /** `languagesKey(scope, market)` → the languages that scope offers there; only where the channel serves the market. */
  languages: Record<string, string[]>
  /** Channel → its primary account (`primaryStudioAccount`), when it has one. */
  accounts: Record<string, string>
}

/** The choices the provider resolves a URL against, derived by the same functions it uses. */
export function studioEntryChoices(marketplaces: MarketplaceLite[], primaryLanguage: string | null): StudioEntryChoices {
  const options = deriveScopeOptions(marketplaces, primaryLanguage)
  const languages: Record<string, string[]> = { [languagesKey('master', null)]: scopeLanguages('master', null, marketplaces, primaryLanguage) }
  const accounts: Record<string, string> = {}
  for (const channel of options.channels) {
    for (const market of channel.markets) languages[languagesKey(channel.id, market)] = scopeLanguages(channel.id, market, marketplaces, primaryLanguage)
    const primary = primaryStudioAccount(marketplaces.find(m => m.channel === channel.id)?.accounts ?? [])
    if (primary) accounts[channel.id] = primary.id
  }
  return { markets: options.markets.map(m => m.code), market: defaultMarket(options), primaryLanguage, languages, accounts }
}

export interface RememberedChoices {
  market: string | null
  languages: (key: string, supported: readonly string[]) => string[] | null
}

/**
 * The URL completed the way the provider completes it: the remembered market when the business offers it, else the
 * default; the scope's remembered languages, else Shared's primary language or the channel market's first; a channel's
 * primary account unless a listing names one. Without the business's choices, the URL as it is.
 */
export function studioEntrySearch(search: Params, choices: StudioEntryChoices | null, remembered: RememberedChoices): Params {
  if (!choices) return search
  const out = new URLSearchParams()
  for (const key of ['scope', 'market', 'tab', 'locale', 'locales', 'account', 'listing']) {
    const value = search.get(key)
    if (value !== null) out.set(key, value)
  }
  const scope = out.get('scope') || 'master'
  if (!out.get('market')) {
    const market = remembered.market && choices.markets.includes(remembered.market) ? remembered.market : choices.market
    if (!market) return search
    out.set('market', market)
  }
  const key = languagesKey(scope, out.get('market'))
  const supported = choices.languages[key]
  // A channel the market does not serve is a scope error: nothing loads, nothing is completed.
  if (!supported) return scope === 'master' ? out : search
  if (out.get('locale') === null && out.get('locales') === null) {
    const fallback = scope === 'master' ? choices.primaryLanguage : supported[0] ?? null
    const chosen = remembered.languages(key, supported) ?? (fallback ? [fallback] : null)
    if (chosen) for (const [name, value] of Object.entries(languagesPatch(chosen))) if (value !== undefined) out.set(name, value)
  }
  if (scope !== 'master' && out.get('account') === null && !out.get('listing') && choices.accounts[scope]) out.set('account', choices.accounts[scope])
  return out
}

const ENTRY_KEY = 'nexus:studio:entry:v1'

function readEntries(): Record<string, StudioEntryChoices> {
  try {
    const raw = window.localStorage.getItem(ENTRY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, StudioEntryChoices>) : {}
  } catch {
    return {}
  }
}

/** The business's choices, kept per business: one business's markets never complete another's link. */
export function rememberStudioEntry(workspaceId: string | null, choices: StudioEntryChoices): void {
  try {
    const all = readEntries()
    const key = workspaceId ?? ''
    if (JSON.stringify(all[key]) === JSON.stringify(choices)) return
    window.localStorage.setItem(ENTRY_KEY, JSON.stringify({ ...all, [key]: choices }))
  } catch {
    /* not remembering costs a prefetch, nothing else */
  }
}

export function readStudioEntry(workspaceId: string | null): StudioEntryChoices | null {
  const choices = readEntries()[workspaceId ?? '']
  return choices && Array.isArray(choices.markets) && choices.languages && typeof choices.languages === 'object' && choices.accounts && typeof choices.accounts === 'object' ? choices : null
}

/** Start the plan's reads. Safe to call twice for the same page (one request each). */
export function prefetchStudio(productId: string, search: Params): StudioPrefetchPlan {
  const complete = studioEntrySearch(search, readStudioEntry(browserWorkspaceId()), { market: readLastMarket(), languages: readLastLanguages })
  const plan = studioPrefetchPlan(productId, complete)
  if (plan.destination) startPrefetch(plan.destination)
  if (plan.sheet) startPrefetch(plan.sheet)
  return plan
}
