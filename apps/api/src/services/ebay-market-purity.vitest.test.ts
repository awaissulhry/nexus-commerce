/**
 * MARKET PURITY CONTRACT — what we transmit to eBay must be in the MARKET's own
 * language, never translated into another market's.
 *
 * Operator rule: the grid may show a bilingual reading aid ("Color (Colore)"),
 * but the PUSH is strictly market-pure — IT gets Italian, DE gets German, and
 * an English name must never reach an eBay payload.
 *
 * Audit finding F3: the Trading shared-listing push rebuilds every transmitted
 * aspect/axis name through the Italian-hardcoded aspectCanonicalName, so a
 * German listing is published to eBay.de with Italian aspect names.
 */
import { describe, it, expect } from 'vitest'
import { buildSharedListingInput } from './ebay-shared-listing-push.service.js'

type Row = Record<string, unknown>

const parent = (theme: string, extra: Row = {}): Row => ({
  sku: 'DE-WATERPROOF-JACKET',
  parentage: 'parent',
  title: 'Motorradjacke wasserdicht',
  description: '<p>Wasserdichte Motorradjacke</p>',
  category_id: '177104',
  condition: 'NEW',
  variation_theme: theme,
  shared_sku_listing: true,
  ...extra,
})

const variant = (sku: string, aspects: Row, price = '99', qty = '5'): Row => ({
  sku,
  parentage: 'child',
  parent_sku: 'DE-WATERPROOF-JACKET',
  price,
  quantity: qty,
  ean: 'Does not apply',
  ...aspects,
})

describe('market purity — the eBay payload speaks the market’s language', () => {
  it('IT: an Italian family transmits Italian axis names (today’s live behaviour, must not change)', () => {
    const rows = [
      variant('IT-A', { aspect_Colore: 'Nero', aspect_Taglia: 'M' }),
      variant('IT-B', { aspect_Colore: 'Giallo', aspect_Taglia: 'L' }),
    ]
    const input = buildSharedListingInput(
      parent('Colore,Taglia') as Parameters<typeof buildSharedListingInput>[0],
      rows as Parameters<typeof buildSharedListingInput>[1],
      'IT',
    )
    expect(input.variationSpecificNames.sort()).toEqual(['Colore', 'Taglia'])
  })

  it('DE: a German family must transmit GERMAN axis names — never Italian', () => {
    const rows = [
      variant('DE-A', { aspect_Farbe: 'Schwarz', aspect_Größe: 'M' }),
      variant('DE-B', { aspect_Farbe: 'Gelb', aspect_Größe: 'L' }),
    ]
    const input = buildSharedListingInput(
      parent('Farbe,Größe') as Parameters<typeof buildSharedListingInput>[0],
      rows as Parameters<typeof buildSharedListingInput>[1],
      'DE',
    )
    // The operator declared Farbe,Größe on a DE listing. eBay.de must receive
    // exactly that — translating it to Colore/Taglia publishes Italian aspect
    // names on a German listing and breaks the buyer-facing variation picker.
    expect(input.variationSpecificNames.sort()).toEqual(['Farbe', 'Größe'])
    for (const v of input.variations) {
      expect(Object.keys(v.specifics).sort()).toEqual(['Farbe', 'Größe'])
    }
  })

  it('DE: listing-level item specifics stay German too', () => {
    const rows = [
      variant('DE-A', { aspect_Farbe: 'Schwarz', aspect_Größe: 'M', aspect_Marke: 'Xavia Racing' }),
      variant('DE-B', { aspect_Farbe: 'Gelb', aspect_Größe: 'L', aspect_Marke: 'Xavia Racing' }),
    ]
    const input = buildSharedListingInput(
      parent('Farbe,Größe') as Parameters<typeof buildSharedListingInput>[0],
      rows as Parameters<typeof buildSharedListingInput>[1],
      'DE',
    )
    const keys = Object.keys(input.itemSpecifics ?? {})
    expect(keys).toContain('Marke')
    expect(keys).not.toContain('Marca')
  })

  it('NO ENGLISH may reach an eBay payload for a localized market', () => {
    const rows = [
      variant('X-A', { aspect_Color: 'Nero', aspect_Size: 'M' }),
      variant('X-B', { aspect_Color: 'Giallo', aspect_Size: 'L' }),
    ]
    const input = buildSharedListingInput(
      parent('Colore,Taglia') as Parameters<typeof buildSharedListingInput>[0],
      rows as Parameters<typeof buildSharedListingInput>[1],
      'IT',
    )
    // English column data is legacy residue; the IT payload must carry the
    // localized names the operator declared.
    expect(input.variationSpecificNames).not.toContain('Color')
    expect(input.variationSpecificNames).not.toContain('Size')
  })
})

// ── Cross-market bleed: the aspect columns must come from the market being
// viewed, not from whichever eBay listing happens to sort first. ────────────
import { buildFlatRow } from './ebay-variation-push.service.js'

const listing = (region: string, specifics: Record<string, string>) => ({
  id: `cl-${region}`, region, externalListingId: null, title: null, description: null,
  price: null, quantity: null, listingStatus: '', offerActive: false, syncStatus: '',
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  platformAttributes: { itemSpecifics: specifics },
})

describe('buildFlatRow — aspect columns follow the ACTIVE market', () => {
  const product = {
    id: 'p1', sku: 'MULTI-MARKET-SKU', name: 'x', ean: null,
    images: [],
    // DE listing sorts FIRST — the old code took listings[0] blindly.
    channelListings: [
      listing('DE', { Farbe: 'Schwarz', Größe: 'M' }),
      listing('IT', { Colore: 'Nero', Taglia: 'M' }),
    ],
  }

  it('renders the IT listing’s specifics when IT is the active market', () => {
    const row = buildFlatRow(product as unknown as Parameters<typeof buildFlatRow>[0], { marketplace: 'IT' })
    expect(row.aspect_Colore).toBe('Nero')
    expect(row.aspect_Farbe).toBeUndefined()
  })

  it('renders the DE listing’s specifics when DE is the active market', () => {
    const row = buildFlatRow(product as unknown as Parameters<typeof buildFlatRow>[0], { marketplace: 'DE' })
    expect(row.aspect_Farbe).toBe('Schwarz')
    expect(row.aspect_Colore).toBeUndefined()
  })

  it('accepts EBAY_-prefixed market codes', () => {
    const row = buildFlatRow(product as unknown as Parameters<typeof buildFlatRow>[0], { marketplace: 'EBAY_IT' })
    expect(row.aspect_Colore).toBe('Nero')
  })

  it('with NO market supplied falls back to the first listing (legacy callers unchanged)', () => {
    const row = buildFlatRow(product as unknown as Parameters<typeof buildFlatRow>[0], {})
    expect(row.aspect_Farbe).toBe('Schwarz') // listings[0] === DE
  })
})
