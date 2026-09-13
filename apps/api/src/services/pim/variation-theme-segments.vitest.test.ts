/**
 * VT.1 - the ONE theme parser and the schema-property attribute binding.
 *
 * Everything here runs against the REAL cached OUTERWEAR schema facts (`__fixtures__/outerwear-theme-schema.ts`,
 * emitted from the database, not typed), because the whole design rests on two properties of that real data:
 * the theme enum offers TWO spellings of the same relationship, and the `_NAME` spelling binds to NO attribute.
 * A hand-written enum would have let both assertions pass for the wrong reason.
 */

import { describe, expect, it } from 'vitest'
import { findEnumDeprecated } from '../amazon/flat-file.service.js'
import { OUTERWEAR_DE, OUTERWEAR_IT } from './__fixtures__/outerwear-theme-schema.js'
import {
  addsForTheme,
  attributeTitle,
  bindSegmentToAttribute,
  canonicalThemeKeys,
  canonicalThemeSegment,
  classifyThemes,
  deriveAmazonTheme,
  dropsForTheme,
  marketplaceIdFor,
  normaliseStoredTheme,
  themeSchemaFacts,
  themeSegments,
  type ThemeSchemaFacts,
} from './variation-theme-segments.js'

const factsFor = (fixture: typeof OUTERWEAR_IT | typeof OUTERWEAR_DE): ThemeSchemaFacts => ({
  properties: fixture.properties as Record<string, { title?: unknown }>,
  themes: [...fixture.themes],
  deprecated: [...fixture.deprecated],
})

describe('the fixture is the real thing (positive controls before any assertion about it)', () => {
  it('IT and DE each offer 50 theme values and mark 28 of them deprecated', () => {
    expect(OUTERWEAR_IT.themes.length).toBe(50)
    expect(OUTERWEAR_DE.themes.length).toBe(50)
    expect(OUTERWEAR_IT.deprecated.length).toBe(28)
    expect(OUTERWEAR_DE.deprecated.length).toBe(28)
  })

  it('T15: the `_NAME` spellings are NOT properties of this product type, while the bare ones are', () => {
    for (const fixture of [OUTERWEAR_IT, OUTERWEAR_DE]) {
      const names = new Set<string>(fixture.propertyNames as readonly string[])
      // the positive control - the bare attributes DO exist, so an empty-set claim below cannot be blind
      expect(names.has('color')).toBe(true)
      expect(names.has('size')).toBe(true)
      expect(names.has('style')).toBe(true)
      expect(names.has('material')).toBe(true)
      // the finding
      expect(names.has('color_name')).toBe(false)
      expect(names.has('size_name')).toBe(false)
      expect(names.has('style_name')).toBe(false)
      expect(names.has('material_type')).toBe(false)
    }
  })

  it('the enum contains BOTH spellings of colour x size, in order, on both markets (T14)', () => {
    for (const fixture of [OUTERWEAR_IT, OUTERWEAR_DE]) {
      expect(fixture.themes).toContain('COLOR/SIZE')
      expect(fixture.themes).toContain('COLOR_NAME/SIZE_NAME')
    }
  })
})

describe('canonicalThemeSegment - a segment is not an axis label', () => {
  it('strips a trailing NAME token BEFORE canonicalising', () => {
    expect(canonicalThemeSegment('COLOR_NAME')).toBe('color')
    expect(canonicalThemeSegment('SIZE_NAME')).toBe('size')
    expect(canonicalThemeSegment('COLOR')).toBe('color')
    expect(canonicalThemeSegment('SIZE')).toBe('size')
    expect(canonicalThemeSegment('STYLE_NAME')).toBe('style')
    expect(canonicalThemeSegment('FIT_TYPE')).toBe('fittype')
  })

  it('canonicalises the localized family keys the catalogue actually stores', () => {
    expect(canonicalThemeKeys('COLOR/SIZE')).toEqual(['color', 'size'])
    expect(canonicalThemeKeys('SIZE_NAME/COLOR_NAME')).toEqual(['size', 'color'])
    expect(canonicalThemeKeys('FIT_TYPE/SIZE_NAME/COLOR_NAME')).toEqual(['fittype', 'size', 'color'])
  })

  it('themeSegments drops empties and trims, and takes null', () => {
    expect(themeSegments('COLOR / SIZE')).toEqual(['COLOR', 'SIZE'])
    expect(themeSegments('COLOR//SIZE')).toEqual(['COLOR', 'SIZE'])
    expect(themeSegments(null)).toEqual([])
    expect(themeSegments('')).toEqual([])
  })
})

