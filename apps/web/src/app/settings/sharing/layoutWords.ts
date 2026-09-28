/**
 * Sharing studio step 3 — the words for a shared product's listing LAYOUT, made here as drafts. One module for the
 * product studio's "Other businesses" page and Settings › Shared products, so both say it the same way.
 * Step 4: when the share offers "Listing content", each draft with no content of its own gets the other business's
 * content for that listing, once.
 * API: apps/api/src/services/assortment/listing-layout.service.ts and listing-content.service.ts.
 */
import { channelLabel } from '@nexus/shared/channel-label'
import { count } from './words'

/** `content` (only when the share offers listing content): the other business's listing has content to copy. */
export interface LayoutSlot { position: number; label: string | null; content?: boolean }
/** The slots of one account here; `blank` (only when the share offers listing content): drafts with no content yet. */
export interface PresentSlots { main: boolean; aliases: string[]; blank?: { main: boolean; aliases: string[] } }
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
  here: { suggestedAccountId: string | null; blocked: string | null; present: Record<string, PresentSlots> }
}
export interface ListingLayout {
  productId: string
  rootId: string
  sourceBusiness: string
  /** The share offers "Listing content": each draft made here gets the other business's content, once. */
  copiesContent: boolean
  groups: LayoutGroup[]
  accounts: Record<string, FollowerAccount[]>
}
export interface ListingContentResult {
  listings: number
  copied: number
  notShared: number
  /** One field of a listing, or (field null) all of it. */
  refused: Array<{ listing: string; field: string | null; message: string }>
  /** Not copied: neither business has a channel category for these listings. */
  noCategory?: string[]
  /** Left unchanged, by alias name or "main listing": already on a channel … */
  onChannel: string[]
  /** … or a draft that already has content of its own. */
  ownContent: string[]
  /** Languages the other business writes this listing in that this business's market does not carry: not copied. */
  otherLanguages?: string[]
  /** The copy as a whole could not be made (the drafts were): why. */
  error?: string | null
}
export interface LayoutGroupResult { key: string; listings: number; aliases: number; refused: string | null; content?: ListingContentResult | null }
export interface ShareContentResult { listings: number; copied: number; ownContent: number; onChannel: number }
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

/**
 * How many listings (the main listing, each alias) would get the other business's content on the chosen account: the
 * ones made now and the drafts here with no content of their own yet — where the other business's listing has content
 * to copy. 0 when the share does not offer it.
 */
export function toFill(slots: LayoutSlot[], present: PresentSlots | undefined, copiesContent: boolean): number {
  if (!copiesContent) return 0
  const make = toMake(slots, present)
  const blank = new Set((present?.blank?.aliases ?? []).map((label) => label.trim().toLowerCase()))
  const main = slots.some((s) => s.position === 0 && s.content) && (make.main || !!present?.blank?.main)
  const aliases = slots.filter((s) => s.position > 0 && s.content && s.label && (make.aliases.includes(s.label) || blank.has(s.label.trim().toLowerCase()))).length
  return (main ? 1 : 0) + aliases
}

/** The "Here now" cell for the chosen account. */
export function hereWords(slots: LayoutSlot[], present: PresentSlots | undefined, copiesContent = false): string {
  const make = toMake(slots, present)
  const missing = (make.main ? 1 : 0) + make.aliases.length
  if (!missing) {
    const empty = toFill(slots, present, copiesContent)
    return empty ? `All here · content to copy into ${count(empty, 'draft')}` : 'All here'
  }
  const has = !!present?.main || (present?.aliases.length ?? 0) > 0
  if (!has) return 'Nothing here yet'
  const parts = [make.main ? 'the main listing' : null, make.aliases.length ? count(make.aliases.length, 'alias', 'aliases') : null].filter(Boolean)
  return `Partly here: ${parts.join(' and ')} to make`
}

/**
 * The button: "Make 1 main listing and 2 aliases", "… and copy content into 3 listings", or "Copy content into 2
 * listings". Null when nothing chosen is missing.
 */
export function makeWords(total: { main: number; aliases: number; fill?: number }): string | null {
  const parts = [total.main ? count(total.main, 'main listing') : null, total.aliases ? count(total.aliases, 'alias', 'aliases') : null].filter(Boolean)
  const fill = total.fill ? `copy content into ${count(total.fill, 'listing')}` : null
  if (parts.length) return `Make ${parts.join(' and ')}${fill ? ` and ${fill}` : ''}`
  return fill ? fill.charAt(0).toUpperCase() + fill.slice(1) : null
}

/** "the main listing", "Winter", "the main listing and Winter": the names of listings here. */
function listingNames(names: string[]): string {
  const words = names.map((name) => (name === 'main listing' ? 'the main listing' : `“${name}”`))
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? ''
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** "German", "German and French": language codes in English words (the code itself when it is not known). */
function languageNames(codes: string[]): string {
  const names = codes.map((code) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code } catch { return code } })
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? ''
}

