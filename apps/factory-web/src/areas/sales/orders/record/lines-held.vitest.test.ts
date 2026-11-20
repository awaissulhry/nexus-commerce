import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { render, renderView } from '../../../../lib/record-thread/parts/testing'
import { AMEND_PREVIEW, forRole, LINE_BLK, LINE_RED, order } from '../_demo/fixtures'
import type { AmendPreview, Order } from '../api'
import { amendBodyOf, amendKeyOf, draftOf, stripHeld, stripOf, type AmendReview } from '../daily-model'
import { closedShort, designScreen } from './fixtures'
// ---- F-OO-124: the Close / Reopen dialogs drawn with one line asked ----
import { dialogLinesOf, type OrderRecordModel, type RecordDialog } from './record-model'
import { CloseLinesDialog, ReopenLinesDialog } from './view/DailyDialogs'
// ---- F-OO-125: a line's "Change quantity or sizes…" — the Lines edit mode, its style group focused ----
import { amendStyleAnchorOf, COMPOSER_EMPTY } from './record-model'
import { useOverviewActs } from './use-overview-acts'
import { LinesEditor, type LinesEditorModel } from './view/LinesEditor'

// F-OO-124: the DS Modal draws into a portal once hydrated, never on the server: here it draws in place, so the dialog can be read
// (the page cases below draw no dialog: they are unchanged by it).
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})
// ---- end F-OO-124

/**
 * F-CP-149 (customer page plan C4, the money wall; review A8, D5: A08 shipped blanks for readers without prices) — the order page's
 * Lines edit mode as Sales worker (no price grain since B-CP-011) and as Production manager: the strip says "Net: shown to people who
 * see prices" where the net would be, the fee's place says "Shown to people who see prices", and "Apply as a priced change" is held
 * "A priced change is made by someone who sees prices." — never a blank, never a blind priced change; the amendment's body carries no
 * price key. Kept out of so/orders.vitest.test.ts (the order lane's). Every name and number is made up.
 */

const value = forRole(order('CONFIRMED'), 'manager')
const draft = { lines: draftOf(value).map((line, index) => (index === 0 ? { ...line, sizes: { ...line.sizes, '50': (line.sizes['50'] ?? 0) + 1 } } : line)), customerRef: value.customerRef ?? '', requestedDate: value.requestedDate ?? '' }
const key = amendKeyOf(draft, value)
const review = (preview: AmendPreview): AmendReview => ({ phase: 'ready', key, preview, problem: null })
const frozen = { ok: false, revision: 4, version: 7, problems: [{ path: 'body/lines/10/SIZE_QUANTITY', message: 'x' }], diff: null, workOrders: null } as unknown as AmendPreview
const label = () => 'DEMO-JKT-01 · Nero'

describe('F-CP-149: the strip as a reader without prices', () => {
  it('the net\'s place is held in words, never a blank; with the price grain the net itself', () => {
    const held = stripOf({ order: value, review: review(AMEND_PREVIEW), key, local: null, price: false, label })
    expect(held.phase).toBe('ready')
    expect(held.net).toBeNull()
    expect(held.netHeld).toBe(true)
    const owner = stripOf({ order: value, review: review(AMEND_PREVIEW), key, local: null, price: true, label })
    expect(owner.netHeld).toBe(false)
    // Nothing to say yet (reading, idle): no held line either.
    expect(stripOf({ order: value, review: null, key, local: null, price: false, label }).netHeld).toBe(false)
  })

  it('"Apply as a priced change" is held for a reader without prices — whatever the reason and the fee typed', () => {
    const strip = stripOf({ order: value, review: review(frozen), key, local: null, price: false, label })
    expect(strip.frozen.length).toBeGreaterThan(0)
    expect(stripHeld(strip, { reason: 'Una giacca in più.', busy: false, local: null, offer: 'priced', fee: '', price: false })).toEqual({ key: 'edit.pricedHeld.apply' })
    expect(stripHeld(strip, { reason: 'Una giacca in più.', busy: false, local: null, offer: 'priced', fee: '25,00', price: false })).toEqual({ key: 'edit.pricedHeld.apply' })
    // A price holder applies it (its fee checked as before).
    expect(stripHeld(strip, { reason: 'Una giacca in più.', busy: false, local: null, offer: 'priced', fee: '', price: true })).toBeNull()
    // Not a priced change: nothing new is held.
    const plain = stripOf({ order: value, review: review(AMEND_PREVIEW), key, local: null, price: false, label })
    expect(stripHeld(plain, { reason: 'Una giacca in più.', busy: false, local: null, offer: null, fee: '', price: false })).toBeNull()
  })

  it('the amendment\'s body carries no price key for a reader without prices (the API refuses one: the grain filter)', () => {
    const body = JSON.stringify(amendBodyOf(draft, value))
    expect(body).not.toMatch(/unitPrice|netAmount|fee|amount/i)
  })
})

