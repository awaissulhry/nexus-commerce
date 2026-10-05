/**
 * Aliases everywhere (Owner, 2026-10-05: "I should be able to publish the aliases as well … I do not want to do anything in
 * the address bar … the product sheet … should be able to manage all the aliases as well").
 *
 * The rules for choosing ONE listing of a channel · market · account, in one place: the studio bar's listing picker, the
 * sheet band's "Show only this listing" and "Publish this listing…", the Presentation tab, the Activity tab's Undo and
 * "Publish failed products again", and the names the Selling summary and the reference table print.
 *
 * One id kind (the canonical contract): an alias is named by its ALIAS ID (`ProductListingAlias.id`), in the studio URL's
 * `listing=` and as a Publish destination's `listingId`. The main listing has no alias id: a Publish destination names it
 * by leaving `listingId` out. Only the studio URL must tell "the main listing alone" from "every listing", and it does so
 * with the main listing's own record id — the one id the destination read resolves to the main listing. An old link that
 * carries a listing record id (an alias's, or a variation's) keeps resolving as before.
 *
 * The page stays on its product (review 2026-10-05): the studio opens the product of the record `listing=` resolves to.
 * So on a variation's page "Main listing" writes THAT variation's own main record (never the family main product's), and
 * an alias id resolves to the variation's own record of the alias first (the server's `resolveWorkspaceDestination`).
 *
 * Pure: the bar, the sheet and the tests read the same rules.
 */
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import type { StudioPublishScope } from '@nexus/shared/studio-publication'
import { aliasMarkGlyph, aliasMarkName } from '@/design-system/primitives/AliasMark'

/** The picker's options: every listing, the main listing, one alias. */
export const ALL_LISTINGS = 'all'
export const MAIN_LISTING = 'main'
const ALIAS_PREFIX = 'alias:'

export interface ListingAliasChoice {
  /** The alias id (`ProductListingAlias.id`) — what `listing=` and a Publish destination's `listingId` carry. */
  id: string
  /** The alias's own name, as the sheet's band shows it; '' when it has none. */
  label: string
  /** 1, 2, 3… — the ①②③ the sheet's bands show. */
  position: number
}

export interface ListingChoices {
  /** The main listing's record id on this destination (the family's main product), or null when it has none here. */
  mainListingId: string | null
  /** Each family product's own main-listing record here, by product id — what "Main listing" writes on that product's page. */
  mainByProduct: Readonly<Record<string, string>>
  /** Each offered alias → the family products holding a record of it here (a variation without one cannot open it). */
  productsByAlias: Readonly<Record<string, readonly string[]>>
  /** The destination's aliases, in their position order. */
  aliases: ListingAliasChoice[]
  /** Every listing record here (any product of the family) → its listing: '' = the main listing, else the alias id. */
  aliasByRecord: Readonly<Record<string, string>>
}

export const NO_LISTING_CHOICES: ListingChoices = Object.freeze({ mainListingId: null, mainByProduct: {}, productsByAlias: {}, aliases: [], aliasByRecord: {} }) as ListingChoices

/**
 * Why a listing cannot be chosen on this page: the page's product holds no record of it here. Opening it would show and
 * save another product's record (the family main product's) under this product's header (review 2026-10-05, M1/N3).
 */
export const LISTING_NOT_RECORDED = 'This product has no record of this listing on this account and market yet, so it cannot be shown alone.'

/** An alias's name: its own label, else "Listing alias 2"; position 0 is the main listing. */
export function aliasName(position: number, label: string | null | undefined): string {
  const own = label?.trim()
  if (own) return own
  return position > 0 ? `Listing alias ${position}` : 'Main listing'
}

/** "① ALT1", "★ Main listing" — the mark and the name, as one string (menus, sentences, a reference file). */
export function aliasMarkText(position: number, label: string | null | undefined): string {
  return `${aliasMarkGlyph(position)} ${aliasName(position, label)}`
}

/**
 * Whether the mark (`AliasMark`, role img) adds anything a screen reader would not hear from the name beside it: not for
 * "Main listing" or an unnamed "Listing alias 2" — the mark's own spoken name — so there it is drawn hidden from assistive
 * technology, and the listing is read once.
 */
export function aliasMarkSpoken(position: number, label: string | null | undefined): boolean {
  return aliasName(position, label) !== aliasMarkName(position)
}

type ChoiceCell = Pick<PublishActionCell, 'listingId' | 'productId' | 'aliasKey'> & Partial<Pick<PublishActionCell, 'aliasLabel' | 'aliasPosition' | 'aliasStatus'>>

