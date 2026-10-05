/**
 * The Publish window's destination pickers (Owner, 2026-10-02: "I have to scroll through the whole sheet to find the
 * channel and the market of my choice").
 *
 * Pure rules for the compact row at the top of the window — Channel, Account (only when the channel has more than one)
 * and Markets — and for the one tab each chosen market gets. The same rules serve the studio's family publish and the
 * products list's many-product publish. One channel and one account at a time, as the sheet's own top bar works; the
 * markets keep their order in the market list, whatever order they were picked in.
 *
 * One-click publish (Owner 2026-10-04, OD1/OD2 A): the window opens with every market where the family is listed
 * (`initialChoice` with `listed`), and another channel or account refills the same way (`refillChoice`).
 *
 * Aliases (Owner 2026-10-05): a market's listing aliases are picked like markets — each right after its market's main
 * listing, named with the sheet band's mark ("IT · Italy · ① Racing edition"; the main listing "IT · Italy · ★ Main listing"
 * when its market has aliases) — and a listed alias starts chosen like a listed main listing.
 */
import type { PublicationBatchChild } from '@nexus/shared/studio-publication'
import { channelLabel } from '@nexus/shared/channel-label'
import { LISTINGS_WORD, MARKETS_WORD, MAX_BATCH_DESTINATIONS, type DestinationState, type PlacesWord, type PublishPlan } from './destinations'
import { manyRowState, type ManyPlan } from './many'
import { optionListingLabel, publicationScopeKey, type PublicationDestinationOption } from './model'

/** What the pickers hold: one channel, one account of it, and the chosen markets (option keys). */
export interface PickerChoice {
  channel: string | null
  accountId: string | null
  keys: string[]
}

export const EMPTY_CHOICE: PickerChoice = Object.freeze({ channel: null, accountId: null, keys: [] }) as PickerChoice

const unique = <T, K>(items: readonly T[], key: (item: T) => K) => [...new Map(items.map(item => [key(item), item])).values()]
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** The channels the business can publish to, in list order. */
export function pickerChannels(options: readonly PublicationDestinationOption[]): Array<{ value: string; label: string }> {
  return unique(options, o => o.scope.channel).map(o => ({ value: o.scope.channel, label: channelLabel(o.scope.channel) }))
}

/** The connected accounts of one channel. The Account picker is shown only when there are two or more. */
export function pickerAccounts(options: readonly PublicationDestinationOption[], channel: string | null): Array<{ value: string; label: string }> {
  if (!channel) return []
  return unique(options.filter(o => o.scope.channel === channel), o => o.scope.accountId).map(o => ({ value: o.scope.accountId, label: o.accountLabel }))
}

/** The markets of one channel on one account, in the market list's order. */
export function pickerMarkets(options: readonly PublicationDestinationOption[], channel: string | null, accountId: string | null): PublicationDestinationOption[] {
  if (!channel || !accountId) return []
  return options.filter(o => o.scope.channel === channel && o.scope.accountId === accountId)
}

/** Which listing of its market an option is, for the pickers: the band's mark and name, or "selected listing". */
const pickerListing = (option: PublicationDestinationOption) =>
  option.scope.listingId && !option.alias ? 'selected listing' : optionListingLabel(option)

/**
 * "IT · Italy" — the market code first, as the sheet's market picker reads ("IT · Italy · Italian"). A listing alias
 * adds the sheet band's mark and name ("IT · Italy · ① Racing edition"); its market's main listing then reads
 * "IT · Italy · ★ Main listing".
 */
export function marketOptionLabel(option: PublicationDestinationOption): string {
  const prefix = `${channelLabel(option.scope.channel)} `
  const name = option.marketName.startsWith(prefix) ? option.marketName.slice(prefix.length) : option.marketName
  const parts = [option.scope.marketplace, name !== option.scope.marketplace ? name : null, pickerListing(option)]
  return parts.filter(Boolean).join(' · ')
}

