import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  EBAY_MAX_AXES, EBAY_MAX_VARIANTS_PER_LISTING, isFreeformTarget, limitsFor, parseThemeAxes, vocabularyFor,
} from './family-projection-limits.js'

/**
 * These are PINNING tests, not example tests.
 *
 * The Variants page serves eBay's two limits to the browser ("2 of 5 specifics", "20 of 250 allowed"). A page
 * that restates a number goes stale the day the number moves, silently, and nobody finds out until a publish
 * is refused. So each of the two is asserted against the code that ENFORCES it rather than against a literal:
 * if `parseThemeAxes` stops truncating at five, or the preflight's cap changes, these fail here instead of
 * lying on screen.
 */
describe('eBay limits are pinned to the code that enforces them', () => {
  it('parseThemeAxes truncates a declared theme at exactly the axis limit we serve', () => {
    const names = Array.from({ length: EBAY_MAX_AXES + 3 }, (_unused, index) => `Axis${index}`)
    const parsed = parseThemeAxes(names.join(','))
    expect(parsed).toHaveLength(EBAY_MAX_AXES)
    expect(parsed).toEqual(names.slice(0, EBAY_MAX_AXES))

    // The positive control: one fewer than the cap is NOT truncated, so the assertion above is about the cap
    // and not about the parser silently returning a fixed-length list.
    const under = names.slice(0, EBAY_MAX_AXES - 1)
    expect(parseThemeAxes(under.join(','))).toEqual(under)
  })

  it('the variants limit is the preflight constant, read from the preflight', () => {
    const source = readFileSync(fileURLToPath(new URL('../ebay-variation-preflight.ts', import.meta.url)), 'utf8')
    const declared = /const MAX_VARIANTS = (\d+)/.exec(source)
    expect(declared, 'ebay-variation-preflight.ts no longer declares MAX_VARIANTS — the served limit has lost its source').not.toBeNull()
    expect(Number(declared![1])).toBe(EBAY_MAX_VARIANTS_PER_LISTING)
    expect(limitsFor('EBAY').variants).toBe(EBAY_MAX_VARIANTS_PER_LISTING)
  })

  it('names both sources, so an operator can check the number rather than trust it', () => {
    const limits = limitsFor('EBAY')
    expect(limits.source.axes).toMatch(/ebay-theme-axes/)
    expect(limits.source.variants).toMatch(/ebay-variation-preflight/)
  })
})

describe('Amazon derives its axis cap from the product type, and states no variant cap', () => {
  // The real OUTERWEAR·IT enum, trimmed: it genuinely offers a four-segment theme, so a hardcoded 3 would
  // refuse a combination Amazon itself offers.
  const enumOptions = ['COLOR', 'SIZE/COLOR', 'SIZE_NAME/COLOR_NAME/NUMBER_OF_ITEMS', 'STYLE/MODEL_NUMBER/NUMBER_OF_ITEMS/PART_NUMBER']

  it('takes the widest combination the enum offers', () => {
    expect(limitsFor('AMAZON', enumOptions).axes).toBe(4)
    expect(limitsFor('AMAZON', ['COLOR', 'SIZE']).axes).toBe(1)
  })

  it('reports null — not a guess — when there is no enum and no sourced variant cap', () => {
    const limits = limitsFor('AMAZON', [])
    expect(limits.axes).toBeNull()
    expect(limits.variants).toBeNull()
    expect(limits.source.axes).toBeNull()
    // `null` is NOT COUNTED, which is a different fact from a number. A page that rendered 0 here would tell
    // an operator Amazon allows no variants at all.
    expect(limits.variants).not.toBe(0)
  })
})

describe('every channel states its own noun, and an unmodelled one says so', () => {
  it.each([
    ['EBAY', 'specific', 'specifics', 'Variation specifics'],
    ['AMAZON', 'theme', 'themes', 'Variation theme'],
    ['SHOPIFY', 'option', 'options', 'Options'],
    ['ETSY', 'property', 'properties', 'Properties'],
  ])('%s', (channel, noun, plural, title) => {
    const vocabulary = vocabularyFor(channel)
    expect(vocabulary.axisNoun).toBe(noun)
    expect(vocabulary.axisNounPlural).toBe(plural)
    expect(vocabulary.sectionTitle).toBe(title)
  })

  it('sends the plural explicitly, because one of them does not take +s', () => {
    // The whole reason `axisNounPlural` exists rather than the copy appending an "s".
    expect(`${vocabularyFor('ETSY').axisNoun}s`).not.toBe(vocabularyFor('ETSY').axisNounPlural)
  })

  it('an unknown channel gets the neutral word, never eBay’s', () => {
    const vocabulary = vocabularyFor('TIKTOK')
    expect(vocabulary.axisNoun).toBe('axis')
    expect(vocabulary.axisNoun).not.toBe('specific')
    expect(limitsFor('TIKTOK')).toMatchObject({ axes: null, variants: null })
  })
})

describe('freeform targets', () => {
  it('is Shopify only — the other three pick from a served list', () => {
    expect(isFreeformTarget('SHOPIFY')).toBe(true)
    expect(isFreeformTarget('EBAY')).toBe(false)
    expect(isFreeformTarget('AMAZON')).toBe(false)
    expect(isFreeformTarget('ETSY')).toBe(false)
  })
})
