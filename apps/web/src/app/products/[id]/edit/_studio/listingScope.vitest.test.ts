/**
 * Aliases everywhere (Owner 2026-10-05) — choosing one listing of a channel · market · account without the address bar,
 * and opening Publish on exactly that listing. Fake ids only.
 */
import { describe, expect, it } from 'vitest'
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import {
  ALL_LISTINGS, MAIN_LISTING, NO_LISTING_CHOICES, aliasMarkSpoken, aliasMarkText, aliasName, listingChoicesFromCells, listingParamOf, listingPickerOptions,
  listingParamForRecord, listingPickerValue, listingPublishScope, listingSelection, mainListingOf, pageListingSelection, retryPublishScope, showListingPicker,
  undoPublishScope, type ListingChoices,
} from './listingScope'

const FAMILY = 'fam-1'
type Cell = Pick<PublishActionCell, 'listingId' | 'productId' | 'aliasKey' | 'aliasLabel' | 'aliasPosition' | 'aliasStatus'>
const cell = (over: Partial<Cell>): Cell => ({ listingId: 'cl-main', productId: FAMILY, aliasKey: '', aliasLabel: null, aliasPosition: null, ...over })

const CHOICES: ListingChoices = {
  mainListingId: 'cl-main',
  mainByProduct: { 'child-1': 'cl-child', [FAMILY]: 'cl-main' },
  aliases: [{ id: 'alias-1', label: 'ALT1', position: 1 }, { id: 'alias-2', label: 'ALT2', position: 2 }],
  aliasByRecord: { 'cl-alt2': 'alias-2', 'cl-child-alt2': 'alias-2', 'cl-child': '', 'cl-main': '', 'cl-alt1': 'alias-1' },
}

describe('the listings of one destination (listingChoicesFromCells)', () => {
  it('names the main listing by its record and each alias by its id, in place order — whatever order the read sends', () => {
    const choices = listingChoicesFromCells([
      cell({ listingId: 'cl-alt2', aliasKey: 'alias-2', aliasLabel: 'ALT2', aliasPosition: 2 }),
      cell({ listingId: 'cl-child-alt2', productId: 'child-1', aliasKey: 'alias-2', aliasLabel: 'ALT2', aliasPosition: 2 }),
      cell({ listingId: 'cl-child', productId: 'child-1' }),
      cell({}),
      cell({ listingId: 'cl-alt1', aliasKey: 'alias-1', aliasLabel: 'ALT1', aliasPosition: 1 }),
    ], FAMILY)
    expect(choices).toEqual(CHOICES)
  })

  it('a variation\'s record or a not-yet-created row is never the family\'s main listing; each product keeps its own', () => {
    const child = listingChoicesFromCells([cell({ listingId: 'cl-child', productId: 'child-1' })], FAMILY)
    expect(child.mainListingId).toBeNull()
    expect(child.mainByProduct).toEqual({ 'child-1': 'cl-child' })
    expect(listingChoicesFromCells([cell({ listingId: 'new:fam-1:EBAY:IT:acc-1:' })], FAMILY)).toMatchObject({ mainListingId: null, mainByProduct: {} })
  })

  it('offers only ACTIVE aliases once the read names states: an archived alias\'s rows are read, never offered', () => {
    const choices = listingChoicesFromCells([cell({}),
      cell({ listingId: 'cl-a', aliasKey: 'alias-1', aliasLabel: 'ALT1', aliasPosition: 1, aliasStatus: 'ACTIVE' }),
      cell({ listingId: 'cl-old', aliasKey: 'alias-old', aliasLabel: 'OLD', aliasPosition: 2, aliasStatus: 'ARCHIVED' }),
      cell({ listingId: 'cl-gone', aliasKey: 'alias-gone', aliasStatus: null })], FAMILY)
    expect(choices.aliases.map(a => a.id)).toEqual(['alias-1'])
    expect(choices.aliasByRecord).toEqual({ 'cl-main': '', 'cl-a': 'alias-1' })
  })

  it('leaves out an alias the server gives no place (not active) once the read names places', () => {
    const choices = listingChoicesFromCells([cell({}), cell({ listingId: 'cl-a', aliasKey: 'alias-1', aliasLabel: 'ALT1', aliasPosition: 1 }),
      cell({ listingId: 'cl-old', aliasKey: 'alias-old' })], FAMILY)
    expect(choices.aliases.map(a => a.id)).toEqual(['alias-1'])
    expect(choices.aliasByRecord).toEqual({ 'cl-main': '', 'cl-a': 'alias-1' })
  })

  it('a server that names no places keeps every alias, numbered in id order', () => {
    const choices = listingChoicesFromCells([cell({ listingId: 'cl-b', aliasKey: 'b-alias' }), cell({ listingId: 'cl-a', aliasKey: 'a-alias' })], FAMILY)
    expect(choices.aliases).toEqual([{ id: 'a-alias', label: '', position: 1 }, { id: 'b-alias', label: '', position: 2 }])
    expect(choices.aliasByRecord).toEqual({ 'cl-b': 'b-alias', 'cl-a': 'a-alias' })
  })
})

