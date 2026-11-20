import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { render, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { forRole, LINE_BLK, LINE_RED, order } from '../_demo/fixtures'
import type { Order } from '../api'
import { closedShort, designScreen } from './fixtures'
import { bodyLinesOf, EMPTY_HISTORY, setCell } from './lines-draft'
import { LinesTab } from './view/LinesTab'
// ---- F-OO-124: the Close / Reopen dialogs drawn with one line asked ----
import { dialogLinesOf, type OrderRecordModel, type RecordDialog } from './record-model'
import { CloseLinesDialog, ReopenLinesDialog } from './view/DailyDialogs'
import { COMPOSER_EMPTY } from './record-model'
import { useOverviewActs } from './use-overview-acts'
import { LinesEditor, type LinesEditorModel } from './view/LinesEditor'
// ---- F-OO-144: Requested by customer's small dialog — ONE amendment (no lines since ol-s1, the new date, the version) ----
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
 * F-CP-149 → F-OL-05 (the money wall on the Lines tab changed in place; Order LINES lane): Sales (no price grain since B-CP-011) sees no
 * price column, no total, no amount in Review and save — not even which way the total moved — and one line why; its draft and its save
 * carry no price key (the API refuses one: the grain filter). Then the dialogs the line ⋯ opens, the doors that land on a box, and the
 * requested date's small window (no lines, Why optional). Every name and number is made up.
 */

/** The Lines tab of a design case, drawn alone (the band, the dock and the thread are other tests'). */
const drawCase = (id: string, locale: (typeof LOCALES)[number] = 'en') => {
  const item = (designScreen as DesignScreen<unknown>).cases.find((entry) => entry.id === id)
  expect(item, id).toBeDefined()
  const record = (item!.model as { record: OrderRecordModel }).record
  return render(createElement(LinesTab, { order: (record.order as { value: Order }).value, model: record }), locale)
}

describe('F-CP-149 → F-OL-05: the money wall on the Lines tab', () => {
  it('Sales\' draft and save carry no price key (only the cells typed): the grain filter has nothing to refuse', () => {
    const value = forRole(order('CONFIRMED'), 'sales')
    const body = JSON.stringify(bodyLinesOf(setCell(EMPTY_HISTORY, value, LINE_BLK, '50', 3).draft, value))
    expect(body).not.toMatch(/unitPrice|netAmount|fee|amount/i)
  })

  it('drawn as Sales (en, it): no Unit price, no Line total, no currency; the one line why prices are hidden', () => {
    for (const locale of LOCALES) {
      const text = textOf(drawCase('lines-sales', locale))
      expect(text).toContain(locale === 'en' ? 'You change pieces, sizes and notes; prices are set by someone who sees them.' : 'Cambi capi, taglie e note; i prezzi li imposta chi li vede.')
      expect(text).not.toMatch(locale === 'en' ? /Unit price|Line total|Order total/ : /Prezzo unitario|Totale riga|Totale ordine/)
      expect(text).not.toMatch(/€|EUR/)
    }
    // The Owner reads them.
    expect(textOf(drawCase('lines-view'))).toContain('Unit price')
  })

  it('Review and save as Sales: the pieces only and "The amount changes"; a locked change has no fee field — the customer is asked by the rule', () => {
    for (const locale of LOCALES) {
      const text = textOf(drawCase('lines-review-sales', locale))
      expect(text).toContain(locale === 'en' ? 'The amount changes' : "L'importo cambia")
      expect(text).not.toMatch(/€|EUR|goes up|goes down/)
    }
    const locked = textOf(drawCase('lines-review-locked-sales'))
    expect(locked).not.toContain('Change fee')
    expect(locked).toContain("Your company's rule asks the customer's yes for this change.")
    // The Owner's locked change: the fee optional (0 allowed).
    expect(textOf(drawCase('lines-review-locked'))).toContain('Change fee (optional)')
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

// ---- F-OO-125 → F-OL-05: a line's door lands on the Lines tab's box (no edit mode, no style-group anchor) ----
describe('F-OL-05: the doors land on a box of the Lines table — the old "Change quantity or sizes…" hop and its anchor went', () => {
  it('the container lands on the line\'s first box (or its price box), else the row; the band and Money ask it', () => {
    const hook = readFileSync(new URL('./use-lines-draft.ts', import.meta.url), 'utf8')
    expect(hook).toContain('if (typeable && box === \'price\' && can.price) focus(priceCellId(line.id))')
    expect(hook).toContain('else if (typeable && firstSize) focus(cellId(line.id, firstSize))')
    expect(hook).toContain("else focus(rowAnchor('SalesOrderLine', line.id))")
    expect(readFileSync(new URL('./use-overview-acts.ts', import.meta.url), 'utf8')).not.toContain('onLineChange')
  })

  it('the typed New order keeps today\'s editor (no anchor, no edit mode of its own)', () => {
    const value = forRole(order('IN_PRODUCTION'), 'sales')
    const editor: LinesEditorModel = { mode: 'new', lines: [], order: value, styles: {}, composer: COMPOSER_EMPTY, price: false, currency: 'EUR', priceBasis: 'NET', busy: false }
    expect(render(createElement(LinesEditor, { model: editor }), 'en')).not.toContain('amend-style-')
    expect(readFileSync(new URL('./view/LinesEditor.tsx', import.meta.url), 'utf8')).not.toMatch(/amendStyleAnchorOf|LineActs|onRemove|onText/)
  })
})
// ---- end F-OL-05

// ---- F-OO-144 (order overview 10-design §4.2; review F7) → F-OL-04: "Requested by customer" — a small dialog, ONE amendment, no lines ----
describe('F-OO-144: the requested date\'s small dialog — no lines (ol-s1), the new date, the version; Why optional; held by amendHeld', () => {
  const NEW_DATE = '2026-12-20'
  const WHY = 'Il cliente apre il negozio una settimana dopo.'
  /** The opening tag of the dialog's Go button (its words are its label). */
  const goTag = (html: string, label: string) => {
    const at = html.indexOf(`>${label}</button>`)
    expect(at, label).toBeGreaterThan(-1)
    return html.slice(html.lastIndexOf('<button', at), at)
  }

  it('the body: the date, the version and the reason only when typed — no line (every line stays as it is now), no price, no header', () => {
    for (const role of ['owner', 'sales'] as const) {
      const value = forRole(order('IN_PRODUCTION'), role)
      expect(requestedBodyOf(value, NEW_DATE, `  ${WHY}  `)).toEqual({ version: value.version, requestedDate: NEW_DATE, reason: WHY })
      expect(requestedBodyOf(value, NEW_DATE, '   ')).toEqual({ version: value.version, requestedDate: NEW_DATE })
      expect(JSON.stringify(requestedBodyOf(value, NEW_DATE, WHY))).not.toMatch(/lines|unitPrice|customerRef|shipToAddressId/)
    }
  })

  it('the dialog\'s own problems: a date from today on, not the requested date already; Why is optional', () => {
    const today = '2026-10-29'
    const current = '2026-12-10'
    expect(requestedProblem({ date: '', reason: WHY, today, current })).toEqual({ key: 'promise.problem.date' })
    expect(requestedProblem({ date: '2026-10-28', reason: WHY, today, current })).toEqual({ key: 'facts.requested.problem.past' })
    expect(requestedProblem({ date: current, reason: WHY, today, current })).toEqual({ key: 'facts.requested.problem.same' })
    expect(requestedProblem({ date: NEW_DATE, reason: '   ', today, current })).toBeNull()
    expect(requestedProblem({ date: today, reason: WHY, today, current })).toBeNull()
  })

  it('held by the amendment\'s own rule (amendHeld): no right, a closed order, shipped — a fee line no longer holds it (B-OL-012)', () => {
    const sales = base('sales', order('IN_PRODUCTION')).record
    const value = (sales.order as { value: Order }).value
    expect(requestedHeld(value, sales)).toBeNull()
    expect(requestedHeld(value, base('manager', order('IN_PRODUCTION')).record)).toEqual({ key: 'held.noManage' })
    expect(requestedHeld({ ...value, status: 'CLOSED' }, sales)).toEqual({ key: 'held.final' })
    expect(requestedHeld({ ...value, status: 'SHIPPED' }, sales)).toEqual({ key: 'held.amendShipped' })
    expect(requestedHeld({ ...value, lines: value.lines.map((line, index) => (index === 0 ? { ...line, kind: 'FEE' as const } : line)) }, sales)).toBeNull()
  })

  it('drawn (en, it): the date and "Why · optional", "Saved as amendment 1", "Applies at once — no approval"; Go held until a date', () => {
    const sales = base('sales', order('IN_PRODUCTION')).record
    const value = (sales.order as { value: Order }).value
    const draw = (model: OrderRecordModel, locale: (typeof LOCALES)[number], on: Order = value) => render(createElement(RequestedDateDialog, { order: on, model: { ...model, dialog: { kind: 'requested' } } }), locale)
    const en = draw(sales, 'en')
    for (const words of ['Change the requested date of SO-2026-0088', 'New requested date', 'Today or later. Saved as amendment 1.', 'Applies at once — no approval', 'Why · optional']) expect(en, words).toContain(words)
    expect(goTag(en, 'Change the date')).toContain('aria-description="Choose a date"')
    const it = draw(sales, 'it')
    for (const words of ['Cambia la data richiesta di SO-2026-0088', 'Nuova data richiesta', 'Da oggi in poi. Salvata come modifica 1.', 'Si applica subito — senza approvazione', 'Perché · facoltativo']) expect(it, words).toContain(words)
    // A date typed, no reason: Go is live.
    expect(goTag(draw({ ...sales, draft: { date: NEW_DATE, reason: '' } }, 'en'), 'Change the date')).not.toContain('aria-disabled')
    expect(draw({ ...sales, draft: { date: value.requestedDate!, reason: WHY } }, 'en')).toContain('It is the requested date already')
  })

  it('the amendHeld words on Go: the production manager (no orders.manage), a closed order (en, it)', () => {
    const typed = { draft: { date: NEW_DATE, reason: WHY } }
    const draw = (model: OrderRecordModel, on: Order, locale: (typeof LOCALES)[number]) => render(createElement(RequestedDateDialog, { order: on, model: { ...model, ...typed, dialog: { kind: 'requested' } } }), locale)
    const manager = base('manager', order('IN_PRODUCTION')).record
    const value = (manager.order as { value: Order }).value
    expect(goTag(draw(manager, value, 'en'), 'Change the date')).toContain('aria-description="Changing an order needs the sales right to manage orders"')
    expect(goTag(draw(manager, value, 'it'), 'Cambia la data')).toContain('aria-description="Cambiare un ordine richiede il diritto vendite di gestire gli ordini"')
    const sales = base('sales', order('IN_PRODUCTION')).record
    expect(goTag(draw(sales, { ...value, status: 'CLOSED' }, 'en'), 'Change the date')).toContain('aria-description="A closed or cancelled order never changes"')
  })

  it('the door opens the dialog in the page\'s one slot (no hop to Lines, no focus asked); the wiring', () => {
    const calls: unknown[] = []
    function Harness() {
      const acts = useOverviewActs({ setDialog: (dialog) => calls.push(dialog) })
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
      expect(html).not.toMatch(/\bfacts\.requested\.[a-zA-Z.]+|\blineMenu\.[a-zA-Z.]+/)
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
