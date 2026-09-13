import { describe, expect, it } from 'vitest'
import { formulaCandidates, formulaColumnId, formulaReadKey } from './formulaColumns'
import { languageField } from './languages'

const columns = ['name@it','name@de','name@fr','description@de','description@fr','brand'].map(key => ({ key, label: key.split('@')[0] }))
describe('language view formula boundaries', () => {
  it('uses canonical references and values from the edited language, with shared non-text fields', () => {
    const values = Object.fromEntries(columns.map(column => [column.key, { value: column.key + ' value' }]))
    const candidates = formulaCandidates(columns, values, 'description@fr', 'it')
    expect(candidates.map(candidate => [candidate.name, candidate.value])).toEqual([
      ['name','name@fr value'],['description','description@fr value'],['brand','brand value'],
    ])
    expect(formulaColumnId(columns, 'NAME', 'description@fr', 'it')).toBe('name@fr')
    expect(formulaColumnId(columns, 'brand', 'description@fr', 'it')).toBe('brand')
  })
  it('keeps read formulas separate and does not duplicate non-text formulas across languages', () => {
    const keys = columns.map(column => column.key)
    expect(formulaReadKey(keys,'name','de','it')).toBe('name@de')
    expect(formulaReadKey(keys,'name','fr','it')).toBe('name@fr')
    expect(formulaReadKey(keys,'brand','de','it')).toBeNull()
    expect(formulaReadKey(keys,'brand','it','it')).toBe('brand')
    expect(formulaReadKey([], 'name','it','it')).toBe('name')
  })
  it('sends canonical service keys with the column language for preview, save and removal', () => {
    expect(languageField('name@fr-FR','it')).toEqual({fieldKey:'name',locale:'fr'})
    expect(languageField('bulletPoints@de','it')).toEqual({fieldKey:'bulletPoints',locale:'de'})
    expect(languageField('brand','it')).toEqual({fieldKey:'brand',locale:'it'})
  })
})
