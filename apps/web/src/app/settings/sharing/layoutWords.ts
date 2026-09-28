/**
 * Sharing studio step 3 — the words for a shared product's listing LAYOUT, made here as drafts. One module for the
 * product studio's "Other businesses" page and Settings › Shared products, so both say it the same way.
 * API: apps/api/src/services/assortment/listing-layout.service.ts.
 */
import { channelLabel } from '@nexus/shared/channel-label'
import { count } from './words'

export interface LayoutSlot { position: number; label: string | null }
export interface FollowerAccount {
  id: string
  label: string
  primary: boolean
  /** Another business's account shared with this one for publishing: its owner, else null. */
  sharedBy: string | null
  /** The markets a shared account may be used on; empty = every market. */
  markets: string[]
}
export interface LayoutGroup {
  key: string
  channel: string
  marketplace: string
  sourceAccount: number
  sourceAccounts: number
  slots: LayoutSlot[]
  here: { suggestedAccountId: string | null; blocked: string | null; present: Record<string, { main: boolean; aliases: string[] }> }
}
export interface ListingLayout { productId: string; rootId: string; sourceBusiness: string; groups: LayoutGroup[]; accounts: Record<string, FollowerAccount[]> }
export interface LayoutGroupResult { key: string; listings: number; aliases: number; refused: string | null }
export interface ShareLayoutGroup {
  key: string
  channel: string
  sourceAccount: number
  sourceAccounts: number
  products: number
  markets: string[]
  aliases: number
  suggestedAccountId: string | null
}

/** "the other business's account 2 of 2" — only when it lists the product with more than one account on the channel. */
function whichAccount(g: { sourceAccount: number; sourceAccounts: number }, business: string): string {
  return g.sourceAccounts > 1 ? ` · ${business}’s account ${g.sourceAccount} of ${g.sourceAccounts}` : ''
}

/** Where the other business lists it: "eBay IT", "eBay DE · Business A’s account 2 of 2". */
export function sourcePlaceWords(g: Pick<LayoutGroup, 'channel' | 'marketplace' | 'sourceAccount' | 'sourceAccounts'>, business: string): string {
  return `${channelLabel(g.channel)} ${g.marketplace}${whichAccount(g, business)}`
}

/** What is listed there: "Main listing", "Main listing and 2 aliases: Winter, Summer", "1 alias: Winter". */
export function slotsWords(slots: LayoutSlot[]): string {
  const main = slots.some((s) => s.position === 0)
  const aliases = slots.filter((s) => s.position > 0).map((s) => s.label ?? `Listing ${s.position + 1}`)
  const named = aliases.length ? `${count(aliases.length, 'alias', 'aliases')}: ${aliases.join(', ')}` : ''
  if (main) return named ? `Main listing and ${named}` : 'Main listing'
  return named.charAt(0).toUpperCase() + named.slice(1)
}

/** What choosing this account would make: the main listing when it is missing, and each alias whose name is not here. */
export function toMake(slots: LayoutSlot[], present: { main: boolean; aliases: string[] } | undefined): { main: boolean; aliases: string[] } {
  const have = new Set((present?.aliases ?? []).map((label) => label.trim().toLowerCase()))
  return {
    main: slots.some((s) => s.position === 0) && !present?.main,
    aliases: slots.filter((s) => s.position > 0 && s.label && !have.has(s.label.trim().toLowerCase())).map((s) => s.label!),
  }
}

/** The "Here now" cell for the chosen account. */
export function hereWords(slots: LayoutSlot[], present: { main: boolean; aliases: string[] } | undefined): string {
  const make = toMake(slots, present)
  const missing = (make.main ? 1 : 0) + make.aliases.length
  if (!missing) return 'All here'
  const has = !!present?.main || (present?.aliases.length ?? 0) > 0
  if (!has) return 'Nothing here yet'
  const parts = [make.main ? 'the main listing' : null, make.aliases.length ? count(make.aliases.length, 'alias', 'aliases') : null].filter(Boolean)
  return `Partly here: ${parts.join(' and ')} to make`
}

/** The button: "Make 1 main listing and 2 aliases". Null when nothing chosen is missing. */
export function makeWords(total: { main: number; aliases: number }): string | null {
  const parts = [total.main ? count(total.main, 'main listing') : null, total.aliases ? count(total.aliases, 'alias', 'aliases') : null].filter(Boolean)
  return parts.length ? `Make ${parts.join(' and ')}` : null
}

/** After making: what was made, and each refusal with its place. */
export function madeWords(results: LayoutGroupResult[], place: (key: string) => string): { text: string; refused: string[] } {
  const mains = results.filter((r) => !r.refused && r.listings > 0).length
  const aliases = results.reduce((sum, r) => sum + (r.refused ? 0 : r.aliases), 0)
  const made = [mains ? count(mains, 'main listing') : null, aliases ? count(aliases, 'alias', 'aliases') : null].filter(Boolean)
  return {
    text: made.length ? `Made ${made.join(' and ')} as drafts. A draft sends nothing until you publish it.` : 'Nothing new was needed: what you chose is already here.',
    refused: results.filter((r) => r.refused).map((r) => `${place(r.key)}: ${r.refused}`),
  }
}

/** Settings: one row per channel and account of the other business. */
export function shareLayoutRowWords(g: ShareLayoutGroup, business: string): { place: string; detail: string } {
  return {
    place: `${channelLabel(g.channel)}${g.sourceAccounts > 1 ? ` · ${business}’s account ${g.sourceAccount} of ${g.sourceAccounts}` : ''}`,
    detail: `${count(g.products, 'product')} · ${g.markets.join(', ')}${g.aliases ? ` · ${count(g.aliases, 'alias', 'aliases')}` : ''}`,
  }
}

/** Settings: the result for a whole share. */
export function shareMadeWords(result: { products: number; listings: number; aliases: number; refused: Array<{ sku: string; reason: string }> }): { text: string; refused: string[] } {
  return {
    text: result.listings || result.aliases
      ? `Made drafts for ${count(result.products, 'product')}: ${count(result.listings, 'listing row')} and ${count(result.aliases, 'alias', 'aliases')}. A draft sends nothing until you publish it.`
      : 'Nothing new was needed: the listings you chose are already here.',
    refused: result.refused.map((r) => `${r.sku}: ${r.reason}`),
  }
}

/**
 * The account list for a choice: this business's accounts (a shared one says whose it is), and "Don't make it". With a
 * market, a shared account limited to other markets is left out.
 */
export function accountOptions(accounts: FollowerAccount[], market?: string): Array<{ value: string; label: string }> {
  const usable = accounts.filter((a) => !market || a.markets.length === 0 || a.markets.includes(market))
  return [
    ...usable.map((a) => ({ value: a.id, label: a.sharedBy ? `${a.label} · shared by ${a.sharedBy}` : a.primary ? `${a.label} (primary)` : a.label })),
    { value: '', label: 'Don’t make it here' },
  ]
}