describe("normaliseStoredTheme - '' is not a theme (T16)", () => {
  it('turns the empty string on a live row into null', () => {
    expect(normaliseStoredTheme('')).toBeNull()
    expect(normaliseStoredTheme('   ')).toBeNull()
    expect(normaliseStoredTheme(null)).toBeNull()
    expect(normaliseStoredTheme(undefined)).toBeNull()
    expect(normaliseStoredTheme(42)).toBeNull()
  })

  it('keeps a real stored theme verbatim, including the deprecated spelling', () => {
    expect(normaliseStoredTheme('SIZE/COLOR')).toBe('SIZE/COLOR')
    expect(normaliseStoredTheme(' COLOR_NAME/SIZE_NAME ')).toBe('COLOR_NAME/SIZE_NAME')
  })
})

describe('bindSegmentToAttribute - against properties, never by convention', () => {
  const props = OUTERWEAR_IT.properties as Record<string, unknown>

  it('binds the bare spelling exactly', () => {
    expect(bindSegmentToAttribute('COLOR', props)).toEqual({ attribute: 'color', via: 'exact' })
    expect(bindSegmentToAttribute('SIZE', props)).toEqual({ attribute: 'size', via: 'exact' })
  })

  it('binds the `_NAME` spelling by dropping the suffix, because the suffixed property does not exist', () => {
    expect(bindSegmentToAttribute('COLOR_NAME', props)).toEqual({ attribute: 'color', via: 'name-suffix' })
    expect(bindSegmentToAttribute('SIZE_NAME', props)).toEqual({ attribute: 'size', via: 'name-suffix' })
    expect(bindSegmentToAttribute('STYLE_NAME', props)).toEqual({ attribute: 'style', via: 'name-suffix' })
  })

  it('binds MATERIAL_TYPE to material through the prefix rule - which steps 1-2 cannot do', () => {
    expect(bindSegmentToAttribute('MATERIAL_TYPE', props)).toEqual({ attribute: 'material', via: 'prefix' })
  })

  it('refuses to invent an attribute: a segment with no property at all is unbound', () => {
    expect(bindSegmentToAttribute('TOTALLY_MADE_UP_XYZ', props)).toBeNull()
    // and the positive control in the same test: the identical call shape DOES bind for a real segment
    expect(bindSegmentToAttribute('COLOR', props)).not.toBeNull()
  })

  it('every segment of every theme in the real enum binds, on both markets', () => {
    for (const fixture of [OUTERWEAR_IT, OUTERWEAR_DE]) {
      const unbound: string[] = []
      const seen = new Set<string>()
      for (const theme of fixture.themes) {
        for (const segment of themeSegments(theme)) {
          if (seen.has(segment)) continue
          seen.add(segment)
          if (!bindSegmentToAttribute(segment, fixture.properties as Record<string, unknown>)) unbound.push(segment)
        }
      }
      expect(seen.size).toBeGreaterThan(10)
      expect(unbound).toEqual([])
    }
  })
})

describe('attributeTitle - the label comes from the attribute, not from enumNames', () => {
  it('reads the localised title per market (the design predicted exactly these)', () => {
    expect(attributeTitle('color', OUTERWEAR_IT.properties as Record<string, unknown>)).toBe('Colore')
    expect(attributeTitle('size', OUTERWEAR_IT.properties as Record<string, unknown>)).toBe('Taglia')
    expect(attributeTitle('color', OUTERWEAR_DE.properties as Record<string, unknown>)).toBe('Farbe')
    expect(attributeTitle('size', OUTERWEAR_DE.properties as Record<string, unknown>)).toBe('Größe')
  })

  it('returns null for an attribute with no title, and for null', () => {
    expect(attributeTitle(null, OUTERWEAR_IT.properties as Record<string, unknown>)).toBeNull()
    expect(attributeTitle('no_such_attribute', OUTERWEAR_IT.properties as Record<string, unknown>)).toBeNull()
  })
})

