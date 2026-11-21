import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
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
// ---- F-OO-126 ----
import { WORK_ORDERS } from '../../_demo/fixtures'
import { NO_WORK_READ, QUALITY_READ, WORK, WORK_READ } from './fixtures'
import { lineFinalsOf, lineWorkOf } from './progress'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'

// The DS DetailModal opens in a portal after mount; drawn on the server it is a section in place (as lines-held.vitest draws Modal).
vi.mock('../../../../../lib/i18n/ds-parts', async (original) => {
  const actual = await original<typeof import('../../../../../lib/i18n/ds-parts')>()
  const { createElement: h } = await import('react')
  const DetailModal = ({ open, title, subtitle, meta, actions, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; meta?: unknown; actions?: unknown; children?: unknown; footer?: unknown }) =>
    open ? h('section', { role: 'dialog', 'data-detail': '' }, h('h2', null, title as never), h('p', { 'data-subtitle': '' }, subtitle as never), meta as never, h('div', { 'data-actions': '' }, actions as never), children as never, h('footer', null, footer as never)) : null
  return { ...actual, DetailModal }
})
// ---- end F-OO-126
// ---- F-OO-122 (its list moved to ../line-moves.ts with F-OL-01 (c): line-moves.vitest.test.ts holds it) ----
import { abilitiesOf } from '../../model'
// ---- end F-OO-122

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

  it('made extra: one wording with the API’s (B-OO-015, T01 #1768; walk follow-up: the size first) — "Size <size>: N more than ordered (cut or planned to cut)", en + it', () => {
    const sizes = madeExtraSizesOf({ lineIds: [LINE_RED] }, scene().read.lines!)
    expect(sizes).toEqual([{ size: '50', count: 1 }])
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    const sizeEn = (size: string, count: number) => en('progress.extraSize', { size, count })
    expect(madeExtraSizesText([{ size: 'M', count: 4 }], sizeEn)).toBe('Size M: 4')
    expect(madeExtraSizesText([{ size: '48', count: 1 }, { size: '50', count: 2 }, { size: null, count: 1 }], sizeEn)).toBe('Size 48: 1 · Size 50: 2 · 1')
    // The API's MADE_EXTRA_WORDS.madeExtra(4, 'M') (apps/factory-api/src/modules/sales/orders/made-extra.ts), word for word.
    expect(en('progress.madeExtra', { sizes: madeExtraSizesText([{ size: 'M', count: 4 }], sizeEn) })).toBe('Size M: 4 more than ordered (cut or planned to cut)')
    expect(it('progress.madeExtra', { sizes: madeExtraSizesText([{ size: 'M', count: 4 }], (size, count) => it('progress.extraSize', { size, count })) })).toBe("Taglia M: 4 in più dell'ordine (tagliati o da tagliare)")
    // Never the count and a numeric size run together ("1 48 more…").
    expect(en('progress.madeExtra', { sizes: madeExtraSizesText([{ size: '48', count: 1 }], sizeEn) })).not.toMatch(/\b1 48\b/)
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
    // pt-sc-fx3 (stage walk #3): a narrow card (a phone) gives the pills the cell's whole width, so "Not in work orders yet" is never cut.
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 479px\) \{\s*\.fw-so-ov-line > \.fw-so-inline \{\s*grid-column: 1 \/ -1;/)
    // The pills are the line cell's own inline group (the class the rule reads).
    expect(read('../view/overview/ProgressCard.tsx')).toContain('<span className="fw-so-inline">')
  })
})
// ---- end F-OO-121

