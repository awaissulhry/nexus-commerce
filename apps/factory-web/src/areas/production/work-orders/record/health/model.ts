import { healthRank, HEALTH_NOTE_MAX, HEALTH_REASON_CODES, type BrandHealth, type HealthReasonCode } from '@nexus/factory-domain/production-brand/health'
import { WAITING_ON, type WaitingOn } from '@nexus/factory-domain/production-brand/waiting'
import { isApiError } from '../../../../../lib/api/errors'
import type { HealthInput, HealthState, WaitingInput } from '../../../../../lib/production/model'
import type { WorkOrder } from '../../../_shared/api'
import type { Phrase } from '../../../_shared/model'
import type { BrandHealthView } from './api'

/**
 * F-PR-05a — the work order's health, without a screen (production plan §4 "Health: computed; a person may raise it to At risk
 * with a reason code (drops after 7 days or when the computed health changes). The brand reads the chip and the reason code; free
 * text goes through the thread"; B-PR-35). Health is the sales order's (what its customer reads): the band shows the worst of the
 * work order's orders and who they wait on; the Overview's Health card shows each order's with the raise and the office's note, and
 * "Raise to At risk" (production.brand.manage).
 *
 * Wall (PW-03): only the work order's OWN orders are read (`healthOrdersOf`); the API answers another customer's order as unknown.
 */

export interface HealthPart {
  readonly orderId: string
  readonly number: string
  /** null value while it is read; a problem when the read failed (never drawn as "on track"). */
  readonly read: { readonly value: BrandHealthView | null; readonly problem: string | null }
}

export interface HealthModel {
  readonly orders: readonly HealthPart[]
  /** production.brand.manage: raise and clear. */
  readonly can: boolean
  /** The Raise to At risk dialog, for one order. */
  readonly dialog: { readonly orderId: string } | null
  readonly busy: boolean
  /** A refused write, said in the dialog (or above the card when no dialog is open). */
  readonly problem: Phrase | null
  /** Design cases: the dialog's reason and note. */
  readonly draft?: { readonly reasonCode?: string; readonly note?: string }
}

export interface RaiseInput {
  readonly orderId: string
  readonly reasonCode: HealthReasonCode
  readonly note: string | null
}

export interface HealthActions {
  /** Open the dialog for an order (null closes it). */
  onDialog?: (orderId: string | null) => void
  onRaise?: (input: RaiseInput) => void
  onClear?: (orderId: string) => void
  onRetry?: () => void
}

/** The orders whose health this work order shows: its own (one customer per work order), each once, in its order. */
export function healthOrdersOf(workOrder: Pick<WorkOrder, 'orders'>): Array<{ orderId: string; number: string }> {
  return workOrder.orders.filter((order, index) => workOrder.orders.findIndex((other) => other.id === order.id) === index).map((order) => ({ orderId: order.id, number: order.number }))
}

const STATE_OF: Readonly<Record<BrandHealth, HealthState>> = { LATE: 'LATE', AT_RISK: 'AT_RISK', NO_DATE: 'NOT_PROMISED', ON_TRACK: 'ON_TIME' }

/** The shared chip's state of a brand health (the customer's words: "No date yet", "On track"). */
export const healthStateOf = (health: BrandHealth | null): HealthState | null => (health === null ? null : STATE_OF[health])

/** The shared chip's input for one order: the keeper's computed health and a person's raise while it stands (with the office's note). */
export function healthInputOf(view: BrandHealthView, daysLate: number | null): HealthInput {
  const raise = view.raise && view.raise.stands ? view.raise : null
  return {
    // Not followed yet (the order's production state starts at CONFIRMED): not known, never "on track".
    computed: view.kept ? healthStateOf(view.computed) : undefined,
    daysLate: view.computed === 'LATE' ? daysLate : null,
    raised: raise ? { reason: raise.reasonCode, note: raise.note, by: raise.setBy?.name ?? null, at: raise.setAt } : null,
  }
}

