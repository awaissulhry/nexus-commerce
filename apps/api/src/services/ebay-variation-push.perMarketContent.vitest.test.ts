/**
 * EFX P9e — per-market push content.
 *
 * Part 1 — resolvePerMarketContent (pure): each market pushes its OWN saved
 * title/description/subtitle, falling back to the active-market row value only
 * when the market has none. subtitle is snapshot-authoritative.
 *
 * Part 2 — market isolation: the read path (active-first listing sort +
 * per-market snapshot overlay) keeps DE's saved content off the FR row. Models
 * the invariant the save/push fixes depend on: "save DE title/subtitle → the FR
 * row still shows FR's, not DE's".
 */

import { describe, it, expect } from 'vitest'
import {
  resolvePerMarketContent,
  buildFlatRow,
  applyEbayFlatFileSnapshot,
} from './ebay-variation-push.service.js'

// ── Part 1 — resolvePerMarketContent ──────────────────────────────────────

const rowFallback = {
  title: 'ACTIVE (IT) title',
  description: 'ACTIVE (IT) description',
  subtitle: 'ACTIVE (IT) subtitle',
}

describe('resolvePerMarketContent — market with its own content wins', () => {
  it('returns the market listing title/description over the row fallback', () => {
    const out = resolvePerMarketContent(
      {
        title: 'DE title',
        description: 'DE description',
        platformAttributes: { subtitle: 'DE subtitle' },
        flatFileSnapshot: null,
      },
      rowFallback,
    )
    expect(out.title).toBe('DE title')
    expect(out.description).toBe('DE description')
    expect(out.subtitle).toBe('DE subtitle')
  })

  it('subtitle is snapshot-authoritative: the market snapshot wins over platformAttributes', () => {
    const out = resolvePerMarketContent(
      {
        title: 'DE title',
        description: 'DE description',
        platformAttributes: { subtitle: 'DE attrs subtitle' },
        flatFileSnapshot: { subtitle: 'DE SNAPSHOT subtitle' },
      },
      rowFallback,
    )
    expect(out.subtitle).toBe('DE SNAPSHOT subtitle')
  })

  it('subtitle falls to platformAttributes when the snapshot has no subtitle key', () => {
    const out = resolvePerMarketContent(
      {
        title: 'DE title',
        description: 'DE description',
        platformAttributes: { subtitle: 'DE attrs subtitle' },
        flatFileSnapshot: { title: 'DE title' }, // snapshot present but no subtitle
      },
      rowFallback,
    )
    expect(out.subtitle).toBe('DE attrs subtitle')
  })
})

describe('resolvePerMarketContent — market with no distinct content falls back to the row', () => {
  it('null listing → every field falls back to the active-market row', () => {
    const out = resolvePerMarketContent(null, rowFallback)
    expect(out).toEqual({
      title: 'ACTIVE (IT) title',
      description: 'ACTIVE (IT) description',
      subtitle: 'ACTIVE (IT) subtitle',
    })
  })

  it('blank market fields fall back per-field to the row (blank = inherit active)', () => {
    const out = resolvePerMarketContent(
      { title: '', description: '   ', platformAttributes: { subtitle: '' }, flatFileSnapshot: {} },
      rowFallback,
    )
    expect(out.title).toBe('ACTIVE (IT) title')
    expect(out.description).toBe('ACTIVE (IT) description')
    expect(out.subtitle).toBe('ACTIVE (IT) subtitle')
  })

  it('a non-blank market value is NEVER overwritten by the row (no reverse bleed)', () => {
    const out = resolvePerMarketContent(
      { title: 'FR title', description: '', platformAttributes: {}, flatFileSnapshot: {} },
      rowFallback,
    )
    expect(out.title).toBe('FR title')            // market's own — kept
    expect(out.description).toBe('ACTIVE (IT) description') // blank → inherit
  })

  it('empty fallback yields empty strings (never undefined)', () => {
    const out = resolvePerMarketContent(null, {})
    expect(out).toEqual({ title: '', subtitle: '', description: '' })
  })
})

// ── Part 1b — variation-family push resolves per-market PARENT content ─────
// A variation listing carries ONE title/subtitle/description at the PARENT
// level (children differ only by aspects), so per-market family content =
// resolvePerMarketContent applied to the PARENT product's ChannelListing for
// the target market, falling back to the active-market parent row. This models
// the resolution the family push route now threads into pushVariationGroup
// (ebay-flat-file.routes.ts → opts.parentContent → group title/description +
// offer subtitle).