/**
 * The market's short name for a tab or a chip: "IT"; with aliases on the market "IT ★ Main listing" and
 * "IT ① Racing edition"; "IT · selected listing" for a listing the window knows nothing more about.
 */
export function marketShortLabel(option: PublicationDestinationOption): string {
  const listing = pickerListing(option)
  if (!listing) return option.scope.marketplace
  return option.alias || !option.scope.listingId ? `${option.scope.marketplace} ${listing}` : `${option.scope.marketplace} · ${listing}`
}

/**
 * What the window counts in the chosen set (`keys`): "listings" when it includes a listing alias, else "markets". The
 * pickers show one channel and one account at a time, so the chosen set never mixes channels.
 */
export function choiceWord(options: readonly PublicationDestinationOption[], keys: readonly string[]): PlacesWord {
  const chosen = new Set(keys)
  return options.some(o => chosen.has(o.key) && !!o.scope.listingId) ? LISTINGS_WORD : MARKETS_WORD
}

/** The Markets picker's closed face: "Markets: 3", or "Listings: 3" once an alias is chosen. */
export function marketsPickerText(options: readonly PublicationDestinationOption[], keys: readonly string[], marketsLabel = 'Markets'): string {
  const word = choiceWord(options, keys)
  const label = word === LISTINGS_WORD ? 'Listings' : marketsLabel
  return `${label}: ${keys.length.toLocaleString('en')}`
}

/** OD2 A — the channel the Shared tab opens with: the first where the family is listed, in this order, then the rest. */
export const LISTED_CHANNEL_ORDER: readonly string[] = ['AMAZON', 'EBAY', 'SHOPIFY']

/**
 * OD1 A — the destinations of one channel and account the window chooses: every main listing and every listing alias
 * where the family is listed (`listed`, see `listedDestinationKeys`: an alias by its own key), plus `extra` (the sheet's
 * own destination), in the market list's order (each alias after its market's main listing), at most the batch limit.
 * An alias that is not listed is offered but not chosen.
 */
export function listedMarkets(options: readonly PublicationDestinationOption[], listed: ReadonlySet<string>, channel: string | null, accountId: string | null,
  extra: readonly string[] = []): string[] {
  const wanted = new Set(extra)
  return pickerMarkets(options, channel, accountId)
    .filter(o => wanted.has(o.key) || listed.has(o.key))
    .map(o => o.key).slice(0, MAX_BATCH_DESTINATIONS)
}

/**
 * What the window opens with. The asked-for destinations (the sheet's own channel, market and account) when they
 * exist — with `listed` (one-click publish, OD1 A), every market of that channel and account where the family is listed
 * as well; otherwise, with `listed` (the Shared tab, OD2 A), the first channel where the family is listed (Amazon, eBay,
 * Shopify, then the rest) on its first such account, with all its listed markets; otherwise the only destination there
 * is; otherwise the first channel and its first account with no market chosen — nothing is reviewed until one is picked.
 */
export function initialChoice(options: readonly PublicationDestinationOption[], initialKeys: readonly string[], listed?: ReadonlySet<string> | null): PickerChoice {
  const byKey = new Map(options.map(o => [o.key, o]))
  const first = initialKeys.map(key => byKey.get(key)).find(Boolean)
  if (first) {
    const keys = initialKeys.filter(key => { const o = byKey.get(key); return !!o && o.scope.channel === first.scope.channel && o.scope.accountId === first.scope.accountId })
    const chosen = listed ? listedMarkets(options, listed, first.scope.channel, first.scope.accountId, keys) : [...new Set(keys)]
    return { channel: first.scope.channel, accountId: first.scope.accountId, keys: chosen }
  }
  if (listed?.size) {
    const rank = (channel: string) => { const at = LISTED_CHANNEL_ORDER.indexOf(channel); return at < 0 ? LISTED_CHANNEL_ORDER.length : at }
    const channels = pickerChannels(options).map(c => c.value).sort((a, b) => rank(a) - rank(b))
    for (const channel of channels) {
      for (const account of pickerAccounts(options, channel)) {
        const keys = listedMarkets(options, listed, channel, account.value)
        if (keys.length) return { channel, accountId: account.value, keys }
      }
    }
  }
  if (options.length === 1) return { channel: options[0].scope.channel, accountId: options[0].scope.accountId, keys: [options[0].key] }
  const channel = options[0]?.scope.channel ?? null
  return { channel, accountId: pickerAccounts(options, channel)[0]?.value ?? null, keys: [] }
}

