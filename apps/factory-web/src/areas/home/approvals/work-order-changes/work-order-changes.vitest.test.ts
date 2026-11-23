import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CHANGE_REFUSALS, CHANGE_WORDS } from '@nexus/factory-domain/order-apply/rules'
import { rowKeyOf } from '@nexus/factory-domain/insights/attention'
import { LOWER_REFUSALS, LOWER_WORDS } from '@nexus/factory-domain/production/work-orders/lower'
import type { ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, placeholdersOf } from '../../../../lib/i18n/messages'
import { leftKeys, render, textOf } from '../../../../lib/record-thread/parts/testing'
import { designScreen } from '../fixtures'
import { heldOf, listedTarget, nextReview, openIdOf, selectHeld } from '../inbox'
import { applyWorkOrderChange, declineWorkOrderChange, getWorkOrderChange, listWorkOrderChanges } from './api'
import { CHANGE_CASES, CHANGE_FIXTURES, change, changeRow, LAY_FIXED, LAY_FOLLOWS, review } from './fixtures'
import {
  applyHeld,
  applyLabelOf,
  bandNoticeOf,
  changeIdOfRow,
  changeProblemOf,
  changedCellsOf,
  decideCellsOf,
  decidedNotice,
  declineHeld,
  KNOWN_CHANGE_REFUSALS,
  laysOf,
  outcomeWordsOf,
  routeOf,
  wordsRefusalOf,
} from './model'
import { WorkOrderChangeReview } from './view/WorkOrderChangeReview'
// The work order's own door (its band notice), drawn as the work order studio's design cases draw it.
import { recordCase, RecordDesign } from '../../../production/work-orders/record/fixtures'
import type { WorkOrderRecordModel } from '../../../production/work-orders/record/record-model'

// The DS windows open only in a browser (after hydration, in a portal): here they draw in place — the window's title, subtitle,
// meta, its arrows ("n of N"), its error, its content and its footer; a dialog's title, body and footer.
vi.mock('@nexus/ui/patterns', async (original) => {
  const actual = await original<typeof import('@nexus/ui/patterns')>()
  const DetailModal = ({ open, title, subtitle, meta, actions, error, children, nav }: { open: boolean; title?: unknown; subtitle?: unknown; meta?: unknown; actions?: unknown; error?: unknown; children?: unknown; nav?: { ids: readonly string[]; current: string } }) =>
    open
      ? createElement(
          'section',
          { role: 'dialog', 'data-window': '' },
          createElement('h2', null, title as never),
          createElement('p', null, subtitle as never),
          meta as never,
          nav ? createElement('p', { 'data-nav': '' }, `${nav.ids.indexOf(nav.current) + 1} of ${nav.ids.length}`) : null,
          error ? createElement('p', { 'data-error': '' }, error as never) : null,
          children as never,
          createElement('footer', null, actions as never),
        )
      : null
  return { ...actual, DetailModal }
})
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-SA-245 (sales page plan R1; lead picks P6', Round 4–5; 14-change-flow §2.0 S7; review C-11, R-6): work-order changes in the
 * office — ONE decide window from Home › Approvals' row "Work order change · WO-…" and from the work order's band notice: the
 * cells before → after beside what is cut and bundled, the extra pieces and their outcome, the lay it touches; Apply ("Lower to
 * the order") and Leave as is… (with words), each held with its reason before the click; a 409 "WO-… changed since — propose
 * again" with Read again; "Re-plan the lay first" held with a door to the lay. Wall: the rows and the window are the API's
 * (B-SA-044's source, B-SA-041's reads: another customer's change opens "not there any more", naming nobody).
 */

const View = designScreen.view as ComponentType<{ model: unknown }>
const caseOf = (id: string) => {
  const found = designScreen.cases.find((entry) => entry.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return found.model
}
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => render(createElement(View, { model: caseOf(id) }), locale)
/** The first window drawn (the decide window, or a dialog): its own markup only (sections nest inside it). */
const windowHtml = (html: string, marker = 'data-window=""') => {
  const at = html.indexOf(marker)
  if (at < 0) return ''
  const start = html.lastIndexOf('<section', at)
  const tags = /<section\b|<\/section>/g
  tags.lastIndex = start
  let depth = 0
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0] === '</section>' ? -1 : 1
    if (depth === 0) return html.slice(start, tag.index + tag[0].length)
  }
  return html.slice(start)
}
const windowOf = (html: string, marker = 'data-window=""') => textOf(windowHtml(html, marker))
/** The window's footer (its buttons). */
const footerOf = (html: string) => {
  const own = windowHtml(html)
  return own.slice(own.lastIndexOf('<footer'))
}
const { WORK_ORDER, RED50, RED52 } = CHANGE_FIXTURES
const free = { offline: false, busy: false }
const facts = (over: Partial<Parameters<typeof applyHeld>[1]> = {}): Parameters<typeof applyHeld>[1] => ({ workOrder: WORK_ORDER, stop: null, problem: null, ...free, ...over })
const refused = (path: string, message = 'x') => new ApiError('conflict', 409, 'invalid_state', message, null, [{ path, message }])

describe('the decide window draws every case in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`SCR-030 · F-SA-245 in ${locale}`, () => {
      expect(CHANGE_CASES.length).toBeGreaterThan(7)
      for (const entry of CHANGE_CASES) {
        const html = draw(entry.id, locale)
        expect(html.length, entry.id).toBeGreaterThan(200)
        expect(leftKeys(html, ['workOrderChange', 'notice', 'inbox', 'held', 'refusal', 'problem', 'today']), `${entry.id} (${locale})`).toEqual([])
      }
    })
  }

  it('made-up data only: no real address, no mail, no path', () => {
    const text = JSON.stringify(CHANGE_CASES)
    expect(text).not.toMatch(/@[a-z0-9-]+\.(com|it|net)/i)
    expect(text).not.toMatch(/\/Users\//)
  })
})

