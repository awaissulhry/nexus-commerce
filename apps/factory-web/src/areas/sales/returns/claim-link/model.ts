import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { ClaimLinkBody, ClaimLinkSent } from './api'

/**
 * F-OS-303 — Send a claim link…, pure: to whom (one of the customer's active contacts with an e-mail, or an address typed), what holds
 * Send, the request, a refusal in words.
 */

export interface ClaimContact {
  readonly id: string
  readonly name: string
  readonly email: string
}

export interface ClaimLinkModel {
  /** What the link names: a shipment that left (its row) or the order (the section head), and its number for the title. */
  readonly record: { readonly type: 'Shipment' | 'SalesOrder'; readonly id: string; readonly number: string }
  /** The customer's contacts with an e-mail (null: being read; a failed read leaves only the typed address). */
  readonly contacts: readonly ClaimContact[] | null
  /** The contact picked ('' : none), or 'other' with the address typed. */
  readonly to: string
  readonly email: string
  readonly busy: boolean
  readonly problem: string | null
  readonly sent: ClaimLinkSent | null
}

export interface ClaimLinkActions {
  onTo?: (to: string) => void
  onEmail?: (email: string) => void
  onSend?: () => void
  onClose?: () => void
}

export const OTHER_ADDRESS = 'other'
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Why Send waits, as a key of the lane's words (null: it may go). */
export function claimLinkHeld(model: Pick<ClaimLinkModel, 'to' | 'email' | 'busy'>): string | null {
  if (model.busy) return 'door.held.busy'
  if (model.to === '') return 'claim.held.pickTo'
  if (model.to === OTHER_ADDRESS && !EMAIL.test(model.email.trim())) return 'claim.held.email'
  return null
}

/** The request: the record, and the contact or the address typed; always mailed (`send`). */
export function claimLinkBody(model: Pick<ClaimLinkModel, 'record' | 'to' | 'email'>): ClaimLinkBody {
  const to = model.to === OTHER_ADDRESS ? { email: model.email.trim() } : { contactId: model.to }
  return { recordType: model.record.type, recordId: model.record.id, ...to, send: true }
}

/** A refusal in the lane's words: an address that bounced, an address the API refuses, a record it cannot find; else try again. */
export function claimLinkRefusal(error: unknown): string {
  if (!isApiError(error)) return 'claim.refusal.other'
  const paths = error.issues.map((issue) => issuePath(issue))
  if (paths.includes('refusal/SUPPRESSED')) return 'claim.refusal.SUPPRESSED'
  if (paths.some((path) => path === 'body/email' || path === 'body/contactId')) return 'claim.refusal.email'
  if (error.status === 404) return 'claim.refusal.notFound'
  return 'claim.refusal.other'
}