describe('the studio bar\'s listing picker', () => {
  it('offers All listings · Main listing · ① ALT1 · ② ALT2, in that order', () => {
    const options = listingPickerOptions(CHOICES)
    expect(options.map(o => [o.value, o.label, o.position])).toEqual([
      [ALL_LISTINGS, 'All listings', null], [MAIN_LISTING, 'Main listing', 0], ['alias:alias-1', 'ALT1', 1], ['alias:alias-2', 'ALT2', 2],
    ])
    expect(options.every(o => !o.disabled)).toBe(true)
  })

  it('an unnamed alias reads "Listing alias N"; a main listing with no record here cannot be chosen, and says why', () => {
    const options = listingPickerOptions({ mainListingId: null, mainByProduct: {}, aliases: [{ id: 'alias-3', label: '', position: 3 }], aliasByRecord: {} })
    expect(options[1]).toMatchObject({ value: MAIN_LISTING, disabled: true })
    expect(options[1].title).toMatch(/no record/)
    expect(options[2].label).toBe('Listing alias 3')
  })

  it('is drawn when the destination holds an alias, or a listing is chosen (the way back); not for one lone listing', () => {
    expect(showListingPicker(CHOICES, undefined)).toBe(true)
    expect(showListingPicker({ ...NO_LISTING_CHOICES, mainListingId: 'cl-main' }, undefined)).toBe(false)
    expect(NO_LISTING_CHOICES.mainByProduct).toEqual({})
    expect(showListingPicker({ ...NO_LISTING_CHOICES, mainListingId: 'cl-main' }, 'cl-main')).toBe(true)
    expect(showListingPicker(null, undefined)).toBe(false)
  })

  it('shows what the studio shows: nothing chosen = All listings; the resolved listing decides; an id it knows while resolving', () => {
    expect(listingPickerValue(undefined, undefined, CHOICES)).toBe(ALL_LISTINGS)
    expect(listingPickerValue('alias-2', 'alias-2', CHOICES)).toBe('alias:alias-2')
    // An old link: a listing record id that the destination resolved to alias 1, or to the main listing.
    expect(listingPickerValue('cl-alt1', 'alias-1', CHOICES)).toBe('alias:alias-1')
    expect(listingPickerValue('cl-main', '', CHOICES)).toBe(MAIN_LISTING)
    expect(listingPickerValue('alias-1', undefined, CHOICES)).toBe('alias:alias-1')
    expect(listingPickerValue('cl-main', undefined, CHOICES)).toBe(MAIN_LISTING)
    // A variation's own records, while resolving: its main record is the main listing, its alias record the alias.
    expect(listingPickerValue('cl-child', undefined, CHOICES)).toBe(MAIN_LISTING)
    expect(listingPickerValue('cl-child-alt2', undefined, CHOICES)).toBe('alias:alias-2')
    expect(listingPickerValue('cl-unknown', undefined, CHOICES)).toBeUndefined()
  })

  it('writes the alias id for an alias, the main listing\'s record for the main listing, nothing for All listings', () => {
    expect(listingParamOf('alias:alias-1', CHOICES)).toBe('alias-1')
    expect(listingParamOf(MAIN_LISTING, CHOICES)).toBe('cl-main')
    expect(listingParamOf(ALL_LISTINGS, CHOICES)).toBeUndefined()
    expect(listingParamOf(MAIN_LISTING, NO_LISTING_CHOICES)).toBeUndefined()
  })

  /* Review 2026-10-05 (M1): on a variation's page, choosing a listing keeps the page on that variation. */
  it('on a variation\'s page, "Main listing" writes the variation\'s OWN main record, never the family main product\'s', () => {
    expect(listingParamOf(MAIN_LISTING, CHOICES, 'child-1')).toBe('cl-child')
    expect(listingParamOf(MAIN_LISTING, CHOICES, FAMILY)).toBe('cl-main')
    // An alias is its alias id on every page (the server opens the page product's own record of it).
    expect(listingParamOf('alias:alias-2', CHOICES, 'child-1')).toBe('alias-2')
    expect(mainListingOf(CHOICES, 'child-1')).toBe('cl-child')
    expect(mainListingOf(CHOICES)).toBe('cl-main')
    expect(mainListingOf(null, 'child-1')).toBeNull()
  })

  it('a variation without its own main record cannot choose "Main listing" (it would move the page), and says why', () => {
    const options = listingPickerOptions(CHOICES, 'child-2')
    expect(options[1]).toMatchObject({ value: MAIN_LISTING, disabled: true })
    expect(options[1].title).toMatch(/This product has no record/)
    expect(listingParamOf(MAIN_LISTING, CHOICES, 'child-2')).toBeUndefined()
    expect(listingPickerOptions(CHOICES, 'child-1')[1].disabled).toBeUndefined()
  })
})