/**
 * OD1 A — another channel or account in the pickers chooses its listed markets the same way (plus the sheet's own
 * market when it belongs there). Where the family is listed nowhere on it, the pickers' own choice stands (the same
 * market codes).
 */
export function refillChoice(options: readonly PublicationDestinationOption[], previous: PickerChoice, next: PickerChoice, listed: ReadonlySet<string> | null | undefined,
  sheetKeys: readonly string[] = []): PickerChoice {
  if (!listed || (next.channel === previous.channel && next.accountId === previous.accountId)) return next
  const keys = listedMarkets(options, listed, next.channel, next.accountId, sheetKeys)
  return keys.length ? { ...next, keys } : next
}

/** Keep the same market codes on the new channel or account (IT stays IT), where that market exists. */
function carryMarkets(options: readonly PublicationDestinationOption[], previous: PickerChoice, channel: string | null, accountId: string | null): string[] {
  const byKey = new Map(options.map(o => [o.key, o]))
  const codes = new Set(previous.keys.map(key => byKey.get(key)?.scope.marketplace).filter(Boolean))
  return pickerMarkets(options, channel, accountId).filter(o => !o.scope.listingId && codes.has(o.scope.marketplace)).map(o => o.key)
}

/** Another channel: its first account, and the same market codes where it has them. */
export function changeChannel(options: readonly PublicationDestinationOption[], previous: PickerChoice, channel: string): PickerChoice {
  if (channel === previous.channel) return previous
  const accountId = pickerAccounts(options, channel)[0]?.value ?? null
  return { channel, accountId, keys: carryMarkets(options, previous, channel, accountId) }
}

/** Another account of the same channel: the same market codes where it has them. */
export function changeAccount(options: readonly PublicationDestinationOption[], previous: PickerChoice, accountId: string): PickerChoice {
  if (accountId === previous.accountId) return previous
  return { ...previous, accountId, keys: carryMarkets(options, previous, previous.channel, accountId) }
}

/** The markets picked: kept in the market list's order, only of this channel and account, at most the batch limit. */
export function changeMarkets(options: readonly PublicationDestinationOption[], previous: PickerChoice, keys: readonly string[]): PickerChoice {
  const wanted = new Set(keys)
  const ordered = pickerMarkets(options, previous.channel, previous.accountId).filter(o => wanted.has(o.key)).map(o => o.key)
  return { ...previous, keys: ordered.slice(0, MAX_BATCH_DESTINATIONS) }
}

/** Removing a market's chip removes it, and its tab. */
export const removeMarket = (previous: PickerChoice, key: string): PickerChoice => ({ ...previous, keys: previous.keys.filter(k => k !== key) })

/** The open tab: the one asked for while it is still chosen, else the first chosen market. */
export const activeTab = (keys: readonly string[], active: string | null): string | null => (active && keys.includes(active) ? active : keys[0] ?? null)

/** What a market's review says, in a few words after its code: "12 changes", "2 problems", "checking…". */
export function reviewTabWords(state: DestinationState): string {
  switch (state.kind) {
    case 'not_checked': return 'not checked'
    case 'checking': return 'checking…'
    case 'error': return 'could not check'
    case 'earlier': return 'earlier publish waiting'
    case 'blocked': return state.request ? 'skipped' : state.problems ? plural(state.problems, 'problem', 'problems') : 'cannot be sent'
    case 'expired': return 'review expired'
    case 'nothing': return state.reason === 'unticked' ? 'no fields ticked' : 'nothing to send'
    case 'input': return state.needs === 'location' ? 'choose a location' : 'confirm the overwrite'
    case 'ready': return state.whole ? 'new product' : plural(state.changes, 'change', 'changes')
  }
}

