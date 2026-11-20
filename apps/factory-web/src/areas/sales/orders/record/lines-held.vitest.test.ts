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
// ---- F-OO-144: Requested by customer's small dialog — ONE amendment (every line as it is, the new date, the version) ----
import { requestedBodyOf, requestedHeld, requestedProblem } from './record-model'
import { RequestedDateDialog } from './view/RequestedDateDialog'
import { base } from './fixtures'
// ---- F-OO-110: cancel a waiting order — the band's own rule (cancelHeld through actionOf), the dialog's line ----
import { canOf, CANCEL_CHECK } from '../_demo/fixtures'
import { actionOf, cancelHeld } from '../model'
import { cancelTakesBackYes } from './record-model'
import { CancelDialog } from './view/DailyDialogs'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import type { CancelCheck, OpenApproval } from '../api'
// ---- end F-OO-110

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
    // F-OO-144: the container also hands the page's one dialog slot (Requested's small dialog).
    expect(container).toContain('useOverviewActs({ startAmend: () => lines.actions.onAmendStart?.(), focus: (anchor) => setFocusRow({ anchor, at: Date.now() }), setDialog /* F-OO-144 */')
    expect(container).toContain('...overview.actions,')
    // The one edit path: the editor stays the Lines tab's; no view opens a second one.
    expect(readFileSync(new URL('./view/LinesEditor.tsx', import.meta.url), 'utf8')).toContain("const anchor = model.mode === 'amend' ? amendStyleAnchorOf(styleId) : null")
  })
})
// ---- end F-OO-125