describe('one id kind', () => {
  it('a page that lists listing records (Media) writes what the picker writes: alias id, or the page product\'s own main record', () => {
    expect(listingParamForRecord('cl-child-alt2', CHOICES)).toBe('alias-2')
    expect(listingParamForRecord('cl-alt1', CHOICES)).toBe('alias-1')
    // A variation's main-listing record (the Media pages list the page product's own records): itself, so the page stays
    // on the variation — exactly what the picker's "Main listing" writes on that page.
    expect(listingParamForRecord('cl-child', CHOICES)).toBe('cl-child')
    expect(listingParamForRecord('cl-main', CHOICES)).toBe('cl-main')
    // Not read yet, or a record the read does not know: the record itself (the studio still resolves it).
    expect(listingParamForRecord('cl-other', CHOICES)).toBe('cl-other')
    expect(listingParamForRecord('cl-alt1', null)).toBe('cl-alt1')
  })

  it('a listing shown alone is its alias id, else the main listing\'s own record', () => {
    expect(listingSelection('alias-1', 'cl-alt1-root')).toBe('alias-1')
    expect(listingSelection(null, 'cl-main')).toBe('cl-main')
    expect(listingSelection(null, null)).toBeUndefined()
  })

  it('from the sheet\'s rows (band, Presentation): the main listing is the PAGE product\'s own record; an alias its id', () => {
    const rows = [
      { id: FAMILY, aliasId: null, rowKind: 'parent', listing: { id: 'cl-main' } },
      { id: 'child-1', aliasId: null, rowKind: 'variant', listing: { id: 'cl-child' } },
      { id: 'child-2', aliasId: null, rowKind: 'variant', listing: null },
      { id: FAMILY, aliasId: 'alias-1', rowKind: 'parent', listing: { id: 'cl-alt1' } },
      { id: 'child-1', aliasId: 'alias-1', rowKind: 'variant', listing: { id: 'cl-child-alt1' } },
      { id: FAMILY, aliasId: 'alias-2', rowKind: 'parent', listing: null },
      { id: 'child-1', aliasId: 'alias-2', rowKind: 'variant', listing: null },
    ]
    expect(pageListingSelection(null, rows, FAMILY)).toBe('cl-main')
    expect(pageListingSelection(null, rows, 'child-1')).toBe('cl-child')
    // A variation with no record of the main listing: none (never the family main product's record).
    expect(pageListingSelection(null, rows, 'child-2')).toBeUndefined()
    expect(pageListingSelection('alias-1', rows, 'child-1')).toBe('alias-1')
    expect(pageListingSelection('alias-1', rows, 'child-2')).toBe('alias-1')
    expect(pageListingSelection('alias-2', rows, 'child-1')).toBeUndefined()
  })

  it('a Publish destination names an alias by its alias id and the main listing by none', () => {
    const at = { channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1' }
    expect(listingPublishScope(at, 'alias-1')).toEqual({ ...at, listingId: 'alias-1' })
    expect(listingPublishScope(at, '')).toEqual(at)
    expect(listingPublishScope(at, null)).toEqual(at)
  })

  it('Undo opens Publish on the run\'s own listing', () => {
    expect(undoPublishScope({ channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1', aliasKey: 'alias-2' }))
      .toEqual({ channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1', listingId: 'alias-2' })
    expect(undoPublishScope({ channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1', aliasKey: '' })).toEqual({ channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1' })
    expect(undoPublishScope({ channel: 'EBAY', marketplace: null, accountId: 'acc-1', aliasKey: null })).toEqual({ channel: 'EBAY', marketplace: '', accountId: 'acc-1' })
  })

  it('"Publish failed products again" opens on the failed listing by its alias id, never a stored record id', () => {
    expect(retryPublishScope({ channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1', aliasKey: 'alias-1', listingId: 'cl-alt1-root' }))
      .toEqual({ channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1', listingId: 'alias-1' })
    expect(retryPublishScope({ channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1', aliasKey: '', listingId: 'cl-main' }))
      .toEqual({ channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1' })
  })
})

describe('the names', () => {
  it('marks and names a listing as the sheet\'s band does', () => {
    expect(aliasMarkText(0, null)).toBe('★ Main listing')
    expect(aliasMarkText(1, 'ALT1')).toBe('① ALT1')
    expect(aliasMarkText(2, '  ')).toBe('② Listing alias 2')
    expect(aliasName(4, null)).toBe('Listing alias 4')
  })

  it('the mark is spoken only when it adds to the name beside it ("Main listing" is read once)', () => {
    expect(aliasMarkSpoken(0, 'Main listing')).toBe(false)
    expect(aliasMarkSpoken(0, null)).toBe(false)
    expect(aliasMarkSpoken(2, '')).toBe(false)
    expect(aliasMarkSpoken(1, 'ALT1')).toBe(true)
  })
})