/**
 * The listings of one destination, from its Status and Action read (`GET …/studio/publish-actions?channel&marketplace&
 * accountId`, every listing record there, no channel call). The main listing is the family main product's record without
 * an alias ('' alias key; a `new:` stand-in is not a record). An alias is listed when a record carries its id.
 *
 * The server names each alias's place (`aliasPosition`), label and state (`aliasStatus`). Only an ACTIVE alias is offered:
 * an archived alias's rows are still read (its live item stays endable from its Status cell), but the studio cannot open
 * it. A read that names no state, but places, leaves out an alias without a place; a read that names neither keeps every
 * alias, numbered in id order.
 */
export function listingChoicesFromCells(cells: readonly ChoiceCell[], familyId: string): ListingChoices {
  const stated = cells.some(cell => !!cell.aliasKey && cell.aliasStatus !== undefined)
  const placed = cells.some(cell => !!cell.aliasKey && typeof cell.aliasPosition === 'number')
  // A `new:` id (`newRowId`) is a stand-in for a family member with no record here, never a listing to open.
  const records = cells.filter(cell => !cell.listingId.startsWith('new:'))
  const main = records.find(cell => cell.productId === familyId && !cell.aliasKey)
  const mainByProduct: Record<string, string> = {}
  for (const cell of records) if (!cell.aliasKey && !(cell.productId in mainByProduct)) mainByProduct[cell.productId] = cell.listingId
  const byId = new Map<string, ListingAliasChoice>()
  for (const cell of cells) {
    if (!cell.aliasKey) continue
    const position = typeof cell.aliasPosition === 'number' ? cell.aliasPosition : null
    if (stated ? cell.aliasStatus !== 'ACTIVE' : placed && position === null) continue
    const known = byId.get(cell.aliasKey)
    const label = cell.aliasLabel?.trim() ?? ''
    if (!known) byId.set(cell.aliasKey, { id: cell.aliasKey, label, position: position ?? 0 })
    else if (!known.label && label) known.label = label
  }
  const aliases = [...byId.values()].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  const aliasByRecord: Record<string, string> = {}
  const productsByAlias: Record<string, string[]> = {}
  for (const cell of cells) {
    if (cell.listingId.startsWith('new:') || (cell.aliasKey && !byId.has(cell.aliasKey))) continue
    aliasByRecord[cell.listingId] = cell.aliasKey
    if (!cell.aliasKey) continue
    const holders = productsByAlias[cell.aliasKey] ??= []
    if (!holders.includes(cell.productId)) holders.push(cell.productId)
  }
  return {
    mainListingId: main?.listingId ?? null,
    mainByProduct,
    productsByAlias,
    aliases: placed ? aliases : aliases.map((alias, index) => ({ ...alias, position: index + 1 })),
    aliasByRecord,
  }
}

/**
 * The main-listing record "Main listing" writes on a product's page: that product's OWN record here, so a variation's
 * page stays on the variation; null when it has none (the choice is then not offered). No product named: the family's.
 */
export function mainListingOf(choices: ListingChoices | null, productId?: string | null): string | null {
  if (!choices) return null
  return productId ? choices.mainByProduct[productId] ?? null : choices.mainListingId
}

/** Whether the page's product holds a record of this alias here (no product named: any record will do). */
export function aliasRecordedFor(choices: ListingChoices, aliasId: string, productId?: string | null): boolean {
  const holders = choices.productsByAlias[aliasId] ?? []
  return productId ? holders.includes(productId) : holders.length > 0
}

/**
 * The picker is drawn when the destination holds more than one listing. A family without aliases looks as it always did
 * (review 2026-10-05, N2): a chosen listing there keeps the bar's "Selected listing · Clear" button as its way back.
 */
export function showListingPicker(choices: ListingChoices | null, _listingId?: string | null): boolean {
  return (choices?.aliases.length ?? 0) > 0
}

export interface ListingPickerOption {
  value: string
  label: string
  /** The mark to draw before the label: 0 = ★ main, 1… = ①②③; null = none ("All listings"). */
  position: number | null
  disabled?: boolean
  title?: string
}

/** "All listings · ★ Main listing · ① ALT1 · ② ALT2 …", the aliases in their position order. `productId`: the page's. */
export function listingPickerOptions(choices: ListingChoices, productId?: string | null): ListingPickerOption[] {
  return [
    { value: ALL_LISTINGS, label: 'All listings', position: null, title: 'Show every listing on this account and market' },
    mainListingOf(choices, productId)
      ? { value: MAIN_LISTING, label: 'Main listing', position: 0, title: 'Show only the main listing' }
      : { value: MAIN_LISTING, label: 'Main listing', position: 0, disabled: true,
        // The family's main product has one, this variation has none: choosing it would move the page to the main product.
        title: productId && choices.mainListingId ? LISTING_NOT_RECORDED : 'The main listing has no record on this account and market yet.' },
    // An alias this page's product holds no record of is shown, but cannot be chosen (review 2026-10-05, N3): the server
    // would answer with the family main product's record, and the page would show that product's data.
    ...choices.aliases.map(alias => aliasRecordedFor(choices, alias.id, productId)
      ? { value: `${ALIAS_PREFIX}${alias.id}`, label: aliasName(alias.position, alias.label), position: alias.position,
        title: `Show only ${aliasName(alias.position, alias.label)}` }
      : { value: `${ALIAS_PREFIX}${alias.id}`, label: aliasName(alias.position, alias.label), position: alias.position, disabled: true, title: LISTING_NOT_RECORDED }),
  ]
}