describe('the window: cells before → after, what is cut and bundled, the extra pieces, the lay, what Apply does', () => {
  it('Lower to the order: each size beside what the work order makes now and what is already cut and bundled', () => {
    const en = windowOf(draw('f-sa-245-lower'))
    expect(en).toContain('Work order change · WO-DEMO-0142')
    expect(en).toContain('Order SO-DEMO-0142 · proposed by Bea Esempio')
    expect(en).toContain('Why: Brand Alpha asked for fewer red jackets')
    for (const word of ['Line · size', 'Before → after', 'Makes now', 'Already cut and bundled']) expect(en).toContain(word)
    expect(en).toContain('Line 2 · RED · 50')
    expect(en).toContain('3 → 2')
    expect(en).toContain(`${RED50.progress.cut} cut · ${RED50.progress.bundled} bundled`)
    expect(en).toContain('3 → 1')
    // The extra piece (cut beyond the new figure) and the outcome chosen at Accept.
    expect(en).toContain('Extra pieces')
    expect(en).toContain('Extra pieces: 1 50 already cut')
    expect(en).toContain('What happens to them: Keep as leftover for Brand Alpha')
    // The lay it touches: a leather lay still planned follows the work order down.
    expect(en).toContain('The lay it touches')
    expect(en).toContain('CO-DEMO-0006 · planned: follows the work order down · 52')
    expect(en).toContain('What Apply does')
    expect(en).toContain('Lowers the released work order to the order, never below what is already cut')
    expect(en).toContain('A proposal is not an approval')
    // The buttons: Leave as is… and Lower to the order, neither held.
    expect(en).toContain('Leave as is…')
    expect(en).toContain('Lower to the order')
    const html = draw('f-sa-245-lower')
    expect(footerOf(html)).not.toContain('aria-disabled="true"')
    // Doors: the work order, the order, the lay.
    expect(html).toContain(`/w/DEMO/production/work-orders/${WORK_ORDER.id}`)
    expect(html).toContain('/w/DEMO/sales/orders/')
    expect(html).toContain(`/w/DEMO/production/cutting/orders/${LAY_FOLLOWS.cutOrder.id}`)
    const it_ = windowOf(draw('f-sa-245-lower', 'it'))
    for (const word of ["Modifica dell'ordine di lavoro · WO-DEMO-0142", 'Già tagliati e in fasci', 'Pezzi in più', 'Tieni come rimanenza di Brand Alpha', 'Il piazzamento che tocca', "Riduci all'ordine", 'Lascia così…']) expect(it_).toContain(word)
  })

  it('"Re-plan the lay first": a fabric lay fixed for the size holds more — Apply held, said once, with a door to the lay', () => {
    const html = draw('f-sa-245-lay')
    const en = windowOf(html)
    expect(en).toContain('Re-plan the lay first')
    expect(en).toContain('Open CO-DEMO-0007')
    expect(html).toContain(`/w/DEMO/production/cutting/orders/${LAY_FIXED.cutOrder.id}`)
    expect(en).toContain('CO-DEMO-0007 · fixed: re-plan it first if it holds more than the new figure')
    expect(footerOf(html)).toContain('aria-disabled="true"')
    expect(windowOf(draw('f-sa-245-lay', 'it'))).toContain('Ripianifica prima il piazzamento')
  })

  it('the work order changed since it was proposed: "WO-… changed since — propose again", the size marked', () => {
    const en = windowOf(draw('f-sa-245-changed'))
    expect(en).toContain('WO-DEMO-0142 changed since — propose again')
    expect(en).toContain('Changed since: 2')
    expect(windowOf(draw('f-sa-245-changed', 'it'))).toContain('WO-DEMO-0142 è cambiato nel frattempo: proponi di nuovo')
  })

  it('a refusal of the API in our words, with Read again and the door to its lay; Apply held until read again', () => {
    const html = draw('f-sa-245-refused')
    const en = windowOf(html)
    expect(en).toContain('Its lay is being cut: lower the work order once it is cut.')
    expect(en).toContain('Read again')
    expect(en).toContain('Open CO-DEMO-0006')
    expect(footerOf(html)).toContain('aria-disabled="true"')
  })

  it('Leave as is…: why it stays as it is (1 to 300), held until written', () => {
    const dialog = windowOf(draw('f-sa-245-leave'), 'data-modal=""')
    expect(dialog).toContain('Leave as is · WO-DEMO-0142')
    expect(dialog).toContain('Why it stays as it is')
    expect(dialog).toContain('Up to 300 characters')
    expect(draw('f-sa-245-leave')).toContain('aria-description="Say why it is left as is."')
  })

  it('a raise no open draft can take: "Make the new work order", no lay, no cells of a work order', () => {
    const en = windowOf(draw('f-sa-245-new'))
    expect(en).toContain('Work order change · new work order')
    expect(en).toContain('Make the new work order')
    expect(en).toContain('Makes a new draft work order with these sizes.')
    expect(en).not.toContain('The lay it touches')
  })

  it('a reader who does not manage it: both answers held, the window says who decides; no figures without workorders.view', () => {
    const html = draw('f-sa-245-reader')
    const en = windowOf(html)
    expect(en).toContain('Only a person who manages this work order decides it.')
    expect(en).toContain('need the right to see work orders')
    expect(footerOf(html).match(/aria-disabled="true"/g)?.length).toBe(2)
  })

  it('decided already: who left it as is and why; no buttons', () => {
    const html = draw('f-sa-245-decided')
    const en = windowOf(html)
    expect(en).toContain('left as is by Carla Prova')
    expect(en).toContain('Why: The extra red jackets are already sewn')
    expect(en).not.toContain('Lower to the order')
    expect(en).not.toContain('Leave as is…')
  })

  it('another customer’s change (or one out of reach): "not there any more", naming no customer, order or work order', () => {
    for (const locale of LOCALES) {
      const shown = windowOf(draw('f-sa-245-not-found', locale))
      expect(shown, locale).toContain(locale === 'en' ? 'This work order change is not there any more.' : "Questa modifica dell'ordine di lavoro non c'è più.")
      expect(shown, locale).not.toMatch(/Brand Alpha|SO-DEMO|WO-DEMO|CO-DEMO/)
      expect(shown, locale).not.toMatch(/Lower to the order|Riduci all'ordine|Leave as is|Lascia così/)
    }
  })

  it('mounted by the work order’s own door: its arrows walk the changes waiting on it', () => {
    const one = review()
    const html = render(createElement(WorkOrderChangeReview, { review: one, prefix: '/w/DEMO', offline: false, nav: { ids: [one.id, 'other'], onOpen: () => undefined } }))
    expect(windowOf(html)).toContain('1 of 2')
    expect(windowOf(render(createElement(WorkOrderChangeReview, { review: one, prefix: '/w/DEMO', offline: false, nav: { ids: [one.id] } })))).not.toMatch(/\d of \d/)
  })
})

describe('the model: the cells, the route, the lay, held with the reason before the click', () => {
  it('each cell beside the work order now: what it makes, cut, bundled; a raise’s new cell makes 0', () => {
    const cells = decideCellsOf(change(), WORK_ORDER)
    expect(cells.map((cell) => [cell.size, cell.from, cell.to, cell.now, cell.cut, cell.changed])).toEqual([
      ['50', 3, 2, 3, RED50.progress.cut, false],
      ['52', 3, 1, 3, RED52.progress.cut, false],
    ])
    expect(decideCellsOf(change(), null).every((cell) => cell.now === null && cell.cut === null)).toBe(true)
    const raise = change({ kind: 'MAKE_MORE', cells: [{ salesOrderLineId: 'line-new', lineSeq: 9, size: '56', from: 0, to: 2, workOrderSizeId: null }] })
    expect(decideCellsOf(raise, WORK_ORDER)[0]).toMatchObject({ now: 0, changed: false })
  })

  it('changed since: the command’s own rule (by its cell, a new cell by line and size)', () => {
    expect(changedCellsOf(change(), WORK_ORDER)).toBe(0)
    const moved = { ...WORK_ORDER, cells: WORK_ORDER.cells.map((cell) => (cell.id === RED52.id ? { ...cell, quantity: 2 } : cell)) }
    expect(changedCellsOf(change(), moved)).toBe(1)
  })

  it('the route and the button: lowered (released), set (draft), cancelled (every size to 0), a new draft, more on a draft', () => {
    expect(routeOf(change(), WORK_ORDER)).toEqual({ route: 'LOWER_RELEASED' })
    expect(routeOf(change(), { ...WORK_ORDER, status: 'DRAFT' })).toEqual({ route: 'SET_DRAFT_CELLS' })
    expect(routeOf(change(), { ...WORK_ORDER, status: 'ON_HOLD' })).toEqual({ refusal: 'ON_HOLD' })
    expect(routeOf(change(), { ...WORK_ORDER, status: 'COMPLETED' })).toEqual({ refusal: 'WORK_ORDER_DONE' })
    const everyCell = change({ cells: WORK_ORDER.cells.map((cell) => ({ salesOrderLineId: cell.salesOrderLineId!, lineSeq: cell.lineSeq, size: cell.size, from: cell.quantity, to: 0, workOrderSizeId: cell.id })) })
    expect(routeOf(everyCell, WORK_ORDER)).toEqual({ route: 'CANCEL_WORK_ORDER' })
    expect(applyLabelOf(change(), 'LOWER_RELEASED')).toBe('workOrderChange.apply.LOWER_TO_ORDER')
    expect(applyLabelOf(change(), 'CANCEL_WORK_ORDER')).toBe('workOrderChange.apply.CANCEL_WORK_ORDER')
    expect(applyLabelOf(change({ kind: 'MAKE_MORE', workOrder: null }), 'NEW_DRAFT')).toBe('workOrderChange.apply.NEW_DRAFT')
    expect(applyLabelOf(change({ kind: 'MAKE_MORE' }), 'SET_DRAFT_CELLS')).toBe('workOrderChange.apply.MAKE_MORE')
    expect(routeOf(change({ kind: 'MAKE_MORE' }), WORK_ORDER)).toEqual({ refusal: 'NOT_A_DRAFT' })
  })

  it('the lay: a planned leather lay follows; a fixed fabric one holding more stops it (REPLAN_LAY); one being cut waits', () => {
    expect(laysOf(change(), [LAY_FOLLOWS]).stop).toBeNull()
    expect(laysOf(change(), [LAY_FOLLOWS]).lays.map((lay) => [lay.number, lay.stand, lay.sizes])).toEqual([['CO-DEMO-0006', 'FOLLOWS', ['52']]])
    expect(laysOf(change(), [LAY_FIXED]).stop).toEqual({ code: 'REPLAN_LAY', number: 'CO-DEMO-0007', cutOrderId: LAY_FIXED.cutOrder.id })
    const cutting = { ...LAY_FIXED, cutOrder: { ...LAY_FIXED.cutOrder, status: 'IN_PROGRESS' } }
    expect(laysOf(change(), [cutting]).stop?.code).toBe('CUTTING_UNDER_WAY')
    // The leather lay gives back first: with both, it follows down and the fixed one still holds 3 > 1 → stopped.
    expect(laysOf(change(), [LAY_FOLLOWS, LAY_FIXED]).stop?.code).toBe('REPLAN_LAY')
    // A fixed lay that holds no more than the new figure stops nothing; cut, reconciled and cancelled lays are not open.
    expect(laysOf(change(), [{ ...LAY_FIXED, lines: [{ ...LAY_FIXED.lines[0]!, quantity: 1 }] }]).stop).toBeNull()
    for (const status of ['CUT', 'RECONCILED', 'CANCELLED']) expect(laysOf(change(), [{ ...LAY_FIXED, cutOrder: { ...LAY_FIXED.cutOrder, status } }])).toEqual({ lays: [], stop: null })
    // A raise never stops at a lay; a lay of another work order's cells is not this change's.
    expect(laysOf(change({ kind: 'MAKE_MORE' }), [LAY_FIXED]).stop).toBeNull()
    expect(laysOf(change(), [{ ...LAY_FIXED, lines: [{ ...LAY_FIXED.lines[0]!, workOrderSizeId: 'another-cell' }] }])).toEqual({ lays: [], stop: null })
  })

  it('Apply held, in order: decided, not this reader’s, the work order now, changed since, a lay, a refusal standing, offline, busy', () => {
    expect(applyHeld(change(), facts())).toBeNull()
    expect(applyHeld(change({ status: 'APPLIED' }), facts())?.key).toBe('workOrderChange.held.decided')
    expect(applyHeld(change({ mayDecide: false }), facts())?.key).toBe('workOrderChange.held.noRight')
    expect(applyHeld(change(), facts({ workOrder: { ...WORK_ORDER, status: 'ON_HOLD' } }))).toEqual({ key: 'workOrderChange.held.ON_HOLD', params: { number: 'WO-DEMO-0142' } })
    const moved = { ...WORK_ORDER, cells: WORK_ORDER.cells.map((cell) => (cell.id === RED50.id ? { ...cell, quantity: 4 } : cell)) }
    expect(applyHeld(change(), facts({ workOrder: moved }))).toEqual({ key: 'workOrderChange.held.CHANGED_SINCE', params: { number: 'WO-DEMO-0142' } })
    expect(applyHeld(change(), facts({ stop: { code: 'REPLAN_LAY', number: 'CO-DEMO-0007', cutOrderId: 'x' } }))?.key).toBe('workOrderChange.held.REPLAN_LAY')
    expect(applyHeld(change(), facts({ problem: changeProblemOf(refused('refusal/CHANGED_SINCE')) }))?.key).toBe('workOrderChange.held.CHANGED_SINCE')
    // A refusal that would not come back (a moved version) does not hold Apply: it was read again.
    expect(applyHeld(change(), facts({ problem: changeProblemOf(refused('version')) }))).toBeNull()
    expect(applyHeld(change(), facts({ offline: true }))?.key).toBe('workOrderChange.held.offline')
    expect(applyHeld(change(), facts({ busy: true }))?.key).toBe('workOrderChange.held.busy')
    // Without the work order (no workorders.view): only what the change itself says; the API decides the rest.
    expect(applyHeld(change(), facts({ workOrder: null }))).toBeNull()
  })

  it('Leave as is held: decided, not this reader’s, its words (1 to 300), offline, busy', () => {
    expect(declineHeld(change(), 'Already sewn: we keep them.', free)).toBeNull()
    expect(declineHeld(change(), null, free)).toBeNull()
    expect(declineHeld(change(), '  ', free)?.key).toBe('workOrderChange.held.words')
    expect(declineHeld(change(), 'x'.repeat(301), free)).toEqual({ key: 'workOrderChange.held.long', params: { max: '300' } })
    expect(declineHeld(change({ status: 'STALE' }), 'x', free)?.key).toBe('workOrderChange.held.decided')
    expect(declineHeld(change({ mayDecide: false }), 'x', free)?.key).toBe('workOrderChange.held.noRight')
    expect(declineHeld(change(), 'x', { offline: true, busy: false })?.key).toBe('workOrderChange.held.offline')
  })

  it('a refusal in words: its code, the lay its words name, whether it reads again and holds Apply', () => {
    expect(changeProblemOf(refused('refusal/CHANGED_SINCE', CHANGE_WORDS.changedSince('WO-DEMO-0142').en))).toEqual({ key: 'workOrderChange.refusal.CHANGED_SINCE', code: 'CHANGED_SINCE', lay: null, reload: true, holds: true })
    expect(changeProblemOf(refused('refusal/REPLAN_LAY', LOWER_WORDS.replanLay('CO-DEMO-0007').en))).toMatchObject({ code: 'REPLAN_LAY', lay: 'CO-DEMO-0007', holds: true })
    expect(changeProblemOf(refused('refusal/CUTTING_UNDER_WAY', LOWER_WORDS.cuttingUnderWay('CO-DEMO-0006').en))).toMatchObject({ lay: 'CO-DEMO-0006' })
    expect(changeProblemOf(refused('refusal/LAST_CELL'))).toMatchObject({ key: 'workOrderChange.refusal.LAST_CELL', holds: false, reload: true })
    expect(changeProblemOf(refused('refusal/SOMETHING_NEW'))).toMatchObject({ key: 'workOrderChange.refusal.other' })
    expect(changeProblemOf(refused('version'))).toMatchObject({ key: 'workOrderChange.refusal.moved', reload: true, holds: false })
    expect(changeProblemOf(new ApiError('not_found', 404, 'not_found', 'Work order change not found.'))).toMatchObject({ key: 'workOrderChange.refusal.gone', reload: true })
    expect(changeProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toMatchObject({ key: 'workOrderChange.problem.forbidden', reload: false })
    expect(changeProblemOf(new Error('boom'))).toMatchObject({ key: 'workOrderChange.problem.internal' })
  })

  it('a refusal kept on the change (lastError, the API’s English) read back to its code from factory-domain’s own words', () => {
    expect(wordsRefusalOf(LOWER_WORDS.replanLay('CO-DEMO-0007').en)).toEqual({ code: 'REPLAN_LAY', lay: 'CO-DEMO-0007' })
    expect(wordsRefusalOf(CHANGE_WORDS.changedSince('WO-DEMO-0142').en)).toEqual({ code: 'CHANGED_SINCE', lay: null })
    expect(wordsRefusalOf(LOWER_WORDS.lastCell('WO-DEMO-0142').en)?.code).toBe('LAST_CELL')
    expect(wordsRefusalOf(LOWER_WORDS.cellInUse('M').en)?.code).toBe('CELL_IN_USE')
    expect(wordsRefusalOf('Something else entirely.')).toBeNull()
    expect(wordsRefusalOf(null)).toBeNull()
  })

  it('the outcome of the extra pieces in words; none chosen: production decides', () => {
    expect(outcomeWordsOf(change(), 'Brand Alpha')).toEqual(CHANGE_WORDS.extraOutcome('LEFTOVER', 'Brand Alpha'))
    expect(outcomeWordsOf(change({ extraOutcome: 'CHARGE' }), null)?.en).toBe('Keep and charge the customer')
    expect(outcomeWordsOf(change({ extraOutcome: null }), 'Brand Alpha')).toBeNull()
  })

  it('the notice of a decision names the change by its work order (a new draft: the order); a reprint said beside', () => {
    const applied = decidedNotice(change(), 'applied', LOWER_WORDS.reprint())
    expect(applied).toMatchObject({ key: 'notice.changeApplied', request: { record: { label: 'WO-DEMO-0142' } }, lines: [LOWER_WORDS.reprint()] })
    expect(decidedNotice(change({ workOrder: null }), 'declined')).toMatchObject({ key: 'notice.changeDeclined', request: { record: { label: 'SO-DEMO-0142' } } })
    const text = textOf(render(createElement(View, { model: { depth: { ...(caseOf('f-sa-245-lower') as { depth: object }).depth, changeReview: null, notice: applied } } })))
    expect(text).toContain('Applied: Work order change: WO-DEMO-0142.')
    expect(text).toContain('Print the traveller again: its quantities changed.')
  })

  it('the work order’s band notice: the changes waiting on it, the oldest first', () => {
    expect(bandNoticeOf(null)).toBeNull()
    expect(bandNoticeOf([change({ status: 'APPLIED' })])).toBeNull()
    const later = change({ id: '0190f0e2-3090-7000-8000-000000000003', proposedAt: '2026-11-18T12:00:00.000Z' })
    expect(bandNoticeOf([later, change()])).toMatchObject({ count: 2, first: { id: change().id } })
  })
})

describe('Home › Approvals: the row "Work order change · WO-…" opens the window here (B-SA-044’s source, its wall)', () => {
  it('the change’s id from its row key (factory-domain rowKeyOf), and nothing from any other row', () => {
    const value = change()
    const key = rowKeyOf({ kind: 'WORK_ORDER_CHANGE', record: { type: 'WorkOrder', id: WORK_ORDER.id, label: WORK_ORDER.number }, subKey: `change:${value.id}` } as never)
    expect(changeRow(value).key).toBe(key)
    expect(changeIdOfRow(changeRow(value))).toBe(value.id)
    expect(changeIdOfRow({ ...changeRow(value), kind: 'CHANGE_ORDER' })).toBeNull()
    expect(changeIdOfRow({ ...changeRow(value), source: 'task' })).toBeNull()
    expect(changeIdOfRow({ ...changeRow(value), item: { ...changeRow(value).item!, key: `WORK_ORDER_CHANGE:${WORK_ORDER.id}` } })).toBeNull()
  })

  it('the inbox opens it in place (?open=<change id>), walks it with the others, never ticks it for Approve N', () => {
    const row = changeRow()
    expect(openIdOf(row)).toBe(change().id)
    expect(listedTarget([row], change().id)).toBe('change')
    expect(nextReview([row], 'nothing')).toBe(change().id)
    expect(heldOf(row, free)).toBe('inbox.held.changeAlone')
    expect(selectHeld(row, free)).toBe('inbox.held.changeAlone')
    // Its row's Record column still opens the work order (Today's own page for it).
    expect(row.href).toBe(`/w/DEMO/production/work-orders/${WORK_ORDER.id}`)
  })

  it('the page wires the window: an id no row names is asked, the live events read it again, the work order’s band opens it', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    const page = read('../Approvals.tsx')
    expect(page).toContain("type.startsWith('work_order_change.')")
    // cq fx2 (W-10): with the request inbox's kind in the address no engine task is probed (no 404 first); requests and changes as before.
    expect(page).toContain('probeOpen(api, openId, { tasks: can.tasks && controls.kind !== REQUEST_INBOX_KIND, requests: can.requests, changes: can.changes })')
    expect(page).toContain("openId: target === 'change' ? openId : null")
    expect(read('../requests/use-request-review.ts')).toContain('await getWorkOrderChange(api, id)')
    const inboxView = read('../view/InboxView.tsx')
    expect(inboxView).toContain('<WorkOrderChangeReview review={model.changeReview}')
    // Its row no longer says "decided on its own page": it opens here.
    expect(inboxView).toContain("data.source === 'attention' && !id && <span className=\"fw-apv-sub\">{t('row.ownPage')}</span>")
    const record = read('../../../production/work-orders/record/WorkOrderRecord.tsx')
    expect(record).toContain('useWorkOrderChanges(api, value, session.permissions)')
    expect(record).toContain("openId: params?.get('open') || null")
    const recordView = read('../../../production/work-orders/record/view/WorkOrderRecordView.tsx')
    expect(recordView).toContain("tw('changes.notice'")
    expect(recordView).toContain('<WorkOrderChangeReview review={model.changes.review}')
  })
})

describe('the work order’s door: ONE band notice, the same window on its page', () => {
  const href = `/w/DEMO/production/work-orders/${WORK_ORDER.id}?tab=overview&open=${change().id}`
  const drawRecord = (changes: WorkOrderRecordModel['changes'], locale: (typeof LOCALES)[number] = 'en') => render(createElement(RecordDesign, { model: recordCase('manager', 'IN_PROGRESS', { changes }) }), locale)

  it('a change waiting: "A work order change waits: … for order …" with Open — a real link on the same page', () => {
    const html = drawRecord({ waiting: [change()], firstHref: href, review: null, busy: false })
    const text = textOf(html)
    expect(text).toContain('A work order change waits: 50 3 → 2, 52 3 → 1 for order SO-DEMO-0142.')
    expect(html).toContain(`href="${href.replace(/&/g, '&amp;')}"`)
    expect(textOf(drawRecord({ waiting: [change()], firstHref: href, review: null, busy: false }, 'it'))).toContain("Una modifica dell'ordine di lavoro aspetta: 50 3 → 2, 52 3 → 1 per l'ordine SO-DEMO-0142.")
    // Two: one notice, the count and the oldest first.
    const later = change({ id: '0190f0e2-3090-7000-8000-000000000003', proposedAt: '2026-11-18T12:00:00.000Z', words: { ...change().words, cells: 'M 40 → 36' } })
    expect(textOf(drawRecord({ waiting: [later, change()], firstHref: href, review: null, busy: false }))).toContain('2 work order changes wait — the first: 50 3 → 2, 52 3 → 1 for order SO-DEMO-0142.')
  })

  it('none waiting, or not read (no workorders.view): no notice', () => {
    for (const changes of [{ waiting: [], firstHref: null, review: null, busy: false }, { waiting: null, firstHref: null, review: null, busy: false }, undefined]) {
      const text = textOf(drawRecord(changes))
      expect(text).not.toContain('work order change waits')
      expect(text).not.toContain('work order changes wait')
    }
  })

  it('the window opened on the work order’s page (?open=<change id>): the same decide window', () => {
    const html = drawRecord({ waiting: [change()], firstHref: href, review: review(), busy: false })
    const own = windowOf(html)
    expect(own).toContain('Work order change · WO-DEMO-0142')
    expect(own).toContain('Lower to the order')
    expect(own).toContain('Already cut and bundled')
  })
})

describe('the calls: the routes, the version, one Idempotency-Key per write', () => {
  const fake = () => {
    const calls: { method: string; path: string; options: Record<string, unknown> }[] = []
    const answer = { change: change() }
    const api = {
      get: async (path: string, options: Record<string, unknown>) => {
        calls.push({ method: 'GET', path, options })
        return path.endsWith('/production/work-order-changes') ? { items: [change()], live: { events: [] } } : answer
      },
      post: async (path: string, options: Record<string, unknown>) => {
        calls.push({ method: 'POST', path, options })
        return path.endsWith('/apply') ? { change: change({ status: 'APPLIED' }), workOrder: { id: WORK_ORDER.id, number: WORK_ORDER.number, status: 'IN_PROGRESS', version: 8 }, reprint: { traveller: true, words: LOWER_WORDS.reprint() } } : { change: change({ status: 'DECLINED' }) }
      },
    } as unknown as ApiClient
    return { api, calls }
  }

  it('list (the work order’s waiting ones), one, apply {version}, decline {version, words}', async () => {
    const { api, calls } = fake()
    await listWorkOrderChanges(api, { workOrderId: WORK_ORDER.id })
    await getWorkOrderChange(api, change().id)
    await applyWorkOrderChange(api, change().id, { version: 3 }, 'key-apply')
    await declineWorkOrderChange(api, change().id, { version: 4, words: '  Already sewn.  ' }, 'key-decline')
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /production/work-order-changes',
      `GET /production/work-order-changes/${change().id}`,
      `POST /production/work-order-changes/${change().id}/apply`,
      `POST /production/work-order-changes/${change().id}/decline`,
    ])
    expect(calls[0]!.options.query).toEqual({ workOrderId: WORK_ORDER.id, salesOrderId: undefined, status: 'PROPOSED', limit: 50 })
    expect(calls[2]!.options).toMatchObject({ body: { version: 3 }, idempotencyKey: 'key-apply' })
    expect(calls[3]!.options).toMatchObject({ body: { version: 4, words: 'Already sewn.' }, idempotencyKey: 'key-decline' })
  })
})

