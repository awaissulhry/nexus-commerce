import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { VALUATION_METHODS } from '@nexus/factory-domain/inventory/ledger/valuation'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { canFor, COLOURS, ITEMS, ledgerRow, LOCATIONS, LOTS, named, SITE, stockRow, uid } from '../../_shared/stock/fixtures'
import { designScreen as movesScreen } from '../moves/fixtures'
import { adjustKeyOf, explainsFigure, ledgerQueryOf, mirrorOf, movesAddressOf, movesQueryString, MOVE_TILES, PERIODS, reverseProblemKey, runningBalances, tileActive, tileFilter } from '../moves/model'
import { adjustBody, adjustChecks, adjustPreview, adjustProblemKey, blankDraft, typedDecimal, type AdjustTarget } from './adjust/model'
import { designScreen as stockScreen, ROWS } from './fixtures'
import { adjustHeldKey, onHandPerUnit, scanTarget, STOCK_TILES, STOCK_VIEWS, stockAddressOf, stockLines, stockNotices, stockQueryString, visibleLines } from './model'

/**
 * Warehouse › Stock (SCR-060) and Movements (SCR-064): their rules, and every design case drawn in both languages with
 * no message key left on screen and no money for a role without the cost grain.
 */

const params = (query: string) => new URLSearchParams(query)
const base = { site: null, view: 'material' as const, q: '', tile: null }

describe('Stock: the address, the rows, the views', () => {
  it('reads and writes the address (unknown values fall back)', () => {
    expect(stockAddressOf(params('view=lot&tile=crvi&q=LOT&site=s1'))).toEqual({ site: 's1', view: 'lot', q: 'LOT', tile: 'crvi' })
    expect(stockAddressOf(params('view=nope&tile=nope'))).toEqual(base)
    expect(stockQueryString({ ...base, view: 'leather', q: ' HD ' })).toBe('view=leather&q=HD')
    expect(stockQueryString(base)).toBe('')
  })

  it('folds a leather lot’s hides into one row per place, the hides counted, values only with the cost grain', () => {
    const lines = stockLines(ROWS, false, true)
    const nappaBin = lines.find((line) => line.lot?.id === LOTS.nappa.id && line.location.id === LOCATIONS.binA1.id)!
    expect(nappaBin).toMatchObject({ hides: 5, hide: null, onHand: '257.8000', unitCost: '6.850000' })
    expect(nappaBin.value).toBe(ROWS.slice(0, 5).reduce((sum, row) => sum + (row.value ?? 0), 0))
    expect(stockLines(ROWS, false, false).find((line) => line.id === nappaBin.id)).toMatchObject({ unitCost: undefined, value: undefined })
    // The Leather view keeps one row per hide; a lot of one hide at a place keeps its hide (adjustable).
    expect(stockLines(ROWS, true, false).filter((line) => line.item.tracking === 'HIDE')).toHaveLength(12)
    expect(stockLines(ROWS, false, false).find((line) => line.lot?.id === LOTS.nappa.id && line.location.id === LOCATIONS.cutting.id)?.hides).toBe(2)
  })

  it('the views, the tiles and the search', () => {
    const crVi = new Set([LOTS.nappaQuarantine.id])
    expect(visibleLines(ROWS, { ...base, view: 'lot' }, false).every((line) => line.lot !== null)).toBe(true)
    expect(visibleLines(ROWS, { ...base, view: 'leather' }, false).every((line) => line.item.tracking === 'HIDE' && line.hide !== null)).toBe(true)
    expect(visibleLines(ROWS, { ...base, view: 'quarantine' }, false).map((line) => line.lot?.qualityStatus).sort()).toEqual(['BLOCKED', 'QUARANTINE', 'QUARANTINE'])
    expect(visibleLines(ROWS, { ...base, tile: 'crvi' }, false, crVi).map((line) => line.lot?.code)).toEqual(['LOT-D-000102'])
    expect(visibleLines(ROWS, { ...base, tile: 'blocked' }, false).map((line) => line.lot?.code)).toEqual(['LOT-D-000103'])
    expect(visibleLines(ROWS, { ...base, q: 'n-tag' }, false).map((line) => line.location.code)).toEqual(['N-TAG', 'N-TAG'])
    expect(scanTarget(ROWS, 'hd-demo-0003')).toEqual({ type: 'Hide', id: uid('8282', 3) })
    expect(scanTarget(ROWS, 'LOT-D-000104')).toEqual({ type: 'Lot', id: LOTS.lining.id })
    expect(scanTarget(ROWS, 'nothing')).toBeNull()
  })

  it('totals per unit, never across units', () => {
    const totals = onHandPerUnit(visibleLines(ROWS, base, false))
    expect(totals.map((entry) => entry.uom).sort()).toEqual(['FT2', 'M', 'M2', 'PCS'])
    expect(totals.find((entry) => entry.uom === 'PCS')?.quantity).toBe('348.0000')
  })

  it('the notices, the most serious first; Adjust is one stock key at one place', () => {
    expect(stockNotices({ quarantine: 2, waitingCrVi: 1, crViFailed: 1, blocked: 1, rejected: 0, released: 2 }, true, 3).map((notice) => notice.key)).toEqual(['st.notice.crViFailed', 'st.notice.crVi', 'st.notice.quarantine', 'st.notice.truncated', 'st.notice.unvalued'])
    expect(stockNotices(null, false, null)).toEqual([])
    const lines = stockLines(ROWS, false, false)
    const folded = lines.find((line) => line.hides > 1)!
    const single = stockLines(ROWS, true, false).find((line) => line.hide !== null)!
    expect(adjustHeldKey(folded, canFor('warehouse'))).toBe('st.held.severalHides')
    expect(adjustHeldKey(single, canFor('warehouse'))).toBeNull()
    expect(adjustHeldKey(single, canFor('quality'))).toBe('st.held.noAdjust')
    expect(adjustHeldKey(null, canFor('warehouse'))).toBe('st.held.pickOne')
  })
})

