import type { InquiryView } from '../../../api'
import { actionHeld, isOpen, quotePreview, type InquiriesCan, type Phrase } from '../../../model'

/**
 * B-TH-218 (threads plan TH-1b; O-SAL-INQ-LIST.pane-actions, O-SAL-INQ-REC.side): the reading pane's row 2, pure — the actions
 * the API allows now, each held with its reason (the API's own `actions` for this reader, then the right, then offline), and ONE
 * main button that follows the request: Make quote when there is something to quote, Ask for info when nothing can go on a quote
 * yet. Make order and Make style draft come with B-TH-025 / 026 (not drawn: no dead buttons). The production manager reads every
 * request and holds Make quote, Ask for info and Decline with "Needs the sales permission" (B-TH-014): held, not hidden.
 */

export type PaneAction = 'quote' | 'askInfo' | 'decline'

export interface PaneActionsModel {
  /** The main button (primary), then the others in the row; none once the request is closed. */
  readonly main: PaneAction | null
  readonly others: readonly PaneAction[]
  readonly held: Readonly<Record<PaneAction, Phrase | null>>
  /** A closed request: what it became, in words (the row shows it instead of buttons). */
  readonly outcome: Phrase | null
  /** ⋯ — Assign or Take off, Mark lost, Match to a customer (a prospect), each held with its reason. */
  readonly menu: ReadonlyArray<{ readonly id: 'assign' | 'unassign' | 'lost' | 'match'; readonly held: Phrase | null }>
}

const API_ACTION = { quote: 'quote', askInfo: 'askInfo', decline: 'decline' } as const

/** Why an action waits now, in words, or null. A prospect gets no question: replies need a customer record (B-TH-013). */
export function paneHeld(view: InquiryView, action: PaneAction, can: InquiriesCan, offline: boolean): Phrase | null {
  const held = actionHeld(view, API_ACTION[action], can, offline)
  if (held) return held
  if (action === 'askInfo' && view.prospect) return { key: 'pane.held.prospect' }
  if (action === 'askInfo' && !can.email && view.source !== 'PORTAL') return { key: 'held.right', params: { right: 'right.email.send' } }
  return null
}

export function paneActions(view: InquiryView, can: InquiriesCan, offline: boolean): PaneActionsModel {
  const held = { quote: paneHeld(view, 'quote', can, offline), askInfo: paneHeld(view, 'askInfo', can, offline), decline: paneHeld(view, 'decline', can, offline) }
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
            ? { key: 'pane.outcome.ordered' }
            : { key: 'pane.outcome.lost' }
    return { main: null, others: [], held, outcome, menu: [] }
  }
  // The main button follows the request: something to quote → Make quote; nothing that can go on a quote yet (no line with a
  // style and sizes) and the question is possible → Ask for info.
  const quotable = quotePreview(view).copied.length > 0
  const main: PaneAction = !quotable && held.askInfo === null ? 'askInfo' : 'quote'
  const others: PaneAction[] = (['quote', 'askInfo', 'decline'] as const).filter((action) => action !== main)
  const verbHeld = (action: 'assign' | 'unassign' | 'lose'): Phrase | null => actionHeld(view, action, can, offline)
  const menu: PaneActionsModel['menu'] = [
    { id: 'assign', held: verbHeld('assign') },
    ...(view.assigneeId ? [{ id: 'unassign' as const, held: verbHeld('unassign') }] : []),
    ...(view.prospect && !view.prospectDetails?.erased ? [{ id: 'match' as const, held: can.manage && view.actions.edit.allowed ? null : { key: 'held.right', params: { right: 'right.sales.inquiries.manage' } } }] : []),
    { id: 'lost', held: verbHeld('lose') },
  ]
  return { main, others, held, outcome: null, menu }
}
