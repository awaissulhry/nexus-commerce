/**
 * VT.1 - `resolveVariationProjection`: the three tiers, the four derivation outcomes, and every coordinate fact
 * measured on 2026-09-13.
 *
 * The Amazon arms run against the REAL cached OUTERWEAR enum (`__fixtures__/outerwear-theme-schema.ts`); the eBay
 * arms against the LIVE aspect readings taken in Phase 0 (IT category 177104: Taglia / Colore / Scollatura; DE
 * category 177117: Groesse / Farbe / ...). The listing rows are the real ones: GALE-JACKET holds
 * `variationTheme = "SIZE/COLOR"` on its Amazon-DE child, `""` on Amazon-IT, `"Color,Size"` on its eBay-IT parent,
 * and item 257584954808 / ASIN B0F7J163XJ are LIVE.
 */

import { describe, expect, it } from 'vitest'
import { parseThemeAxes } from '../ebay-theme-axes.js'
import { limitsFor, vocabularyFor } from './family-projection-limits.js'
import { OUTERWEAR_DE, OUTERWEAR_IT } from './__fixtures__/outerwear-theme-schema.js'
import type { ThemeSchemaFacts } from './variation-theme-segments.js'
import {
  childVariationCell,
  foldAvailability,
  variationLockFor,
  variationReadinessItems,
  collisionsFor,
  ebayAxisSet,
  isLiveCoordinate,
  resolveVariationProjection,
  separatorFor,
  splitSetString,
  VT_COPY,
  type ResolveVariationInput,
  type VariationListingFacts,
} from './variation-rules.service.js'

const factsFor = (fixture: typeof OUTERWEAR_IT | typeof OUTERWEAR_DE): ThemeSchemaFacts => ({
  properties: fixture.properties as Record<string, { title?: unknown }>,
  themes: [...fixture.themes],
  deprecated: [...fixture.deprecated],
})

/** GALE-JACKET as it stands on the local database: two axes, 20 children, `Product.version` 59. */
const GALE = {
  familyAxes: ['Colore', 'Taglia'],
  axisLabels: { color: 'Color', size: 'Size' },
  productVersion: 59,
  productTheme: 'Colore,Taglia',
  childIds: Array.from({ length: 20 }, (_, i) => `child-${i}`),
}

/** The LIVE eBay-IT reading: 20 aspects, 3 variation-enabled. */
const EBAY_IT_ASPECTS = [
  { name: 'Marca', englishName: 'Brand', variantEligible: false, required: true },
  { name: 'Taglia', englishName: 'Size', variantEligible: true, required: false },
  { name: 'Colore', englishName: 'Color', variantEligible: true, required: false },
  { name: 'Scollatura', englishName: null, variantEligible: true, required: false },
]
/** The LIVE eBay-DE reading on category 177117: 30 aspects, 6 variation-enabled. */
const EBAY_DE_ASPECTS = [
  { name: 'Marke', englishName: 'Brand', variantEligible: false, required: true },
  { name: 'Größe', englishName: 'Size', variantEligible: true, required: true },
  { name: 'Farbe', englishName: 'Color', variantEligible: true, required: false },
  { name: 'Verschluss', englishName: 'Closure', variantEligible: true, required: false },
]

function input(over: Partial<ResolveVariationInput> & { channel: string | null; market: string }): ResolveVariationInput {
  const channel = over.channel
  return {
    coordinate: {
      channel,
      market: over.market,
      accountId: null,
      aliasKey: '',
      label: channel === null ? 'Master' : `${channel} · ${over.market}`,
      ...(over.coordinate ?? {}),
    },
    family: { ...GALE, ...(over.family ?? {}) },
    listing: over.listing ?? null,
    rule: over.rule ?? null,
    schema: over.schema ?? {},
    limits: over.limits ?? limitsFor(channel ?? 'MASTER', channel === 'AMAZON' ? [...OUTERWEAR_IT.themes] : []),
    vocabulary: over.vocabulary ?? vocabularyFor(channel ?? 'MASTER'),
  }
}

const listing = (over: Partial<VariationListingFacts> = {}): VariationListingFacts => ({
  version: 13,
  variationTheme: null,
  variationMapping: null,
  platformAttributes: null,
  externalListingId: null,
  listingStatus: 'DRAFT',
  ...over,
})

