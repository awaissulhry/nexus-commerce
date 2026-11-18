import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { LINE_BLK, LINE_RED, order } from '../../_demo/fixtures'
import { groupMadeToMeasure } from '../../mtm-groups'
import { designScreen } from '../fixtures'
import { CONFIRMED_READ, HEADLINE, LINES, PRODUCTION_READ } from './fixtures'
import { bandHealthOf, exFactoryOf, headlineOf, healthInputOf, inWorkOf, lineRowsOf, lineSizesOf, lineStageOf, mergeRead, nothingCutYet, preparingNote, stageStripOf, totalOf, waitingInputOf, walkOf } from './model'

/**
 * F-SA-232 (sales page plan N2; 10-order-page §2.1 O1, O2; review OW-6, OW-7, C-3) — Overview's rules and its cases: the headline
 * sentence per state, the five stages, who acts next, the health only from the reads (never "On track" in the band), "Not counted
 * here" never 0, made to measure grouped per style × colourway, the line's sizes window, and a re-read that keeps the other parts.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)

describe('"Where it is now": one sentence per state', () => {
  it('in production: the plain stage and "1 line ahead"; before: the commercial words; after: shipped and delivered', () => {
    expect(headlineOf(order('IN_PRODUCTION'), HEADLINE)).toEqual({ kind: 'stage', stage: 'SEWING', ahead: { key: 'overview.ahead', params: { count: 1 } } })
    expect(headlineOf(order('IN_PRODUCTION'), { ...HEADLINE, stage: { ...HEADLINE.stage!, ahead: 0 } })).toEqual({ kind: 'stage', stage: 'SEWING', ahead: null })
    expect(headlineOf(order('PENDING_APPROVAL'), HEADLINE)).toEqual({ kind: 'phrase', phrase: { key: 'status.PENDING_APPROVAL' } })
    expect(headlineOf(order('CONFIRMED'), CONFIRMED_READ.headline)).toEqual({ kind: 'phrase', phrase: { key: 'overview.headline.waitingDeposit' } })
    const shipped = order('SHIPPED')
    const words = headlineOf(shipped, HEADLINE)
    expect(words.kind).toBe('phrase')
    if (words.kind === 'phrase') expect(words.phrase.key).toMatch(/^overview\.headline\.(shipped|delivered)$|^status\.SHIPPED$/)
    expect(headlineOf(order('CANCELLED'), HEADLINE)).toEqual({ kind: 'phrase', phrase: { key: 'status.CANCELLED' } })
    // In production with no stage read: "Stage not known yet", never step 1.
    expect(headlineOf(order('IN_PRODUCTION'), { ...HEADLINE, stage: null })).toEqual({ kind: 'unknown' })
  })

  it('the stages: the stage now with its day, the working plan, blocked with why; before any work order Preparing after the deposit', () => {
    const strip = stageStripOf(order('IN_PRODUCTION'), HEADLINE, PRODUCTION_READ.dates, 'en')
    expect(strip).toMatchObject({ stage: 'SEWING', reached: { SEWING: '2026-11-13' }, sewingCounted: true, blocked: null, expected: { CUTTING: '2026-11-10', SEWING: '2026-11-13', QUALITY: '2026-12-10' } })
    const held = stageStripOf(order('IN_PRODUCTION'), { ...HEADLINE, held: true, holds: [{ kind: 'QUALITY', words: { en: 'Quality hold', it: 'Sospensione qualità' }, since: '2026-11-14' }] }, null, 'it')
    expect(held.blocked).toEqual({ why: 'Sospensione qualità' })
    expect(stageStripOf(order('CONFIRMED'), CONFIRMED_READ.headline, null, 'en').stage).toBe('PREPARING')
    expect(preparingNote(order('CONFIRMED'), CONFIRMED_READ.headline)).toEqual({ key: 'overview.afterDeposit' })
    expect(stageStripOf(order('IN_PRODUCTION'), { ...HEADLINE, stage: null }, null, 'en').stage).toBeNull()
  })

  it('who acts next, the ex-factory slip, the bundles as counts only (OW-6), the health from the keeper else the order’s lateness', () => {
    expect(waitingInputOf(HEADLINE, 'it')).toMatchObject({ who: 'US', kind: 'request', what: 'Una richiesta di modifica' })
    expect(waitingInputOf(null, 'en')).toEqual({ who: undefined })
    expect(exFactoryOf(order('IN_PRODUCTION'), HEADLINE)).toEqual({ key: 'overview.exFactoryMoved', params: { date: '2026-12-15', count: 2, days: '+6' } })
    expect(inWorkOf(HEADLINE)).toEqual({ count: 3, stage: 'SEWING' })
    expect(inWorkOf(CONFIRMED_READ.headline)).toBeNull()
    const atRisk = healthInputOf(order('IN_PRODUCTION'), HEADLINE)
    expect(atRisk.computed).toBe('AT_RISK')
    expect(bandHealthOf(atRisk)).toBe(true)
    expect(bandHealthOf(healthInputOf(order('IN_PRODUCTION'), { ...HEADLINE, health: { ...HEADLINE.health!, code: 'ON_TRACK', computed: 'ON_TRACK' } }))).toBe(false)
    // No state kept yet: the order read's own lateness, in the same words.
    const late = healthInputOf({ ...order('IN_PRODUCTION'), daysLate: 3 }, { ...HEADLINE, health: null })
    expect(late).toMatchObject({ computed: 'LATE', daysLate: 3 })
    expect(healthInputOf(order('IN_PRODUCTION'), null).computed).toBeUndefined()
  })
})

describe('"Progress by line": the order’s own pieces', () => {
  it('one row per colour line; a step a site does not count is null ("Not counted here"), never 0; totals the same way', () => {
    const rows = lineRowsOf(LINES, order('IN_PRODUCTION'))
    expect(rows.map((row) => row.id)).toEqual([LINE_BLK, LINE_RED])
    expect(rows[0]!.figures).toEqual({ ordered: 8, cut: 8, sewn: 6, checked: 2, packed: 0, shipped: 0 })
    expect(rows[1]!.figures.sewn).toBeNull()
    expect(totalOf(rows)).toEqual({ ordered: 14, cut: 11, sewn: 6, checked: 2, packed: 0, shipped: 0 })
    expect(totalOf([rows[1]!]).sewn).toBeNull()
    expect(rows[0]!.stage).toBe('SEWING')
    expect(rows[1]!.stage).toBe('CUTTING')
    expect(rows[0]!.styleId).toBe(order('IN_PRODUCTION').lines[0]!.styleId)
    expect(nothingCutYet(lineRowsOf(CONFIRMED_READ.lines!, order('CONFIRMED')))).toBe(true)
    expect(lineRowsOf(CONFIRMED_READ.lines!, order('CONFIRMED')).every((row) => row.notInWorkOrders && row.stage === null)).toBe(true)
  })

  it('a line’s stage from its own counts: nothing cut → Preparing; the first step not done; a step not counted is passed over', () => {
    expect(lineStageOf({ ordered: 10, cut: 0, sewn: 0, checked: 0, packed: 0, shipped: 0 })).toBe('PREPARING')
    expect(lineStageOf({ ordered: 10, cut: 4, sewn: 0, checked: 0, packed: 0, shipped: 0 })).toBe('CUTTING')
    expect(lineStageOf({ ordered: 10, cut: 10, sewn: null, checked: 3, packed: 0, shipped: 0 })).toBe('QUALITY')
    expect(lineStageOf({ ordered: 10, cut: 10, sewn: 10, checked: 10, packed: 10, shipped: 0 })).toBe('READY')
  })

  it('made to measure: the units of one style × colourway are ONE row (R9), never one per unit', () => {
    const unit = (id: string, seq: number, colour: string) => ({ ...LINES[0]!, lineId: id, seq, kind: 'MADE_TO_MEASURE', colourway: { code: colour, name: colour }, ordered: 1, cut: 1, sewn: 0, checked: 0, packed: 0, sizes: [{ size: null, ordered: 1, cut: 1, sewn: 0, checked: 0, packed: 0, shipped: 0, madeExtra: 0, madeExtraWords: null }] })
    const lines = [unit('u1', 30, 'BLK'), unit('u2', 31, 'BLK'), unit('u3', 32, 'RED'), ...LINES]
    const rows = lineRowsOf(lines, order('IN_PRODUCTION'))
    const mtm = rows.filter((row) => row.mtm)
    expect(mtm.map((row) => [row.colourway?.code, row.mtm?.units, row.lineIds.length])).toEqual([
      ['BLK', 2, 2],
      ['RED', 1, 1],
    ])
    expect(mtm[0]!.figures).toMatchObject({ ordered: 2, cut: 2 })
    const grouped = groupMadeToMeasure(lines, (line) => line.lineId)
    expect(grouped.map((entry) => entry.kind)).toEqual(['mtm', 'mtm', 'line', 'line'])
  })

  it('the line’s sizes window: PiecesGrid per size (Checked = released by quality), shipped and the finish forecast; ‹ › walk and wrap', () => {
    const rows = lineRowsOf(LINES, order('IN_PRODUCTION'))
    const sizes = lineSizesOf(rows[0]!, LINES, PRODUCTION_READ.dates, 'DEMO-JKT-01 · Nero')
    expect(sizes.colourway.sizes[0]).toEqual({ size: '48', ordered: 2, cut: 2, sewn: 2, inspected: 1, packed: 0 })
    expect(sizes.sizes.map((size) => [size.size, size.finish])).toEqual([
      ['48', '2026-12-05'],
      ['50', '2026-12-08'],
      ['52', null],
      ['54', null],
    ])
    expect(sizes.units).toBeNull()
    expect(walkOf(rows, LINE_BLK, 1)).toBe(LINE_RED)
    expect(walkOf(rows, LINE_RED, 1)).toBe(LINE_BLK)
    expect(walkOf(rows, LINE_BLK, -1)).toBe(LINE_RED)
    expect(walkOf([], null, 1)).toBeNull()
  })

  it('a re-read of some parts keeps the others (and their withheld keys); the newest time wins', () => {
    const first = { ...PRODUCTION_READ, withheld: ['people', 'dates.forecast'] }
    const next = { ...PRODUCTION_READ, asOf: '2026-11-18T09:50:00Z', parts: ['lines' as const], withheld: [], lines: [LINES[0]!], headline: undefined }
    const merged = mergeRead(first, next)
    expect(merged.lines).toHaveLength(1)
    expect(merged.headline).toEqual(PRODUCTION_READ.headline)
    expect(merged.asOf).toBe('2026-11-18T09:50:00Z')
    expect(merged.withheld).toEqual(['people', 'dates.forecast'])
    expect(mergeRead(null, next)).toBe(next)
  })
})

describe('the Overview cases draw in both languages, never a 0 for a step not counted, never a worker', () => {
  it('in production: the sentence, who acts next, the ex-factory slip, Urgent (customer), the bundles, the stages, "Not counted here"', () => {
    const text = textOf(draw('overview'))
    for (const words of ['Where it is now', 'Sewing · 1 line ahead', 'Waiting on us', 'moved 2×', '+6 d since first promised', 'At risk', 'Urgent (customer)', 'Bundles in work: 3 at Sewing', 'Progress by line', 'Cut and bundled', 'Checked', 'Shipped', 'Not counted here', 'Total · 2 lines', 'Pieces as of']) expect(text, words).toContain(words)
    const it = textOf(draw('overview', 'it'))
    for (const words of ['A che punto è', 'Confezione · 1 riga avanti', 'Avanzamento per riga', 'Tagliati e in fasci', 'Spediti', 'Non contato qui', 'Urgente (cliente)', 'Fasci in lavorazione: 3 a Confezione']) expect(it, words).toContain(words)
    expect(text).not.toMatch(/\b(?:operator|operatore|station|postazione)\b/i)
  })

  it('before any work order: Confirmed · waiting for the deposit, Preparing with why, "Not in work orders yet", "Nothing cut yet"', () => {
    const text = textOf(draw('overview-confirmed'))
    for (const words of ['Confirmed · waiting for the deposit', 'Work orders are made after the deposit', 'Not in work orders yet', 'Nothing cut yet']) expect(text, words).toContain(words)
  })

  it('loading says it reads (no figure), a failed read says so in this part only with Try again', () => {
    expect(textOf(draw('overview-loading'))).not.toMatch(/Total · /)
    const failed = textOf(draw('overview-failed'))
    expect(failed).toContain('Try again')
    expect(failed).toContain('Lines') // the rest of the page stays: the tabs
  })

  it('every overview word exists in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['tab.overview', 'tab.attention', 'overview.where', 'overview.progress', 'overview.progressHint', 'overview.notInWorkOrders', 'overview.afterDeposit', 'overview.piecesAsOf', 'overview.headline.waitingDeposit', 'overview.headline.shipped', 'overview.headline.delivered', 'overview.fact.who', 'overview.fact.exFactory', 'overview.fact.health', 'overview.fact.customer', 'overview.fact.inWork', 'overview.col.line', 'overview.sizes.label', 'overview.sizes.finish', 'overview.sizes.units', 'overview.sizes.openLines']) expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const key of ['overview.ahead', 'overview.bundles', 'overview.total', 'overview.madeExtra', 'mtm.units']) expect(t(key, { count: 2, stage: 'x' }), `${locale}: ${key}`).not.toBe(key)
      const p = createTranslator(locale, messagesFor(locale, ['production']).production!)
      expect(p('parts.pieces.stages.SHIPPED')).not.toBe('parts.pieces.stages.SHIPPED')
    }
  })
})
