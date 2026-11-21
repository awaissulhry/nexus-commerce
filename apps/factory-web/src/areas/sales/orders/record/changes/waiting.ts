import type { Order } from '../../api'
import type { WaitingCard, WaitingRow, WaitingState } from '../overview/model'
// ---- F-OC-102: whose turn a row is and who does it ----
import { waitsForMe } from '../../../../home/approvals/requests/model'
import { yesDoorOf } from '../../depth/model'
import { rowAnchor } from '../dock/discuss'
// ---- end F-OC-102
import type { StillRowOf } from './model' // F-OC-104

/**
 * F-OC-101 … 104 (order CHANGES tab, 10-design §3; 18-lead-settles L1, L2, L4, L11) — section 1, Waiting, without a screen.
 *
 * ONE list: the rows are the waiting list's own (`orderWaitingOf`: the call Overview's Requests & changes card and the Changes badge
 * make, D8), in the same three groups and words — Waiting on us · Waiting on {customer} · Still to do — so the tab, the card and the
 * badge never disagree. This file says what the section says about them: its one answer, the reader's turns, who does each row, the
 * quiet foot and its one pointer to Production (L4).
 */

type Phrase = { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }

/** The three groups' sizes: the same rows the badge adds up (changesBadgeOf). */
export interface WaitingCounts {
  readonly onUs: number
  readonly onCustomer: number
  readonly still: number
}

export const countsOf = (card: Pick<WaitingCard, 'onUs' | 'onCustomer' | 'still'>): WaitingCounts => ({ onUs: card.onUs.length, onCustomer: card.onCustomer.length, still: card.still.length })

/**
 * The section's one answer: "5 things wait: 4 on us, 1 on Seed Customer One." · only steps: "4 steps are still to do." · nothing:
 * "Nothing waits." (the head then says the last change and, L4, where holds and dates are). The customer is named by the view.
 */
export type WaitingAnswer = { readonly kind: 'nothing' } | { readonly kind: 'steps'; readonly count: number } | { readonly kind: 'total'; readonly count: number; readonly parts: readonly Phrase[] }

export function waitingAnswerOf(counts: WaitingCounts): WaitingAnswer {
  const total = counts.onUs + counts.onCustomer + counts.still
  if (total === 0) return { kind: 'nothing' }
  if (counts.onUs === 0 && counts.onCustomer === 0) return { kind: 'steps', count: counts.still }
  const parts: Phrase[] = []
  if (counts.onUs > 0) parts.push({ key: 'changesTab.waiting.partUs', params: { count: counts.onUs } })
  if (counts.onCustomer > 0) parts.push({ key: 'changesTab.waiting.partCustomer', params: { count: counts.onCustomer } })
  if (counts.still > 0) parts.push({ key: 'changesTab.waiting.partSteps', params: { count: counts.still } })
  return { kind: 'total', count: total, parts }
}

/** "Last change: revision 2, 12/11/2026." — the order's latest revision (the changes read, else the amendments read); null: none. */
export function lastRevisionOf(revisions: readonly { readonly revision: number; readonly createdAt: string }[] | null | undefined): { readonly revision: number; readonly at: string } | null {
  const latest = [...(revisions ?? [])].sort((a, b) => b.revision - a.revision)[0]
  return latest ? { revision: latest.revision, at: latest.createdAt } : null
}

/**
 * L4 (Overview plan §5, Owner yes): ONE quiet pointer "Holds and dates are on Production ›" — only while the order has a hold or a
 * date waiting (they left this tab for Production on 11-21), never on a cancelled order; it lands on the holds first, else the dates.
 */
export function holdsPointerOf(state: WaitingState, status: Order['status']): 'holds' | 'dates' | null {
  if (state.status !== 'ready' || status === 'CANCELLED') return null
  if (state.holds.length > 0) return 'holds'
  return state.dates.length > 0 ? 'dates' : null
}

// ---- F-OC-102 (10-design §3; L1, L2, L11): one row of Waiting — its face, whose turn, who does it, its address ----------------------
/**
 * How a row of the ONE list is drawn on this tab:
 *
 *   request    a customer request waiting on us (or our counter-offer they agreed to, or that lapsed): one line, Answer… (the ONE
 *              review window) only for the team that answers its kind — "Sales answers it" / "The production manager or the planner
 *              answers it" for everyone else, no button
 *   problem    L2: a problem the customer reported — a COUNTED pointer row ("Production ›"); it is answered on Production › Problems &
 *              holds, never here
 *   approval   our approval of an old change (D2): Confirm / Refuse… for its approver only — THE place for it on this tab
 *   refused    L11: a revision the customer said no to — "Open ›" its row in What changed (restore it as before, or change it again)
 *   counter    our counter-offer still open: Open… (the same window, read only); their turn
 *   asked      what we asked the customer (an approval, a task on its portal, the revised order's yes): their turn, no button
 */