// ------------------------------------------------------------------
describe('MASTER - the structure itself', () => {
  it('serves the family axes with their English labels and the axes PATCH, with childIds', () => {
    const cell = resolveVariationProjection(input({ channel: null, market: 'IT' }))
    expect(cell.axes.map((a) => a.axisKey)).toEqual(['color', 'size'])
    expect(cell.axes.map((a) => a.label)).toEqual(['Color', 'Size'])
    expect(cell.axes.map((a) => a.channelName).join(cell.separator)).toBe('Color · Size')
    expect(cell.theme).toBeNull()
    expect(cell.candidates).toBeNull()
    expect(cell.source).toMatchObject({ kind: 'derived', label: VT_COPY.derived })
    expect(cell.write).toMatchObject({ endpoint: 'variation-axes', expectedVersion: 59, aliasKey: '' })
    expect(cell.write!.childIds).toHaveLength(20)
    expect(cell.locked).toBeNull()
  })

  it('a family with NO axes reads `Set axes…`, and still offers the write', () => {
    const cell = resolveVariationProjection(input({ channel: null, market: 'IT', family: { ...GALE, familyAxes: [] } }))
    expect(cell.source.kind).toBe('none')
    expect(cell.source.label).toBe('Set axes…')
    expect(cell.axes).toEqual([])
    expect(cell.writable).toBe(true)
  })

  it('the xracing shape - a 3-axis theme string on Product but variationAxes [] - reads `Set axes…`', () => {
    const cell = resolveVariationProjection(input({
      channel: null, market: 'IT',
      family: { ...GALE, familyAxes: [], productTheme: 'Fit Type / Size Name / Color Name', childIds: Array.from({ length: 49 }, (_, i) => `x-${i}`) },
    }))
    expect(cell.source.label).toBe('Set axes…')
    expect(cell.axes).toEqual([])
  })
})

