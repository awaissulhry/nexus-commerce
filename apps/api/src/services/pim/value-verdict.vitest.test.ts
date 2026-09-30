import { describe, expect, it } from 'vitest'
import { cellFindings, editVerdict, finding, publishVerdict, type FindingRule } from './value-verdict.js'
import { checkForStorage, coerceForShape } from './sheet-values.js'
import { validateChannelValue } from './mapping/validate-channel-value.js'

/**
 * P1 of fix/product-sheet-editing — the verdict rule (BUILD-P1.md), pinned as one table:
 *   edit time: only a value the field's TYPE cannot hold is refused; everything else is stored and warned about;
 *   publish time: block only what the channel itself would reject; Nexus's own rules warn.
 */
const RULES: FindingRule[] = ['type', 'required', 'offList', 'deprecated', 'length', 'count', 'format', 'schema', 'nexus']

describe('edit time', () => {
  it('refuses only the type rule; every other finding is stored', () => {
    expect(Object.fromEntries(RULES.map(rule => [rule, editVerdict(finding(rule, 'x'))]))).toEqual({
      type: 'refuse', required: 'store', offList: 'store', deprecated: 'store', length: 'store', count: 'store', format: 'store', schema: 'store', nexus: 'store',
    })
  })
})

describe('publish time', () => {
  const table = (channel: string) => Object.fromEntries(RULES.map(rule => [rule, publishVerdict(channel, finding(rule, 'x'))]))
  it('eBay: an off-list value warns (eBay keeps "Tutte le stagioni" live); limits, counts and requirements block', () => {
    expect(table('EBAY')).toEqual({ type: 'block', required: 'block', offList: 'warn', deprecated: 'warn', length: 'block', count: 'block', format: 'block', schema: 'block', nexus: 'warn' })
  })
  it.each(['AMAZON', 'SHOPIFY', 'ETSY'])('%s: an off-list value blocks (a closed enum, a definition, a property list)', channel => {
    expect(table(channel).offList).toBe('block')
    expect(table(channel).nexus).toBe('warn')
  })
  it('the channel name is case-insensitive', () => expect(publishVerdict('amazon', finding('offList', 'x'))).toBe('block'))
})

describe('cellFindings', () => {
  it('returns the finding behind each sentence, in order', () => {
    const cell = { errors: ['a', 'b'], findings: [finding('offList', 'b'), finding('length', 'a')] }
    expect(cellFindings(cell).map(f => f.rule)).toEqual(['length', 'offList'])
  })
  it('an error with no finding keeps its old meaning: it blocks', () => {
    expect(cellFindings({ errors: ['pushed later'] })).toEqual([finding('schema', 'pushed later')])
    expect(publishVerdict('EBAY', cellFindings({ errors: ['pushed later'] })[0])).toBe('block')
  })
})

describe('checkForStorage — type refusals vs stored findings, with the old sentences', () => {
  const title = { key: 'title', label: 'Title', maxLength: 80, kind: 'text', shape: 'scalar' as const }
  it('an over-length text is stored, with the cap as a length finding (it was refused)', () => {
    const long = 'x'.repeat(94)
    expect(checkForStorage(title, long)).toEqual({ ok: true, value: long, findings: [finding('length', 'Title takes at most 80 characters')] })
    expect(coerceForShape(title, long)).toEqual({ ok: false, error: 'Title takes at most 80 characters' })
  })
  it('an off-list value on a strict list is stored, named', () => {
    const season = { key: 'season', label: 'Season', mode: 'strict' as const, options: ['Estate', 'Inverno'] }
    expect(checkForStorage(season, 'Tutte le stagioni')).toEqual({ ok: true, value: 'Tutte le stagioni', findings: [finding('offList', '"Tutte le stagioni" is not one of the allowed values for Season')] })
  })
  it('too many values for a list, an incomplete measure and a unit off the list are stored', () => {
    expect(checkForStorage({ label: 'Tags', shape: 'list', cardinality: { min: 1, max: 1 } }, ['a', 'b'])).toMatchObject({ ok: true, value: ['a', 'b'], findings: [{ rule: 'count' }] })
    expect(checkForStorage({ label: 'Weight', shape: 'measure', unitOptions: ['KILOGRAM'] }, { value: 2, unit: null })).toMatchObject({ ok: true, value: { value: 2, unit: null }, findings: [{ rule: 'format' }] })
    expect(checkForStorage({ label: 'Weight', shape: 'measure', unitOptions: ['KILOGRAM'] }, { value: 2, unit: 'kg' })).toMatchObject({ ok: true, findings: [{ rule: 'format' }] })
  })
  it('refuses only what the type cannot hold', () => {
    expect(checkForStorage({ label: 'Handling time', kind: 'number' }, 'three days')).toEqual({ ok: false, error: 'Handling time needs a number' })
    expect(checkForStorage({ label: 'Weight', shape: 'measure' }, { value: 'heavy', unit: 'KILOGRAM' })).toMatchObject({ ok: false })
    expect(checkForStorage({ label: 'Brand', shape: 'scalar' }, ['a', 'b'])).toEqual({ ok: false, error: 'Brand takes ONE value — a list was sent' })
    expect(checkForStorage({ label: 'Tags', shape: 'list' }, 'one')).toMatchObject({ ok: false })
  })
  it('an incomplete record is stored and flagged; a record that is not a record is refused', () => {
    const facts = { label: 'Sizes', validation: { recordFields: [{ key: 'size', label: 'Size', kind: 'text', required: true }] } }
    expect(checkForStorage(facts, [{}])).toMatchObject({ ok: true, findings: [{ rule: 'format', message: 'Sizes record 1 needs Size' }] })
    expect(checkForStorage(facts, 'not json')).toMatchObject({ ok: false })
  })
})

describe('validateChannelValue — findings carry the rule behind each sentence', () => {
  const field = (extra: Record<string, unknown>) => ({ fieldKey: 'f', label: 'Field', options: null, selectionOnly: false, maxLength: null, maxBytes: null, priority: 'optional', ...extra }) as never
  it('names off-list, deprecated and over-limit problems by rule', () => {
    const checked = validateChannelValue(field({ options: ['A', 'B'], selectionOnly: true, deprecatedOptions: ['B'], maxLength: 1 }), 'C')
    expect(checked.findings.map(f => f.rule)).toEqual(['offList'])
    expect(validateChannelValue(field({ options: ['A', 'B'], selectionOnly: true, deprecatedOptions: ['B'] }), 'B').findings.map(f => f.rule)).toEqual(['deprecated'])
    expect(validateChannelValue(field({ maxLength: 3 }), 'abcd').findings).toEqual([finding('length', 'Field exceeds 3 characters (4).')])
    expect(checked.errors).toEqual(checked.findings.map(f => f.message))
  })
  it('a stored LIST on a single-value field: one member is validated as the value; two are a count problem, not a type one', () => {
    expect(validateChannelValue(field({ shape: 'scalar' }), ['not_applicable']).findings).toEqual([])
    expect(validateChannelValue(field({ shape: 'scalar' }), ['a', 'b']).findings.map(f => f.rule)).toEqual(['count'])
  })
})