describe('Adjust stock (one dialog for Stock and Movements)', () => {
  const target: AdjustTarget = { siteId: SITE.id, siteCode: SITE.code, item: ITEMS.leather, colour: COLOURS.black, lot: LOTS.nappa, hide: { id: 'h1', code: 'HD-1' }, location: named(LOCATIONS.cutting), onHand: '31.2000' }

  it('reads a typed decimal in either language', () => {
    expect(typedDecimal('1,5')).toBe('1.5')
    expect(typedDecimal('1.234,5')).toBe('1234.5')
    expect(typedDecimal(' 12 ')).toBe('12')
    expect(typedDecimal('1,23456')).toBeNull()
    expect(typedDecimal('abc')).toBeNull()
  })

  it('holds the post with the missing field named, and previews the change', () => {
    const draft = blankDraft(target)
    expect(adjustChecks({ target, draft, withCost: false })).toEqual(['quantity', 'note'])
    expect(adjustChecks({ target, draft: { ...draft, quantity: '40', note: 'x' }, withCost: false })).toEqual(['tooMuch'])
    expect(adjustChecks({ target, draft: { ...draft, quantity: '1', note: 'x', unitCost: 'abc' }, withCost: true })).toEqual(['unitCost'])
    expect(adjustPreview({ target, draft: { ...draft, quantity: '1,5' } })).toMatchObject({ before: 31.2, after: 29.7, place: 'row' })
    expect(adjustPreview({ target, draft: { ...draft, direction: 'IN', locationId: 'other', quantity: '2' } })).toMatchObject({ before: null, after: null, delta: 2, place: 'other' })
  })

  it('the request: the row’s key, a decrease at the row’s place, a cost only with the grain', () => {
    const draft = { ...blankDraft(target), quantity: '1,5', note: ' Bordo rovinato ', unitCost: '6,9' }
    expect(adjustBody({ target, draft, withCost: false })).toEqual({ siteId: SITE.id, itemId: ITEMS.leather.id, itemColourId: COLOURS.black.id, lotId: LOTS.nappa.id, hideId: 'h1', locationId: LOCATIONS.cutting.id, direction: 'OUT', quantity: '1.5', note: 'Bordo rovinato' })
    expect(adjustBody({ target, draft: { ...draft, direction: 'IN', locationId: 'bin' }, withCost: true })).toMatchObject({ direction: 'IN', locationId: 'bin', unitCost: '6.900000' })
    expect(adjustProblemKey('conflict', 'conflict', true)).toBe('adj.problem.notEnough')
    expect(adjustProblemKey('conflict', 'conflict', false)).toBe('adj.problem.changed')
    expect(adjustProblemKey('unavailable', 'x', false)).toBe('adj.problem.offline')
  })
})

