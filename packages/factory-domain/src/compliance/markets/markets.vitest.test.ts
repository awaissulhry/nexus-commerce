import { describe, expect, it } from 'vitest'
import { languageMatrix, marketProblems, switchRefusal } from './rules'

describe('market profiles (B-W2b-249; PRD-275)', () => {
  it('refuses a market in words: the code, the languages, the marks, the national rules', () => {
    expect(marketProblems({ code: 'IT', name: 'Italy', labelLanguages: ['it'], markings: ['CE'], nationalRules: [{ key: 'it-test', words: { it: 'Regola di prova.' } }] })).toEqual([])
    expect(marketProblems({ code: 'US-CA' })).toEqual([])
    expect(marketProblems({ code: 'it' }).map((issue) => issue.path)).toEqual(['body/code'])
    expect(marketProblems({ labelLanguages: ['de', 'de'] }).map((issue) => issue.path)).toEqual(['body/labelLanguages'])
    expect(marketProblems({ docLanguages: ['de-CH'] }).map((issue) => issue.path)).toEqual(['body/docLanguages'])
    expect(marketProblems({ markings: ['ce'] }).map((issue) => issue.path)).toEqual(['body/markings'])
    expect(
      marketProblems({ nationalRules: [{ key: 'a', words: { it: 'x' } }, { key: 'a', words: {} }, { key: 'b', words: { it: 'y' }, href: 'http://x' }] }).map((issue) => issue.path),
    ).toEqual(['body/nationalRules/1/key', 'body/nationalRules/1/words', 'body/nationalRules/2/href'])
  })

  it('switches a market off only with a reason, and never to the state it is in', () => {
    expect(switchRefusal({ code: 'UK', on: false, switchedOn: true, reason: 'Owner question Q23 (made up).' })).toBeNull()
    expect(switchRefusal({ code: 'UK', on: false, switchedOn: true, reason: ' x ' })?.code).toBe('REASON_NEEDED')
    expect(switchRefusal({ code: 'UK', on: true, switchedOn: false, reason: undefined })).toBeNull()
    expect(switchRefusal({ code: 'UK', on: true, switchedOn: true, reason: undefined })).toMatchObject({ code: 'ALREADY_ON', message: 'Market UK is already on.' })
  })

  it('lists which language each market needs for which document, the switched-on markets\' languages first', () => {
    const matrix = languageMatrix([
      { code: 'IT', name: 'Italy', switchedOn: true, labelLanguages: ['it'], docLanguages: ['it'], userInfoLanguages: ['it'] },
      { code: 'CH', name: 'Switzerland', switchedOn: false, labelLanguages: ['de', 'fr'], docLanguages: ['de'], userInfoLanguages: ['de', 'fr', 'it'] },
      { code: 'DE', name: 'Germany', switchedOn: true, labelLanguages: ['de'], docLanguages: ['de'], userInfoLanguages: [] },
    ])
    expect(matrix.languages).toEqual(['de', 'it', 'fr'])
    expect(matrix.markets[1]!.needs).toEqual([
      { language: 'de', documents: ['LABEL', 'DOC', 'USER_INFO'] },
      { language: 'fr', documents: ['LABEL', 'USER_INFO'] },
      { language: 'it', documents: ['USER_INFO'] },
    ])
    expect(matrix.markets[2]!.needs).toEqual([{ language: 'de', documents: ['LABEL', 'DOC'] }])
  })
})
