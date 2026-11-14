import type { Phrase, Tone } from '../../_shared/model'
import type { DeadlineState, SelfInvoice, SelfInvoiceCandidate, SelfInvoiceKind, SelfInvoiceStatus } from './api'

/**
 * Self-invoices, pure (B-W2b-417; design finance.payables sec:selfinv "Purchase, kind (TD17 services from abroad · TD18
 * goods from the EU · TD19 goods already in Italy), deadline, status", "Create from the supplier invoice"): who may do what,
 * the rows (to do, issued, cancelled, all), the deadline in words, what holds each verb and the bulk "Make drafts", and
 * the refusals' codes (`finance-invoices-depth`).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface SelfInvoiceAbilities {
  view: boolean
  /** The candidates read the supplier invoices (payables.view). */
  payables: boolean
  /** Making one (its draft) and cancelling one. */
  manage: boolean
  /** A self-invoice's draft is a purchase's amounts (money.cost). */
  cost: boolean
  issue: boolean
}

export const selfInvoiceAbilitiesOf = (permissions: readonly string[]): SelfInvoiceAbilities => {
  const held = new Set(permissions)
  return { view: held.has('invoices.view'), payables: held.has('payables.view'), manage: held.has('invoices.manage'), cost: held.has('money.cost'), issue: held.has('invoices.issue') }
}

export const SELF_ROWS = ['open', 'issued', 'cancelled', 'all'] as const
export type SelfRows = (typeof SELF_ROWS)[number]
export const statusOfRows = (rows: SelfRows): SelfInvoiceStatus | null => (rows === 'open' ? 'PENDING' : rows === 'issued' ? 'ISSUED' : rows === 'cancelled' ? 'CANCELLED' : null)

export const DEADLINE_TONE: Record<DeadlineState, Tone> = { OPEN: 'neutral', DUE_SOON: 'warning', LATE: 'danger', DONE: 'success' }
export const STATUS_TONE: Record<SelfInvoiceStatus, Tone> = { PENDING: 'warning', ISSUED: 'success', CANCELLED: 'neutral' }

/** The deadline in words: days left, due today, late by n days, done. */
export function deadlineWords(state: { state: DeadlineState; daysLeft: number }): Phrase {
  if (state.state === 'DONE') return phrase('self.deadline.done')
  if (state.state === 'LATE') return phrase('self.deadline.late', { count: Math.abs(state.daysLeft) })
  if (state.daysLeft === 0) return phrase('self.deadline.today')
  return phrase('self.deadline.left', { count: state.daysLeft })
}

/** Where a self-invoice stands: to draft, its draft waiting, issued (number), cancelled. */
export function stageOf(row: Pick<SelfInvoice, 'status' | 'invoice'>): Phrase {
  if (row.status === 'CANCELLED') return phrase('self.stage.cancelled')
  if (row.status === 'ISSUED') return phrase('self.stage.issued', { number: row.invoice?.number ?? '—' })
  return row.invoice ? phrase('self.stage.draft') : phrase('self.stage.toDraft')
}

/** Why "Make its draft" is held: the rights (its amounts are a purchase's), the API's word, busy. */
export function draftHeld(row: Pick<SelfInvoice, 'can' | 'invoice' | 'status'>, can: SelfInvoiceAbilities, busy = false): Phrase | null {
  if (!can.manage) return phrase('self.held.noManage')
  if (!can.cost || !can.payables) return phrase('self.held.noCost')
  if (row.status !== 'PENDING') return phrase('self.held.notPending')
  if (row.invoice) return phrase('self.held.hasDraft')
  if (!row.can.draft) return phrase('self.held.cannot')
  if (busy) return phrase('held.busy')
  return null
}

/** Why "Cancel" is held: the right, issued, cancelled already, busy. */
export function cancelHeld(row: Pick<SelfInvoice, 'can' | 'status'>, can: SelfInvoiceAbilities, busy = false): Phrase | null {
  if (!can.manage) return phrase('self.held.noManage')
  if (row.status === 'ISSUED') return phrase('self.held.issued')
  if (row.status === 'CANCELLED') return phrase('self.held.cancelled')
  if (!row.can.cancel) return phrase('self.held.cannot')
  if (busy) return phrase('held.busy')
  return null
}

/** Why "Create from the supplier invoice" is held: the rights. */
export function createHeld(can: SelfInvoiceAbilities): Phrase | null {
  if (!can.manage) return phrase('self.held.noManage')
  if (!can.cost || !can.payables) return phrase('self.held.noCost')
  return null
}

/** The kind preset for a candidate: the suggestion, else none (mixed lines: the person decides). */
export const presetKind = (candidate: Pick<SelfInvoiceCandidate, 'suggestion'> | null): SelfInvoiceKind | null => candidate?.suggestion.kind ?? null

/** Why the create dialog's Create is held. */
export function createDialogHeld(input: { candidate: SelfInvoiceCandidate | null; kind: SelfInvoiceKind | null; busy: boolean }): Phrase | null {
  if (input.busy) return phrase('held.busy')
  if (!input.candidate) return phrase('self.create.held.pick')
  if (!input.kind) return phrase('self.create.held.kind')
  return null
}

/** The cancel's reason: 3 to 500 characters. */
export const reasonProblem = (reason: string): Phrase | null => (reason.trim().length < 3 ? phrase('self.cancelProblem.short') : reason.trim().length > 500 ? phrase('self.cancelProblem.long') : null)

/** The refusal codes of self-invoices this step words. */
export const SELF_REFUSALS = ['SELF_INVOICE', 'SELF_INVOICE_ISSUED', 'NO_RATE', 'SWITCH_OFF', 'DATABASE'] as const