/**
 * The option the studio shows now. `resolvedAliasKey` is the destination read's answer for the chosen listing ('' = the
 * main listing); while it resolves, a listing id the choices know names its option; anything else is unknown (undefined).
 */
export function listingPickerValue(listingId: string | null | undefined, resolvedAliasKey: string | null | undefined, choices: ListingChoices | null): string | undefined {
  if (!listingId) return ALL_LISTINGS
  if (typeof resolvedAliasKey === 'string') return resolvedAliasKey ? `${ALIAS_PREFIX}${resolvedAliasKey}` : MAIN_LISTING
  if (choices?.aliases.some(alias => alias.id === listingId)) return `${ALIAS_PREFIX}${listingId}`
  // A listing record (any product's): its own listing.
  const alias = choices?.aliasByRecord[listingId]
  if (alias === '') return MAIN_LISTING
  if (alias) return `${ALIAS_PREFIX}${alias}`
  return undefined
}

/**
 * What the studio's `setListing` receives for a picker option; undefined = every listing (or a listing this page's
 * product holds no record of, which the picker never offers). `productId`: the page's.
 */
export function listingParamOf(value: string, choices: ListingChoices, productId?: string | null): string | undefined {
  if (value === MAIN_LISTING) return mainListingOf(choices, productId) ?? undefined
  if (!value.startsWith(ALIAS_PREFIX)) return undefined
  const aliasId = value.slice(ALIAS_PREFIX.length)
  return aliasId && aliasRecordedFor(choices, aliasId, productId) ? aliasId : undefined
}

/**
 * A page that lists listing RECORDS (the Media workspaces) writes the same `listing=` as the picker: an alias's record
 * becomes its alias id; a main-listing record stays itself — those pages list the page product's OWN records, and that
 * record is exactly what the picker's "Main listing" writes on this page (a variation's page stays on the variation). A
 * record these choices do not know (not read yet, or another product's) stays as it is — the studio still resolves it.
 */
export function listingParamForRecord(recordId: string, choices: ListingChoices | null): string {
  const alias = choices?.aliasByRecord[recordId]
  return alias || recordId
}

/** The `listing=` value that shows one listing alone: the alias id, or the main listing's record id; undefined = none known. */
export function listingSelection(aliasId: string | null | undefined, mainListingId: string | null | undefined): string | undefined {
  return aliasId || mainListingId || undefined
}

/** A sheet row as far as choosing its listing goes: its product, its listing (alias) and its record here. */
export interface ListingSelectionRow {
  id: string
  aliasId?: string | null
  rowKind?: string
  listing: { id: string } | null
}

/**
 * The `listing=` that shows one listing alone from a page's sheet rows (the band's "Show only this listing", the
 * Presentation tab): an alias by its alias id, the main listing by its record — and only when the PAGE PRODUCT holds its
 * own record of that listing here. Another product's record (the family main product's band) would move the page to that
 * product, so it is never used (review 2026-10-05, M1/N3). Undefined when this product has none (the choice is refused,
 * `LISTING_NOT_RECORDED`).
 */
export function pageListingSelection(aliasId: string | null | undefined, rows: readonly ListingSelectionRow[], pageProductId: string): string | undefined {
  const own = rows.find(row => row.id === pageProductId && (row.aliasId || null) === (aliasId || null) && !!row.listing?.id)
  if (!own) return undefined
  return aliasId || own.listing!.id
}

/** A Publish destination for one listing: an alias names its alias id; the main listing names none. */
export function listingPublishScope(at: { channel: string; marketplace: string; accountId: string }, aliasKey: string | null | undefined): StudioPublishScope {
  return { channel: at.channel, marketplace: at.marketplace, accountId: at.accountId, ...(aliasKey ? { listingId: aliasKey } : {}) }
}

/** Undo of a selling change: Publish opens on the run's own listing. */
export function undoPublishScope(run: { channel: string; marketplace: string | null; accountId: string; aliasKey: string | null }): StudioPublishScope {
  return listingPublishScope({ channel: run.channel, marketplace: run.marketplace ?? '', accountId: run.accountId }, run.aliasKey)
}

/** "Publish failed products again": Publish opens on the failed publication's own listing. */
export function retryPublishScope(destination: StudioPublishScope & { aliasKey: string }): StudioPublishScope {
  return listingPublishScope(destination, destination.aliasKey)
}
