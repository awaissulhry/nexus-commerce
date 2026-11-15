import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { MINIMUMS } from '../_demo/fixtures'
import { minimumEditHeld, minimumPatch, surchargeHeld, surchargeTyped, withMinimum } from './model'

/** B-W2b-380 (XF6:03): the minimums edited in place — what each cell sends, what it refuses before any call, who may. */

const style = MINIMUMS[0]! // a style, 5 per line, BLOCK
const gloves = MINIMUMS[1]! // a kind of garment, SURCHARGE 12 EUR
const archived = MINIMUMS[3]!

describe('a minimum cell typed or picked', () => {
  it('sends only what changed; nothing when the value is the same', () => {
    expect(minimumPatch(style, 'minQuantity', ' 8 ', 'EUR')).toEqual({ minQuantity: 8 })
    expect(minimumPatch(style, 'minQuantity', String(style.minQuantity), 'EUR')).toBeNull()
    expect(minimumPatch(style, 'per', 'ORDER', 'EUR')).toEqual(style.per === 'ORDER' ? null : { per: 'ORDER' })
    expect(minimumPatch(style, 'action', 'WARN', 'EUR')).toEqual({ action: 'WARN' })
    expect(minimumPatch(style, 'action', 'BLOCK', 'EUR')).toBeNull()
    expect(minimumPatch(style, 'note', '  Sotto 5 il lotto non si taglia  ', 'EUR')).toEqual({ note: 'Sotto 5 il lotto non si taglia' })
    expect(minimumPatch(gloves, 'note', '', 'EUR')).toEqual({ note: null })
  })

  it('a surcharge typed makes the minimum a small-run surcharge (an amount in the list currency, or a percent)', () => {
    expect(minimumPatch(style, 'surcharge', '12,50', 'EUR')).toEqual({ action: 'SURCHARGE', surchargeAmount: '12.50', surchargePct: null, currency: 'EUR' })
    expect(minimumPatch(style, 'surcharge', '3%', 'EUR')).toEqual({ action: 'SURCHARGE', surchargePct: '3', surchargeAmount: null, currency: null })
    expect(minimumPatch(gloves, 'surcharge', '12', 'EUR')).toBeNull()
    expect(minimumPatch(gloves, 'surcharge', '15', 'EUR')).toMatchObject({ surchargeAmount: '15' })
    expect(surchargeTyped(gloves)).toBe('12')
    expect(surchargeTyped(style)).toBe('')
  })

  it('refuses in words before any call', () => {
    expect(minimumPatch(style, 'minQuantity', '1', 'EUR')).toEqual({ key: 'minimums.problem.quantity' })
    expect(minimumPatch(style, 'minQuantity', '2,5', 'EUR')).toEqual({ key: 'minimums.problem.quantity' })
    expect(minimumPatch(style, 'action', 'SURCHARGE', 'EUR')).toEqual({ key: 'minimums.problem.surchargeFirst' })
    expect(minimumPatch(gloves, 'surcharge', '', 'EUR')).toEqual({ key: 'minimums.problem.surchargeNeeded' })
    expect(minimumPatch(style, 'surcharge', '0', 'EUR')).toEqual({ key: 'minimums.problem.surcharge' })
    expect(minimumPatch(style, 'surcharge', '120%', 'EUR')).toEqual({ key: 'minimums.problem.surcharge' })
    expect(minimumPatch(style, 'note', 'x'.repeat(501), 'EUR')).toEqual({ key: 'minimums.problem.note', params: { limit: 500 } })
  })

  it('held with why: no right, an archived list or minimum, the surcharge without the price grain', () => {
    expect(minimumEditHeld(style, { manage: true }, false)).toBeNull()
    expect(minimumEditHeld(style, { manage: false }, false)).toEqual({ key: 'minimums.held.noManage' })
    expect(minimumEditHeld(style, { manage: true }, true)).toEqual({ key: 'minimums.held.listArchived' })
    expect(minimumEditHeld(archived, { manage: true }, false)).toEqual({ key: 'minimums.held.archived' })
    expect(surchargeHeld(style, { manage: true, price: false }, false)).toEqual({ key: 'minimums.held.noPrice' })
  })

  it('the answer takes the row’s place; every word is in both languages', () => {
    const next = { ...style, minQuantity: 9, version: style.version + 1 }
    expect(withMinimum(MINIMUMS, next).map((row) => row.minQuantity)).toEqual([9, ...MINIMUMS.slice(1).map((row) => row.minQuantity)])
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['prices-followups']!
      for (const key of ['minimums.problem.quantity', 'minimums.problem.surchargeFirst', 'minimums.held.archived', 'minimums.refused.moved', 'minimums.saved', 'minimums.cell.saving', 'minimums.col.surcharge']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})