// ---- F-OO-144 (order overview 10-design §4.2; review F7): "Requested by customer" — a small dialog, ONE amendment, no API change ----
describe('F-OO-144: the requested date\'s small dialog — every line as it is, the new date, the version; held by amendHeld', () => {
  const NEW_DATE = '2026-12-20'
  const WHY = 'Il cliente apre il negozio una settimana dopo.'
  /** The order's own sizes of a line (what "as it is" means), as an amendment line sends them. */
  const sizesOf = (line: Order['lines'][number]) => line.sizes.flatMap((size) => (size.size !== null && size.quantity > 0 ? [{ size: size.size, quantity: size.quantity }] : []))
  /** The opening tag of the dialog's Go button (its words are its label). */
  const goTag = (html: string, label: string) => {
    const at = html.indexOf(`>${label}</button>`)
    expect(at, label).toBeGreaterThan(-1)
    return html.slice(html.lastIndexOf('<button', at), at)
  }

  it('the body carries every line unchanged (its whole size grid, no price, no text), the new date, the version and the reason', () => {
    for (const role of ['owner', 'sales'] as const) {
      const value = forRole(order('IN_PRODUCTION'), role)
      const body = requestedBodyOf(value, NEW_DATE, `  ${WHY}  `)
      expect(body.version).toBe(value.version)
      expect(body.reason).toBe(WHY)
      expect(body.requestedDate).toBe(NEW_DATE)
      expect(body.lines).toEqual(value.lines.map((line) => ({ id: line.id, sizes: sizesOf(line) })))
      // Nothing else of the header moves: the customer PO and the delivery address are not sent; no price key (a price holder too).
      expect(Object.keys(body).sort()).toEqual(['lines', 'reason', 'requestedDate', 'version'])
      expect(JSON.stringify(body)).not.toMatch(/unitPrice|description|note|customerRef|shipToAddressId/)
    }
  })

  it('a line closed short (or made to measure) is kept as it is ({ id } only): no line is removed or closed short by mistake', () => {
    const value: Order = { ...closedShort, status: 'IN_PRODUCTION' }
    const body = requestedBodyOf(value, NEW_DATE, WHY)
    expect(body.lines).toHaveLength(value.lines.length)
    expect(body.lines.find((entry) => 'id' in entry && entry.id === LINE_RED)).toEqual({ id: LINE_RED })
    expect(body.lines.find((entry) => 'id' in entry && entry.id === LINE_BLK)).toEqual({ id: LINE_BLK, sizes: sizesOf(value.lines.find((line) => line.id === LINE_BLK)!) })
  })

  it('the dialog\'s own problems: a date from today on, not the requested date already, then why', () => {
    const today = '2026-10-29'
    const current = '2026-12-10'
    expect(requestedProblem({ date: '', reason: WHY, today, current })).toEqual({ key: 'promise.problem.date' })
    expect(requestedProblem({ date: '2026-10-28', reason: WHY, today, current })).toEqual({ key: 'facts.requested.problem.past' })
    expect(requestedProblem({ date: current, reason: WHY, today, current })).toEqual({ key: 'facts.requested.problem.same' })
    expect(requestedProblem({ date: NEW_DATE, reason: '   ', today, current })).toEqual({ key: 'promise.problem.reason' })
    expect(requestedProblem({ date: today, reason: WHY, today, current })).toBeNull()
    expect(requestedProblem({ date: NEW_DATE, reason: WHY, today, current: null })).toBeNull()
  })

  it('held by the amendment\'s own rule (amendHeld): no right, a closed order, shipped, a fee line; and while a draft is open on Lines', () => {
    const sales = base('sales', order('IN_PRODUCTION')).record
    const value = (sales.order as { value: Order }).value
    expect(requestedHeld(value, sales)).toBeNull()
    expect(requestedHeld(value, base('manager', order('IN_PRODUCTION')).record)).toEqual({ key: 'held.noManage' })
    expect(requestedHeld({ ...value, status: 'CLOSED' }, sales)).toEqual({ key: 'held.final' })
    expect(requestedHeld({ ...value, status: 'SHIPPED' }, sales)).toEqual({ key: 'held.amendShipped' })
    expect(requestedHeld({ ...value, lines: value.lines.map((line, index) => (index === 0 ? { ...line, kind: 'FEE' as const } : line)) }, sales)).toEqual({ key: 'held.amendFee' })
    const amend = { revision: 1, lines: draftOf(value), customerRef: '', requestedDate: '', styles: {}, composer: COMPOSER_EMPTY, review: null, reason: '', tell: { words: '', chosen: null }, extraOutcome: null, fee: '' }
    expect(requestedHeld(value, { ...sales, amend })).toEqual({ key: 'held.amending' })
  })

  it('drawn (en, it): the date and why, "Saved as amendment 1", "Applies at once — no approval"; Go held in words until both are typed', () => {
    const sales = base('sales', order('IN_PRODUCTION')).record
    const value = (sales.order as { value: Order }).value
    const draw = (model: OrderRecordModel, locale: (typeof LOCALES)[number], on: Order = value) => render(createElement(RequestedDateDialog, { order: on, model: { ...model, dialog: { kind: 'requested' } } }), locale)
    const en = draw(sales, 'en')
    for (const words of ['Change the requested date of SO-2026-0088', 'New requested date', 'Today or later. Saved as amendment 1.', 'Applies at once — no approval', 'Why']) expect(en, words).toContain(words)
    expect(goTag(en, 'Change the date')).toContain('aria-description="Choose a date"')
    const it = draw(sales, 'it')
    for (const words of ['Cambia la data richiesta di SO-2026-0088', 'Nuova data richiesta', 'Da oggi in poi. Salvata come modifica 1.', 'Si applica subito — senza approvazione']) expect(it, words).toContain(words)
    expect(goTag(it, 'Cambia la data')).toContain('aria-description="Scegli una data"')
    // Typed: Go is live.
    expect(goTag(draw({ ...sales, draft: { date: NEW_DATE, reason: WHY } }, 'en'), 'Change the date')).not.toContain('aria-disabled')
    // The requested date already: said at the field and on Go.
    const same = draw({ ...sales, draft: { date: value.requestedDate!, reason: WHY } }, 'en')
    expect(same).toContain('It is the requested date already')
  })

  it('the amendHeld words on Go: the production manager (no orders.manage), a closed order, a draft open on Lines (en, it)', () => {
    const typed = { draft: { date: NEW_DATE, reason: WHY } }
    const draw = (model: OrderRecordModel, on: Order, locale: (typeof LOCALES)[number]) => render(createElement(RequestedDateDialog, { order: on, model: { ...model, ...typed, dialog: { kind: 'requested' } } }), locale)
    const manager = base('manager', order('IN_PRODUCTION')).record
    const value = (manager.order as { value: Order }).value
    expect(goTag(draw(manager, value, 'en'), 'Change the date')).toContain('aria-description="Changing an order needs the sales right to manage orders"')
    expect(goTag(draw(manager, value, 'it'), 'Cambia la data')).toContain('aria-description="Cambiare un ordine richiede il diritto vendite di gestire gli ordini"')
    const sales = base('sales', order('IN_PRODUCTION')).record
    expect(goTag(draw(sales, { ...value, status: 'CLOSED' }, 'en'), 'Change the date')).toContain('aria-description="A closed or cancelled order never changes"')
    const amend = { revision: 1, lines: draftOf(value), customerRef: '', requestedDate: '', styles: {}, composer: COMPOSER_EMPTY, review: null, reason: '', tell: { words: '', chosen: null }, extraOutcome: null, fee: '' }
    expect(goTag(draw({ ...sales, amend }, value, 'en'), 'Change the date')).toContain('aria-description="The lines are being amended: review or discard the amendment first"')
  })

  it('the door opens the dialog in the page\'s one slot (no hop to Lines, no focus asked); the wiring', () => {
    const calls: unknown[] = []
    function Harness() {
      const acts = useOverviewActs({ startAmend: () => calls.push('edit mode'), focus: (id) => calls.push(`focus ${id}`), setDialog: (dialog) => calls.push(dialog) })
      acts.actions.onRequestedChange?.()
      return null
    }
    render(createElement(Harness), 'en')
    expect(calls).toEqual([{ kind: 'requested' }])
    const lines = readFileSync(new URL('./use-lines-acts.ts', import.meta.url), 'utf8')
    expect(lines).toContain('await applyAmendment(api, orderId, requestedBodyOf(value, date, reason), key)')
    const dialogs = readFileSync(new URL('./view/Dialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain("case 'requested': // F-OO-144")
    // The customer page lane's F-CP-108 exports stay (the Orders sheet's row mounts these dialogs).
    for (const kept of ['export type CommandDialogModel', 'export type CommandDialogActions', 'export /* F-CP-108 */ function ReadyDialog', 'export /* F-CP-108 */ function CloseDialog', 'export function DialogProblem', 'export function Frame']) expect(dialogs, kept).toContain(kept)
  })

  it('every new word exists in both languages', () => {
    for (const locale of LOCALES) {
      const html = render(createElement(RequestedDateDialog, { order: order('IN_PRODUCTION'), model: { ...base('sales', order('IN_PRODUCTION')).record, dialog: { kind: 'requested' } } }), locale)
      expect(html).not.toMatch(/\bfacts\.requested\.[a-zA-Z.]+/)
    }
  })
})
// ---- end F-OO-144

// ---- F-OO-110 (order overview §1.4; N3, B-OO-003): cancel a waiting order — Cancel order… through actionOf, the yes taken back ----
describe('F-OO-110: cancel a waiting order — Cancel order… appears through actionOf; the dialog says the yes asked on it is taken back', () => {
  const asked = (kind: string): OpenApproval => ({ taskId: `t-${kind}`, kind, kindLabel: { en: kind, it: kind }, requestedAt: '2026-11-18T09:30:00Z', requester: { name: 'Luca Prova', me: false }, approver: { kind: 'ROLE', name: 'Finance', me: false }, version: 1, requireStepUp: false, approve: { allowed: true, why: null }, reject: { allowed: true, why: null }, withdraw: { allowed: false, why: null } })
  const waiting: Order = { ...order('PENDING_APPROVAL'), openApprovals: [asked('SALES_ORDER')] }

  it('cancelHeld on PENDING_APPROVAL: the API lists the cancel (B-OO-003), so it runs for who changes orders; held for anyone else', () => {
    expect(actionOf(order('PENDING_APPROVAL'), 'cancel')).toEqual({ action: 'cancel', allowed: true, needsReason: true, held: null })
    expect(cancelHeld(order('PENDING_APPROVAL'), canOf('sales'))).toBeNull()
    expect(cancelHeld(order('PENDING_APPROVAL'), canOf('owner'))).toBeNull()
    expect(cancelHeld(order('PENDING_APPROVAL'), canOf('manager'))).toEqual({ key: 'held.noManage' })
    // Shipped states keep theirs: no cancel listed, held with the state's words.
    expect(cancelHeld(order('PARTLY_SHIPPED'), canOf('sales'))).toEqual({ key: 'held.cancelState' })
  })

  it('the yes is taken back only while the order waits and one is asked on it (seen, or counted but not shown)', () => {
    expect(cancelTakesBackYes(waiting)).toBe(true)
    expect(cancelTakesBackYes({ ...waiting, openApprovals: [asked('CREDIT_OVERRIDE')] })).toBe(true)
    expect(cancelTakesBackYes({ ...waiting, openApprovals: [], openApprovalsHidden: 1 })).toBe(true)
    expect(cancelTakesBackYes({ ...waiting, openApprovals: [] })).toBe(false)
    expect(cancelTakesBackYes({ ...order('IN_PRODUCTION'), openApprovals: [asked('SALES_ORDER')] })).toBe(false)
  })

  it('the dialog line, en + it — only on a waiting order with a yes asked, and only when the cancel may go', () => {
    const check: CancelCheck = { ...CANCEL_CHECK, status: 'PENDING_APPROVAL', impact: { cancellable: true, blocks: [], touches: [], leavesBehind: [] }, leatherCut: [] }
    const record = base('sales', waiting).record
    // quick-check fix (W11): the dialog's model is CommandDialogModel (F-CP-108: no `dialog` in it) — the literal names only what it reads.
    const draw = (on: Order, value: CancelCheck, locale: (typeof LOCALES)[number] = 'en') => render(createElement(CancelDialog, { order: on, model: { ...record, cancelCheck: { value, problem: null } } }), locale)
    expect(draw(waiting, check)).toContain('The yes asked on it is taken back')
    expect(draw(waiting, check, 'it')).toContain('Il sì chiesto viene ritirato')
    expect(draw({ ...waiting, openApprovals: [] }, check)).not.toContain('The yes asked on it is taken back')
    expect(draw({ ...order('IN_PRODUCTION'), openApprovals: [asked('SALES_ORDER')] }, { ...check, status: 'IN_PRODUCTION' })).not.toContain('The yes asked on it is taken back')
    expect(draw(waiting, { ...check, impact: { ...check.impact, cancellable: false } })).not.toContain('The yes asked on it is taken back')
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['orders']).orders!)('where.cancel.yesTakenBack'), locale).not.toBe('where.cancel.yesTakenBack')
  })

  it('drawn: a waiting order\'s Overview offers Cancel order… under More ▾ (live), and its dialog says the yes is taken back', () => {
    const view = designScreen.view as ComponentType<{ model: unknown }>
    const draw = (id: string) => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, 'en')
    const more = draw('f-oo-110-waiting')
    expect(more).toContain('aria-label="More moves for SO-2026-0088"')
    expect(draw('f-oo-110-cancel')).toContain('The yes asked on it is taken back')
    // The F-CP-108 export blocks of DailyDialogs stay (the Orders sheet's row mounts this very dialog).
    const source = readFileSync(new URL('./view/DailyDialogs.tsx', import.meta.url), 'utf8')
    expect(source).toContain('export function CancelDialog({ order, model, actions }: { order: Order; model: CommandDialogModel; actions?: CommandDialogActions } /* F-CP-108: type only */)')
    expect(source).toContain("import type { CommandDialogActions, CommandDialogModel } from './Dialogs' // F-CP-108: type only")
  })
})
// ---- end F-OO-110

