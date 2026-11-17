import { describe, expect, it } from 'vitest'
import { checkedProductionAnswer, daysAfterWanted, mondayOfWeek, productionAnswerBody, productionWords, suggestedAnswer, weekOf } from './production-answer'

/** B-TH-094 (N17, X-G04): production's answer on a request — weeks, words, the body's checks, planning's suggestion. Pure. */

describe('weeks (ISO: the week of the year\'s first Thursday is week 1)', () => {
  it('names a week by its Monday, across the turn of the year', () => {
    expect(mondayOfWeek('2026-W01')).toBe('2025-12-29')
    expect(mondayOfWeek('2026-W14')).toBe('2026-03-30')
    // 2026 starts on a Thursday: it has 53 weeks; 2025 has 52.
    expect(mondayOfWeek('2026-W53')).toBe('2026-12-28')
    expect(mondayOfWeek('2025-W53')).toBeNull()
    expect(mondayOfWeek('2026-W00')).toBeNull()
    expect(mondayOfWeek('W14')).toBeNull()
  })

  it('gives a day its week', () => {
    expect(weekOf('2026-04-02')).toEqual({ key: '2026-W14', year: 2026, week: 14, monday: '2026-03-30' })
    expect(weekOf('2026-01-01')).toMatchObject({ key: '2026-W01', monday: '2025-12-29' })
  })
})

describe('the words', () => {
  it('says OK, or not before week N (with its year when it is not this one)', () => {
    expect(productionWords('OK', null, '2026-01-15')).toEqual({ it: 'Produzione: OK', en: 'Production: OK' })
    expect(productionWords('NOT_BEFORE', '2026-03-30', '2026-01-15')).toEqual({ it: 'Produzione: non prima della settimana 14', en: 'Production: not before week 14' })
    expect(productionWords('NOT_BEFORE', '2026-03-30', '2025-11-17').en).toBe('Production: not before week 14 of 2026')
  })

  it('counts the days after the wanted date (none for OK or without a wanted date)', () => {
    expect(daysAfterWanted('2026-03-30', '2026-03-20')).toBe(10)
    expect(daysAfterWanted('2026-03-30', '2026-04-20')).toBe(0)
    expect(daysAfterWanted(null, '2026-03-20')).toBeNull()
    expect(daysAfterWanted('2026-03-30', null)).toBeNull()
  })
})

describe('the body', () => {
  it('takes OK, NOT_BEFORE with this week or a later one, and null (taken back)', () => {
    expect(checkedProductionAnswer({ answer: 'OK' }, '2026-04-01')).toEqual({ ok: true, answer: 'OK', notBefore: null })
    expect(checkedProductionAnswer({ answer: 'NOT_BEFORE', week: '2026-W14' }, '2026-04-01')).toEqual({ ok: true, answer: 'NOT_BEFORE', notBefore: '2026-03-30' })
    expect(checkedProductionAnswer({ answer: 'NOT_BEFORE', week: '2026-W20' }, '2026-04-01')).toEqual({ ok: true, answer: 'NOT_BEFORE', notBefore: '2026-05-11' })
    expect(checkedProductionAnswer({ answer: null }, '2026-04-01')).toEqual({ ok: true, answer: null, notBefore: null })
  })

  it('refuses in words: no week, a week with OK, a week that is no week, a week that is over', () => {
    expect(checkedProductionAnswer({ answer: 'NOT_BEFORE' }, '2026-04-01')).toMatchObject({ ok: false, path: 'body/week', words: { en: expect.stringMatching(/Name the week/) } })
    expect(checkedProductionAnswer({ answer: 'OK', week: '2026-W14' }, '2026-04-01')).toMatchObject({ ok: false, words: { en: expect.stringMatching(/only with "not before week N"/) } })
    expect(checkedProductionAnswer({ answer: null, week: '2026-W14' }, '2026-04-01')).toMatchObject({ ok: false, path: 'body/week' })
    expect(checkedProductionAnswer({ answer: 'NOT_BEFORE', week: '2025-W53' }, '2025-11-17')).toMatchObject({ ok: false, words: { en: expect.stringMatching(/Not a week of the year/) } })
    expect(checkedProductionAnswer({ answer: 'NOT_BEFORE', week: '2026-W14' }, '2026-04-08')).toMatchObject({ ok: false, words: { en: expect.stringMatching(/That week is over/), it: expect.stringMatching(/già passata/) } })
  })

  it('parses the route body strictly', () => {
    expect(productionAnswerBody.safeParse({ version: 3, answer: 'NOT_BEFORE', week: '2026-W14' }).success).toBe(true)
    expect(productionAnswerBody.safeParse({ version: 3, answer: null }).success).toBe(true)
    expect(productionAnswerBody.safeParse({ version: 3, answer: 'NOT_BEFORE', week: '14' }).success).toBe(false)
    expect(productionAnswerBody.safeParse({ version: 3, answer: 'MAYBE' }).success).toBe(false)
    // Who answered and when are the server's: never in the body.
    expect(productionAnswerBody.safeParse({ version: 3, answer: 'OK', answeredById: '019a0000-0000-7000-8000-000000000001' }).success).toBe(false)
  })
})

describe('planning\'s suggestion', () => {
  const line = (date: string | null, complete = true, meetsWanted: boolean | null = null) => ({ date, complete, meetsWanted })

  it('suggests OK when every line is dated, completely, by the wanted date', () => {
    expect(suggestedAnswer([line('2026-04-10'), line('2026-04-03')], 0, '2026-04-20', '2026-03-01')).toMatchObject({ answer: 'OK', notBefore: null, readyDate: '2026-04-10', partial: false })
  })

  it('suggests not before the week of the latest date when it is after the wanted date', () => {
    expect(suggestedAnswer([line('2026-04-10'), line('2026-04-03')], 0, '2026-04-05', '2026-03-01')).toMatchObject({ answer: 'NOT_BEFORE', notBefore: '2026-04-06', readyDate: '2026-04-10', words: { en: expect.stringMatching(/not before week 15/) } })
  })

  it('never suggests OK for a partial answer (a line left out, or a size not promised)', () => {
    expect(suggestedAnswer([line('2026-04-10')], 1, '2026-04-20', '2026-03-01')).toMatchObject({ answer: 'NOT_BEFORE', partial: true, words: { en: expect.stringMatching(/Only some lines are dated/) } })
    expect(suggestedAnswer([line('2026-04-10', false)], 0, '2026-04-20', '2026-03-01')).toMatchObject({ answer: 'NOT_BEFORE', partial: true })
  })

  it('without a wanted date: OK only within this week, else its week', () => {
    expect(suggestedAnswer([line('2026-03-04')], 0, null, '2026-03-02')).toMatchObject({ answer: 'OK' })
    expect(suggestedAnswer([line('2026-03-20')], 0, null, '2026-03-02')).toMatchObject({ answer: 'NOT_BEFORE', notBefore: '2026-03-16' })
  })

  it('suggests nothing when no line could be dated: the person answers alone', () => {
    expect(suggestedAnswer([], 2, '2026-04-20', '2026-03-01')).toMatchObject({ answer: null, notBefore: null, readyDate: null, partial: true, words: { en: expect.stringMatching(/answer it yourself/) } })
    expect(suggestedAnswer([line(null, false)], 0, null, '2026-03-01')).toMatchObject({ answer: null })
  })
})