export type WaitingFace = 'request' | 'problem' | 'approval' | 'refused' | 'counter' | 'asked' | 'other'

export interface WaitingItem {
  readonly row: WaitingRow
  readonly face: WaitingFace
  /** Your turn: this reader acts on it now (the team that answers the request, the approver, Sales for a refused revision). */
  readonly mine: boolean
  /** Who does it, in words; null: nothing to say (the row's own words say it). */
  readonly who: Phrase | null
  /** The row's address ("Show on the page" and the band land here); null: none. */
  readonly anchor: string | null
}

export function waitingItemOf(row: WaitingRow, can: { readonly manage: boolean }): WaitingItem {
  const door = row.door
  if (door.kind === 'answer') {
    const request = door.request
    const who = request ? { key: request.answeredIn === 'SALES' ? 'changesTab.who.sales' : 'changesTab.who.production' } : null
    return { row, face: 'request', mine: !!request && waitsForMe(request), who, anchor: rowAnchor('OrderChangeRequest', door.requestId) }
  }
  if (row.kind === 'BRAND_REQUEST' && row.sub === 'PROBLEM') return { row, face: 'problem', mine: false, who: { key: 'changesTab.who.problem' }, anchor: row.ref ? `about-ProductionIssue-${row.ref.id}` : null }
  if (door.kind === 'yes') {
    const yes = yesDoorOf(door.task)
    return { row, face: 'approval', mine: yes.kind === 'decide', who: { key: yes.kind === 'selfAsked' ? 'changesTab.who.youAsked' : 'changesTab.who.decides', params: { who: door.task.approver.name } }, anchor: `about-Approval-${door.task.taskId}` }
  }
  if (door.kind === 'refused') return { row, face: 'refused', mine: can.manage, who: { key: 'changesTab.who.salesDecides' }, anchor: rowAnchor('Amendment', door.amendmentId) }
  if (door.kind === 'open') return { row, face: 'counter', mine: false, who: { key: 'waiting.theirTurn' }, anchor: rowAnchor('OrderChangeRequest', door.requestId) }
  if (door.kind === 'their') return { row, face: 'asked', mine: false, who: { key: 'waiting.theirTurn' }, anchor: row.ref ? `about-${row.ref.type}-${row.ref.id}` : null }
  return { row, face: 'other', mine: false, who: null, anchor: null }
}

/** "3 are your turn" (the head's tag): the rows this reader acts on now — the ones above and every Still to do row that asks them. */
export const mineCountOf = (items: readonly Pick<WaitingItem, 'mine'>[], still: readonly { readonly mayAct: boolean }[]): number => items.filter((item) => item.mine).length + still.filter((row) => row.mayAct).length
// ---- end F-OC-102

// ---- F-OC-103 (10-design §3): Waiting on {customer} — by when, and how late ----------------------------------------------------
/**
 * Whole days a row is past its due day, counted to the read's own time ("1 d late"); null: not late, or no due day known (the server
 * sends `due` with B-OC-004 — until then nothing is said, never a fake 0).
 */
export function lateDaysOf(due: string | null | undefined, asOf: string | null | undefined, now: number = Date.now()): number | null {
  const at = due ? Date.parse(due) : NaN
  if (!Number.isFinite(at)) return null
  const read = asOf ? Date.parse(asOf) : NaN
  const days = Math.floor(((Number.isFinite(read) ? read : now) - at) / 86_400_000)
  return days >= 1 ? days : null
}
// ---- end F-OC-103

// ---- F-OC-104 (10-design §3; B-OC-007): Still to do — a workshop's row under the change it waits on -----------------------------
export interface StillItem {
  readonly row: StillRowOf
  /** Its place in the group (a key when the row names no record). */
  readonly index: number
  /** The workshops told by themselves when this work-order change is applied (their rows name it: `waitsOn`). */
  readonly workshops: readonly StillRowOf[]
}

/**
 * The rows of one accepted change as drawn: a workshop's row that names the work-order change it waits on (B-OC-007) is that change's
 * sub-line, never a row of its own; a workshop's row that names none (an older answer, or its change is not in this group) stays a
 * row. Every row is still counted (the badge and the group's head count the read's rows).
 */
export function stillItemsOf(rows: readonly StillRowOf[]): StillItem[] {
  const changes = new Set(rows.flatMap((row) => (row.kind === 'WORK_ORDER_CHANGE' && row.ref ? [row.ref.id] : [])))
  const folded = (row: StillRowOf): boolean => row.kind === 'TELL_WORKSHOP' && !!row.waitsOn && changes.has(row.waitsOn)
  return rows.flatMap((row, index) => (folded(row) ? [] : [{ row, index, workshops: row.kind === 'WORK_ORDER_CHANGE' && row.ref ? rows.filter((other) => folded(other) && other.waitsOn === row.ref!.id) : [] }]))
}
// ---- end F-OC-104