// ---- F-OP-312 (order page follow-up 13): the amendment's "how" never tells a reader without the price grain to change prices ----
describe('F-OP-312: Amend order says "Change the sizes below…" to a reader who sees no price, "…sizes and prices…" to one who does', () => {
  const view = designScreen.view as ComponentType<{ model: unknown }>
  const draw = (id: string, locale: (typeof LOCALES)[number]) => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
  it('drawn: Sales (no price grain, B-CP-011) reads the no-price words; the Owner the priced ones — in Italian and English', () => {
    expect(draw('amend-start', 'en')).toContain('Change the sizes below, add a colour or a style, or set a line to 0 to remove it.')
    expect(draw('amend-start', 'en')).not.toContain('sizes and prices')
    expect(draw('amend-start', 'it')).toContain('Cambia qui sotto le taglie, aggiungi un colore o un modello')
    expect(draw('amend-start', 'it')).not.toContain('taglie e prezzi')
    expect(draw('amend-draft', 'en')).toContain('Change the sizes and prices below')
    expect(draw('amend-draft', 'it')).toContain('Cambia qui sotto taglie e prezzi')
  })
  it('the two wordings exist in both languages and differ only by the prices', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['amend.how', 'amend.howNoPrice']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('amend.howNoPrice'), locale).not.toMatch(/prezz|price/i)
    }
  })
})
// ---- end F-OP-312