// ------------------------------------------------------------------
describe('AMAZON - the three tiers, in order', () => {
  const amazonIT = { amazon: { facts: factsFor(OUTERWEAR_IT), fetchedAt: OUTERWEAR_IT.fetchedAt } }
  const amazonDE = { amazon: { facts: factsFor(OUTERWEAR_DE), fetchedAt: OUTERWEAR_DE.fetchedAt } }

  it('DERIVED on DE: the bare form wins by the deprecation marker, labelled from the bound titles', () => {
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'DE', schema: amazonDE,
      listing: listing({ version: 13, externalListingId: 'B0D8XBXM5H', listingStatus: 'ACTIVE' }),
      limits: limitsFor('AMAZON', [...OUTERWEAR_DE.themes]),
    }))
    expect(cell.source).toMatchObject({ kind: 'derived', label: VT_COPY.derived, tieBreak: 'only-live' })
    expect(cell.theme).toEqual({ code: 'COLOR/SIZE', label: 'Farbe / Größe', deprecated: false })
    expect(cell.axes.map((a) => a.target)).toEqual(['color', 'size'])
    expect(cell.axes.map((a) => a.segment)).toEqual(['COLOR', 'SIZE'])
    expect(cell.axes.every((a) => !a.unbound)).toBe(true)
    expect(cell.dropped).toEqual([])
    expect(cell.candidates!.limit).toBe(4)
    expect(cell.candidates!.schemaFetchedAt).toBe(OUTERWEAR_DE.fetchedAt)
    expect(cell.candidates!.state).toBe('ok')
    expect(cell.candidates!.items).toHaveLength(50)
    expect(cell.separator).toBe(' / ')
  })

  it('DERIVED on IT gives the SAME code and the IT titles - names follow the market (the Owner\'s ALWAYS)', () => {
    const cell = resolveVariationProjection(input({ channel: 'AMAZON', market: 'IT', schema: amazonIT, listing: listing({ version: 87 }) }))
    expect(cell.theme).toEqual({ code: 'COLOR/SIZE', label: 'Colore / Taglia', deprecated: false })
    expect(cell.axes.map((a) => a.channelName)).toEqual(['Colore', 'Taglia'])
  })

  it("OVERRIDE: a stored theme WINS over the derivation and keeps its spelling, even the deprecated one", () => {
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'DE', schema: amazonDE,
      listing: listing({ variationTheme: 'SIZE_NAME/COLOR_NAME', externalListingId: 'B0D8XBXM5H', listingStatus: 'ACTIVE' }),
    }))
    expect(cell.source).toMatchObject({ kind: 'override', label: VT_COPY.override, tieBreak: 'kept-from-listing' })
    expect(cell.theme).toEqual({ code: 'SIZE_NAME/COLOR_NAME', label: 'Größe / Farbe', deprecated: true })
    expect(cell.axes.map((a) => a.axisKey)).toEqual(['size', 'color'])
    expect(cell.axes.map((a) => a.target)).toEqual(['size', 'color'])
  })

  it("T16: `''` on a LIVE row is NOT an override - it falls through to the derivation", () => {
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'IT', schema: amazonIT,
      listing: listing({ variationTheme: '', version: 87, externalListingId: 'B0F7J163XJ', listingStatus: 'ACTIVE' }),
    }))
    expect(cell.source.kind).toBe('derived')
    expect(cell.theme!.code).toBe('COLOR/SIZE')
    // the positive control in the same run: a real stored value on the identical input DOES override
    const overridden = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'IT', schema: amazonIT,
      listing: listing({ variationTheme: 'SIZE/COLOR', version: 87, externalListingId: 'B0F7J163XJ', listingStatus: 'ACTIVE' }),
    }))
    expect(overridden.source.kind).toBe('override')
  })

  it('RULE: a category rule wins over the derivation and names itself', () => {
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'IT', schema: amazonIT, listing: listing({ version: 87 }),
      rule: { label: 'Apparel default', category: 'OUTERWEAR', theme: 'SIZE/COLOR' },
    }))
    expect(cell.source).toMatchObject({ kind: 'rule', ruleLabel: 'Apparel default', category: 'OUTERWEAR' })
    expect(cell.source.label).toBe('Follows rule Apparel default')
    expect(cell.theme!.code).toBe('SIZE/COLOR')
  })

  it('NONE: no theme covers the axes - `Choose a theme`, every axis unbound, nothing dropped', () => {
    const facts: ThemeSchemaFacts = { properties: { color: { title: 'Colore' } }, themes: ['SIZE', 'COLOR'], deprecated: [] }
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'IT', schema: { amazon: { facts, fetchedAt: null } },
      listing: listing({ version: 87 }), limits: limitsFor('AMAZON', ['SIZE', 'COLOR']),
    }))
    expect(cell.source).toMatchObject({ kind: 'none', label: 'Choose a theme' })
    expect(cell.theme).toBeNull()
    expect(cell.axes.every((a) => !!a.unbound)).toBe(true)
    expect(cell.axes[0].unbound!.reason).toBe(VT_COPY.noThemeCovers)
  })

  it('the derivation NEVER drops an axis by itself: a 3-axis family with only 2-segment themes reads `Choose a theme`', () => {
    const facts: ThemeSchemaFacts = {
      properties: { color: { title: 'Colore' }, size: { title: 'Taglia' }, style: { title: 'Stile' } },
      themes: ['COLOR/SIZE', 'SIZE/COLOR'], deprecated: [],
    }
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'IT',
      family: { ...GALE, familyAxes: ['Colore', 'Taglia', 'Style'], axisLabels: { color: 'Color', size: 'Size', style: 'Style' } },
      schema: { amazon: { facts, fetchedAt: null } }, listing: listing({ version: 87 }),
      limits: limitsFor('AMAZON', ['COLOR/SIZE', 'SIZE/COLOR']),
    }))
    expect(cell.source).toMatchObject({ kind: 'none', label: 'Choose a theme' })
    expect(cell.theme).toBeNull()
    // dropping an axis must be a DELIBERATE choice, so the candidate list is where the 2-segment themes appear,
    // each naming what it would drop
    expect(cell.candidates!.items.find((i) => i.code === 'COLOR/SIZE')!.drops).toEqual(['style'])
    expect(cell.candidates!.items.every((i) => !i.coversAll)).toBe(true)
  })

  it('a CHOSEN (overriding) theme that drops an axis names the drop, and the axis is not delivered', () => {
    const facts: ThemeSchemaFacts = {
      properties: { color: { title: 'Colore' }, size: { title: 'Taglia' }, style: { title: 'Stile' } },
      themes: ['COLOR/SIZE'], deprecated: [],
    }
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'IT',
      family: { ...GALE, familyAxes: ['Colore', 'Taglia', 'Style'], axisLabels: { color: 'Color', size: 'Size', style: 'Style' } },
      schema: { amazon: { facts, fetchedAt: null } },
      listing: listing({ version: 87, variationTheme: 'COLOR/SIZE' }),
      limits: limitsFor('AMAZON', ['COLOR/SIZE']),
    }))
    expect(cell.source.kind).toBe('override')
    expect(cell.theme!.code).toBe('COLOR/SIZE')
    expect(cell.dropped).toEqual(['style'])
    expect(cell.axes.find((a) => a.axisKey === 'style')!.included).toBe(false)
  })

  it('an unbound SEGMENT is reported, never turned into `${axis}_name` (T15)', () => {
    const facts: ThemeSchemaFacts = { properties: { color: { title: 'Colore' } }, themes: ['COLOR/MADE_UP_XYZ'], deprecated: [] }
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'IT',
      family: { ...GALE, familyAxes: ['Colore', 'MADE_UP_XYZ'], axisLabels: { color: 'Color' } },
      schema: { amazon: { facts, fetchedAt: null } }, listing: listing({ version: 87 }),
      limits: limitsFor('AMAZON', ['COLOR/MADE_UP_XYZ']),
    }))
    const unbound = cell.axes.filter((a) => !!a.unbound)
    expect(unbound).toHaveLength(1)
    expect(unbound[0].segment).toBe('MADE_UP_XYZ')
    expect(unbound[0].target).toBeNull()
    expect(unbound[0].unbound!.reason).toBe('MADE_UP_XYZ binds to no attribute of this product type.')
  })

  it('NO cached schema is `unavailable` with a reason, not an empty list that reads as "none offered"', () => {
    const cell = resolveVariationProjection(input({ channel: 'AMAZON', market: 'BE', schema: {}, listing: listing({ version: 1 }) }))
    expect(cell.candidates!.state).toBe('unavailable')
    expect(cell.candidates!.unavailableReason).toBe(VT_COPY.schemaUnavailable)
    expect(cell.candidates!.items).toEqual([])
  })

  it('LIVE on Amazon locks the cell with the Appendix A sentence and `new-parent`', () => {
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'DE', schema: amazonDE,
      listing: listing({ externalListingId: 'B0D8XBXM5H', listingStatus: 'ACTIVE' }),
    }))
    expect(cell.locked).toEqual({
      reason: 'Live on Amazon DE (B0D8XBXM5H) — changing the theme creates a new parent and relinks 20 children. Commit opens the plan.',
      externalId: 'B0D8XBXM5H',
      setChangeIs: 'new-parent',
      orderChangeAllowed: false,
      /* VT.F item A5 — the CELL now serves the per-axis lock too, so the dock and the sheet cannot give two
         answers for one live listing. `[]` here is the MEASURED empty: this fixture's `platformAttributes`
         carry no `__lastPublishedAxes`, which is "this coordinate has published nothing under that
         marketplace id" — and the arm below proves the non-empty case, so `[]` cannot pass for both. */
      lockedAxisKeys: [],
    })
  })

  it('NO listing on the coordinate: no write, and the reason says so', () => {
    const cell = resolveVariationProjection(input({ channel: 'AMAZON', market: 'NL', schema: amazonIT, listing: null }))
    expect(cell.write).toBeNull()
    expect(cell.writable).toBe(false)
    expect(cell.writeBlockedReason).toBe('This family has no Amazon listing on NL, so there is nothing to project yet.')
  })
})

