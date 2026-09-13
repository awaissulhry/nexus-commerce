import { describe, expect, it } from 'vitest'
import { columnLanguages, languageSelection, toggleLanguage, languageProjectionReady } from './languages'
import { languageChips, orderLanguageChips } from './languageChips'

describe('saved language selection', () => {
  it('restores languages from qualified saved column keys with one normaliser', () => {
    expect(columnLanguages(['name@it','name@de','description@it','brand'])).toEqual(['it','de'])
    expect(languageSelection(null)).toBeNull()
    expect(languageSelection('nl-BE,fr,nl')).toEqual(['nl','fr'])
    expect(languageSelection('!')).toEqual([])
  })
  it('keeps at least one language pressed and preserves market order', () => {
    expect(toggleLanguage(['nl'], 'nl', ['nl','fr'])).toEqual(['nl'])
    expect(toggleLanguage(['fr'], 'nl', ['nl','fr'])).toEqual(['nl','fr'])
    expect(toggleLanguage(['nl','fr'], 'nl', ['nl','fr'])).toEqual(['fr'])
  })
  it('counts fallback even when non-empty, and counts machine drafts and outdated values separately', () => {
    const columns = ['name@de','name@fr','description@fr','name@it'].map(key => ({ key, localizable: true }))
    const chips=languageChips([{id:'p',values:{
      'name@de': { requested:'de',language:'it', },
      'name@fr': { requested:'fr',language:'fr',translation:{source:'ai',reviewedAt:null,outdated:false} },
      'description@fr': {requested:'fr',language:'fr',translation:{source:'manual',reviewedAt:'2026-09-12',outdated:true}},
      'name@it': {requested:'it',language:'it',},
      brand: {requested:'de',language:'it',},
    }}], [...columns, { key: 'brand', localizable: false }])
    expect(chips.map(c=>[c.id,c.count])).toEqual([['needs-translation',{n:1,unit:'cells'}],['ai-drafts',{n:1,unit:'cells'}],['out-of-date',{n:1,unit:'cells'}]])
    expect(chips[0].cells.byRow.p).toEqual(['name@de'])
    expect(languageChips(null, columns).every(c=>c.count===null)).toBe(true)
    expect(languageChips([], columns).every(c=>c.count?.n===0 && c.count.unit==='cells' && c.hideWhenZero===false)).toBe(true)
  })
  it('waits for the requested projection before applying a pending language view', () => {
    expect(languageProjectionReady([], ['de','fr'])).toBe(false)
    expect(languageProjectionReady([{key:'name',localizable:true}], ['de','fr'])).toBe(false)
    expect(languageProjectionReady([{key:'name@de',locale:'de'}], ['de','fr'])).toBe(false)
    const ready = [{key:'name@de',locale:'de'},{key:'name@fr',locale:'fr'}]
    expect(languageProjectionReady(ready, ['de','fr'])).toBe(true)
    expect(languageProjectionReady(ready, null)).toBe(false)
    expect(languageProjectionReady([{key:'name',localizable:true}], null)).toBe(true)
    expect(languageProjectionReady([{key:'productType'}], ['nl','fr'])).toBe(true)
  })
})

it('keeps all three language filters before generic findings without changing other views', () => {
  const chips = ['missing-required','warnings','out-of-date','needs-translation','ai-drafts'].map(id => ({id}))
  expect(orderLanguageChips(chips,true).map(chip => chip.id)).toEqual(['needs-translation','ai-drafts','out-of-date','missing-required','warnings'])
  expect(orderLanguageChips(chips,false)).toBe(chips)
})
