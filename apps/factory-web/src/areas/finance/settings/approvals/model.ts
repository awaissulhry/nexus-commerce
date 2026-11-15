import { scoped, type Phrase } from '../../payments/riba/depth'
import type { MoneyControl } from './api'

/**
 * Approvals & notifications without a screen (B-W2b-425): what each money action asks today, in a code the view words, and
 * why a switch waits. Pure: the tests hold it.
 */

export interface ApprovalsCan {
  /** payables.view: the card is read. */
  view: boolean
  /** money.cost: the dual approval's amount is drawn. */
  cost: boolean
}

export const approvalsCanOf = (permissions: readonly string[]): ApprovalsCan => ({ view: permissions.includes('payables.view'), cost: permissions.includes('money.cost') })

/**
 * What asks a yes for an action: NO_KIND (the schema has no approval kind for it yet), NOT_REGISTERED (the kind exists, no
 * module asks it), NO_RULE (no rule of its kind is on for the company: no yes is asked), RULES (that many rules on), SEPARATION
 * (the person who made it never approves it; no rule needed).
 */
export type YesState = 'NO_KIND' | 'NOT_REGISTERED' | 'NO_RULE' | 'RULES' | 'SEPARATION'

export function yesStateOf(control: MoneyControl): YesState {
  if (control.code === 'SUPPLIER_INVOICE' || control.code === 'PAYMENT_PROPOSAL') return 'SEPARATION'
  if (!control.kind) return 'NO_KIND'
  if (!control.kind.registered) return 'NOT_REGISTERED'
  return control.kind.active > 0 ? 'RULES' : 'NO_RULE'
}

export type SwitchName = 'remittance' | 'notice'

/** Why a mail switch waits (null: it may move): not read, not the person's (the Owner's alone), a write running. */
export function switchHeld(input: { read: boolean; mayChange: boolean; busy: boolean }): Phrase | null {
  if (!input.read) return { key: scoped('approvals.held.unread') }
  if (!input.mayChange) return { key: scoped('approvals.held.owner') }
  if (input.busy) return { key: 'held.busy' }
  return null
}

/** A settings change of either switch, or an approval rule, reads the card again. */
export const approvalsTouched = (change: { type: string }): boolean => change.type === 'payables_settings.changed' || change.type === 'collections_settings.changed' || change.type === 'approval.rule_changed'
