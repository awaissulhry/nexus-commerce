/**
 * P2 (2026-09-30, I4-2) — what the studio can read from its URL alone, started the moment the page mounts.
 *
 * The frame validates the URL against the markets and accounts it reads first, and only then asks for the destination
 * and the sheet. Most loads name everything in the URL (`?scope=EBAY&market=IT&account=…&locale=it`), so those two reads
 * start here in parallel with the frame's own; the hooks adopt them only when they resolve exactly the same read
 * (`prefetchStore.ts`). When the frame resolves something else, the destination wins and the sheet reads again.
 * The rules below mirror `StudioStateProvider` (contracts.tsx) and must stay a subset of it: anything the URL does not
 * state (no account, no language, another tab) is not guessed, it is simply not prefetched.
 */
import { languageSelection } from './sheet/languages'
import { channelScopeUrl, compactSheetUrl, destinationUrl, masterSheetUrl } from './sheetUrls'
import { startPrefetch } from './prefetchStore'

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

/** Start the plan's reads. Safe to call twice for the same page (one request each). */
export function prefetchStudio(productId: string, search: Params): StudioPrefetchPlan {
  const plan = studioPrefetchPlan(productId, search)
  if (plan.destination) startPrefetch(plan.destination)
  if (plan.sheet) startPrefetch(plan.sheet)
  return plan
}