describe('the words: every refusal and every held reason in both languages, the same placeholders', () => {
  it('each code of the change and of Lower to the order has words; it and en say the same placeholders', () => {
    const tree = (locale: 'it' | 'en') => CATALOGUE[locale].approvals as Record<string, string>
    const keys = [
      ...[...CHANGE_REFUSALS, ...LOWER_REFUSALS, 'other', 'moved', 'gone'].map((code) => `workOrderChange.refusal.${code}`),
      ...['reading', 'decided', 'DECIDED', 'noRight', 'WORK_ORDER_DONE', 'ON_HOLD', 'NOT_A_DRAFT', 'CHANGED_SINCE', 'REPLAN_LAY', 'CUTTING_UNDER_WAY', 'UNIT_CUT', 'offline', 'busy', 'words', 'long'].map((held) => `workOrderChange.held.${held}`),
      ...['FOLLOWS', 'FIXED', 'CUTTING', 'CUT'].map((stand) => `workOrderChange.lays.stand.${stand}`),
      ...['LOWER_RELEASED', 'SET_DRAFT_CELLS', 'CANCEL_WORK_ORDER', 'NEW_DRAFT', 'unknown'].map((route) => `workOrderChange.does.${route}`),
      ...['LOWER_TO_ORDER', 'MAKE_MORE', 'NEW_DRAFT', 'CANCEL_WORK_ORDER'].map((label) => `workOrderChange.apply.${label}`),
    ]
    for (const key of keys) {
      for (const locale of LOCALES) expect(tree(locale)[key], `${locale} ${key}`).toBeTruthy()
      expect(placeholdersOf(tree('it')[key]!), key).toEqual(placeholdersOf(tree('en')[key]!))
    }
    for (const code of KNOWN_CHANGE_REFUSALS) expect(tree('en')[`workOrderChange.refusal.${code}`], code).toBeTruthy()
    for (const locale of LOCALES) {
      expect(CATALOGUE[locale]['approvals-depth']!['notice.changeApplied']).toContain('{request}')
      expect(CATALOGUE[locale]['production-work-orders']!['changes.notice_one']).toContain('{cells}')
      expect(CATALOGUE[locale]['production-work-orders']!['changes.notice_other']).toContain('{count}')
    }
  })
})
