import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { order, LINE_BLK, LINE_RED } from '../../_demo/fixtures'
import { HEADLINE, PRODUCTION_READ } from '../overview/fixtures'
import { readyDayOf } from '../overview/dates'
import { keyDatesOf, readyTileOf } from './dates'
import { byLineOf, onTimeOf } from './by-line'

// F-PT-201 / F-PT-203 (order PRODUCTION tab, W2): the key dates — ONE ready day (the line forecast, B13), "Customer sees" only when
// the customer's sharing shows the plan's days (B8); by line — short / spare (B7), worst first, charge lines out (B9), withheld (B10).

const so = order('IN_PRODUCTION')
const dates = PRODUCTION_READ.dates!

describe('F-PT-201: the key dates', () => {
  it('Plan says ready = the latest line forecast; without the forecast the published finish; a line nobody plans: no day', () => {
    expect(readyDayOf(dates)).toBe('2026-12-29')
    expect(readyDayOf({ ...dates, forecast: null })).toBe('2026-12-10')
    expect(readyDayOf({ ...dates, forecast: [{ ...dates.forecast![0]!, finish: null }, dates.forecast![1]!] })).toBeNull()
  })

  it('the tile: the day and its gap to the promise (+ after); withheld (no planning.promise.view) said as such, never "—"', () => {
    expect(readyTileOf(PRODUCTION_READ, dates, '2026-12-15')).toEqual({ kind: 'day', date: '2026-12-29', days: 14 })
    expect(readyTileOf({ withheld: ['dates.forecast'] }, { ...dates, forecast: null }, '2026-12-15')).toEqual({ kind: 'withheld' })
    expect(readyTileOf(PRODUCTION_READ, { ...dates, forecast: [{ ...dates.forecast![0]!, finish: null }] }, '2026-12-15')).toEqual({ kind: 'none' })
    // Not read yet: no claim at all (never "not shown to you" while the read is on its way).
    expect(readyTileOf(null, null, '2026-12-15')).toEqual({ kind: 'reading' })
  })

  it('the promise with its moves and first day; Customer sees the plan days only from GATES on; not said when the read has no level', () => {
    const keys = keyDatesOf(so, PRODUCTION_READ, HEADLINE)
    expect(keys.promised).toEqual({ date: '2026-12-15', moves: 2, first: '2026-12-09' })
    expect(keys.sees).toEqual({ kind: 'unknown' })
    const gates = keyDatesOf(so, { ...PRODUCTION_READ, dates: { ...dates, customer: { level: 'GATES' } } }, HEADLINE)
    expect(gates.sees).toEqual({ kind: 'days', cut: '2026-11-10', sew: '2026-11-13', finish: '2026-12-10' })
    expect(keyDatesOf(so, { ...PRODUCTION_READ, dates: { ...dates, customer: { level: 'STATUS' } } }, HEADLINE).sees).toEqual({ kind: 'promiseOnly' })
    expect(keys.shipped.shipments).toEqual([])
  })
})

describe('F-PT-203: by line', () => {
  it('worst first (the most short), each its own day or the order’s, the forecast’s source; short / spare in days (B7)', () => {
    const view = byLineOf(so, dates, false)
    expect(view.rows.map((row) => row.lineId)).toEqual([LINE_RED, LINE_BLK])
    expect(onTimeOf(view.rows[0]!)).toEqual({ kind: 'short', days: 7 })
    expect(onTimeOf(view.rows[1]!)).toEqual({ kind: 'spare', days: 7 })
    expect(view.rows[1]!.ready?.source).toBe('BOARD')
    expect(view.rows[0]!.promised).toEqual({ date: '2026-12-22', own: true })
    expect(view.rows[1]!.promised?.own).toBe(false)
  })

  it('sizes that end on different days fold under the line ("48, 50 …"); one day: nothing to fold', () => {
    const view = byLineOf(so, { forecast: [{ ...dates.forecast![0]!, sizes: [{ size: '48', finish: '2026-12-03', risk: null }, { size: '50', finish: '2026-12-03', risk: null }, { size: '52', finish: '2026-12-03', risk: null }, { size: '54', finish: '2026-12-11', risk: null }] }] }, false)
    const black = view.rows.find((row) => row.lineId === LINE_BLK)!
    expect(black.sizes).toEqual([{ sizes: '48–52', finish: '2026-12-03' }, { sizes: '54', finish: '2026-12-11' }])
  })

  it('charge lines (FEE) out, counted; the forecast withheld: said once, no ready day per row (B10)', () => {
    const fee = { ...so, lines: [...so.lines, { ...so.lines[0]!, id: 'fee-1', seq: 90, kind: 'FEE' }] }
    expect(byLineOf(fee, dates, false).charges).toBe(1)
    expect(byLineOf(fee, dates, false).rows.some((row) => row.lineId === 'fee-1')).toBe(false)
    const held = byLineOf(so, { forecast: null }, true)
    expect(held.withheld).toBe(true)
    expect(held.rows.every((row) => row.ready === null)).toBe(true)
  })
})

describe('F-PT-201: the promise dialog says what really happens (B14) and offers no charge line (B9); the words', () => {
  it('the dialog', () => {
    const dialogs = readFileSync(new URL('../view/Dialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain("<p className=\"fw-so-hint\">{t('productionTab.promise.hint')}</p>")
    expect(dialogs).toContain("const promiseLines = order.lines.filter((line) => line.kind !== 'FEE')")
    expect(dialogs).not.toContain("t('promise.tellCustomer')")
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    expect(en('productionTab.promise.hint')).toBe('The customer gets a notice in the portal (and an e-mail if they chose it). The floor is not told.')
  })

  it('every word in it + en; the page banner leaves the re-promise to Dates & plan on this tab', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['productionTab.dates.title', 'productionTab.dates.answerPromised', 'productionTab.dates.answerReady', 'productionTab.dates.answerNoPromise', 'productionTab.dates.asked', 'productionTab.dates.promised', 'productionTab.dates.neverMoved', 'productionTab.dates.moved', 'productionTab.dates.first', 'productionTab.dates.readyWithheld', 'productionTab.dates.sees', 'productionTab.dates.seesDays', 'productionTab.dates.seesPromise', 'productionTab.dates.shipped', 'productionTab.dates.nothingShipped', 'productionTab.dates.planning', 'productionTab.dates.partPlan', 'productionTab.byLine.title', 'productionTab.byLine.charges', 'productionTab.byLine.sizes', 'productionTab.byLine.sizeDay', 'productionTab.byLine.changeLine', 'productionTab.byLine.more'])
        expect(t(key, { date: 'd', cut: 'c', sew: 's', finish: 'f', count: 2, sizes: 'x', seq: 10 }), `${locale} ${key}`).not.toMatch(/^productionTab\.|\{/)
    }
    const view = readFileSync(new URL('../view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{model.tab !== 'production' && <RePromiseNotices model={model.links} actions={actions?.links} />}")
    const section = readFileSync(new URL('../view/production/DatesSection.tsx', import.meta.url), 'utf8')
    expect(section).toContain('<RePromiseNotices model={model.links} actions={actions?.links} />')
  })
})