/**
 * The band's health: the worst order the customer reads (its effective health), or 'loading' while one is read, or null for a work
 * order of no order (nothing to follow). A read that failed counts as not known ("—"), never as on track.
 */
export function bandHealthOf(parts: readonly HealthPart[], daysLate: number | null): HealthInput | 'loading' | null {
  if (parts.length === 0) return null
  if (parts.some((part) => part.read.value === null && part.read.problem === null)) return 'loading'
  const read = parts.flatMap((part) => (part.read.value && part.read.value.kept ? [part.read.value] : []))
  if (read.length === 0) return { computed: undefined }
  const worst = read.reduce((a, b) => (healthRank(b.health ?? 'ON_TRACK') < healthRank(a.health ?? 'ON_TRACK') ? b : a))
  return healthInputOf(worst, daysLate)
}

/** The band's waiting on: the first owner customer → supplier → workshop → us among the orders, since its earliest. */
export function bandWaitingOf(parts: readonly HealthPart[]): WaitingInput | 'loading' | null {
  if (parts.length === 0) return null
  if (parts.some((part) => part.read.value === null && part.read.problem === null)) return 'loading'
  const read = parts.flatMap((part) => (part.read.value && part.read.value.kept && part.read.value.waitingOn ? [part.read.value] : []))
  for (const on of WAITING_ON) {
    const mine = read.filter((view) => view.waitingOn === on)
    if (mine.length === 0) continue
    const since = mine.flatMap((view) => (view.waitingSince ? [view.waitingSince] : [])).sort()[0] ?? null
    return { who: on as WaitingOn, since }
  }
  return { who: undefined }
}

const ONE_LINE = /^[^\r\n]*$/

/** Why "Raise to At risk" waits for this order, in this app's words (the API checks again: B-PR-35 raiseProblems). */
export function raiseOpenHeld(view: BrandHealthView | null, can: boolean): Phrase | null {
  if (!can) return { key: 'raise.held.noRight' }
  if (!view) return { key: 'held.checking' }
  if (!view.kept) return { key: 'raise.held.notKept' }
  if (view.computed === null) return { key: 'raise.held.nothingLeft' }
  if (view.computed === 'LATE') return { key: 'raise.held.late' }
  if (view.computed === 'AT_RISK') return { key: 'raise.held.atRisk' }
  return null
}

/** Why the dialog's "Raise to At risk" waits: the order's state, a reason to pick, a note of one line and at most 200 characters. */
export function raiseHeld(view: BrandHealthView | null, can: boolean, reasonCode: string, note: string, busy: boolean): Phrase | null {
  const open = raiseOpenHeld(view, can)
  if (open) return open
  if (!(HEALTH_REASON_CODES as readonly string[]).includes(reasonCode)) return { key: 'raise.held.pick' }
  const text = note.trim()
  if (text.length > HEALTH_NOTE_MAX || !ONE_LINE.test(text)) return { key: 'raise.held.note', params: { max: HEALTH_NOTE_MAX } }
  if (busy) return { key: 'held.busy' }
  return null
}

/** Why "Clear the raise" waits (no raise to clear, no right, a write running). */
export function clearHeld(view: BrandHealthView | null, can: boolean, busy: boolean): Phrase | null {
  if (!can) return { key: 'raise.held.noRight' }
  if (!view?.raise) return { key: 'raise.held.noRaise' }
  if (busy) return { key: 'held.busy' }
  return null
}

/** A refused raise or clear, in this app's words (never the API's English). */
export function raiseProblem(error: unknown): Phrase {
  if (!isApiError(error)) return { key: 'error.write' }
  switch (error.kind) {
    case 'conflict':
      return { key: 'raise.refused' }
    case 'invalid':
      return { key: 'raise.invalid' }
    case 'not_found':
      return { key: 'error.gone' }
    case 'forbidden':
    case 'step_up':
      return { key: 'error.forbidden' }
    case 'unavailable':
      return { key: 'error.offline' }
    default:
      return { key: 'error.write' }
  }
}