// ------------------------------------------------------------------
describe('eBay - the precedence flip and the site aspects', () => {
  const itSchema = { ebay: { categoryId: '177104', aspects: EBAY_IT_ASPECTS, unavailableReason: null } }

  it('the coordinate `_variationAxes` WINS over Product.variationTheme when non-empty (VX D1)', () => {
    expect(ebayAxisSet(listing({ platformAttributes: { _variationAxes: ['Taglia', 'Colore'] } }), 'Colore,Taglia'))
      .toEqual({ names: ['Taglia', 'Colore'], from: 'coordinate' })
  })

  it('an EMPTY `_variationAxes` falls back to the product theme - today\'s behaviour, unchanged', () => {
    expect(ebayAxisSet(listing({ platformAttributes: { _variationAxes: [] } }), 'Colore,Taglia'))
      .toEqual({ names: ['Colore', 'Taglia'], from: 'product' })
    expect(ebayAxisSet(listing({ platformAttributes: {} }), 'Colore,Taglia').from).toBe('product')
    expect(ebayAxisSet(null, null)).toEqual({ names: [], from: 'none' })
  })

  it('splitSetString is byte-identical to parseThemeAxes on every shape the catalogue stores', () => {
    const cases = [
      'Colore,Taglia', 'Color,Size', 'Fit Type / Size Name / Color Name', 'Size / Color', 'Color / Size',
      'a;b|c,d/e', ' Colore , Colore ', '', 'one,two,three,four,five,six', null, undefined,
    ]
    for (const c of cases) expect(splitSetString(c as string), String(c)).toEqual(parseThemeAxes(c))
    // the positive control: the two DO produce a non-empty answer for a real value
    expect(splitSetString('Colore,Taglia')).toEqual(['Colore', 'Taglia'])
  })

  it('IT: the delivered names are the site aspects, and the stored set makes it an override', () => {
    const cell = resolveVariationProjection(input({
      channel: 'EBAY', market: 'IT', schema: itSchema,
      listing: listing({ version: 18, externalListingId: '257584954808', listingStatus: 'ACTIVE', platformAttributes: { _variationAxes: ['Color', 'Size'] } }),
    }))
    expect(cell.source).toMatchObject({ kind: 'override', label: VT_COPY.override })
    expect(cell.axes.map((a) => a.channelName)).toEqual(['Colore', 'Taglia'])
    expect(cell.axes.map((a) => a.target)).toEqual(['Colore', 'Taglia'])
    expect(cell.axes.map((a) => a.channelName).join(cell.separator)).toBe('Colore · Taglia')
    expect(cell.candidates!.items.map((i) => i.code)).toEqual(['Taglia', 'Colore', 'Scollatura'])
    expect(cell.candidates!.limit).toBe(5)
    expect(cell.locked).toEqual({
      reason: 'Live on eBay IT (item 257584954808) — changing the set relists it. Reordering does not.',
      externalId: '257584954808', setChangeIs: 'relist', orderChangeAllowed: true, lockedAxisKeys: [],
    })
  })

  it('DE: the same axes deliver the DE aspect names, and `Größe` is required there but `Taglia` is not', () => {
    const cell = resolveVariationProjection(input({
      channel: 'EBAY', market: 'DE',
      schema: { ebay: { categoryId: '177117', aspects: EBAY_DE_ASPECTS, unavailableReason: null } },
      listing: listing({ version: 7 }),
    }))
    expect(cell.axes.map((a) => a.channelName)).toEqual(['Farbe', 'Größe'])
    const size = cell.candidates!.items.find((i) => i.code === 'Größe')!
    expect(size.required).toBe(true)
    const itCell = resolveVariationProjection(input({ channel: 'EBAY', market: 'IT', schema: itSchema, listing: listing({ version: 18 }) }))
    expect(itCell.candidates!.items.find((i) => i.code === 'Taglia')!.required).toBe(false)
  })

  it('NO category on the coordinate is `unavailable` with the measured reason, and every axis is unbound', () => {
    const cell = resolveVariationProjection(input({
      channel: 'EBAY', market: 'DE',
      schema: { ebay: { categoryId: null, aspects: [], unavailableReason: null } },
      listing: listing({ version: 7 }),
    }))
    expect(cell.candidates!.state).toBe('unavailable')
    expect(cell.candidates!.unavailableReason).toBe('This eBay DE listing has no category yet, so its variation specifics cannot be read.')
    expect(cell.axes.every((a) => !!a.unbound)).toBe(true)
    expect(cell.axes.every((a) => a.target === null)).toBe(true)
  })

  it('an axis IN the set with no ELIGIBLE aspect is a custom specific, outside the filters', () => {
    const cell = resolveVariationProjection(input({
      channel: 'EBAY', market: 'IT', schema: itSchema,
      listing: listing({ version: 18, platformAttributes: { _variationAxes: ['Colore', 'Taglia', 'Materiale'] } }),
      family: { ...GALE, familyAxes: ['Colore', 'Taglia', 'Materiale'], axisLabels: { color: 'Color', size: 'Size', materiale: 'Material' } },
    }))
    const material = cell.axes.find((a) => a.axisKey === 'materiale')!
    expect(material.unbound!.reason).toBe(VT_COPY.notASiteAspect)
    expect(material.target).toBeNull()
    // and the control: the two axes that ARE aspects are bound in the same call
    expect(cell.axes.filter((a) => !a.unbound).map((a) => a.channelName)).toEqual(['Colore', 'Taglia'])
  })

  it('an axis the family has but the stored SET omits is DROPPED, not unbound - two different sentences', () => {
    const cell = resolveVariationProjection(input({
      channel: 'EBAY', market: 'IT', schema: itSchema, listing: listing({ version: 18 }),
      family: { ...GALE, familyAxes: ['Colore', 'Taglia', 'Materiale'], axisLabels: { color: 'Color', size: 'Size', materiale: 'Material' } },
    }))
    const material = cell.axes.find((a) => a.axisKey === 'materiale')!
    expect(material.included).toBe(false)
    expect(material.unbound).toBeUndefined()
    expect(cell.dropped).toEqual(['materiale'])
  })

  it('an axis the stored set omits is DROPPED by name', () => {
    const cell = resolveVariationProjection(input({
      channel: 'EBAY', market: 'IT', schema: itSchema,
      listing: listing({ version: 18, platformAttributes: { _variationAxes: ['Colore'] } }),
    }))
    expect(cell.dropped).toEqual(['size'])
    expect(cell.axes.find((a) => a.axisKey === 'size')!.included).toBe(false)
  })
})