describe('the deprecation reader is PINNED to the untouchable one', () => {
  it("themeSchemaFacts().deprecated equals flat-file.service's findEnumDeprecated on the same node", () => {
    for (const fixture of [OUTERWEAR_IT, OUTERWEAR_DE]) {
      const node = { $lifecycle: { enumDeprecated: [...fixture.deprecated] }, enum: [...fixture.themes] }
      const definition = { properties: { variation_theme: { items: { properties: { name: node } } } } }
      const mine = themeSchemaFacts(definition).deprecated
      const theirs = findEnumDeprecated(node as Record<string, unknown>)
      expect(mine).toEqual(theirs)
      expect(mine.length).toBe(28)
    }
  })

  it('themeSchemaFacts reads the enum and the properties out of a whole definition', () => {
    const definition = {
      properties: {
        color: { title: 'Colore' },
        variation_theme: { items: { properties: { name: { enum: ['COLOR/SIZE'], $lifecycle: { enumDeprecated: [] } } } } },
      },
    }
    const facts = themeSchemaFacts(definition)
    expect(facts.themes).toEqual(['COLOR/SIZE'])
    expect(facts.deprecated).toEqual([])
    expect(Object.keys(facts.properties)).toContain('color')
  })

  it('an absent theme block is an empty enum, not a throw', () => {
    expect(themeSchemaFacts({}).themes).toEqual([])
    expect(themeSchemaFacts(null).themes).toEqual([])
    expect(themeSchemaFacts(undefined).deprecated).toEqual([])
  })
})

describe('deriveAmazonTheme - the four outcome classes (D-VT8)', () => {
  it('AMBIGUOUS on the real data resolves by the DEPRECATION marker, not by a preference', () => {
    for (const [market, fixture] of [['IT', OUTERWEAR_IT], ['DE', OUTERWEAR_DE]] as const) {
      const facts = factsFor(fixture)
      const both = classifyThemes(facts).filter((t) => t.keys.join('/') === 'color/size')
      expect(both.map((t) => t.code).sort()).toEqual(['COLOR/SIZE', 'COLOR_NAME/SIZE_NAME'])
      const result = deriveAmazonTheme(['color', 'size'], facts)
      expect(result, market).not.toBeNull()
      expect(result!.match.code, market).toBe('COLOR/SIZE')
      expect(result!.tieBreak, market).toBe('only-live')
      expect(result!.match.deprecated).toBe(false)
    }
  })

  it('UNIQUE: one in-order match gives only-match', () => {
    const facts: ThemeSchemaFacts = { properties: { color: {}, size: {} }, themes: ['COLOR/SIZE'], deprecated: [] }
    const result = deriveAmazonTheme(['color', 'size'], facts)
    expect(result!.match.code).toBe('COLOR/SIZE')
    expect(result!.tieBreak).toBe('only-match')
  })

  it('AMBIGUOUS with NEITHER deprecated falls back to the BARE form', () => {
    const facts: ThemeSchemaFacts = { properties: {}, themes: ['COLOR_NAME/SIZE_NAME', 'COLOR/SIZE'], deprecated: [] }
    const result = deriveAmazonTheme(['color', 'size'], facts)
    expect(result!.match.code).toBe('COLOR/SIZE')
    expect(result!.tieBreak).toBe('bare-form')
  })

  it('AMBIGUOUS with BOTH deprecated still answers, preferring the bare one, and says bare-form', () => {
    const facts: ThemeSchemaFacts = { properties: {}, themes: ['COLOR_NAME/SIZE_NAME', 'COLOR/SIZE'], deprecated: ['COLOR_NAME/SIZE_NAME', 'COLOR/SIZE'] }
    const result = deriveAmazonTheme(['color', 'size'], facts)
    expect(result!.match.code).toBe('COLOR/SIZE')
    expect(result!.tieBreak).toBe('bare-form')
    expect(result!.match.deprecated).toBe(true)
  })

  it('SET-ONLY: no in-order match, one as a set, and the THEME order wins', () => {
    const facts: ThemeSchemaFacts = { properties: {}, themes: ['SIZE/COLOR'], deprecated: [] }
    const result = deriveAmazonTheme(['color', 'size'], facts)
    expect(result!.match.code).toBe('SIZE/COLOR')
    expect(result!.tieBreak).toBe('set-order')
    expect(result!.match.keys).toEqual(['size', 'color'])
  })

  it('NONE: nothing matches, and an empty axis list never derives', () => {
    const facts: ThemeSchemaFacts = { properties: {}, themes: ['SIZE', 'COLOR'], deprecated: [] }
    expect(deriveAmazonTheme(['color', 'size'], facts)).toBeNull()
    expect(deriveAmazonTheme([], factsFor(OUTERWEAR_IT))).toBeNull()
  })

  it('the xracing shape: a 3-axis family DOES derive on a product type that offers it', () => {
    const facts: ThemeSchemaFacts = {
      properties: { fit_type: { title: 'Vestibilita' }, size: { title: 'Taglia' }, color: { title: 'Colore' } },
      themes: ['FIT_TYPE/SIZE_NAME/COLOR_NAME', 'FIT_TYPE/SIZE/COLOR'],
      deprecated: ['FIT_TYPE/SIZE_NAME/COLOR_NAME'],
    }
    const result = deriveAmazonTheme(['fittype', 'size', 'color'], facts)
    expect(result!.match.code).toBe('FIT_TYPE/SIZE/COLOR')
    expect(result!.tieBreak).toBe('only-live')
  })
})

