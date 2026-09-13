import { describe, expect, it } from 'vitest'
import { sheetLanguages, widenLanguageSheets } from './language-sheet.js'
import type { StudioSheet } from './studio-sheet.service.js'

const column = (key: string, storage = 'column') => ({ key, label: key, writeField: key, storage, kind: 'text', scope: 'global', requiredBy: ['Master'], channels: {}, group: 'Content', groupKey: 'content' })
function sheet(locale: string): StudioSheet {
  return { scope: { locale, kind: 'channel', channel: 'AMAZON' }, columns: [column('name'), column('brand'), column('bulletPoints')],
    groups: [], meta: { tookMs: 1 }, rows: ['', 'alias'].map(aliasId => ({ id: 'p', aliasId, isParent: true, productType: null, readiness: { state: 'missing', issues: [] }, values: {
      name: { value: `${locale}:${aliasId}`, contentVersion: locale === 'nl' ? 3 : 5, contentAddress: { tier: 'pin', language: locale, coordinate: { channel: 'AMAZON', market: 'BE', accountId: 'account', aliasId } } },
      brand: { value: 'Shared brand' }, bulletPoints: { value: [] },
    } })) } as unknown as StudioSheet
}
describe('Languages view wire', () => {
  it('uses the one normaliser, preserves request order and deduplicates regional forms', () => {
    expect(sheetLanguages(['nl-BE', 'fr', 'nl'])).toEqual(['nl', 'fr'])
    expect(() => sheetLanguages([])).toThrow('at least one')
    expect(() => sheetLanguages(['invalid!'])).toThrow()
    try { sheetLanguages(['invalid!']) } catch (error) { expect(error).toMatchObject({ statusCode: 400 }) }
  })
  it('groups by field and widens only localizable fields; retains list clears and exact alias addresses', () => {
    const output = widenLanguageSheets([sheet('nl'), sheet('fr')])
    expect(output.columns.map(c => [c.key, c.locale])).toEqual([['name@nl','nl'],['name@fr','fr'],['brand',undefined],['bulletPoints@nl','nl'],['bulletPoints@fr','fr']])
    expect(output.columns[0].groupKey).toBe(output.columns[1].groupKey)
    expect(output.columns[0].writeField).toBe('name')
    expect(output.rows[1].values['name@fr']).toEqual(sheet('fr').rows[1].values.name)
    expect(output.rows[0].values['name@fr'].contentVersion).toBe(5)
    expect(output.rows[0].values['bulletPoints@nl'].value).toEqual([])
    expect(output.rows[0].values.brand.value).toBe('Shared brand')
    expect(output.rows[0].values.name).toBeUndefined()
  })
})

it('keeps per-language validation destinations and counts shared non-text requirements once', () => {
  const nl = sheet('nl'), fr = sheet('fr')
  fr.rows[0].values.name.value = ''
  nl.rows[0].readiness.issues = [{key:'brand',label:'Brand',message:'Review brand.',severity:'warn'}]
  fr.rows[0].readiness.issues = [{key:'name',label:'Name',message:'French title is required.',severity:'error'},
    {key:'brand',label:'Brand',message:'Review brand.',severity:'warn'}]
  const row = widenLanguageSheets([nl,fr]).rows[0]
  expect(row.readiness.issues.map(issue => [issue.key,issue.message])).toEqual([['brand','Review brand.'],['name@fr','French title is required.']])
  expect(row.completeness.required.missing.map(missing => missing.key)).toEqual(['bulletPoints@nl','name@fr','bulletPoints@fr'])
  expect(row.completeness.required).toMatchObject({filled:2,total:5})
})
