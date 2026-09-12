/**
 * VP.3 — the projection rules and the derived read.
 *
 * The fixture is a slice of the CATALOGUE read's real shape (`sheet-rows.service.ts`), not a
 * hand-built convenience object: the point of `deriveFamilyProjections` is that it reads that
 * shape, so a fixture that skipped `listings` / `readiness` / `coordinates` would test a function
 * against a contract nobody serves (reference_fixture_must_be_writer_produced).
 */
import { describe, expect, it } from 'vitest'

import { projectionMeta } from '@/design-system/grid/renderers/projection'

import {
  asRowState,
  mergeAxisValues,
  parentIdentityNote,
  projectionIncluded,
  projectionState,
  type ProjectionChannel,
} from './projections'

const amazon: ProjectionChannel = { channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', connected: true, key: 'AMAZON:IT' }
const etsy: ProjectionChannel = { channel: 'ETSY', market: 'IT', label: 'Etsy · IT', connected: false, key: 'ETSY:IT' }
const ebay: ProjectionChannel = { channel: 'EBAY', market: 'IT', label: 'eBay · IT', connected: true, key: 'EBAY:IT' }

describe('projectionState — §3.3’s five states, in the design’s order', () => {
  it('says Not set up before anything else, however good the listing looks', () => {
    expect(projectionState(etsy, { included: true, published: true, state: 'live', externalId: 'x' })).toBe('not-set-up')
  })
  it('says Excluded for a connected channel the variant has no listing row on', () => {
    expect(projectionState(amazon, undefined)).toBe('excluded')
    expect(projectionState(amazon, { included: false, published: false, state: null, externalId: null })).toBe('excluded')
  })
  it('lets a readiness complaint beat Listed — a live listing with a rejected value is not fine', () => {
    expect(projectionState(amazon, { included: true, published: true, state: 'errors', externalId: 'x' })).toBe('needs-value')
    expect(projectionState(amazon, { included: true, published: true, state: 'missing', externalId: 'x' })).toBe('needs-value')
  })
  it('says Listed when published and Draft when not', () => {
    expect(projectionState(amazon, { included: true, published: true, state: 'live', externalId: 'x' })).toBe('listed')
    expect(projectionState(amazon, { included: true, published: false, state: 'ready', externalId: null })).toBe('draft')
  })
  it('produces only states the DS vocabulary recognises', () => {
    for (const p of [undefined, { included: true, published: true, state: 'live' as const, externalId: 'x' }]) {
      const meta = projectionMeta(projectionState(amazon, p))
      expect(meta.label).not.toBe(projectionState(amazon, p))
    }
  })
})

describe('projectionIncluded — the cell VALUE', () => {
  it('is null on an unconnected channel, so no checkbox is drawn', () => {
    expect(projectionIncluded(etsy, undefined)).toBeNull()
  })
  it('is a boolean on a connected one', () => {
    expect(projectionIncluded(amazon, undefined)).toBe(false)
    expect(projectionIncluded(amazon, { included: true, published: false, state: null, externalId: null })).toBe(true)
  })
})

describe('parentIdentityNote', () => {
  it('names Amazon’s family record for what it is', () => {
    expect(parentIdentityNote(amazon, 1, 'listed')).toBe('Parent ASIN')
  })
  it('counts eBay’s listings, because eBay has no parent item', () => {
    expect(parentIdentityNote(ebay, 1, 'listed')).toBe('1 listing')
    expect(parentIdentityNote(ebay, 2, 'listed')).toBe('2 listings')
  })
  it('falls back to the state’s own word, from the DS table and not from here', () => {
    const shopify: ProjectionChannel = { channel: 'SHOPIFY', market: 'GLOBAL', label: 'Shopify · GLOBAL', connected: true, key: 'SHOPIFY:GLOBAL' }
    expect(parentIdentityNote(shopify, 1, 'draft')).toBe(projectionMeta('draft').label)
  })
})

describe('asRowState', () => {
  it('keeps the five row states and refuses anything else', () => {
    expect(asRowState('errors')).toBe('errors')
    expect(asRowState('ready')).toBe('ready')
    /* A contract change must not be able to paint a green dot. */
    expect(asRowState('READY')).toBeNull()
    expect(asRowState('shipped')).toBeNull()
    expect(asRowState(undefined)).toBeNull()
  })
})

describe('mergeAxisValues — the two sources key the SAME field differently', () => {
  const axisKeys = ['Colore', 'Taglia']

  it('takes the family read, which is the source keyed by the AXIS keys', () => {
    expect(mergeAxisValues(axisKeys, { Colore: 'Nero', Taglia: 'XS' }, undefined)).toEqual({ Colore: 'Nero', Taglia: 'XS' })
  })

  it('🔴 IGNORES a sheet object keyed by COLUMN keys — the regression this function exists for', () => {
    /*
     * Measured on GALE-JACKET: `/studio/family` carries `{Colore,Taglia}`, `/studio/sheet` carries
     * `{Color,Size}` on exactly two of its twenty-one rows. A merge that preferred "whichever source
     * is non-empty" kept the sheet's object on those two, looked up `Colore` in it, found nothing,
     * and drew `—` on two variants that have values — which then sorted them last as value-less,
     * claimed 2 variants were missing axis values, and claimed 0 duplicate combinations where the
     * server reports 2 real pairs. One wrong merge, three wrong numbers, all of them plausible.
     */
    const fromSheet = { Color: 'Nero', Size: 'XS' }
    expect(mergeAxisValues(axisKeys, { Colore: 'Nero', Taglia: 'XS' }, fromSheet)).toEqual({ Colore: 'Nero', Taglia: 'XS' })
    expect(mergeAxisValues(axisKeys, undefined, fromSheet)).toEqual({})
  })

  it('falls back to the sheet under the SAME key, for a family spelled like its columns', () => {
    expect(mergeAxisValues(['color', 'size'], undefined, { color: 'Nero', size: 'XS' })).toEqual({ color: 'Nero', size: 'XS' })
  })

  it('lets the family read win per KEY, not per object', () => {
    expect(mergeAxisValues(axisKeys, { Colore: 'Nero' }, { Taglia: 'XS' })).toEqual({ Colore: 'Nero', Taglia: 'XS' })
  })

  it('drops blanks rather than carrying an empty string that reads as a value', () => {
    expect(mergeAxisValues(axisKeys, { Colore: '  ', Taglia: 'XS' }, {})).toEqual({ Taglia: 'XS' })
  })

  it('carries no key the axes did not ask for', () => {
    expect(mergeAxisValues(['Colore'], { Colore: 'Nero', Taglia: 'XS' }, undefined)).toEqual({ Colore: 'Nero' })
  })
})