describe('dropsForTheme', () => {
  it('names the axes a theme does not deliver, in family order', () => {
    expect(dropsForTheme(['color', 'size'], ['color', 'size', 'style'])).toEqual(['style'])
    expect(dropsForTheme(['color'], ['color', 'size'])).toEqual(['size'])
    expect(dropsForTheme(['color', 'size'], ['color', 'size'])).toEqual([])
  })

  it('separates "drops nothing" from "covers exactly" on the real 50 themes', () => {
    const classified = classifyThemes(factsFor(OUTERWEAR_IT))
    const wanted = ['color', 'size']
    const dropsNothing = classified.filter((t) => dropsForTheme(t.keys, wanted).length === 0)
    const coversExactly = dropsNothing.filter((t) => addsForTheme(t.keys, wanted).length === 0)
    // 13 themes deliver colour AND size; only 4 do so without demanding a value the family does not have.
    expect(dropsNothing.length).toBe(13)
    expect(coversExactly.map((t) => t.code).sort()).toEqual([
      'COLOR/SIZE', 'COLOR_NAME/SIZE_NAME', 'SIZE/COLOR', 'SIZE_NAME/COLOR_NAME',
    ])
    expect(classified.length - dropsNothing.length).toBe(37)
    // and the nine that "drop nothing" but ADD a segment are named, never silently grouped with the four
    const addsOne = dropsNothing.filter((t) => addsForTheme(t.keys, wanted).length > 0)
    expect(addsOne.length).toBe(9)
    expect(addsOne.map((t) => t.code)).toContain('MATERIAL/SIZE/COLOR')
  })
})

describe('marketplaceIdFor - one rule for the __lastPublishedAxes key', () => {
  it('prefixes only eBay', () => {
    expect(marketplaceIdFor('EBAY', 'IT')).toBe('EBAY_IT')
    expect(marketplaceIdFor('ebay', 'de')).toBe('EBAY_DE')
    expect(marketplaceIdFor('AMAZON', 'IT')).toBe('IT')
    expect(marketplaceIdFor('SHOPIFY', 'GLOBAL')).toBe('GLOBAL')
  })
})
