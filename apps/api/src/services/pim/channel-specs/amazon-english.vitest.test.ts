/**
 * W3 PR-A — Amazon's English names joined into the market spec (`amazon-english.ts`), through the real Amazon walker.
 * The market row decides every rule; the English copy adds names only — by spec key and option code.
 * Run: npx vitest run src/services/pim/channel-specs/amazon-english.vitest.test.ts
 */
import { describe, expect, it } from 'vitest'
import { amazonSpecFromDefinition } from './amazon.js'
import { isEnglishLocale, schemaLocale, withEnglish } from './amazon-english.js'

/** A trimmed product-type definition: one closed option list (`color`), one open one (`fit_type`), one text field. */
function definition(locale: string, names: { color: Record<string, string>; fit: Record<string, string> }, opts: { help?: string; colorCodes?: string[]; extra?: boolean; maxLength?: number } = {}) {
  const colorCodes = opts.colorCodes ?? Object.keys(names.color)
  const value = (node: Record<string, unknown>) => ({ type: 'array', maxUniqueItems: 1, selectors: ['marketplace_id', 'language_tag'],
    items: { type: 'object', properties: { value: node, marketplace_id: { type: 'string' }, language_tag: { type: 'string' } } } })
  return {
    __schemaProvenance: { scope: 'marketplace', locale },
    required: ['color'],
    properties: {
      color: value({ type: 'string', enum: colorCodes, enumNames: colorCodes.map(code => names.color[code]), description: opts.help }),
      fit_type: value({ type: 'string', anyOf: [{ type: 'string' }, { type: 'string', enum: Object.keys(names.fit), enumNames: Object.values(names.fit) }] }),
      item_name: value({ type: 'string', maxLength: opts.maxLength ?? 200 }),
      ...(opts.extra ? { only_in_english: value({ type: 'string', enum: ['x'], enumNames: ['Only English'] }) } : {}),
    },
  }
}
const spec = (marketplace: string, def: unknown, fetchedAt = new Date('2026-10-01T04:00:00Z')) =>
  amazonSpecFromDefinition({ marketplace, productType: 'OUTERWEAR', schemaDefinition: def, fetchedAt, schemaVersion: `v-${marketplace}` })
const field = (s: ReturnType<typeof spec>, key: string) => s.fields.find(f => f.key === key)!

const italian = definition('it_IT', { color: { red: 'Rosso', blue: 'Blu', green: 'Verde' }, fit: { slim: 'Aderente', loose: 'Ampio' } }, { help: 'Il colore principale.' })
const englishAt = new Date('2026-10-01T04:01:00Z')
const english = definition('en_GB', { color: { red: 'Red', blue: 'Blue', purple: 'Purple' }, fit: { slim: 'Slim', loose: 'Loose' } },
  { help: 'The main colour.', extra: true, maxLength: 50 })

describe('withEnglish — the English copy joined into the market spec', () => {
  const joined = withEnglish(spec('IT', italian), spec('IT', english, englishAt))

  it('joins option names by code and help text by key, and says where the English came from', () => {
    expect(field(joined, 'color').optionLabelsEnglish).toEqual({ red: 'Red', blue: 'Blue' })
    expect(field(joined, 'fit_type').optionLabelsEnglish).toEqual({ slim: 'Slim', loose: 'Loose' })
    expect(field(joined, 'color').helpTextEnglish).toBe('The main colour.')
    expect(joined.english).toEqual({ locale: 'en_GB', fetchedAt: englishAt })
  })

  it('a code the English copy lacks keeps the market name; its extra codes and fields are ignored', () => {
    const color = field(joined, 'color')
    expect(color.optionLabelsEnglish).not.toHaveProperty('green')
    expect(color.optionLabels).toEqual({ red: 'Rosso', blue: 'Blu', green: 'Verde' })
    expect(color.optionLabelsEnglish).not.toHaveProperty('purple')
    expect(joined.fields.map(f => f.key)).toEqual(spec('IT', italian).fields.map(f => f.key))
  })

  it('every rule stays the market row’s: options, mode, requirement, cap, version and date', () => {
    const market = spec('IT', italian)
    for (const key of ['color', 'fit_type', 'item_name']) {
      const { optionLabelsEnglish: _o, helpTextEnglish: _h, ...rest } = field(joined, key)
      expect(rest).toEqual(field(market, key))
    }
    expect(field(joined, 'item_name').maxLength).toBe(200)
    expect(field(joined, 'color')).toMatchObject({ options: ['red', 'blue', 'green'], mode: 'strict', requirement: 'required' })
    expect(field(joined, 'fit_type').mode).toBe('open')
    expect(joined).toMatchObject({ schemaVersion: 'v-IT', fetchedAt: market.fetchedAt })
  })

  it('without an English copy nothing is added and `english` is null', () => {
    const alone = withEnglish(spec('IT', italian), null)
    expect(alone.english).toBeNull()
    expect(alone.fields.some(f => f.optionLabelsEnglish || f.helpTextEnglish)).toBe(false)
  })

  it('a copy that is not in English is never joined', () => {
    const notEnglish = withEnglish(spec('IT', italian), spec('IT', definition('it_IT', { color: { red: 'Rosso' }, fit: {} })))
    expect(notEnglish.english).toBeNull()
    expect(field(notEnglish, 'color').optionLabelsEnglish).toBeUndefined()
  })

  it('an English market needs no copy: its own row is the English, and nothing is duplicated', () => {
    const uk = spec('UK', definition('en_GB', { color: { red: 'Red' }, fit: {} }))
    const result = withEnglish(uk, null)
    expect(result.english).toEqual({ locale: 'en_GB', fetchedAt: uk.fetchedAt })
    expect(field(result, 'color').optionLabelsEnglish).toBeUndefined()
    expect(field(result, 'color').optionLabels).toEqual({ red: 'Red' })
  })
})

describe('locale helpers', () => {
  it('reads the download locale from the provenance, and recognises English', () => {
    expect(schemaLocale(spec('IT', italian))).toBe('it_IT')
    expect(schemaLocale(spec('IT', { properties: { item_name: { type: 'string' } } }))).toBeNull()
    expect(['en_GB', 'en_US', 'en-IE', 'en'].every(isEnglishLocale)).toBe(true)
    expect([null, undefined, '', 'it_IT', 'nl_BE', 'eng'].some(isEnglishLocale)).toBe(false)
  })
})
