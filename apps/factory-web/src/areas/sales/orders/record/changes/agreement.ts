import type { Order } from '../../api'
import type { Change, Changes, Confirmation } from '../../depth/api'
import { confirmationState } from '../../depth/model'

/**
 * F-OC-203 (order CHANGES tab, 10-design §6; 18-lead-settles L5, L9, L10) — section 4, Customer's agreement, without a screen: how the
 * customer said yes and whether our confirmation prints the order as it is now, said in ONE tag and ONE sentence (the first that
 * applies):
 *
 *   cancelled      Nothing is sent for a cancelled order.
 *   afterApproval  The confirmation is made once we approve the order.
 *   saidNo         {customer} said no to revision 2 on 13/11/2026: decide in Waiting ↑ — restore it as before, or change it again.
 *   waiting        Revision 3 waits for their yes since 19/11/2026: see Waiting on {customer} ↑.
 *   notAsked       Revision 2 needs their yes, but it was never asked (or the ask expired): ask {customer} now. (L5: Ask {customer}…)
 *   sendNew        Send a new confirmation: the order changed after v1 was sent.
 *   notSent        The confirmation is not sent yet.
 *   agreed         Agreed and confirmed: v2 sent 04/11/2026.
 *
 * L10: the confirmation shows prices — for a reader without the price grain Open, Make and Send are hidden and one line of words
 * says who sends it. L9: it is made and sent in the ORDER's language, never the office person's.
 */

export type AgreementState =
  | { readonly kind: 'cancelled' | 'afterApproval' | 'notSent' | 'unknown' }
  | { readonly kind: 'saidNo'; readonly revision: number; readonly at: string | null }
  | { readonly kind: 'waiting'; readonly revision: number; readonly since: string }
  | { readonly kind: 'notAsked'; readonly revision: number; readonly expired: boolean }
  | { readonly kind: 'sendNew'; readonly version: number }
  | { readonly kind: 'agreed'; readonly version: number; readonly at: string }

export const AGREEMENT_TONE: Readonly<Record<AgreementState['kind'], 'success' | 'warning' | 'danger' | 'neutral'>> = Object.freeze({
  cancelled: 'neutral',
  afterApproval: 'neutral',
  unknown: 'neutral',
  saidNo: 'danger',
  waiting: 'warning',
  notAsked: 'warning',
  sendNew: 'warning',
  notSent: 'warning',
  agreed: 'success',
})

/** The latest revision's ask, while the order waits for the customer's yes (the changes read's `reapprovalNeededAt`). */
export function revisionYesOf(changes: Pick<Changes, 'reapprovalNeededAt' | 'changes'> | null | undefined): { readonly change: Change; readonly since: string } | null {
  if (!changes?.reapprovalNeededAt) return null
  const latest = [...changes.changes].sort((a, b) => b.revision - a.revision)[0]
  return latest ? { change: latest, since: changes.reapprovalNeededAt } : null
}

export function agreementOf(input: { readonly status: Order['status']; readonly changes: Pick<Changes, 'reapprovalNeededAt' | 'changes'> | null; readonly confirmation: Confirmation | null }): AgreementState {
  if (input.status === 'CANCELLED') return { kind: 'cancelled' }
  if (input.status === 'PENDING_APPROVAL') return { kind: 'afterApproval' }
  const yes = revisionYesOf(input.changes)
  if (yes) {
    const decision = yes.change.customer.decision
    if (decision === 'REFUSED') return { kind: 'saidNo', revision: yes.change.revision, at: yes.change.customer.answeredAt }
    if (decision === 'WAITING') return { kind: 'waiting', revision: yes.change.revision, since: yes.since }
    if (decision === 'NOT_ASKED' || decision === 'EXPIRED' || decision === 'WITHDRAWN') return { kind: 'notAsked', revision: yes.change.revision, expired: decision === 'EXPIRED' }
  }
  const confirmation = input.confirmation
  if (!confirmation) return { kind: 'unknown' }
  const state = confirmationState(confirmation)
  if (state === 'none' || state === 'notYet' || !confirmation.sentAt || confirmation.sentVersion === null) return { kind: 'notSent' }
  if (state === 'outdated') return { kind: 'sendNew', version: confirmation.sentVersion }
  return { kind: 'agreed', version: confirmation.sentVersion, at: confirmation.sentAt }
}

/** "Send version 3…": the version a send carries — the newest when it prints the order as it is, else the next one it makes. */
export function sendVersionOf(confirmation: Pick<Confirmation, 'versions' | 'upToDate'>): number {
  const newest = confirmation.versions[0]?.version ?? 0
  return newest === 0 || confirmation.upToDate === false ? newest + 1 : newest
}

/** B-OC-015: the signed PDF's check in words; before the server sends it, a document that "differs" may only be missing — neutral. */
export type SignedCheck = 'kept' | 'missing' | 'differs' | 'unchecked'
export function signedCheckOf(acceptance: { readonly documentMatches: boolean; readonly documentCheck?: 'MATCHES' | 'PDF_MISSING' | 'DIFFERS' | undefined }): SignedCheck {
  if (acceptance.documentCheck === 'MATCHES') return 'kept'
  if (acceptance.documentCheck === 'PDF_MISSING') return 'missing'
  if (acceptance.documentCheck === 'DIFFERS') return 'differs'
  return acceptance.documentMatches ? 'kept' : 'unchecked'
}
export const SIGNED_TONE: Readonly<Record<SignedCheck, 'success' | 'neutral' | 'danger'>> = Object.freeze({ kept: 'success', missing: 'neutral', differs: 'danger', unchecked: 'neutral' })

/** L9: the language the confirmation is made and sent in — the order's own (the customer reads it), never the office person's. */
export const confirmationLanguageOf = (order: Pick<Order, 'language'>): 'it' | 'en' => (order.language === 'en' ? 'en' : 'it')