/**
 * One market's tab in the family publish: "IT · 12 changes"; once sent, the publish word ("IT · Waiting for channel").
 * A listing alias's tab: "IT ① Racing edition · 12 changes".
 */
export function marketTabLabel(option: PublicationDestinationOption, state: DestinationState, sentWord?: string | null): string {
  const { name, words } = marketTabParts(option, state, sentWord)
  return `${name} · ${words}`
}

/**
 * The tab's two parts (phone width, review 2026-10-05): the listing's name, which may end with an ellipsis, and what its
 * review says, which is always shown whole.
 */
export function marketTabParts(option: PublicationDestinationOption, state: DestinationState, sentWord?: string | null): { name: string; words: string } {
  return { name: marketShortLabel(option), words: sentWord ?? reviewTabWords(state) }
}

/** The key of a reviewed batch row's market, to put it under that market's tab. */
export const childMarketKey = (child: Pick<PublicationBatchChild, 'channel' | 'marketplace' | 'accountId'>) =>
  publicationScopeKey({ channel: child.channel ?? '', marketplace: child.marketplace ?? '', accountId: child.accountId ?? '' })

/**
 * One market's tab in the many-product publish, from its rows: "IT · checking…" while the server reviews, then
 * "IT · 12 changes" (ready rows), "IT · 3 with problems" or "IT · nothing to send", and while sending "IT · 2 of 5 done".
 */
export function manyTabWords(children: readonly PublicationBatchChild[], stage: 'reviewing' | 'reviewed' | 'sending', now: number = Date.now()): string {
  if (stage === 'reviewing') return 'checking…'
  if (stage === 'sending') {
    const done = children.filter(c => c.terminal).length
    return done === children.length && children.length ? 'done' : `${done} of ${children.length} done`
  }
  let changes = 0, ready = 0, problems = 0
  for (const child of children) {
    const state = manyRowState(child, now)
    if (state.kind === 'ready') { ready++; changes += state.changes }
    else if (state.kind === 'problems' || state.kind === 'not_sent' || state.kind === 'expired') problems++
  }
  if (ready) return plural(changes, 'change', 'changes')
  if (problems) return `${problems.toLocaleString('en')} with problems`
  return children.length ? 'nothing to send' : 'no products'
}

/** One quiet line when two or more markets are chosen — it replaces the big counters: "3 markets · 21 changes · 1 with problems". */
export function familySummary(markets: number, plan: Pick<PublishPlan, 'changes' | 'wholeProducts' | 'skipped' | 'nothing' | 'pending'>, word: PlacesWord = MARKETS_WORD): string {
  return [
    plural(markets, word.one, word.many),
    plan.changes ? plural(plan.changes, 'change', 'changes') : null,
    plan.wholeProducts ? plural(plan.wholeProducts, 'new product', 'new products') : null,
    plan.skipped.length ? `${plan.skipped.length.toLocaleString('en')} with problems` : null,
    plan.nothing.length ? `${plan.nothing.length.toLocaleString('en')} with nothing to send` : null,
    plan.pending.length ? `${plan.pending.length.toLocaleString('en')} not ready yet` : null,
  ].filter(Boolean).join(' · ')
}

/** The same line for the many-product window once checked: "12 listings ready · 214 changes · 3 with problems". */
export function manySummary(plan: Pick<ManyPlan, 'listings' | 'changes' | 'problems' | 'expired' | 'nothing'>): string {
  return [
    `${plural(plan.listings, 'listing', 'listings')} ready`,
    plan.changes ? plural(plan.changes, 'change', 'changes') : null,
    plan.problems ? `${plan.problems.toLocaleString('en')} with problems` : null,
    plan.expired ? `${plan.expired.toLocaleString('en')} expired` : null,
    plan.nothing ? `${plan.nothing.toLocaleString('en')} with nothing to send` : null,
  ].filter(Boolean).join(' · ')
}
