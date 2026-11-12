import { describe, expect, it } from 'vitest'
import { CELL_STATES as DOMAIN_CELL_STATES } from '@nexus/factory-domain/compliance/status/board'
import { MARKET_STANDINGS } from '@nexus/factory-domain/product/markets/rules'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { CELL_STATES } from '../api'
import { BOARD } from '../fixtures'
import { CELL_TONE, firstCellOf, rowsShown } from '../model'
import { soldInFirstMarket } from './fixtures'
import { marketsHref, NOT_SOLD_NAMESPACE, soldInWords, standingNoteKey } from './not-sold'

/** B-W2b-288 (FU2:02) — "Not sold there" on the status board. */

describe('Not sold there', () => {
  it('is a cell state of its own, as the domain says, with its word and a neutral tone', () => {
    expect([...CELL_STATES]).toEqual([...DOMAIN_CELL_STATES])
    expect(CELL_TONE.NOT_SOLD).toBe('neutral')
    for (const locale of LOCALES) expect(CATALOGUE[locale]['compliance-status']?.['cell.NOT_SOLD']).toBeTruthy()
  })

  it('never makes a row missing or blocked; Enter opens a market it is sold in', () => {
    const board = soldInFirstMarket(BOARD)
    const row = board.rows[0]!
    expect(row.cells.slice(1).every((cell) => cell.state === 'NOT_SOLD')).toBe(true)
    expect(rowsShown(board.rows, 'missing').some((entry) => entry.style.id === row.style.id)).toBe(false)
    expect(firstCellOf(row)?.market).toBe(row.cells[0]!.marketCode)
  })

  it('says where the style stands, and where its markets are picked when the person may open the style', () => {
    expect(MARKET_STANDINGS.map(standingNoteKey)).toEqual(['notSold.cell.everyMarket', null, 'notSold.cell.notSold'])
    expect(marketsHref('S1', '/w/DEMO', true, new Set(['/products/styles/[id]']))).toBe('/w/DEMO/products/styles/S1?tab=overview')
    expect(marketsHref('S1', '/w/DEMO', false, new Set(['/products/styles/[id]']))).toBeNull()
    expect(soldInWords(['IT', 'DE'], (code) => code.toLowerCase())).toBe('it, de')
    expect(soldInWords([], (code) => code)).toBeNull()
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][NOT_SOLD_NAMESPACE] ?? {}
      for (const key of ['notSold.cell.title', 'notSold.cell.notSold', 'notSold.cell.everyMarket', 'notSold.cell.change', 'notSold.cell.changeHeld']) expect(key in words, `${locale} ${key}`).toBe(true)
    }
  })
})