/** After making: what was made and copied, what was left as it is, and each refusal with its place. */
export function madeWords(results: LayoutGroupResult[], place: (key: string) => string): { text: string; notes: string[]; refused: string[] } {
  const mains = results.filter((r) => !r.refused && r.listings > 0).length
  const aliases = results.reduce((sum, r) => sum + (r.refused ? 0 : r.aliases), 0)
  const made = [mains ? count(mains, 'main listing') : null, aliases ? count(aliases, 'alias', 'aliases') : null].filter(Boolean)
  const content = results.filter((r) => r.content)
  const copied = content.reduce((sum, r) => sum + (r.content?.listings ?? 0), 0)
  const sentences = [
    made.length ? `Made ${made.join(' and ')} as drafts.` : content.length ? 'No new drafts were needed.' : 'Nothing new was needed: what you chose is already here.',
    content.length ? (copied ? `Copied listing content into ${count(copied, 'draft')}.` : 'No listing content was copied.') : null,
    made.length || copied ? 'A draft sends nothing until you publish it.' : null,
  ].filter(Boolean)
  const notes: string[] = []
  const refused = results.filter((r) => r.refused).map((r) => `${place(r.key)}: ${r.refused}`)
  for (const r of content) {
    const c = r.content!
    if (c.error) refused.push(`${place(r.key)}: The listing content was not copied. ${c.error}`)
    if (c.ownContent.length) notes.push(`${place(r.key)}: ${capital(listingNames(c.ownContent))} already ${c.ownContent.length > 1 ? 'have' : 'has'} content of ${c.ownContent.length > 1 ? 'their' : 'its'} own, so ${c.ownContent.length > 1 ? 'they were' : 'it was'} left as ${c.ownContent.length > 1 ? 'they are' : 'it is'}.`)
    if (c.onChannel.length) notes.push(`${place(r.key)}: ${capital(listingNames(c.onChannel))} ${c.onChannel.length > 1 ? 'are' : 'is'} already on the channel, so ${c.onChannel.length > 1 ? 'they were' : 'it was'} not changed.`)
    if (c.otherLanguages?.length) notes.push(`${place(r.key)}: Text in ${languageNames(c.otherLanguages)} was not copied. This business does not use ${c.otherLanguages.length > 1 ? 'these languages' : 'this language'} on that market.`)
    if (c.noCategory?.length) refused.push(`${place(r.key)}: The content of ${listingNames(c.noCategory)} was not copied: ${c.noCategory.length > 1 ? 'they have' : 'it has'} no category in either business. Choose one on the listing, then copy again.`)
    for (const refusal of c.refused) refused.push(refusal.field
      ? `${place(r.key)}: “${refusal.field}” of ${listingNames([refusal.listing])} was not copied. ${refusal.message}`
      : `${place(r.key)}: The content of ${listingNames([refusal.listing])} was not copied. ${refusal.message}`)
  }
  return { text: sentences.join(' '), notes, refused }
}

/** Settings: one row per channel and account of the other business. */
export function shareLayoutRowWords(g: ShareLayoutGroup, business: string): { place: string; detail: string } {
  return {
    place: `${channelLabel(g.channel)}${g.sourceAccounts > 1 ? ` · ${business}’s account ${g.sourceAccount} of ${g.sourceAccounts}` : ''}`,
    detail: `${count(g.products, 'product')} · ${g.markets.join(', ')}${g.aliases ? ` · ${count(g.aliases, 'alias', 'aliases')}` : ''}`,
  }
}

/** Settings: the result for a whole share. */
export function shareMadeWords(result: { products: number; listings: number; aliases: number; content?: ShareContentResult | null; refused: Array<{ sku: string; reason: string }> }): { text: string; notes: string[]; refused: string[] } {
  const made = result.listings || result.aliases
  const content = result.content
  const sentences = [
    made ? `Made drafts for ${count(result.products, 'product')}: ${count(result.listings, 'listing row')} and ${count(result.aliases, 'alias', 'aliases')}.`
      : content ? 'No new drafts were needed.' : 'Nothing new was needed: the listings you chose are already here.',
    content ? (content.listings ? `Copied listing content into ${count(content.listings, 'draft')}.` : 'No listing content was copied.') : null,
    made || content?.listings ? 'A draft sends nothing until you publish it.' : null,
  ].filter(Boolean)
  const notes = [
    content?.ownContent ? `${count(content.ownContent, 'draft')} already had content of ${content.ownContent > 1 ? 'their' : 'its'} own, so ${content.ownContent > 1 ? 'they were' : 'it was'} left as ${content.ownContent > 1 ? 'they are' : 'it is'}.` : null,
    content?.onChannel ? `${count(content.onChannel, 'listing')} ${content.onChannel > 1 ? 'are' : 'is'} already on a channel, so ${content.onChannel > 1 ? 'they were' : 'it was'} not changed.` : null,
  ].filter((line): line is string => !!line)
  return { text: sentences.join(' '), notes, refused: result.refused.map((r) => `${r.sku}: ${r.reason}`) }
}

/** Before making: what the share's "Listing content" choice will do (one sentence for both screens). */
export function contentNoteWords(business: string): string {
  return `${business} also shares listing content: each draft that has no content of its own gets ${business}’s title, description, item specifics and category for that listing, once. Prices, stock, shipping and policies stay yours.`
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