// ---- F-OO-122 (10-design §2.3; review F8): the row ⋯ — the line's moves only, each through the page's one door, held in the band's words -
describe('F-OO-122: the card draws the ⋯ last; the column is gone for Read-only; Discuss moved into it', () => {
  const draw = (model: OrderRecordModel, value: Order, locale: 'en' | 'it' = 'en') => render(createElement(ProgressCard, { order: value, model }), locale)
  const production = order('IN_PRODUCTION')

  it('the 8th column: "Actions" over a ⋯ per line named for its line; the total row has an empty cell; 72 px', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw(base('manager', production, { tab: 'overview', production: ready() }).record, production, locale)
      expect(html).toContain(locale === 'en' ? '>Actions</th>' : '>Azioni</th>')
      expect(html).toContain(locale === 'en' ? 'aria-label="Actions for line 10 · DEMO-JKT-01 · Nero"' : 'aria-label="Azioni per la riga 10 · DEMO-JKT-01 · Nero"')
      expect(html.match(/aria-haspopup="menu"/g)?.length).toBe(2)
      expect(html).toContain('style="width:72px"')
      expect(html).toContain('style="width:34%"')
    }
  })

  it('Read-only: no ⋯ column, no menu — the counts and the pills as before', () => {
    const readOnly = { ...base('manager', production, { tab: 'overview', production: ready() }).record, can: abilitiesOf(['orders.view', 'workorders.view']) }
    const html = draw(readOnly, production)
    expect(html).not.toContain('>Actions</th>')
    expect(html).not.toContain('aria-haspopup="menu"')
    expect(html).not.toContain('style="width:72px"')
    expect(textOf(html)).toContain('Total · 2 lines')
  })

  it('the sources: the card runs the ONE line list through the ONE router (F-OL-01 (c), view/LineMenu.tsx); no speech icon on the row', () => {
    const card = read('../view/overview/ProgressCard.tsx')
    expect(card).toContain('menu.itemsOf(menu.movesOf(row.lineIds), { seq: row.seq, name }, first)')
    expect(card).not.toContain('<DiscussDoor')
    // Each move opens the page's one door (the router's); a held move is a held item with its words; the view fetches nothing.
    const menu = read('../view/LineMenu.tsx')
    for (const door of ['actions?.makeWorkOrders?.onOpenLine?.(move.lineId)', "actions?.onDialog?.({ kind: 'closeLines', lineIds: move.lineIds })", "actions?.onDialog?.({ kind: 'reopenLines', lineIds: move.lineIds })", "frame?.discuss?.({ record: { type: 'SalesOrder', id: order.id }, about })"]) expect(menu, door).toContain(door)
    expect(menu).toContain('description: move.held ? heldWords(move.held) : undefined')
    expect(card).not.toMatch(/from '[^']*\/use-[a-z-]+'/)
    expect(menu).not.toMatch(/from '[^']*\/use-[a-z-]+'/)
  })

  it('the words exist in both languages (office "tu")', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['progress.held.allInWork', 'progress.held.closedLine', 'progress.held.nothingLeft', 'wo.col.acts']) expect(t(key), `${locale}: ${key}`).not.toBe(key)
    }
    // F-OL-01 (c): the items' words are the shared list's (lineMenu.*, line-moves.vitest.test.ts).
  })
})
// ---- end F-OO-122

// ---- F-OO-126 (10-design §2.4): the line's window — its work orders, their final inspections, the moves, Open in Production --------
/** The read with the work orders' cells (F-OP-113) and the quality part with WO-00021's final inspection. */
const WINDOW_READ: OrderProduction = { ...workActsRead({ manage: true, release: true, hold: true }), quality: QUALITY_READ.quality }

describe('F-OO-126: lineWorkOf / lineFinalsOf — from the cells to the work orders; withheld said, never "none"', () => {
  const value = order('IN_PRODUCTION')
  const rows = lineRowsOf(LINES, value)
  const black = rows.find((row) => row.id === LINE_BLK)!
  const red = rows.find((row) => row.id === LINE_RED)!

  it('the work orders whose cells make the line, by number, with this line’s pieces only (a shared one lends nothing more)', () => {
    expect(lineWorkOf(black, WINDOW_READ)).toEqual({
      kind: 'rows',
      rows: [
        { id: '0190f0e2-6060-7000-8000-000000000019', number: 'WO-00019', status: 'RELEASED', held: false, pieces: 4 },
        { id: WORK_ORDERS[0]!.id, number: 'WO-00021', status: 'IN_PROGRESS', held: false, pieces: 8 },
      ],
      leftOut: WORK.workOrdersLeftOut,
    })
    expect(lineWorkOf(red, WINDOW_READ)).toMatchObject({ kind: 'rows', rows: [{ number: 'WO-00022', held: true, pieces: 6 }] })
  })

  it('withheld without workorders.view; not read (or an older read without cells): nothing claimed; made to measure: its group', () => {
    expect(lineWorkOf(black, NO_WORK_READ)).toEqual({ kind: 'withheld' })
    expect(lineWorkOf(black, null)).toEqual({ kind: 'unread' })
    expect(lineWorkOf(black, { ...WINDOW_READ, work: undefined })).toEqual({ kind: 'unread' })
    expect(lineWorkOf(black, WORK_READ)).toEqual({ kind: 'unread' }) // WORK names no cells (an answer before F-OP-113)
    const unit = { ...LINES[0]!, lineId: 'u1', seq: 30, kind: 'MADE_TO_MEASURE', sizes: [{ size: null, ordered: 1, cut: 1, sewn: 0, checked: 0, packed: 0, shipped: 0, madeExtra: 0, madeExtraWords: null }] }
    const mtm = lineRowsOf([unit, ...LINES], value).find((row) => row.mtm)!
    expect(lineWorkOf(mtm, WINDOW_READ)).toEqual({ kind: 'mtm', group: WORK.mtm[0] })
  })

  it('final inspections of the line’s work orders only; withheld without the right; unknown work orders: none claimed', () => {
    const work = lineWorkOf(black, WINDOW_READ)
    expect(lineFinalsOf(work, WINDOW_READ)).toEqual({ kind: 'rows', rows: QUALITY_READ.quality!.final })
    expect(lineFinalsOf(lineWorkOf(red, WINDOW_READ), WINDOW_READ)).toEqual({ kind: 'rows', rows: [] })
    expect(lineFinalsOf(lineWorkOf(black, NO_WORK_READ), NO_WORK_READ)).toEqual({ kind: 'withheld' })
    expect(lineFinalsOf(work, { ...WINDOW_READ, quality: { ncrs: [], final: null }, withheld: ['quality.final'] })).toEqual({ kind: 'withheld' })
    expect(lineFinalsOf({ kind: 'withheld' }, WINDOW_READ)).toEqual({ kind: 'unread' })
    expect(lineFinalsOf(work, { ...WINDOW_READ, quality: undefined })).toEqual({ kind: 'unread' })
  })
})

