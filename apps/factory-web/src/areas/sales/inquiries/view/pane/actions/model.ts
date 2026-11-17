import type { InquiryView } from '../../../api'
import { actionHeld, isOpen, quotePreview, type InquiriesCan, type Phrase } from '../../../model'
// B-TH-228: Make order and Make style draft.
import { styleDraftHeld } from '../../../model'
// B-TH-234: "Ask <customer> for…" a task in its portal.
import { taskHeld } from '../../../model'

/**
 * B-TH-218 (threads plan TH-1b; O-SAL-INQ-LIST.pane-actions, O-SAL-INQ-REC.side): the reading pane's row 2, pure — the actions
 * the API allows now, each held with its reason (the API's own `actions` for this reader, then the right, then offline), and ONE
 * main button that follows the request: Make quote when there is something to quote, Ask for info when nothing can go on a quote
 * yet. B-TH-228 (on B-TH-025 / 026): Make order (held "make the style draft first" in the API's words while a line is not ready)
 * and Make style draft (the product office's: the production manager may make one; it is the main button while a line is asked in
 * words and nothing can go on a quote). The production manager reads every request and holds Make quote, Make order, Ask for info
 * and Decline with "Needs the sales permission" (B-TH-014): held, not hidden.
 */

export type PaneAction = 'quote' | 'askInfo' | 'decline' | 'order' | 'styleDraft'

/** The row's fixed order after the main button. */
const ROW: readonly PaneAction[] = ['quote', 'order', 'styleDraft', 'askInfo', 'decline']

export interface PaneActionsModel {
  /** The main button (primary), then the others in the row; none once the request is closed. */
  readonly main: PaneAction | null
  readonly others: readonly PaneAction[]
  readonly held: Readonly<Record<PaneAction, Phrase | null>>
  /** A closed request: what it became, in words (the row shows it instead of buttons). */
  readonly outcome: Phrase | null
  /**
   * ⋯ — Assign or Take off, Make or match the customer (a prospect: B-TH-234, the check first), "Ask <customer> for…" (a task in its
   * portal, B-TH-051), Not an order (closed without counting as declined; nothing is sent, B-TH-043), Mark lost — each held with its reason.
   */
  readonly menu: ReadonlyArray<{ readonly id: 'assign' | 'unassign' | 'lost' | 'match' | 'task' | 'notAnOrder'; readonly held: Phrase | null }>
}

const API_ACTION = { quote: 'quote', askInfo: 'askInfo', decline: 'decline', order: 'order' } as const

/** Why an action waits now, in words, or null. A prospect gets no question: replies need a customer record (B-TH-013). */
export function paneHeld(view: InquiryView, action: PaneAction, can: InquiriesCan, offline: boolean): Phrase | null {
  if (action === 'styleDraft') return styleDraftHeld(view, can, offline)
  const held = actionHeld(view, API_ACTION[action], can, offline)
  if (held) return held
  if (action === 'askInfo' && view.prospect) return { key: 'pane.held.prospect' }
  if (action === 'askInfo' && !can.email && view.source !== 'PORTAL') return { key: 'held.right', params: { right: 'right.email.send' } }
  return null
}

export function paneActions(view: InquiryView, can: InquiriesCan, offline: boolean): PaneActionsModel {
  const held = {
    quote: paneHeld(view, 'quote', can, offline),
    askInfo: paneHeld(view, 'askInfo', can, offline),
    decline: paneHeld(view, 'decline', can, offline),
    order: paneHeld(view, 'order', can, offline),
    styleDraft: paneHeld(view, 'styleDraft', can, offline),
  }
  if (!isOpen(view.status)) {
    const quote = view.quoteDetail
    const outcome: Phrase =
      view.status === 'QUOTED'
        ? quote
          ? { key: 'pane.outcome.quotedStatus', params: { quote: quote.number, status: `quoteStatus.${quote.status}` } }
          : { key: 'pane.outcome.quoted', params: { quote: view.quote?.number ?? '—' } }
        : view.status === 'DECLINED'
          ? { key: 'pane.outcome.declined', params: { reason: view.declineReason ? `decline.${view.declineReason}` : 'decline.OTHER' } }
          : view.status === 'ORDERED'
            ? // B-TH-228: the order it became, with ITS own status (the reader sees orders there), else the plain words.
              view.order
              ? { key: 'pane.outcome.orderedStatus', params: { order: view.order.number, status: `orderStatus.${view.order.status}` } }
              : { key: 'pane.outcome.ordered' }
            : view.status === 'WITHDRAWN' // B-TH-234 (on B-TH-090/095): the customer withdrew it, never "lost" by us
              ? { key: 'pane.outcome.withdrawn' }
              : { key: 'pane.outcome.lost' }
    return { main: null, others: [], held, outcome, menu: [] }
  }
  // The main button follows the request: something to quote → Make quote; nothing that can go on a quote yet (no line with a
  // style and sizes) and the question is possible → Ask for info.
  // B-TH-228: a line asked in words with nothing to quote → Make style draft first (when the reader may make one).
  const quotable = quotePreview(view).copied.length > 0
  const inWords = view.lines.some((line) => line.style === null)
  const main: PaneAction = quotable ? 'quote' : inWords && held.styleDraft === null ? 'styleDraft' : held.askInfo === null ? 'askInfo' : 'quote'
  const others: PaneAction[] = ROW.filter((action) => action !== main)
  const verbHeld = (action: 'assign' | 'unassign' | 'lose'): Phrase | null => actionHeld(view, action, can, offline)
  const menu: PaneActionsModel['menu'] = [
    { id: 'assign', held: verbHeld('assign') },
    ...(view.assigneeId ? [{ id: 'unassign' as const, held: verbHeld('unassign') }] : []),
    // B-TH-234: the check decides the rest (who may be matched, whether a new customer may be made).
    ...(view.prospect && !view.prospectDetails?.erased ? [{ id: 'match' as const, held: can.manage ? (offline ? { key: 'held.offline' } : null) : { key: 'held.right', params: { right: 'right.sales.inquiries.manage' } } }] : []),
    { id: 'task' as const, held: taskHeld(view, null, can, offline, '') },
    { id: 'notAnOrder' as const, held: held.decline },
    { id: 'lost', held: verbHeld('lose') },
  ]
  return { main, others, held, outcome: null, menu }
}