// ------------------------------------------------------------------
describe('Shopify and Etsy - named axes', () => {
  it('Shopify is freeform, three options, and the English label is the option name', () => {
    const cell = resolveVariationProjection(input({ channel: 'SHOPIFY', market: 'GLOBAL', listing: listing({ version: 4 }) }))
    expect(cell.candidates).toMatchObject({ kind: 'free', state: 'freeform', limit: 3 })
    expect(cell.axes.map((a) => a.channelName)).toEqual(['Color', 'Size'])
    expect(cell.source.kind).toBe('derived')
    expect(cell.separator).toBe(' · ')
  })

  it('a stored Shopify mapping is an override and its names are delivered verbatim', () => {
    const cell = resolveVariationProjection(input({
      channel: 'SHOPIFY', market: 'GLOBAL',
      listing: listing({ version: 4, variationMapping: { Colore: 'Color', Taglia: 'Fit' } }),
    }))
    expect(cell.source.kind).toBe('override')
    expect(cell.axes.map((a) => a.channelName)).toEqual(['Color', 'Fit'])
  })

  it("Etsy's limit of 2 drops the third axis and the collision rule then fires", () => {
    const three = {
      ...GALE,
      familyAxes: ['Colore', 'Taglia', 'Style'],
      axisLabels: { color: 'Color', size: 'Size', style: 'Style' },
      variants: [
        { id: 'a', sku: 'A-NERO-M-SLIM', included: true, axisValues: { Colore: 'Nero', Taglia: 'M', Style: 'Slim' } },
        { id: 'b', sku: 'B-NERO-M-REG', included: true, axisValues: { Colore: 'Nero', Taglia: 'M', Style: 'Regular' } },
        { id: 'c', sku: 'C-NERO-L-SLIM', included: true, axisValues: { Colore: 'Nero', Taglia: 'L', Style: 'Slim' } },
        { id: 'd', sku: 'D-EXCLUDED', included: false, axisValues: { Colore: 'Nero', Taglia: 'L', Style: 'Regular' } },
      ],
    }
    const cell = resolveVariationProjection(input({ channel: 'ETSY', market: 'GLOBAL', family: three, listing: listing({ version: 1 }) }))
    expect(cell.candidates!.limit).toBe(2)
    expect(cell.dropped).toEqual(['style'])
    expect(cell.collisions).toEqual({
      unresolved: 2,
      summary: '2 variants cannot be told apart on ETSY · GLOBAL after Style is dropped.',
    })
  })
})