describe('F-OO-126: the window draws the line’s work, its inspections and its moves; Open in Production lands on #work-orders', () => {
  const production = order('IN_PRODUCTION')
  const windowOf = (model: OrderRecordModel, locale: 'en' | 'it' = 'en') => {
    const html = render(createElement(ProgressCard, { order: production, model }), locale)
    return html.slice(html.indexOf('<section role="dialog"'))
  }
  const model = (line: string, over: Partial<OrderRecordModel> = {}) => base('manager', production, { tab: 'overview', production: ready(WINDOW_READ), overviewLine: line, ...over }).record

  it('the red line: "Line 20", its pill, WO-00022 (a link, Released · 6 pieces of this line, On hold), no final inspection yet', () => {
    const html = windowOf(model(LINE_RED))
    const text = textOf(html)
    expect(html).toContain('<h2>DEMO-JKT-01 · Rosso</h2>')
    expect(html).toContain('<p data-subtitle="">Line 20</p>')
    expect(html).not.toMatch(/data-subtitle="">Line 20 · /)
    for (const words of ['Its work orders', 'WO-00022', 'Released · 6 pieces of this line', 'On hold', '1 work order not shown', 'Final inspections', 'No final inspection yet']) expect(text, words).toContain(words)
    // The work order's own page (the Production tab's address for it).
    expect(html).toContain(`href="/w/DEMO${recordAddress({ type: 'WorkOrder', id: WORK_ORDERS[1]!.id, label: 'WO-00022', companyId: production.companyId }, OFFICE_PAGES).replace(/&/g, '&amp;')}"`)
    const italian = textOf(windowOf(model(LINE_RED), 'it'))
    for (const words of ['I suoi ordini di lavoro', 'Rilasciato · 6 pezzi di questa riga', 'Controlli finali', 'Ancora nessun controllo finale']) expect(italian, words).toContain(words)
  })

  it('the black line: its two work orders and FI-2026-0088 waiting; Open in Production → ?tab=production#work-orders', () => {
    const html = windowOf(model(LINE_BLK))
    const text = textOf(html)
    for (const words of ['WO-00019', 'WO-00021', 'In progress · 8 pieces of this line', 'FI-2026-0088 · 8 checked', 'Waiting']) expect(text, words).toContain(words)
    expect(html).toMatch(/href="[^"]*\?tab=production#work-orders"/)
    expect(html).not.toContain('#line-')
  })

  it('the head holds the line’s moves ("Actions ▾"), the same as the row’s ⋯; a move closes the window first; Read-only: none', () => {
    const html = windowOf(model(LINE_RED))
    expect(html).toMatch(/<div data-actions="">.*aria-label="Actions for line 20 · DEMO-JKT-01 · Rosso".*>Actions /)
    const card = read('../view/overview/ProgressCard.tsx')
    expect(card).toContain('items={moves.itemsOf(row, label, () => actions?.onOpenLine?.(null))}')
    // `first` runs before the move: the window closes, then the one dialog opens (F-OL-01 c: in the ONE LineMenu shared with Lines).
    const menu = read('../view/LineMenu.tsx')
    expect(menu.indexOf('first?.()')).toBeGreaterThan(-1)
    expect(menu.indexOf('first?.()')).toBeLessThan(menu.indexOf('run(move, row)'))
    const readOnly = windowOf({ ...model(LINE_RED), can: abilitiesOf(['orders.view', 'workorders.view']) })
    expect(readOnly).toContain('<div data-actions=""></div>')
    expect(readOnly).not.toContain('aria-haspopup="menu"')
  })

  it('without workorders.view: the words say who reads them; no inspection list is guessed', () => {
    const text = textOf(windowOf(model(LINE_RED, { production: ready(NO_WORK_READ) })))
    expect(text).toContain('Its work orders are shown to people who follow production.')
    expect(text).not.toContain('No work order makes this line yet')
    expect(text).toContain('Final inspections need the inspections right')
  })

  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['progress.work.title', 'progress.work.none', 'progress.work.held', 'progress.final.none']) expect(t(key), `${locale}: ${key}`).not.toBe(key)
      expect(t('progress.work.of', { status: 'S', count: 1 }), locale).toBe(locale === 'en' ? 'S · 1 piece of this line' : 'S · 1 pezzo di questa riga')
    }
  })
})
// ---- end F-OO-126
