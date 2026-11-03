import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../../../lib/i18n/provider'
import { messagesFor } from '../../../lib/i18n/messages'
import type { HideRow } from '../../_shared/stock/api'
import { HIDE_ROWS } from './demo/fixtures'
import { CUTTING_YIELD, FIND_ANSWER, findModel, GRADE_MIX, LEATHER_AREA_ONLY, LEATHER_DASHBOARD, LEATHER_VALUE } from './demo/w2b/fixtures'
import { areaBarsOf, areaItems, areaWords, articleOfKey, mixItems, mixKeys, onHoldItems, readOpen, remnantLines, writeOpen, yieldItems, yieldRange } from './dashboard/dashboard-model'
import { areaTyped, chosenFigure, emptyDraft, findHeldKey, findProblem, findQueryOf, mixesShades, proposedIds, reserveHeldKey, rowsOf } from './find/find-model'
import { movable, moveHeldKey, moveHides, moveSelectionHeld } from './move/move-model'
import { filtersOf, FILTER_PARAM } from './model'
import { designScreen as dashboardScreen } from './dashboard/fixtures'
import { designScreen as listScreen } from './list/fixtures'

/**
 * Hides in depth (B-W2b-131), pure: the leather dashboard's panels (bars in m², written in their own unit, money only with the
 * cost grain, yield per style and supplier lot), Find hides for a job (the query, the list, the need, mixing shades, why
 * Reserve is held, a refusal in our words), Move N hides (left out with why), the article filter in the address; and every
 * design case of SCR-134 and SCR-200 drawn in both languages without a key on screen.
 */

const unit = (uom: string) => ({ FT2: 'ft²', M2: 'm²', DM2: 'dm²' })[uom] ?? uom
const say = (key: string, params?: Readonly<Record<string, string | number>>) => `${key}${params ? JSON.stringify(params) : ''}`

describe('the leather dashboard (SCM-285)', () => {
  it('writes an area in its unit with the other unit beside it, and bars compare in m²', () => {
    expect(areaWords('51.8000', 'FT2', unit, 'en')).toBe('51.8 ft² (4.8 m²)')
    expect(areaWords('10.0000', 'M2', unit, 'it')).toBe('10 m² (107,6 ft²)')
    const bars = areaBarsOf(LEATHER_VALUE)
    expect(bars.map((bar) => [bar.item.code, bar.colour?.code, bar.hides])).toEqual([
      ['DEMO-LEA-01', 'BLK', 9],
      ['DEMO-LEA-01', 'RED', 3],
      ['DEMO-LEA-05', 'GRY', 2],
    ])
    expect(bars[0]!.m2).toBeCloseTo(38.3225, 4)
  })

  it('shows the area value only when the read carries it (the cost grain)', () => {
    const money = (minor: number, currency: string) => `${currency} ${minor / 100}`
    expect(areaItems(areaBarsOf(LEATHER_VALUE), 'value', unit, 'en', say, money)[0]!.valueText).toBe('EUR 1732.5')
    const blind = areaItems(areaBarsOf(LEATHER_AREA_ONLY), 'value', unit, 'en', say, money)
    expect(blind.every((item) => item.value === null && item.valueText === '—')).toBe(true)
    expect(JSON.stringify(areaBarsOf(LEATHER_AREA_ONLY))).not.toMatch(/"value":\d/)
  })

  it('stacks each lot per grade (ungraded last), counts remnants as pieces, holds per cause, yield per style and lot', () => {
    expect(mixKeys(GRADE_MIX, 'en', say).map((key) => key.id)).toEqual(['A', 'B', 'C', 'ungraded'])
    const nappa = mixItems(GRADE_MIX, unit, 'en', say)[0]!
    expect(Object.keys(nappa.parts ?? {})).toEqual(['A', 'B', 'ungraded'])
    expect(remnantLines(GRADE_MIX, unit, 'en', say)).toHaveLength(2)
    const holds = onHoldItems(LEATHER_DASHBOARD, unit, 'en', say)
    expect(holds[0]!.parts).toMatchObject({ qualityHold: 0 })
    const yields = yieldItems(CUTTING_YIELD, 'en', say)
    expect(yields.map((item) => item.tone ?? null)).toEqual([null, 'warning', 'warning'])
    expect(JSON.stringify(yields)).not.toMatch(/cutter|worker/i)
  })

  it('reads the last 30 days and keeps the open state per person, even without storage', () => {
    const range = yieldRange(new Date('2026-11-30T12:00:00.000Z'))
    expect(range).toEqual({ from: '2026-10-31T12:00:00.000Z', to: '2026-11-30T12:00:00.000Z' })
    const kept = new Map<string, string>()
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) }
    expect(readOpen(storage)).toBe(true)
    writeOpen(storage, false)
    expect(readOpen(storage)).toBe(false)
    expect(readOpen({ getItem: () => { throw new Error('blocked') } })).toBe(true)
    expect(() => writeOpen({ setItem: () => { throw new Error('blocked') } }, true)).not.toThrow()
  })

  it('puts an article and its colour in the address, and the key back', () => {
    expect(filtersOf(new URLSearchParams('item=i1&colour=c1&lot=l1'))).toMatchObject({ itemId: 'i1', itemColourId: 'c1', lotId: 'l1' })
    expect(FILTER_PARAM.itemColourId).toBe('colour')
    expect(articleOfKey('i1|')).toEqual({ itemId: 'i1', colourId: null })
  })
})

