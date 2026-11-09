import { describe, expect, it } from 'vitest'
import { declarationSender, partyMaySee, privateLabelRefusal, shownTo } from './private-label'
import { everyName, normaliseLanguage, resolveText, textProblems, type StoredText } from './rules'

const style = { name: 'Seed jacket', nameI18n: { it: 'Giacca seme', en: 'Seed jacket EN' }, description: 'W1 description' }
const rows: StoredText[] = [
  { language: 'de', name: 'Saatjacke', shortDescription: 'Kurz', longDescription: 'Lang' },
  { language: 'it', name: 'Giacca (testo)', shortDescription: null, longDescription: null },
]

describe('language tags (PRD-019)', () => {
  it('keeps the stored form and refuses what is not a tag', () => {
    expect(normaliseLanguage(' DE-ch ')).toBe('de-CH')
    expect(normaliseLanguage('pt_br')).toBe('pt-BR')
    expect(normaliseLanguage('it')).toBe('it')
    expect(normaliseLanguage('zh-Hant-TW')).toBe('zh-Hant-TW')
    for (const bad of ['', 'e', 'english', 'de--CH', '12', 'de-']) expect(normaliseLanguage(bad), bad).toBeNull()
  })
})

describe('text limits (the database refuses the same)', () => {
  it('names one line of 1 to 200, a short description one line of up to 500, a long one with paragraphs', () => {
    expect(textProblems({ name: 'Giacca', shortDescription: null, longDescription: 'Riga uno\nRiga due\tcon tab' })).toEqual([])
    expect(textProblems({ name: ' ', shortDescription: null, longDescription: null }).map((issue) => issue.path)).toEqual(['name'])
    expect(textProblems({ name: 'a\nb', shortDescription: 'x\ty', longDescription: 'z\u0007' }).map((issue) => issue.path)).toEqual(['name', 'shortDescription', 'longDescription'])
    expect(textProblems({ name: 'x'.repeat(201), shortDescription: 'y'.repeat(501), longDescription: 'z'.repeat(10_001) })).toHaveLength(3)
  })
})

describe('the text a reader gets (fallback)', () => {
  it('takes its language, then its base language, then W1 names, then the company language, then the style', () => {
    expect(resolveText(rows, style, 'de', 'it')).toMatchObject({ source: 'TEXT', from: 'de', name: 'Saatjacke', shortDescription: 'Kurz', longDescription: 'Lang' })
    expect(resolveText(rows, style, 'de-CH', 'it')).toMatchObject({ language: 'de-CH', source: 'BASE_TEXT', from: 'de', name: 'Saatjacke' })
    expect(resolveText(rows, style, 'en', 'it')).toMatchObject({ source: 'STYLE_NAME', from: 'en', name: 'Seed jacket EN', longDescription: 'W1 description' })
    expect(resolveText(rows, style, 'fr', 'it')).toMatchObject({ source: 'COMPANY_TEXT', from: 'it', name: 'Giacca (testo)' })
    expect(resolveText([], style, 'fr', 'it')).toMatchObject({ source: 'COMPANY_STYLE_NAME', from: 'it', name: 'Giacca seme' })
    expect(resolveText([], { ...style, nameI18n: null }, 'fr', 'it')).toMatchObject({ source: 'STYLE', from: null, name: 'Seed jacket', longDescription: 'W1 description' })
    // A text row wins over W1's name in the same language.
    expect(resolveText(rows, style, 'it', 'it')).toMatchObject({ source: 'TEXT', name: 'Giacca (testo)' })
  })

  it('lists every name once (search words)', () => {
    expect(everyName(rows, style)).toEqual(['Seed jacket', 'Giacca seme', 'Seed jacket EN', 'Saatjacke', 'Giacca (testo)'])
  })
})

describe('private label (PRD-010, Owner 11-09 question 3)', () => {
  it('shows a brand style to its brand only and names who sends its declaration', () => {
    expect(shownTo({ brandPartyId: null })).toBe('EVERY_CUSTOMER')
    expect(shownTo({ brandPartyId: 'b' })).toBe('BRAND_ONLY')
    expect(partyMaySee({ brandPartyId: 'b' }, 'b')).toBe(true)
    expect(partyMaySee({ brandPartyId: 'b' }, 'c')).toBe(false)
    expect(partyMaySee({ brandPartyId: null }, 'c')).toBe(true)
    expect(declarationSender({ brandPartyId: 'b', soldUnderOurName: false })).toBe('BRAND')
    expect(declarationSender({ brandPartyId: 'b', soldUnderOurName: true })).toBe('COMPANY')
    expect(declarationSender({ brandPartyId: null, soldUnderOurName: false })).toBe('COMPANY')
  })

  it('refuses "sold under our name" without a brand, in words', () => {
    expect(privateLabelRefusal('JKT-1', { brandPartyId: null, soldUnderOurName: true })).toMatch(/name the brand it is made for/)
    expect(privateLabelRefusal('JKT-1', { brandPartyId: 'b', soldUnderOurName: true })).toBeNull()
  })
})
