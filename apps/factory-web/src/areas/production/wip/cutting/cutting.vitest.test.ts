import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { lotBars, withYieldDays, yieldDaysOf, yieldPeriod } from '../../reports/yield/model'
import { CUT_YIELD } from '../../reports/yield/fixtures'
import { hidesPhrases, verdictOf } from '../../work-orders/record/leather/model'
import { LEATHER_GARMENT, LEATHER_MIXED, LEATHER_NONE, LEATHER_ONE, LEATHER_OUT_OF_SHADE } from '../../work-orders/record/leather/fixtures'
import { cutboardSchema } from './api'
import { CUTBOARD, CUTBOARD_EMPTY, CUTBOARD_SITE_2 } from './fixtures'
import { boardTiles, cutboardLiveTouches, cutOrderHref, oneUnit, pctWords, progressPhrase, signedPct, workOrderCuttingHref } from './model'

/**
 * B-W2b-130 — the rules of Floor now's Cutting room, Production reports' Cutting and yield and the work order's Leather panel, and
 * their words: every key a rule names exists in Italian and English.
 */

const has = (key: string) => {
  for (const locale of ['it', 'en'] as const) {
    const words = CATALOGUE[locale]['production-cutboard'] ?? {}
    if (!(key in words) && !(`${key}_other` in words)) return `${locale}:${key}`
  }
  return null
}

describe('the cutting room board (MES-163)', () => {
  it('reads the made-up boards with the API schema', () => {
    for (const board of [CUTBOARD, CUTBOARD_EMPTY, CUTBOARD_SITE_2]) expect(cutboardSchema.parse(board)).toEqual(board)
  })

  it('says waiting, cutting, the plan, hides, yield, fabric and late as tiles with words', () => {
    const tiles = boardTiles(CUTBOARD, 'it')
    expect(tiles.map((tile) => [tile.id, tile.value])).toEqual([
      ['waiting', '3'],
      ['cutting', '2'],
      ['plan', '96 / 120'],
      ['hides', '7'],
      ['yield', '80,67 %'],
      ['fabric', '15 m'],
      ['late', '1'],
    ])
    expect(tiles.find((tile) => tile.id === 'plan')?.hint).toEqual({ key: 'tile.planAhead', params: { pct: '80 %', count: 8 } })
    expect(tiles.find((tile) => tile.id === 'fabric')?.hint).toEqual({ key: 'tile.fabricHintWaiting', params: { difference: '+4,2 %', count: 1 } })
    const empty = boardTiles(CUTBOARD_EMPTY, 'en')
    expect(empty.map((tile) => tile.id)).not.toContain('late')
    expect(empty.find((tile) => tile.id === 'plan')).toMatchObject({ value: '0', hint: { key: 'tile.planNone', params: { count: 0 } } })
    // Two area units are never added: no single yield.
    expect(oneUnit(CUTBOARD_SITE_2.leather)).toBeNull()
    expect(boardTiles(CUTBOARD_SITE_2, 'en').find((tile) => tile.id === 'yield')).toMatchObject({ value: '—', hint: { key: 'tile.yieldSeeBelow' } })
    for (const board of [CUTBOARD, CUTBOARD_EMPTY, CUTBOARD_SITE_2])
      for (const tile of boardTiles(board, 'en')) expect([has(tile.label.key), tile.hint ? has(tile.hint.key) : null]).toEqual([null, null])
  })

  it('re-reads on the cutting room’s events only, and opens a cut order and a work order’s Cutting tab', () => {
    expect(['cut_order.changed', 'cut_ticket.changed', 'lay.changed', 'cut_consumption.changed', 'cut_order.reconciled', 'production.cut_logged'].every((type) => cutboardLiveTouches({ type }))).toBe(true)
    expect(cutboardLiveTouches({ type: 'production.scan_recorded' })).toBe(false)
    expect(cutOrderHref('/w/DEMO', CUTBOARD.orders[0]!)).toMatch(/^\/w\/DEMO\/(production\/cutting\/|records\/CutOrder\/)/)
    expect(workOrderCuttingHref('/w/DEMO', 'abc')).toBe('/w/DEMO/production/work-orders/abc?tab=cutting')
    expect(progressPhrase(CUTBOARD.orders[0]!)).toEqual({ key: 'row.lays', params: { cut: 1, of: 2 } })
    expect(has(progressPhrase(CUTBOARD.orders[1]!).key)).toBeNull()
  })

  it('writes percentages in the language, signed where they compare', () => {
    expect(pctWords('82.50', 'it')).toBe('82,50 %')
    expect(pctWords(null, 'en')).toBe('—')
    expect(signedPct('-1.33', 'en')).toBe('−1.33 %')
    expect(signedPct('4.2', 'it')).toBe('+4,2 %')
  })
})

describe('the cutting and yield report (MES-302)', () => {
  it('keeps the period in the address, 30 days by default', () => {
    const params = (text: string) => new URLSearchParams(text)
    expect(yieldDaysOf(params('yield=7'))).toBe(7)
    expect(yieldDaysOf(params('yield=12'))).toBe(30)
    expect(withYieldDays('/w/D/production/reports?site=x', 90)).toBe('/w/D/production/reports?site=x&yield=90')
    expect(withYieldDays('/w/D/production/reports?yield=90', 30)).toBe('/w/D/production/reports')
    expect(yieldPeriod('2026-10-29', 7)).toEqual({ from: '2026-10-23', to: '2026-10-29' })
  })

  it('draws the lots worst first, with their plan', () => {
    expect(lotBars(CUT_YIELD.leather.lots)).toEqual([
      { lot: 'LOT-DEMO-0031', yield: 74, planned: 82 },
      { lot: 'LOT-DEMO-0028', yield: 81, planned: 82 },
      { lot: 'LOT-DEMO-0025', yield: 84, planned: 82 },
    ])
  })
})

describe('one shade lot per order on the work order (SCM-206)', () => {
  it('says the verdict in words, a mixed order against the rule as a danger', () => {
    expect(verdictOf(LEATHER_ONE.materials[0]!)).toEqual({ words: { key: 'leather.verdict.ONE', params: { lot: 'LOT-DEMO-0028', shade: '2' } }, tone: 'success' })
    expect(verdictOf(LEATHER_NONE.materials[0]!).tone).toBe('neutral')
    expect(verdictOf(LEATHER_MIXED.materials[0]!)).toEqual({ words: { key: 'leather.verdict.MIXED', params: { count: 2 } }, tone: 'danger' })
    expect(verdictOf(LEATHER_GARMENT.materials[0]!).tone).toBe('warning')
    expect(verdictOf(LEATHER_OUT_OF_SHADE.materials[0]!).words.key).toBe('leather.verdict.outOfShade')
    expect(hidesPhrases({ held: 2, reserved: 0, cut: 3 }).map((words) => words.key)).toEqual(['leather.held', 'leather.cut'])
    for (const leather of [LEATHER_ONE, LEATHER_NONE, LEATHER_MIXED, LEATHER_GARMENT, LEATHER_OUT_OF_SHADE]) expect(has(verdictOf(leather.materials[0]!).words.key)).toBeNull()
    for (const rule of ['ORDER', 'GARMENT', 'OFF']) expect(has(`leather.rule.${rule}`)).toBeNull()
  })
})