describe('F-CP-149: the edit mode drawn', () => {
  const render = (id: string, locale: (typeof LOCALES)[number]) => {
    const screen = designScreen as DesignScreen<unknown>
    const item = screen.cases.find((entry) => entry.id === id)
    expect(item, id).toBeDefined()
    return renderView(screen.view as ComponentType<{ model: unknown }>, item!.model, locale)
  }

  it('as Sales worker without prices: "Net: shown to people who see prices" in the strip (en, it)', () => {
    expect(render('f-cp-149-strip-no-price', 'en')).toContain('Net: shown to people who see prices')
    expect(render('f-cp-149-strip-no-price', 'it')).toContain('Imponibile: visibile a chi vede i prezzi')
  })

  it('frozen: Apply as a priced change held in words, the fee\'s place held, no amount on the strip', () => {
    for (const locale of LOCALES) {
      const html = render('f-cp-149-priced-held', locale)
      expect(html).toContain(locale === 'en' ? 'A priced change is made by someone who sees prices.' : 'Una modifica con prezzi la fa chi vede i prezzi.')
      expect(html).toContain(locale === 'en' ? 'Shown to people who see prices' : 'Visibili a chi vede i prezzi')
      expect(html).not.toMatch(/\bedit\.pricedHeld\.[a-z]+/)
    }
  })

  it('LinesTab keeps the held parts in marked blocks (the order lane\'s file)', () => {
    const tab = readFileSync(new URL('./view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("!model.can.price && strip.netHeld && <span className=\"fw-so-hint\">{t('edit.pricedHeld.net')}</span>")
    expect(tab).toContain('price: model.can.price /* F-CP-149 */')
    expect(tab.match(/F-CP-149/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})

// ---- F-OO-124 (order overview 10-design §2.3): Close short / Reopen ONE line — the row ⋯ opens the same dialog, only that line ticked
describe('F-OO-124: Close this line short… / Reopen this line… — only that line ticked; the band ⋯ still ticks every line', () => {
  const caseOf = (id: string) => ((designScreen as DesignScreen<unknown>).cases.find((entry) => entry.id === id)!.model as { record: OrderRecordModel }).record
  /** The line numbers ticked in the drawn dialog (each DS Checkbox is a label around its input). */
  const ticked = (html: string) =>
    html
      .split('<label class="nds-check')
      .slice(1)
      .map((part) => part.split('</label>')[0]!)
      .filter((part) => /<input[^>]*checked=""/.test(part))
      .map((part) => /(?:Line|Riga) (\d+)/.exec(part)?.[1])

  it('dialogLinesOf: the dialog\'s own lines (only those still offered), else what was typed, else every line offered', () => {
    const offered = [LINE_BLK, LINE_RED]
    expect(dialogLinesOf({ kind: 'closeLines', lineIds: [LINE_RED] }, 'closeLines', offered)).toEqual([LINE_RED])
    expect(dialogLinesOf({ kind: 'reopenLines', lineIds: [LINE_BLK] }, 'reopenLines', offered)).toEqual([LINE_BLK])
    // The band's ⋯ and the Lines tab name no line: every line offered, as before (a design case's typed lines first).
    expect(dialogLinesOf({ kind: 'closeLines' }, 'closeLines', offered)).toEqual(offered)
    expect(dialogLinesOf({ kind: 'closeLines' }, 'closeLines', offered, [LINE_BLK])).toEqual([LINE_BLK])
    expect(dialogLinesOf(null, 'reopenLines', offered)).toEqual(offered)
    // A line closed (or reopened) meanwhile is no longer offered: nothing ticked (the dialog says "pick a line"), never a stray id.
    expect(dialogLinesOf({ kind: 'closeLines', lineIds: ['gone'] }, 'closeLines', offered)).toEqual([])
    // Another dialog's lines are not read.
    expect(dialogLinesOf({ kind: 'reopenLines', lineIds: [LINE_RED] } as RecordDialog, 'closeLines', offered)).toEqual(offered)
  })

  it('Close remaining lines drawn from a line\'s row ⋯: only line 20 ticked, "Close 1 line"; from the band: both, "Close 2 lines"', () => {
    const record = caseOf('close-lines-dialog')
    const value = (record.order as { value: Order }).value
    const draw = (dialog: RecordDialog, locale: (typeof LOCALES)[number]) => render(createElement(CloseLinesDialog, { order: value, model: { ...record, dialog } }), locale)
    expect(ticked(draw({ kind: 'closeLines', lineIds: [LINE_RED] }, 'en'))).toEqual(['20'])
    expect(draw({ kind: 'closeLines', lineIds: [LINE_RED] }, 'en')).toContain('Close 1 line')
    expect(draw({ kind: 'closeLines', lineIds: [LINE_RED] }, 'it')).toContain('Chiudi 1 riga')
    expect(ticked(draw({ kind: 'closeLines' }, 'en'))).toEqual(['10', '20'])
    expect(draw({ kind: 'closeLines' }, 'en')).toContain('Close 2 lines')
  })

  it('Reopen lines drawn from a line\'s row ⋯: only that closed line ticked; from the band: every closed line', () => {
    const record = caseOf('reopen-dialog')
    const red = closedShort.lines.find((line) => line.id === LINE_RED)!.closedShort!
    const both: Order = { ...closedShort, lines: closedShort.lines.map((line) => ({ ...line, closedShort: line.closedShort ?? { ...red, quantity: 1 } })) }
    const draw = (dialog: RecordDialog, locale: (typeof LOCALES)[number]) => render(createElement(ReopenLinesDialog, { order: both, model: { ...record, dialog } }), locale)
    expect(ticked(draw({ kind: 'reopenLines', lineIds: [LINE_BLK] }, 'en'))).toEqual(['10'])
    expect(draw({ kind: 'reopenLines', lineIds: [LINE_BLK] }, 'en')).toContain('Reopen 1 line')
    expect(draw({ kind: 'reopenLines', lineIds: [LINE_BLK] }, 'it')).toContain('Riapri 1 riga')
    expect(ticked(draw({ kind: 'reopenLines' }, 'en'))).toEqual(['10', '20'])
  })

  it('the band ⋯ and the Lines tab still open the dialogs naming no line; DailyDialogs keeps its F-CP-108 type-only blocks', () => {
    const view = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("onSelect: () => actions?.onDialog?.({ kind: 'closeLines' })")
    expect(view).toContain("onSelect: () => actions?.onDialog?.({ kind: 'reopenLines' })")
    const dialogs = readFileSync(new URL('./view/DailyDialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain("dialogLinesOf(model.dialog, 'closeLines', open.map((entry) => entry.line.id), model.draft?.lineIds)")
    expect(dialogs).toContain("dialogLinesOf(model.dialog, 'reopenLines', closedOnes.map((line) => line.id), model.draft?.lineIds)")
    expect(dialogs).toContain("import type { CommandDialogActions, CommandDialogModel } from './Dialogs' // F-CP-108: type only")
    expect(dialogs).toContain('export function CancelDialog({ order, model, actions }: { order: Order; model: CommandDialogModel; actions?: CommandDialogActions } /* F-CP-108: type only */)')
  })
})
// ---- end F-OO-124

// ---- F-OO-125 (order overview 10-design §2.3): Change quantity or sizes… for one line — the ONE edit path, its style group focused ---
describe('F-OO-125: Change quantity or sizes… — the Lines edit mode with the line\'s style group as the anchor focused', () => {
  const value = forRole(order('IN_PRODUCTION'), 'sales')
  const styleId = value.lines[0]!.styleId
  const editor = (mode: LinesEditorModel['mode']): LinesEditorModel => ({ mode, lines: draftOf(value), order: value, styles: {}, composer: COMPOSER_EMPTY, price: false, currency: 'EUR', priceBasis: 'NET', minimums: {}, busy: false })

  it('the anchor id is drawn on the style group in edit mode (focusable, named by its heading); a typed New order draws none', () => {
    expect(amendStyleAnchorOf(styleId)).toBe(`amend-style-${styleId}`)
    for (const locale of LOCALES) {
      const html = render(createElement(LinesEditor, { model: editor('amend') }), locale)
      expect(html).toContain(`id="amend-style-${styleId}"`)
      expect(html).toContain('tabindex="-1"')
      expect(html).toContain(`aria-labelledby="amend-style-${styleId}-title"`)
      expect(html).toContain(`id="amend-style-${styleId}-title"`)
    }
    expect(render(createElement(LinesEditor, { model: editor('new') }), 'en')).not.toContain('amend-style-')
  })

  it('the focus is asked: onLineChange starts (or keeps) edit mode, then focuses that style group — no second editor', () => {
    const calls: string[] = []
    function Harness() {
      const acts = useOverviewActs({ startAmend: () => calls.push('edit mode'), focus: (id) => calls.push(`focus ${id}`) })
      acts.actions.onLineChange?.(styleId)
      return null
    }
    render(createElement(Harness), 'en')
    expect(calls).toEqual(['edit mode', `focus amend-style-${styleId}`])
  })

  it('the wiring: an open draft is kept (never started over); the container hands the one focus and edit mode as for the requested date', () => {
    const acts = readFileSync(new URL('./use-lines-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain('onAmendStart: () => (amendRef.current ? showLines() : startAmend()),')
    const overview = readFileSync(new URL('./use-overview-acts.ts', import.meta.url), 'utf8')
    expect(overview).toContain('input.focus?.(amendStyleAnchorOf(styleId))')
    const container = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain('useOverviewActs({ startAmend: () => lines.actions.onAmendStart?.(), focus: (anchor) => setFocusRow({ anchor, at: Date.now() }) })')
    expect(container).toContain('...overview.actions,')
    // The one edit path: the editor stays the Lines tab's; no view opens a second one.
    expect(readFileSync(new URL('./view/LinesEditor.tsx', import.meta.url), 'utf8')).toContain("const anchor = model.mode === 'amend' ? amendStyleAnchorOf(styleId) : null")
  })
})
// ---- end F-OO-125