describe('Movements: the address, the query, the running balance, the reversal', () => {
  it('a stock key reads the whole ledger by default; else the last 30 days', () => {
    expect(movesAddressOf(params('')).period).toBe('30d')
    expect(movesAddressOf(params(`lot=${LOTS.nappa.id}`)).period).toBe('all')
    const address = movesAddressOf(params(`site=s&item=i&reasons=ADJUSTMENT,NOPE&period=7d&note=with&reversed=yes&open=m`))
    expect(address).toMatchObject({ site: 's', item: 'i', reasons: ['ADJUSTMENT'], period: '7d', note: 'with', reversed: 'yes', open: 'm' })
    expect(movesQueryString(address)).toBe('site=s&item=i&reasons=ADJUSTMENT&period=7d&note=with&reversed=yes&open=m')
    expect(explainsFigure(address)).toBe(true)
    expect(explainsFigure(movesAddressOf(params('lot=l')))).toBe(false)
  })

  it('the API query: the period’s start, never an upper bound (the running balance holds)', () => {
    const now = new Date('2026-10-30T10:00:00Z')
    const query = ledgerQueryOf(movesAddressOf(params('reasons=SCRAP&note=without')), now, 'c1', 500)
    expect(query).toMatchObject({ reasons: ['SCRAP'], hasNote: false, reversed: null, cursor: 'c1', limit: 500, from: '2026-09-30T10:00:00.000Z' })
    expect(query.to).toBeUndefined()
    expect(ledgerQueryOf(movesAddressOf(params('lot=l')), now, null).from).toBeNull()
  })

  it('the running balance: the balance now less the deltas of the newer rows above', () => {
    const rows = [ledgerRow(3, { reason: 'ADJUSTMENT', delta: '-1.5000' }), ledgerRow(2, { reason: 'TRANSFER', delta: '0.0000' }), ledgerRow(1, { reason: 'RECEIPT', delta: '50.0000' })]
    expect([...runningBalances(rows, '48.5000')!.values()]).toEqual([48.5, 50, 50])
    expect(runningBalances(rows, null)).toBeNull()
  })

  it('the tiles are saved filters; the mirror swaps the places; a refusal in our words', () => {
    for (const tile of MOVE_TILES) if (tileFilter(tile)) expect(tileActive(tile, { ...movesAddressOf(null), ...tileFilter(tile)! })).toBe(true)
    expect(tileFilter('unvalued')).toBeNull()
    const move = ledgerRow(1, { reason: 'TRANSFER' })
    expect(mirrorOf(move)).toMatchObject({ from: move.to, to: move.from, baseQuantity: move.baseQuantity })
    expect(reverseProblemKey('conflict', 'conflict', true)).toBe('rev.problem.used')
    expect(reverseProblemKey('conflict', 'invalid_state', false)).toBe('rev.problem.notNow')
    expect(adjustKeyOf(movesAddressOf(params('site=s&item=i&lot=l')), null)).toMatchObject({ siteId: 's', itemId: 'i', lotId: 'l' })
    expect(adjustKeyOf(movesAddressOf(null), move)).toMatchObject({ siteId: SITE.id, itemId: ITEMS.leather.id, locationId: LOCATIONS.cutting.id })
  })
})

const NAMESPACES = ['shell', 'lists', 'stock', 'warehouse-stock', 'records']
function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(View, { model })))
}
const LEFT_KEY = /\b(?:st|mv|adj|rev|problem|live|common|uom|reason|quality|crVi|hideState|side|postedBy|wait|held|money|locationKind|evidence)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const PERMISSIONS = /\binventory\.stock\.view\b/g
const MONEY = /€|EUR\b/

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [stockScreen, movesScreen] as unknown as DesignScreen<{ role: string; page: { can: { cost: boolean } } }>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en; no money without the cost grain`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen as DesignScreen<unknown>, item.model, locale).replace(PERMISSIONS, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          if (!item.model.page.can.cost) expect(html.match(MONEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) shows money`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const messages = messagesFor(locale, ['stock', 'warehouse-stock'])
      const own = createTranslator(locale, messages['warehouse-stock']!)
      const shared = createTranslator(locale, messages.stock!)
      const has = (t: typeof own, key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const view of STOCK_VIEWS) has(own, `st.view.${view}`)
      for (const tile of STOCK_TILES) has(own, `st.tile.${tile}`)
      for (const tracking of ['NONE', 'LOT', 'HIDE', 'SERIAL']) has(own, `st.tracking.${tracking}`)
      for (const check of ['quantity', 'tooMuch', 'note', 'unitCost', 'location']) has(own, `adj.held.${check}`)
      for (const period of PERIODS) has(own, `mv.period.${period}`)
      for (const tile of MOVE_TILES) {
        has(own, `mv.tile.${tile}`)
        has(own, `mv.tileHint.${tile}`)
      }
      for (const method of VALUATION_METHODS) has(own, `mv.method.${method}`)
      for (const reason of STOCK_MOVE_REASONS) has(shared, `reason.${reason}`)
      for (const key of ['st.notice.crVi', 'st.notice.crViFailed', 'st.notice.quarantine', 'st.notice.unvalued', 'st.notice.more', 'st.count', 'mv.countAll', 'mv.countLoaded', 'mv.notice.adjustSeveral']) has(own, key, 2)
      expect(stockRow({ item: ITEMS.zip, location: named(LOCATIONS.binA2) }).onHand).toBe('0.0000')
    }
  })
})