describe('Find hides for a job (SCM-257, SCM-206)', () => {
  it('asks by a work order or by an article, and holds Find until it can', () => {
    expect(areaTyped('44,5')).toBe('44.5')
    expect(areaTyped('0')).toBeNull()
    expect(findQueryOf(emptyDraft('workOrder'), 's1', [])).toBeNull()
    expect(findQueryOf({ ...emptyDraft('workOrder'), workOrderId: 'w1', area: '44', uom: 'M2' }, 's1', [])).toMatchObject({ workOrderId: 'w1', siteId: null, area: '44', uom: 'M2' })
    const articles = [{ key: 'i1|c1', itemId: 'i1', itemColourId: 'c1', label: 'x', hides: 1, left: '1', uom: 'FT2' as const }]
    expect(findQueryOf({ ...emptyDraft('article'), articleKey: 'i1|c1' }, 's1', articles)).toMatchObject({ itemId: 'i1', itemColourId: 'c1', siteId: 's1', area: null })
    expect(findHeldKey({ draft: emptyDraft('article'), siteId: null, sites: [], articles: { value: [], problem: null } })).toBe('find.held.pickArticle')
    expect(findHeldKey({ draft: { ...emptyDraft('article'), articleKey: 'i1|c1' }, siteId: null, sites: [{ id: 'a', code: 'A', name: 'A' }, { id: 'b', code: 'B', name: 'B' }], articles: { value: articles, problem: null } })).toBe('find.held.pickSite')
    expect(findHeldKey({ draft: { ...emptyDraft('workOrder'), workOrderId: 'w1', area: 'abc' }, siteId: 's1', sites: [], articles: { value: [], problem: null } })).toBe('find.held.area')
  })

  it('lists the proposed lot first, the others after, out of shade apart, and sums the chosen against the need', () => {
    const rows = rowsOf(FIND_ANSWER)
    expect(rows.map((row) => [row.proposedLot, row.shadeWarning, row.apart])).toEqual([
      [true, false, false],
      [true, false, false],
      [true, false, false],
      [true, false, false],
      [false, true, false],
      [false, true, false],
      [false, true, true],
    ])
    const proposal = proposedIds(FIND_ANSWER)
    expect(chosenFigure(FIND_ANSWER, proposal)).toMatchObject({ count: 4, need: 168, covers: true, short: null })
    expect(chosenFigure(FIND_ANSWER, proposal.slice(0, 2)).short).toBeCloseTo(61, 4)
  })

  it('holds Reserve while hides mix shades, until the override gives a reason', () => {
    const proposal = proposedIds(FIND_ANSWER)
    const other = FIND_ANSWER.lots[1]!.hides[0]!.hideId
    expect(mixesShades(FIND_ANSWER, proposal)).toBe(false)
    expect(mixesShades(FIND_ANSWER, [...proposal, other])).toBe(true)
    expect(mixesShades({ ...FIND_ANSWER, rule: 'OFF' }, [...proposal, other])).toBe(false)
    expect(reserveHeldKey(findModel())).toBeNull()
    expect(reserveHeldKey(findModel({ chosen: [...proposal, other] }))).toBe('find.held.shadeMix')
    expect(reserveHeldKey(findModel({ chosen: [...proposal, other], can: { reserve: true, override: true, workOrders: true, grades: true } }))).toBe('find.held.overrideReason')
    expect(reserveHeldKey(findModel({ chosen: [...proposal, other], can: { reserve: true, override: true, workOrders: true, grades: true }, overrideReason: 'Agreed' }))).toBeNull()
    expect(reserveHeldKey(findModel({ can: { reserve: false, override: false, workOrders: true, grades: true } }))).toBe('find.held.noReserve')
    expect(reserveHeldKey(findModel({ draft: { ...emptyDraft('article'), workOrderId: null } }))).toBe('find.held.workOrder')
  })

  it('names the hides a shade refusal is about, in our words', async () => {
    const { ApiError } = await import('../../../lib/api/errors')
    const proposal = proposedIds(FIND_ANSWER)
    const error = new ApiError('conflict', 409, 'refused', 'x', null, [{ path: 'body/lines/1/refusal/SHADE_LOT', message: 'x' }] as never)
    const phrase = findProblem(error, proposal, FIND_ANSWER)
    expect(phrase.key).toBe('find.refusal.SHADE_LOT')
    expect(phrase.params).toMatchObject({ count: 1, hides: FIND_ANSWER.lots[0]!.hides[1]!.hideCode })
  })
})

