import { CARD_LIMITS, type UrgencyAct, type UrgencyDialog, type UrgencyOverrideActions, type UrgencyOverrideModel, type UrgencyTarget } from '../../../../_shared/customer-urgency/model'
import type { OrderRow } from '../../api'
import type { StepUpState } from '../../hooks'
import { answerHrefOf, oneCustomerHeld, type Phrase } from './model'

/**
 * F-CW-302 (customer Work tab plan §4; 10-design §4, §5; lead settles S7, S14, S35) — the customer's urgency as WE steer it, on the
 * ONE Orders sheet: Set to regular… · Lock… · Unlock… in a row's ⋯ and (the first and the last) under More ▾. The window, its rules
 * and its one write are the shared ones (areas/_shared/customer-urgency: the work order's Customer card mounts the same); this file is
 * only what the sheet adds — which act a row offers, which ticked orders an act runs on, and why it is held BEFORE the click (by a
 * state only: an act without production.brand.override is not drawn — sheet/bar.ts, the row menu).
 *
 * The facts are the row's own (`customerUrgencyState`: the state, the lock, the open request). A row without it has no urgency that
 * counts — the order left production, or the customer's switch is off — and offers no act.
 */

/** The row as these rules read it. */
export type UrgencyRow = Pick<OrderRow, 'id' | 'number' | 'customerRef' | 'partyId' | 'partyName' | 'customerUrgencyState'>

/**
 * The acts one order offers — the Customer card's own rule: Set to regular… on an order the customer marks Urgent; Lock… while it
 * is not locked, Unlock… while it is. None without a state that counts.
 */
export function rowUrgencyActs(row: Pick<OrderRow, 'customerUrgencyState'>): UrgencyAct[] {
  const state = row.customerUrgencyState
  if (!state) return []
  return [...(state.state === 'URGENT' ? (['regular'] as const) : []), state.locked ? 'unlock' : 'lock']
}

/**
 * Where "Urgent – asked" leads (S7): the order's own request that waits on us — the review window in place on a page that holds it
 * (the customer's Work tab: the host's door), else the order's Changes tab (Sales › Orders, Made to measure). null: the order asks
 * nothing (or an older answer without the state).
 */
export function askedHrefOf(prefix: string, row: Pick<OrderRow, 'id' | 'customerUrgencyState'>, doorHref?: ((requestId: string) => string) | null): string | null {
  const state = row.customerUrgencyState
  if (!state || state.state !== 'ASKED') return null
  return answerHrefOf(prefix, row, { kind: 'request', count: 1, requestId: state.requestId }, doorHref)
}

/** The ticked orders an act runs on (the window names exactly these). */
export function urgencyTargetsOf(act: UrgencyAct, rows: readonly UrgencyRow[]): UrgencyTarget[] {
  return rows.filter((row) => rowUrgencyActs(row).includes(act)).map((row) => ({ id: row.id, number: row.number, customerRef: row.customerRef }))
}

/** The window an act opens over these rows, or null when none of them takes it. */
export function urgencyDialogOf(act: UrgencyAct, rows: readonly UrgencyRow[]): UrgencyDialog | null {
  const orders = urgencyTargetsOf(act, rows)
  const first = rows[0]
  return first && orders.length > 0 ? { act, partyId: first.partyId, orders } : null
}

/** The two acts More ▾ offers over ticked orders (Lock… is a row's own act: it needs each order's own reason). */
export type ManyUrgencyAct = 'regular' | 'unlock'

/** What the host knows of the ticked orders' customer (the customer's Work tab reads its switch; the other hosts know nothing). */
export interface UrgencyHost {
  readonly locked: string | null
  /** The customer's urgency switch is off (the Work tab's own read): every act is held with these words. */
  readonly urgencyOff?: boolean
}

/**
 * Why "Customer urgency: Set to regular…" / "… Unlock…" is held before the click, or null: orders of more than one customer (one
 * window, one reason the customer reads), the customer's switch off, none of the ticked orders in the state the act needs, more than
 * the write takes at once.
 */
export function urgencyHeld(act: ManyUrgencyAct, rows: readonly UrgencyRow[], host: UrgencyHost): Phrase | null {
  if (rows.length === 0) return null
  const one = oneCustomerHeld(rows, host.locked)
  if (one) return one
  const customer = rows[0]!.partyName
  if (host.urgencyOff) return { key: 'urgency.held.off', params: { customer } }
  const targets = urgencyTargetsOf(act, rows)
  if (targets.length === 0) return act === 'regular' ? { key: 'urgency.held.noneUrgent', params: { count: rows.length, customer } } : { key: 'urgency.held.noneLocked', params: { count: rows.length } }
  if (targets.length > CARD_LIMITS.orders) return { key: 'bulk.tooMany', params: { max: CARD_LIMITS.orders } }
  return null
}

// ---- the window on the sheet, as its container holds it and its view draws it -----------------------------------------------------

/** The sheet's mount of the shared urgency window: its model, the reader's right, and the host's own step-up (a fresh code). */
export interface SheetUrgencyModel extends UrgencyOverrideModel {
  /** production.brand.override: without it no urgency act is drawn (the model is then absent). */
  readonly can: boolean
  /** The host's step-up dialog (orders/hooks useStepUp): open with the sentence of what the code allows. */
  readonly stepUp: StepUpState
}

export interface SheetUrgencyActions extends UrgencyOverrideActions {
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}