// ------------------------------------------------------------------
describe('the collision rule - not computed is not zero', () => {
  it('returns null when no variants were passed, and 0 when nothing is dropped', () => {
    const noVariants = resolveVariationProjection(input({ channel: 'SHOPIFY', market: 'GLOBAL', listing: listing({ version: 4 }) }))
    expect(noVariants.collisions).toBeNull()
    const withVariants = resolveVariationProjection(input({
      channel: 'SHOPIFY', market: 'GLOBAL', listing: listing({ version: 4 }),
      family: { ...GALE, variants: [{ id: 'a', sku: 'A', included: true, axisValues: { Colore: 'Nero', Taglia: 'M' } }] },
    }))
    expect(withVariants.collisions).toEqual({ unresolved: 0, summary: '0 collisions on this coordinate' })
  })

  it('counts only INCLUDED variants', () => {
    const cell = resolveVariationProjection(input({
      channel: 'ETSY', market: 'GLOBAL', listing: listing({ version: 1 }),
      family: {
        ...GALE, familyAxes: ['Colore', 'Taglia', 'Style'], axisLabels: { color: 'Color', size: 'Size', style: 'Style' },
        variants: [
          { id: 'a', sku: 'A', included: true, axisValues: { Colore: 'Nero', Taglia: 'M', Style: 'Slim' } },
          { id: 'b', sku: 'B', included: false, axisValues: { Colore: 'Nero', Taglia: 'M', Style: 'Regular' } },
        ],
      },
    }))
    expect(cell.collisions!.unresolved).toBe(0)
  })

  it('collisionsFor is exported so the write path uses the SAME function the read reports', () => {
    const i = input({
      channel: 'ETSY', market: 'GLOBAL', listing: listing({ version: 1 }),
      family: {
        ...GALE, familyAxes: ['Colore', 'Taglia', 'Style'], axisLabels: { color: 'Color', size: 'Size', style: 'Style' },
        variants: [
          { id: 'a', sku: 'A', included: true, axisValues: { Colore: 'Nero', Taglia: 'M', Style: 'Slim' } },
          { id: 'b', sku: 'B', included: true, axisValues: { Colore: 'Nero', Taglia: 'M', Style: 'Regular' } },
        ],
      },
    })
    const cell = resolveVariationProjection(i)
    expect(collisionsFor(cell, i)).toEqual(cell.collisions)
  })
})

// ------------------------------------------------------------------
describe('small rules with a single home', () => {
  it('isLiveCoordinate needs a published id AND a live status', () => {
    expect(isLiveCoordinate(null)).toBe(false)
    expect(isLiveCoordinate(listing({ externalListingId: null, listingStatus: 'ACTIVE' }))).toBe(false)
    expect(isLiveCoordinate(listing({ externalListingId: 'X', listingStatus: 'DRAFT' }))).toBe(false)
    expect(isLiveCoordinate(listing({ externalListingId: 'X', listingStatus: 'ENDED' }))).toBe(false)
    expect(isLiveCoordinate(listing({ externalListingId: 'X', listingStatus: 'ACTIVE' }))).toBe(true)
    expect(isLiveCoordinate(listing({ externalListingId: 'X', listingStatus: 'DISCOVERABLE' }))).toBe(true)
  })

  it('separatorFor gives Amazon a slash and everyone else a middot', () => {
    expect(separatorFor('AMAZON')).toBe(' / ')
    expect(separatorFor('EBAY')).toBe(' · ')
    expect(separatorFor(null)).toBe(' · ')
  })

  it('the child cell is a dash with `Set on the parent`', () => {
    expect(childVariationCell()).toEqual({ value: null, writable: false, writeBlockedReason: 'Set on the parent' })
  })
})

