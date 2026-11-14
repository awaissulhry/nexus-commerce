import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { daysOf, lastWeek, rangeOf } from '../search/model'
import { READ_ACTIONS, READ_SURFACES } from './api'
import { lookedOf, lookedTerm, READ_LOG_RECORD_TYPES, reasonProblem } from './model'

/** B-W2b-413: Who looked and the audit search's window, pure (PLT-074, PLT-077). */

const ID = '0190f0e2-cccc-7000-8000-000000000001'

describe('who looked', () => {
  it('names one record in the address by type and id only', () => {
    expect(lookedOf(new URLSearchParams(`looked=Certificate.${ID}`))).toEqual({ type: 'Certificate', id: ID })
    expect(lookedOf(new URLSearchParams(`looked=Invoice.${ID}`))).toBeNull()
    expect(lookedOf(new URLSearchParams('looked=Certificate.1'))).toBeNull()
    expect(lookedTerm({ type: 'Certificate', id: ID })).toBe(`Certificate.${ID}`)
  })

  it('a person’s reads only with a reason of 3 to 500 characters', () => {
    expect(reasonProblem(' ab ')).toBe('reads.error.reason')
    expect(reasonProblem('x'.repeat(501))).toBe('reads.error.reasonLong')
    expect(reasonProblem('Verifica richiesta')).toBeNull()
  })

  it('every record type, action and surface has words in both languages', () => {
    for (const locale of LOCALES) {
      const own = CATALOGUE[locale]['admin-security-depth'] ?? {}
      for (const type of READ_LOG_RECORD_TYPES) expect(own[`reads.type.${type}`], `${locale} ${type}`).toBeTruthy()
      for (const action of READ_ACTIONS) expect(own[`reads.action.${action}`]).toBeTruthy()
      for (const surface of READ_SURFACES) expect(own[`reads.surface.${surface}`]).toBeTruthy()
    }
  })
})

describe('the window between two days', () => {
  it('from the first day’s start to the start of the day after the last (exclusive), and back', () => {
    const first = new Date(2026, 9, 27, 15, 0)
    const last = new Date(2026, 9, 29, 8, 0)
    const range = rangeOf(last, first)
    expect(new Date(range.from)).toEqual(new Date(2026, 9, 27))
    expect(new Date(range.to)).toEqual(new Date(2026, 9, 30))
    const days = daysOf(range.from, range.to, new Date())
    expect(days.start.getDate()).toBe(27)
    expect(days.end.getDate()).toBe(29)
    const week = lastWeek(new Date(2026, 9, 29, 12))
    expect(new Date(week.from)).toEqual(new Date(2026, 9, 23))
  })
})
