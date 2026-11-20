import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LINE_BLK, LINE_RED, order } from '../../_demo/fixtures'
import { groupMadeToMeasure } from '../../mtm-groups'
import { CONFIRMED_READ, LINES, PRODUCTION_READ } from './fixtures'
import { lineRowsOf, lineSizesOf, totalOf } from './progress'
// ---- F-OO-121 ----
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { base } from '../fixtures'
import { ready, workActsRead } from './fixtures'
import { figureFaceOf, LINE_PILLS_SHOWN, linePillsOf, madeExtraSizesOf, madeExtraSizesText, pillToneOf, stylePictureHref, type LineRow } from './progress'
import { ProgressCard } from '../view/overview/ProgressCard'
import type { OrderProduction, ProductionLine } from './api'
import type { Order } from '../../api'
import type { OrderRecordModel } from '../record-model'
// ---- end F-OO-121

/**
 * F-OO-100 (order overview lane: one file per section) — "Progress by line"'s rules, moved with progress.ts out of
 * overview.vitest.test.ts unchanged (F-SA-232: "Not counted here" never 0, made to measure grouped per style × colourway, the line's
 * sizes window).
 * F-OO-121 (10-design §2.2): the clean line cell — no stage word per line, a line with no work order "—" with no sub, at most two
 * pills in their order, the made-extra pill in the API's words (B-OO-015), a missing picture said with the style's door.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('"Progress by line": the order’s own pieces', () => {
  it('one row per colour line; a step a site does not count is null ("Not counted here"), never 0; totals the same way', () => {
    const rows = lineRowsOf(LINES, order('IN_PRODUCTION'))
    expect(rows.map((row) => row.id)).toEqual([LINE_BLK, LINE_RED])
    expect(rows[0]!.figures).toEqual({ ordered: 8, cut: 8, sewn: 6, checked: 2, packed: 0, shipped: 0 })
    expect(rows[1]!.figures.sewn).toBeNull()
    expect(totalOf(rows)).toEqual({ ordered: 14, cut: 11, sewn: 6, checked: 2, packed: 0, shipped: 0 })
    expect(totalOf([rows[1]!]).sewn).toBeNull()
    expect(rows[0]!.styleId).toBe(order('IN_PRODUCTION').lines[0]!.styleId)
    // F-OO-121: a row says no stage of its own (the order's stage is "Where it is now"); the lines in work orders are not quiet.
    expect(rows.every((row) => !('stage' in row) && !row.quiet)).toBe(true)
    expect(rows.map((row) => row.inWorkOrders)).toEqual([8, 6])
    expect(lineRowsOf(CONFIRMED_READ.lines!, order('CONFIRMED')).every((row) => row.notInWorkOrders && row.quiet && row.inWorkOrders === 0)).toBe(true)
  })

  it('F-OO-121: a figure cell — the count; "—" alone on a quiet line (a step at 0 or not counted); "Not counted here" elsewhere', () => {
    expect(figureFaceOf(4, false, 'cut')).toEqual({ kind: 'count', value: 4 })
    expect(figureFaceOf(0, false, 'cut')).toEqual({ kind: 'count', value: 0 })
    expect(figureFaceOf(null, false, 'sewn')).toEqual({ kind: 'notCounted' })
    expect(figureFaceOf(0, true, 'cut')).toEqual({ kind: 'none' })
    expect(figureFaceOf(null, true, 'sewn')).toEqual({ kind: 'none' })
    // Ordered is always its count; a piece shipped from stock stays its number on a quiet line.
    expect(figureFaceOf(7, true, 'ordered')).toEqual({ kind: 'count', value: 7 })
    expect(figureFaceOf(2, true, 'shipped')).toEqual({ kind: 'count', value: 2 })
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

  it('the line’s sizes window: PiecesGrid per size (Checked = released by quality), shipped and the finish forecast', () => {
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
    // F-OO-121: walkOf went (nothing called it but a test): the window's ‹ › walk the rows in the table's order (the DS DetailModal's nav).
    expect(read('./progress.ts')).not.toContain('export function walkOf(')
    expect(read('../view/overview/ProgressCard.tsx')).toContain('nav={{ ids: rows.map((entry) => entry.id), current: row.id')
  })
})

// ---- F-OO-121 (10-design §2.2): the line's pills, the quiet line, the made-extra words, the missing picture ----------------------
/** The demo order in production with the red line closed short or not, its read with work orders (cells), a late forecast and extra. */
function scene(over: { closedRed?: boolean; redInWork?: number } = {}): { order: Order; read: OrderProduction } {
  const value = order('IN_PRODUCTION')
  const orderValue: Order = over.closedRed ? { ...value, lines: value.lines.map((line) => (line.id === LINE_RED ? { ...line, closedShort: { quantity: 2, at: null, byId: null, reason: 'Pelle finita.', reasonCode: 'CUSTOMER_REQUEST' } } : line)) } : value
  const acts = workActsRead({ manage: true, release: true, hold: true }) // WO-00022 (held) makes the red cells; WO-00021 the black
  const lines = LINES.map((line) => (line.lineId === LINE_RED ? { ...line, inWorkOrders: over.redInWork ?? line.inWorkOrders, madeExtra: 1, sizes: line.sizes.map((size) => (size.size === '50' ? { ...size, madeExtra: 1 } : size)) } : line))
  const dates = { ...PRODUCTION_READ.dates!, forecast: PRODUCTION_READ.dates!.forecast!.map((entry) => (entry.lineId === LINE_RED ? { ...entry, risk: 'LATE' } : entry)) }
  return { order: orderValue, read: { ...acts, lines, dates } }
}
const rowOf = (lines: readonly ProductionLine[] | undefined, value: Order, id: string): LineRow => lineRowsOf(lines ?? [], value).find((row) => row.id === id)!