// ------------------------------------------------------------------
describe('Phase 5 — the three readiness items', () => {
  const amazonIT = { amazon: { facts: factsFor(OUTERWEAR_IT), fetchedAt: OUTERWEAR_IT.fetchedAt } }

  it('a resolved coordinate raises NOTHING', () => {
    const cell = resolveVariationProjection(input({ channel: 'AMAZON', market: 'IT', schema: amazonIT, listing: listing({ version: 87 }) }))
    expect(variationReadinessItems(cell, 'Amazon · IT')).toEqual([])
  })

  it('theme-unset is an ERROR and names the axes', () => {
    const facts: ThemeSchemaFacts = { properties: { color: { title: 'Colore' } }, themes: ['SIZE'], deprecated: [] }
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'IT', schema: { amazon: { facts, fetchedAt: null } },
      listing: listing({ version: 87 }), limits: limitsFor('AMAZON', ['SIZE']),
    }))
    const items = variationReadinessItems(cell, 'Amazon · IT')
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      kind: 'theme-unset',
      coordinate: 'Amazon · IT',
      message: "No variation theme on Amazon · IT — the family's axes match none of this product type's themes.",
      subjects: ['color', 'size'],
      severity: 'error',
    })
  })

  it('a collision is an ERROR carrying the cell\'s own summary — one number, two surfaces', () => {
    const cell = resolveVariationProjection(input({
      channel: 'ETSY', market: 'GLOBAL', listing: listing({ version: 1 }),
      family: {
        ...GALE, familyAxes: ['Colore', 'Taglia', 'Style'], axisLabels: { color: 'Color', size: 'Size', style: 'Style' },
        variants: [
          { id: 'a', sku: 'A', included: true, axisValues: { Colore: 'Nero', Taglia: 'M', Style: 'Slim' } },
          { id: 'b', sku: 'B', included: true, axisValues: { Colore: 'Nero', Taglia: 'M', Style: 'Regular' } },
        ],
      },
    }))
    const items = variationReadinessItems(cell, 'Etsy · GLOBAL')
    expect(items.filter(item => item.kind === 'collision')).toHaveLength(1)
    expect(items[0].kind).toBe('collision')
    expect(items[0].severity).toBe('error')
    expect(items[0].message).toBe(cell.collisions!.summary)
    expect(items[0].subjects).toEqual(['style'])
  })

  it('attribute-unbound blocks Amazon publishing, one per unbound axis, naming the SEGMENT', () => {
    const facts: ThemeSchemaFacts = { properties: { color: { title: 'Colore' } }, themes: ['COLOR/MADE_UP_XYZ'], deprecated: [] }
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'IT',
      family: { ...GALE, familyAxes: ['Colore', 'MADE_UP_XYZ'], axisLabels: { color: 'Color' } },
      schema: { amazon: { facts, fetchedAt: null } }, listing: listing({ version: 87 }),
      limits: limitsFor('AMAZON', ['COLOR/MADE_UP_XYZ']),
    }))
    const items = variationReadinessItems(cell, 'Amazon · IT')
    expect(items.map((i) => i.kind)).toEqual(['attribute-unbound'])
    expect(items[0].severity).toBe('error')
    expect(items[0].message).toBe('MADE_UP_XYZ on Amazon · IT binds to no attribute of this product type.')
  })

  it('an UNSET theme does not ALSO raise attribute-unbound — one fact is reported once', () => {
    const facts: ThemeSchemaFacts = { properties: {}, themes: ['SIZE'], deprecated: [] }
    const cell = resolveVariationProjection(input({
      channel: 'AMAZON', market: 'IT', schema: { amazon: { facts, fetchedAt: null } },
      listing: listing({ version: 87 }), limits: limitsFor('AMAZON', ['SIZE']),
    }))
    // The cell marks every axis unbound in this state, which is what the renderer paints...
    expect(cell.axes.every((a) => !!a.unbound)).toBe(true)
    // ...and readiness still reports ONE item, the theme.
    expect(variationReadinessItems(cell, 'Amazon · IT').map((i) => i.kind)).toEqual(['theme-unset'])
  })

  it('a null cell (a child row) raises nothing', () => {
    expect(variationReadinessItems(null, 'Amazon · IT')).toEqual([])
  })
})

// ------------------------------------------------------------------
describe('VT.1b item 2 (VT.4) — fold needs a WRITABLE target cell, not merely a surviving axis', () => {
  const child = (write: unknown, reason: string | null = null) => ({
    included: true,
    values: { color: { write, writeBlockedReason: reason } },
  })

  it('no surviving axis: fold cannot run, and says so', () => {
    expect(foldAvailability({ children: [child({ field: 'attr_color' })] }, [])).toEqual({
      available: false, foldInto: null,
      reason: 'No axis survives on this coordinate to fold the dropped value into.',
    })
  })

  it('a surviving axis with a WRITABLE cell: available, naming the axis it would fold into', () => {
    expect(foldAvailability({ children: [child({ field: 'attr_color', target: 'master' })] }, ['color'])).toEqual({
      available: true, reason: null, foldInto: 'color',
    })
  })

  it("THE ARM VT.4 MEASURED: every axis cell is `write: null`, so fold is NOT available and repeats the server's reason", () => {
    const result = foldAvailability(
      { children: [child(null, 'This coordinate has no column for Color.')], axes: [{ key: 'color', label: 'Color' }] },
      ['color'],
    )
    expect(result.available).toBe(false)
    expect(result.foldInto).toBeNull()
    expect(result.reason).toBe('Folding writes a value on each variant’s Color cell, and that cell cannot be written here: This coordinate has no column for Color.')
  })

  it('an EXCLUDED variant does not make fold available — the fold only writes included ones', () => {
    const excluded = { included: false, values: { color: { write: { field: 'attr_color' } } } }
    expect(foldAvailability({ children: [excluded] }, ['color']).available).toBe(false)
  })

  it('no projection at all answers FALSE with the reason, never a guessed true', () => {
    const result = foldAvailability(null, ['color'])
    expect(result.available).toBe(false)
    expect(result.reason).toContain('decided per coordinate')
  })
})