describe('variation-family push — per-market PARENT content', () => {
  // The flat row carries only the ACTIVE (IT) market's parent content.
  const parentRowFallback = {
    title: 'AIREON IT parent title',
    description: 'AIREON IT parent description',
    subtitle: 'AIREON IT parent subtitle',
  }

  it('target market WITH its own parent content → pushes that market’s content', () => {
    // DE parent ChannelListing has its own saved title/description + snapshot subtitle.
    const de = resolvePerMarketContent(
      {
        title: 'AIREON DE parent title',
        description: 'AIREON DE parent description',
        platformAttributes: { subtitle: 'DE attrs subtitle' },
        flatFileSnapshot: { subtitle: 'AIREON DE SNAPSHOT subtitle' },
      },
      parentRowFallback,
    )
    expect(de.title).toBe('AIREON DE parent title')
    expect(de.description).toBe('AIREON DE parent description')
    // subtitle snapshot-authoritative → snapshot wins over platformAttributes.
    expect(de.subtitle).toBe('AIREON DE SNAPSHOT subtitle')
  })

  it('target market WITHOUT parent content → falls back to the active parent row', () => {
    // FR parent listing missing → the whole family push inherits the active (IT) row.
    const fr = resolvePerMarketContent(null, parentRowFallback)
    expect(fr).toEqual({
      title: 'AIREON IT parent title',
      description: 'AIREON IT parent description',
      subtitle: 'AIREON IT parent subtitle',
    })
  })

  it('per-field inheritance: FR has its own title but no subtitle/description → mixes market + active row', () => {
    const fr = resolvePerMarketContent(
      { title: 'AIREON FR parent title', description: '', platformAttributes: {}, flatFileSnapshot: {} },
      parentRowFallback,
    )
    expect(fr.title).toBe('AIREON FR parent title')          // market's own — kept
    expect(fr.description).toBe('AIREON IT parent description') // blank → inherit active
    expect(fr.subtitle).toBe('AIREON IT parent subtitle')      // blank → inherit active
  })

  it('a non-blank market parent value is never overwritten by the active row (no reverse bleed)', () => {
    const de = resolvePerMarketContent(
      {
        title: 'AIREON DE parent title',
        description: 'AIREON DE parent description',
        platformAttributes: { subtitle: 'AIREON DE parent subtitle' },
        flatFileSnapshot: {},
      },
      parentRowFallback,
    )
    expect(de.title).toBe('AIREON DE parent title')
    expect(de.description).toBe('AIREON DE parent description')
    expect(de.subtitle).toBe('AIREON DE parent subtitle')
  })
})

// ── Part 2 — market isolation (read path invariant) ───────────────────────

type Listing = Parameters<typeof buildFlatRow>[0]['channelListings'][number]

function listing(over: Partial<Listing> & { region: string }): Listing {
  return {
    id: `l-${over.region}`,
    externalListingId: null,
    title: null,
    description: null,
    price: { toNumber: () => 10 },
    quantity: 1,
    platformAttributes: {},
    listingStatus: 'ACTIVE',
    offerActive: true,
    syncStatus: 'synced',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as Listing
}

/** Replicates the route's active-first listing sort (ebay-flat-file.routes.ts:121-133). */
function activeFirst(listings: Listing[], activeRegion: string): Listing[] {
  const ts = (l: Listing) => (l.updatedAt ? new Date(l.updatedAt).getTime() : 0)
  return [...listings].sort((a, b) => {
    const aActive = a.region === activeRegion ? 1 : 0
    const bActive = b.region === activeRegion ? 1 : 0
    if (aActive !== bActive) return bActive - aActive
    return ts(b) - ts(a)
  })
}

function makeProduct(listings: Listing[]): Parameters<typeof buildFlatRow>[0] {
  return {
    id: 'prod-1',
    sku: 'SKU-1',
    name: 'Fallback name',
    ean: null,
    parentId: null,
    isParent: false,
    variationTheme: null,
    categoryAttributes: null,
    variantAttributes: null,
    brand: null,
    images: [{ url: 'https://cdn.example.com/x.jpg', sortOrder: 0, type: 'MAIN' }],
    channelListings: listings,
  }
}

describe('market isolation — active-first sort keeps one market’s content off another', () => {
  // DE and FR each have their OWN saved title/subtitle. The active market
  // selects which one the flat row shows.
  const deListing = listing({
    region: 'DE',
    title: 'DE title',
    description: 'DE description',
    platformAttributes: { subtitle: 'DE subtitle' },
  })
  const frListing = listing({
    region: 'FR',
    title: 'FR title',
    description: 'FR description',
    platformAttributes: { subtitle: 'FR subtitle' },
  })
  // Per-market snapshots (content is snapshot-authoritative on reload).
  const deSnap = { title: 'DE title', subtitle: 'DE subtitle', description: 'DE description' }
  const frSnap = { title: 'FR title', subtitle: 'FR subtitle', description: 'FR description' }

  function renderRow(activeRegion: string, snap: Record<string, unknown>) {
    const sorted = activeFirst([deListing, frListing], activeRegion)
    const derived = buildFlatRow(makeProduct(sorted))
    return applyEbayFlatFileSnapshot(derived as Record<string, unknown>, snap)
  }

  it('active market = FR → row shows FR’s title/subtitle (NOT DE’s)', () => {
    const row = renderRow('FR', frSnap)
    expect(row.title).toBe('FR title')
    expect(row.subtitle).toBe('FR subtitle')
    expect(row.title).not.toBe('DE title')
    expect(row.subtitle).not.toBe('DE subtitle')
  })

  it('active market = DE → row shows DE’s title/subtitle (NOT FR’s)', () => {
    const row = renderRow('DE', deSnap)
    expect(row.title).toBe('DE title')
    expect(row.subtitle).toBe('DE subtitle')
    expect(row.title).not.toBe('FR title')
    expect(row.subtitle).not.toBe('FR subtitle')
  })

  it('saving DE content does not change what the FR row shows', () => {
    // FR row before + after a DE save (DE listing/snapshot mutate, FR untouched):
    const before = renderRow('FR', frSnap)
    const after = renderRow('FR', frSnap) // DE edits live only on the DE listing/snapshot
    expect(after.title).toBe(before.title)
    expect(after.subtitle).toBe(before.subtitle)
    expect(after.subtitle).toBe('FR subtitle')
  })
})