describe('F-OO-121: a line’s pills — at most two in the cell, in their order; every one in the window', () => {
  it('the order: closed short, on hold, not / partly in work orders, made extra, late — capped at two in the cell', () => {
    const { order: value, read: production } = scene({ redInWork: 4 })
    const red = rowOf(production.lines, value, LINE_RED)
    const input = { order: value, read: production, today: '2026-12-24' }
    const all = linePillsOf(red, input, Number.POSITIVE_INFINITY)
    expect(all.map((pill) => pill.kind)).toEqual(['onHold', 'inWork', 'madeExtra', 'late'])
    expect(all[1]).toEqual({ kind: 'inWork', done: 4, total: 6 })
    expect(all[2]).toEqual({ kind: 'madeExtra', sizes: [{ size: '50', count: 1 }] })
    // Late: the days past the line's own promise (the red line's 22/12), else the order's.
    expect(all[3]).toEqual({ kind: 'late', days: 2 })
    expect(LINE_PILLS_SHOWN).toBe(2)
    expect(linePillsOf(red, input).map((pill) => pill.kind)).toEqual(['onHold', 'inWork'])
    // The black line: in work orders in full, not held, nothing made extra, on time — no pill.
    expect(linePillsOf(rowOf(production.lines, value, LINE_BLK), input, Number.POSITIVE_INFINITY)).toEqual([])
  })

  it('a line closed short leads, and its "In work orders" is not said (the pill says it); before any work order: "Not in work orders yet"', () => {
    const { order: value, read: production } = scene({ closedRed: true, redInWork: 4 })
    const red = rowOf(production.lines, value, LINE_RED)
    expect(linePillsOf(red, { order: value, read: production, today: '2026-12-24' }, Number.POSITIVE_INFINITY).map((pill) => pill.kind)).toEqual(['closedShort', 'onHold', 'madeExtra', 'late'])
    expect(linePillsOf(red, { order: value, read: production, today: '2026-12-24' })).toEqual([{ kind: 'closedShort', count: 2 }, { kind: 'onHold' }])
    const confirmed = order('CONFIRMED')
    const quiet = lineRowsOf(CONFIRMED_READ.lines!, confirmed)
    expect(quiet.map((row) => linePillsOf(row, { order: confirmed, read: CONFIRMED_READ, today: '2026-10-29' }))).toEqual([[{ kind: 'notInWorkOrders' }], [{ kind: 'notInWorkOrders' }]])
    // No read yet: nothing the read would give is claimed (only the order read's closed short).
    expect(linePillsOf(red, { order: value, read: null, today: '2026-12-24' })).toEqual([{ kind: 'closedShort', count: 2 }])
    // Late with no promise known: the plain word, no days.
    const noPromise: Order = { ...value, promiseDate: null, lines: value.lines.map((line) => ({ ...line, promiseDate: null, closedShort: null })) }
    expect(linePillsOf(rowOf(production.lines, noPromise, LINE_RED), { order: noPromise, read: production, today: '2026-12-24' }, Number.POSITIVE_INFINITY).at(-1)).toEqual({ kind: 'late', days: null })
  })

  it('tones: late is danger, on hold and made extra warn, the plain facts are neutral', () => {
    expect(pillToneOf({ kind: 'late', days: 2 })).toBe('danger')
    expect(pillToneOf({ kind: 'onHold' })).toBe('warning')
    expect(pillToneOf({ kind: 'madeExtra', sizes: [] })).toBe('warning')
    for (const kind of ['notInWorkOrders', 'closedShort', 'inWork'] as const) expect(pillToneOf({ kind, count: 1, done: 1, total: 2 } as never), kind).toBe('neutral')
  })

  it('made extra: one wording with the API’s (B-OO-015, T01 #1768) — "N <size> more than ordered: cut or planned to cut", en + it', () => {
    const sizes = madeExtraSizesOf({ lineIds: [LINE_RED] }, scene().read.lines!)
    expect(sizes).toEqual([{ size: '50', count: 1 }])
    expect(madeExtraSizesText([{ size: 'M', count: 4 }])).toBe('4 M')
    expect(madeExtraSizesText([{ size: '48', count: 1 }, { size: '50', count: 2 }, { size: null, count: 1 }])).toBe('1 48 · 2 50 · 1')
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    // The API's MADE_EXTRA_WORDS.madeExtra(4, 'M') (apps/factory-api/src/modules/sales/orders/made-extra.ts), word for word.
    expect(en('progress.madeExtra', { sizes: '4 M' })).toBe('4 M more than ordered: cut or planned to cut')
    expect(it('progress.madeExtra', { sizes: '4 M' })).toBe("4 M in più dell'ordine: tagliati o da tagliare")
    // The old words went from the catalogue and from the card.
    expect(en('overview.madeExtra', { count: 2 })).toBe('overview.madeExtra')
    expect(read('../view/overview/ProgressCard.tsx')).not.toContain("t('overview.madeExtra'")
  })

  it('the words exist in both languages; the ones the clean cell left unused went (hint, the stage line, the old made-extra)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['progress.noPicture', 'progress.addPicture']) expect(t(key), `${locale}: ${key}`).not.toBe(key)
      expect(t('progress.inWork', { done: 4, total: 7 }), locale).toBe(locale === 'en' ? 'In work orders: 4 of 7' : 'Negli ordini di lavoro: 4 di 7')
      expect(t('progress.addPictureOf', { name: 'X' }), locale).not.toBe('progress.addPictureOf')
      for (const key of ['overview.progressHint', 'overview.lineName']) expect(t(key, { seq: 1, stage: 'x' }), `${locale}: ${key}`).toBe(key)
      const r = createTranslator(locale, messagesFor(locale, ['record-picture'])['record-picture']!)
      expect(r('broken'), locale).toBe(locale === 'en' ? 'The picture file is missing' : "Manca il file dell'immagine")
    }
    // RecordPicture (every list): only its title says a file that does not answer; nothing else of the part changed.
    const picture = read('../../../../../lib/record-picture/view/RecordPicture.tsx')
    expect(picture).toContain("const missing = broken ? t('broken') : undefined")
    expect(picture).toContain('title={missing ?? name}')
  })
})