// ------------------------------------------------------------------
describe('VT.1b item 3 (VT.4) — ONE definition of locked', () => {
  const coordinate = { channel: 'AMAZON', market: 'IT' }
  const family = { childIds: ['a', 'b'] }

  it('variationLockFor and the CELL agree on every arm', () => {
    const arms: Array<[string, VariationListingFacts | null]> = [
      ['no listing', null],
      ['draft, no id', listing({ externalListingId: null, listingStatus: 'DRAFT' })],
      ['id but DRAFT', listing({ externalListingId: 'B0X', listingStatus: 'DRAFT' })],
      ['ENDED', listing({ externalListingId: 'B0X', listingStatus: 'ENDED' })],
      ['ACTIVE', listing({ externalListingId: 'B0X', listingStatus: 'ACTIVE' })],
      ['DISCOVERABLE', listing({ externalListingId: 'B0X', listingStatus: 'DISCOVERABLE' })],
    ]
    for (const [name, row] of arms) {
      const shared = variationLockFor({ coordinate, family, listing: row })
      const cell = resolveVariationProjection(input({
        channel: 'AMAZON', market: 'IT', listing: row,
        family: { ...GALE, childIds: family.childIds },
        schema: { amazon: { facts: factsFor(OUTERWEAR_IT), fetchedAt: null } },
      }))
      expect(shared, name).toEqual(cell.locked)
    }
  })

  it("a live AMAZON coordinate with no `__lastPublishedAxes` is LOCKED — the arm the projection used to miss", () => {
    const live = listing({ externalListingId: 'B0F7J163XJ', listingStatus: 'ACTIVE', platformAttributes: {} })
    const lock = variationLockFor({ coordinate, family, listing: live })
    expect(lock).not.toBeNull()
    expect(lock!.setChangeIs).toBe('new-parent')
    expect(lock!.orderChangeAllowed).toBe(false)
    expect(lock!.externalId).toBe('B0F7J163XJ')
  })

  it('eBay says relist and allows a reorder; Shopify says in place', () => {
    const live = listing({ externalListingId: '257584954808', listingStatus: 'ACTIVE' })
    expect(variationLockFor({ coordinate: { channel: 'EBAY', market: 'IT' }, family, listing: live })).toMatchObject({ setChangeIs: 'relist', orderChangeAllowed: true })
    expect(variationLockFor({ coordinate: { channel: 'SHOPIFY', market: 'GLOBAL' }, family, listing: live })).toMatchObject({ setChangeIs: 'in-place', orderChangeAllowed: true })
  })
})

/* ── VT.F item A5 — the sheet cell serves the two facts the dock had to itself ─────────────────────
 *
 * Before this, `locked.lockedAxisKeys` existed only on the projection read and `+ Add` on the cell offered
 * the CHANNEL's candidates as axes — so the cell rendered a live control over an axis the dock showed as
 * frozen, and adding `Scollatura` produced an axisKey the family has no values for and the PATCH answered
 * 400. One producer each, both here.
 */
describe('VT.F A5 — lockedAxisKeys and addableAxes on the SHEET cell', () => {
  const ebayIT = { ebay: { categoryId: '11450', aspects: EBAY_IT_ASPECTS, unavailableReason: null } }
  it('reads WHICH axes were published, from the store that records what went out', () => {
    const cell = resolveVariationProjection(input({
      channel: 'EBAY', market: 'IT', schema: ebayIT,
      listing: listing({
        externalListingId: '257584954808',
        listingStatus: 'ACTIVE',
        platformAttributes: { __lastPublishedAxes: { EBAY_IT: ['Colore', 'Taglia'] } },
      }),
    }))
    expect(cell.locked?.lockedAxisKeys).toEqual(['Colore', 'Taglia'])
  })

  it('🔴 and it is NEVER derived from the DECLARED set — that equals the current set by construction', () => {
    /* The false negative the eBay preflight documents for `priorPublishedAxisNames`: derive the lock from the
       declared axes and every coordinate reads fully locked, so nothing can ever be changed anywhere. */
    const cell = resolveVariationProjection(input({
      channel: 'EBAY', market: 'IT', schema: ebayIT,
      listing: listing({ externalListingId: '257584954808', listingStatus: 'ACTIVE', platformAttributes: {} }),
    }))
    expect(cell.locked).not.toBeNull()
    expect(cell.locked?.lockedAxisKeys).toEqual([])
  })

  it('addableAxes is the FAMILY axes not delivered here — never the channel aspect list', () => {
    const cell = resolveVariationProjection(input({ channel: 'EBAY', market: 'IT', schema: ebayIT }))
    /* GALE delivers both of its axes on eBay·IT, so there is nothing to add — which is exactly what the
       dock computed (`page.axes` minus the mapped ones) and what the cell used to get wrong by offering
       `Scollatura`, a site aspect that is not one of this family's axes. */
    expect(cell.addableAxes).toEqual([])
    expect(cell.candidates!.items.map((i) => i.code)).toContain('Scollatura')
  })

  it('a DROPPED axis IS addable again, because a dropped axis is one an operator may want back', () => {
    const cell = resolveVariationProjection(input({
      channel: 'EBAY', market: 'IT', schema: ebayIT,
      family: { ...GALE, familyAxes: [...GALE.familyAxes, 'Stile'] },
      limits: { axes: 2, variants: null },
    }))
    const dropped = cell.axes.filter((a) => !a.included).map((a) => a.axisKey)
    expect(dropped.length).toBeGreaterThan(0)
    for (const key of dropped) expect(cell.addableAxes.map((a) => a.axisKey)).toContain(key)
  })

  it('MASTER offers masterCandidates, not addableAxes — a different vocabulary, stated as empty not absent', () => {
    const cell = resolveVariationProjection(input({ channel: null, market: 'IT' }))
    expect(cell.addableAxes).toEqual([])
    expect(Array.isArray(cell.masterCandidates)).toBe(true)
  })
})
