import { describe, expect, it } from 'vitest'

import { exportKeyFor, exportSuffix, fileValueFor, formOf, formulaKeyFor, LIST_SEPARATOR } from './sheetExport'

/**
 * LX.F P2-13 / F3 — these four expectations move to the ONE grammar
 * (`@nexus/shared/content-header`, which the API's `languageHeader` and its parser
 * already used): the channel segment is lower-case and a channel scope always emits the
 * third part, even when it is empty. Both spellings parse to the same coordinate, so no
 * existing file changes meaning — the point is that there is now one writer. The fourth
 * divergence was the real defect and it is covered by the arm added below: a master scope
 * with a language used to write `title`, which round-tripped onto the Italian SOURCE.
 */
describe('exportKeyFor — D15.2 keys, the import’s own vocabulary', () => {
  it('a master key is the bare key', () => {
    expect(exportKeyFor('brand', { kind: 'master' })).toBe('brand')
  })
  it('a channel key carries the coordinate as key@CHANNEL:MARKET:locale', () => {
    expect(exportKeyFor('brand', { kind: 'channel', channel: 'amazon', marketplace: 'it', locale: 'IT' })).toBe('brand@amazon:IT:it')
  })
  it('a channel key without a locale omits the third part — the parser accepts both', () => {
    expect(exportKeyFor('brand', { kind: 'channel', channel: 'EBAY', marketplace: 'IT' })).toBe('brand@ebay:IT:')
  })
  it('🔴 a channel scope with no channel or market falls back to the bare key rather than writing "@:"', () => {
    expect(exportKeyFor('brand', { kind: 'channel', channel: null, marketplace: 'IT' })).toBe('brand')
  })
})

describe('declared FORMS — a separator is a rendering claim the file must declare', () => {
  it('a list key reads key[] and a measure key reads key[measure], before the coordinate', () => {
    expect(exportKeyFor('keywords', { kind: 'master' }, 'list')).toBe('keywords[]')
    expect(exportKeyFor('item_weight', { kind: 'channel', channel: 'AMAZON', marketplace: 'IT', locale: 'it' }, 'measure')).toBe('item_weight[measure]@amazon:IT:it')
    expect(exportKeyFor('brand', { kind: 'master' }, null)).toBe('brand')
  })
  it('a list is written as its items joined by the declared separator; a comma inside ONE item survives', () => {
    expect(fileValueFor('list', ['Ventilato, Imbottitura rimovibile', 'Protezioni CE'])).toBe(`Ventilato, Imbottitura rimovibile${LIST_SEPARATOR}Protezioni CE`)
    expect(fileValueFor('list', ['not_applicable'])).toBe('not_applicable')
    expect(fileValueFor('list', [])).toBe('')
  })
  it('a measure is written as "value unit"', () => {
    expect(fileValueFor('measure', { value: 12.5, unit: 'kilograms' })).toBe('12.5 kilograms')
    expect(fileValueFor('measure', { value: 3 })).toBe('3')
    expect(fileValueFor('measure', { value: null, unit: 'kilograms' })).toBeNull()
  })
  it('null stays empty; a value the shape does not expect passes through untouched', () => {
    expect(fileValueFor('list', null)).toBeNull()
    expect(fileValueFor('list', 'already a string')).toBe('already a string')
    expect(fileValueFor('measure', 7)).toBe(7)
  })
  it('formOf reads the AM.1 shape and treats scalar/legacy columns as having no declared form', () => {
    expect(formOf({ shape: 'list' })).toBe('list')
    expect(formOf({ shape: 'measure' })).toBe('measure')
    expect(formOf({ shape: 'scalar' })).toBeNull()
    expect(formOf({})).toBeNull()
  })
})

describe('formulaKeyFor — D15.8, the coordinate stays outside the suffix so the parser reads it', () => {
  it('master', () => {
    expect(formulaKeyFor('brand', { kind: 'master' })).toBe('brand.formula')
  })
  it('channel', () => {
    expect(formulaKeyFor('brand', { kind: 'channel', channel: 'AMAZON', marketplace: 'IT', locale: 'it' })).toBe('brand.formula@amazon:IT:it')
  })
})

describe('exportSuffix — the file says which columns it holds', () => {
  it('all attributes', () => {
    expect(exportSuffix('all', 'Pricing')).toBe('all')
  })
  it('a named view, slugged', () => {
    expect(exportSuffix('view', 'Amazon launch · IT')).toBe('view-amazon-launch-it')
  })
  it('an unnamed arrangement is just a view', () => {
    expect(exportSuffix('view', null)).toBe('view')
    expect(exportSuffix('view', '   ')).toBe('view')
  })
})

it('LX.F P2-13 — a master export keeps the pressed language, instead of landing on the source', () => {
  expect(exportKeyFor('title', { kind: 'master', locale: 'de' })).toBe('title@de')
  expect(exportKeyFor('title', { kind: 'master', locale: 'de-DE' })).toBe('title@de')
  // POSITIVE CONTROL: with no language pressed the master key is still bare.
  expect(exportKeyFor('title', { kind: 'master' })).toBe('title')
})
