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
 * Pure: the bar, the sheet and the tests read the same rules.
 */
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import type { StudioPublishScope } from '@nexus/shared/studio-publication'
import { aliasMarkGlyph } from '@/design-system/primitives/AliasMark'

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
  /** The destination's aliases, in their position order. */
  aliases: ListingAliasChoice[]
  /** Every listing record here (any product of the family) → its listing: '' = the main listing, else the alias id. */
  aliasByRecord: Readonly<Record<string, string>>
}

export const NO_LISTING_CHOICES: ListingChoices = Object.freeze({ mainListingId: null, aliases: [], aliasByRecord: {} }) as ListingChoices

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

type ChoiceCell = Pick<PublishActionCell, 'listingId' | 'productId' | 'aliasKey'> & Partial<Pick<PublishActionCell, 'aliasLabel' | 'aliasPosition'>>

/**
 * The listings of one destination, from its Status and Action read (`GET …/studio/publish-actions?channel&marketplace&
 * accountId`, every listing record there, no channel call). The main listing is the family main product's record without
 * an alias ('' alias key; a `new:` stand-in is not a record). An alias is listed when a record carries its id.
 *
 * The server names each ACTIVE alias's place (`aliasPosition`) and label; once a read carries a place for any alias, an
 * alias without one is not active and is left out (the studio cannot open it). A read from a server that names no place
 * keeps every alias, numbered in id order.
 */
export function listingChoicesFromCells(cells: readonly ChoiceCell[], familyId: string): ListingChoices {
  const placed = cells.some(cell => !!cell.aliasKey && typeof cell.aliasPosition === 'number')
  // A `new:` id (`newRowId`) is a stand-in for a family member with no record here, never a listing to open.
  const main = cells.find(cell => cell.productId === familyId && !cell.aliasKey && !cell.listingId.startsWith('new:'))
  const byId = new Map<string, ListingAliasChoice>()
  for (const cell of cells) {
    if (!cell.aliasKey) continue
    const position = typeof cell.aliasPosition === 'number' ? cell.aliasPosition : null
    if (placed && position === null) continue
    const known = byId.get(cell.aliasKey)
    const label = cell.aliasLabel?.trim() ?? ''
    if (!known) byId.set(cell.aliasKey, { id: cell.aliasKey, label, position: position ?? 0 })
    else if (!known.label && label) known.label = label
  }
  const aliases = [...byId.values()].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  const aliasByRecord: Record<string, string> = {}
  for (const cell of cells) {
    if (cell.listingId.startsWith('new:') || (cell.aliasKey && !byId.has(cell.aliasKey))) continue
    aliasByRecord[cell.listingId] = cell.aliasKey
  }
  return {
    mainListingId: main?.listingId ?? null,
    aliases: placed ? aliases : aliases.map((alias, index) => ({ ...alias, position: index + 1 })),
    aliasByRecord,
  }
}

/** The picker is drawn when the destination holds more than one listing, or one listing is chosen (the way back). */
export function showListingPicker(choices: ListingChoices | null, listingId: string | null | undefined): boolean {
  return !!listingId || (choices?.aliases.length ?? 0) > 0
}

export interface ListingPickerOption {
  value: string
  label: string
  /** The mark to draw before the label: 0 = ★ main, 1… = ①②③; null = none ("All listings"). */
  position: number | null
  disabled?: boolean
  title?: string
}

/** "All listings · ★ Main listing · ① ALT1 · ② ALT2 …", the aliases in their position order. */
export function listingPickerOptions(choices: ListingChoices): ListingPickerOption[] {
  return [
    { value: ALL_LISTINGS, label: 'All listings', position: null, title: 'Show every listing on this account and market' },
    choices.mainListingId
      ? { value: MAIN_LISTING, label: 'Main listing', position: 0, title: 'Show only the main listing' }
      : { value: MAIN_LISTING, label: 'Main listing', position: 0, disabled: true, title: 'The main listing has no record on this account and market yet.' },
    ...choices.aliases.map(alias => ({ value: `${ALIAS_PREFIX}${alias.id}`, label: aliasName(alias.position, alias.label), position: alias.position,
      title: `Show only ${aliasName(alias.position, alias.label)}` })),
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
  if (choices?.mainListingId && choices.mainListingId === listingId) return MAIN_LISTING
  return undefined
}

/** What the studio's `setListing` receives for a picker option; undefined = every listing. */
export function listingParamOf(value: string, choices: ListingChoices): string | undefined {
  if (value === MAIN_LISTING) return choices.mainListingId ?? undefined
  if (value.startsWith(ALIAS_PREFIX)) return value.slice(ALIAS_PREFIX.length) || undefined
  return undefined
}

/**
 * A page that lists listing RECORDS (the Media workspaces) writes the same `listing=` as the picker: an alias's record
 * becomes its alias id, a main-listing record the family's main record. A record these choices do not know (not read
 * yet, or another product's) stays as it is — the studio still resolves a record id.
 */
export function listingParamForRecord(recordId: string, choices: ListingChoices | null): string {
  const alias = choices?.aliasByRecord[recordId]
  if (alias === undefined) return recordId
  return alias || choices?.mainListingId || recordId
}

/** The `listing=` value that shows one listing alone: the alias id, or the main listing's record id; undefined = none known. */
export function listingSelection(aliasId: string | null | undefined, mainListingId: string | null | undefined): string | undefined {
  return aliasId || mainListingId || undefined
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