describe('F-OO-121: the card draws the clean line cell', () => {
  const draw = (model: OrderRecordModel, value: Order, locale: 'en' | 'it' = 'en') => render(createElement(ProgressCard, { order: value, model }), locale)
  const confirmed = order('CONFIRMED')
  const production = order('IN_PRODUCTION')

  it('no stage word per line, no hint, no "Nothing cut yet"; "Line 10" and "Pieces as of" in the head', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw(base('sales', production, { tab: 'overview', production: ready() }).record, production, locale))
      expect(text).toContain(locale === 'en' ? 'Line 10' : 'Riga 10')
      expect(text).not.toMatch(locale === 'en' ? /Line 10 · (?:Sewing|Cutting|Preparing)/ : /Riga 10 · (?:Confezione|Taglio|Preparazione)/)
      expect(text).toContain(locale === 'en' ? 'Pieces as of' : 'Pezzi alle')
      expect(text).not.toContain(locale === 'en' ? "This order's own pieces" : 'I pezzi di questo ordine')
    }
    const source = read('../view/overview/ProgressCard.tsx')
    for (const gone of ['overview.progressHint', 'parts.pieces.nothingCut', 'overview.lineName', 'nothingCutYet']) expect(source, gone).not.toContain(gone)
  })

  it('a line with no work order: "—" with no sub in every step — never 0, never "Not counted here" (office only)', () => {
    const html = draw(base('sales', confirmed, { tab: 'overview', production: ready(CONFIRMED_READ) }).record, confirmed)
    const text = textOf(html)
    expect(text).not.toContain('Not counted here')
    expect(text).toContain('Not in work orders yet')
    // Each line: its Ordered count, then "—" for Cut, Sewn, Checked, Packed and Shipped; the total too.
    expect(html.match(/<td[^>]*><span>—<\/span><\/td>/g)?.length).toBe(3 * 5)
    expect(text).not.toMatch(/Total · 2 lines 14 0/)
    // A line in work orders keeps "Not counted here" where its site counts no such step (the red line's sewing).
    expect(textOf(draw(base('sales', production, { tab: 'overview', production: ready() }).record, production))).toContain('Not counted here')
  })

  it('a line with no picture says so; the style’s door only for who may manage styles (product.styles.manage)', () => {
    const plain = textOf(draw(base('sales', production, { tab: 'overview', production: ready() }).record, production))
    expect(plain).toContain('No picture yet')
    expect(plain).not.toContain('Add on the style ›')
    const html = draw(base('sales', production, { tab: 'overview', production: ready(), stylesManage: true }).record, production, 'it')
    expect(textOf(html)).toContain('Ancora nessuna immagine')
    expect(textOf(html)).toContain('Aggiungila nel modello ›')
    expect(html).toContain(`href="${stylePictureHref('/w/DEMO', production.lines[0]!.styleId)}"`)
    expect(stylePictureHref('/w/DEMO', 'a b')).toBe('/w/DEMO/products/styles/a%20b')
    // The door is a link beside the button that opens the sizes, never inside it.
    expect(html).not.toMatch(/<button[^>]*class="fw-so-lineopen"(?:(?!<\/button>)[\s\S])*<a /)
    const container = read('../OrderRecord.tsx')
    expect(container).toContain("stylesManage: session.permissions.includes('product.styles.manage')")
  })

  it('two pills at most in the cell (each keeps its words in its title); the css lines them up under the name', () => {
    const { order: value, read: production2 } = scene({ redInWork: 4 })
    const html = draw(base('manager', value, { tab: 'overview', production: ready(production2) }).record, value)
    expect(html).toMatch(/<span class="nds-tag warning is-truncated" title="On hold">On hold<\/span><span class="nds-tag neutral is-truncated" title="In work orders: 4 of 6">/)
    expect(textOf(html)).not.toContain('more than ordered')
    const css = read('../view/overview/progress.css')
    expect(css).toContain('grid-template-columns: subgrid')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})
// ---- end F-OO-121