describe('Move N hides', () => {
  it('moves each hide whole from its place, leaves out what is not at a place of the site, and holds with the reason', () => {
    const rows: HideRow[] = [HIDE_ROWS[1]!, HIDE_ROWS[2]!, HIDE_ROWS[4]!]
    const hides = moveHides(rows)
    expect(hides.map((hide) => hide.why?.key ?? null)).toEqual([null, 'move.why.notHere', 'move.why.gone'])
    const model = { hides, toLocationId: null, posting: false, results: null }
    expect(moveHeldKey(model)).toBe('move.held.place')
    expect(movable({ hides, toLocationId: hides[0]!.from!.id })).toHaveLength(0)
    expect(moveHeldKey({ ...model, toLocationId: hides[0]!.from!.id })).toBe('move.held.none')
    expect(moveHeldKey({ ...model, toLocationId: 'elsewhere' })).toBeNull()
    expect(moveSelectionHeld(rows, false)).toBe('move.held.noRight')
    expect(moveSelectionHeld([], true)).toBe('move.held.pick')
  })
})

describe('the design cases of SCR-134 and SCR-200 (W2b parts)', () => {
  for (const screen of [dashboardScreen, listScreen])
    for (const locale of ['en', 'it'] as const)
      it(`${screen.screen} draws every case in ${locale} without a key on screen`, () => {
        const messages = messagesFor(locale, ['shell'])
        for (const item of screen.cases) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages }, createElement(screen.view as never, { model: item.model })))
          expect(html, `${screen.screen}/${item.id}`).not.toMatch(/\b(dash|find|move|rem|band|photo|filter|tile)\.[a-z][A-Za-z.]*[A-Za-z]\b(?![^<]*>)/)
        }
      })
})
