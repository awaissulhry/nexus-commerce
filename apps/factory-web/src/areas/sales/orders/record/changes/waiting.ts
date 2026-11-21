import type { Order } from '../../api'
import type { WaitingCard, WaitingState } from '../overview/model'

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
