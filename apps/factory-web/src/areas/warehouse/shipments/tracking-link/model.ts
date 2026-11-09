import { isApiError } from '../../../../lib/api/errors'
import type { TrackingLinks } from './api'

/**
 * The shipment's tracking-page card, pure (B-W2b-170): its view model, what each button is held by, and what an answer
 * means — in codes the view says in the person's language.
 */

export type Busy = null | 'send' | 'other' | 'copy' | `revoke:${string}`
export type Outcome = null | { readonly kind: 'sent'; readonly count: number } | { readonly kind: 'skipped' } | { readonly kind: 'failed'; readonly why: 'forbidden' | 'refused' | 'error' }

export interface TrackingLinkCardModel {
  readonly state: 'loading' | 'ready' | 'error'
  readonly read: TrackingLinks | null
  readonly busy: Busy
  /** The link just taken to pass on (its address shown this once, until the tab is left), and whether it was copied. */
  readonly passOn: { readonly url: string; readonly copied: boolean } | null
  /** "To another address": the field, open or not, and its problem. */
  readonly other: { readonly open: boolean; readonly email: string; readonly problem: 'EMPTY' | 'FORMAT' | null }
  readonly outcome: Outcome
}

export interface TrackingLinkCardActions {
  onRetry?: () => void
  onSend?: () => void
  onOther?: (open: boolean) => void
  onOtherEmail?: (email: string) => void
  onSendOther?: () => void
  onCopy?: () => void
  onCopyAgain?: () => void
  onRevoke?: (linkId: string) => void
}

export const initialCard: TrackingLinkCardModel = { state: 'loading', read: null, busy: null, passOn: null, other: { open: false, email: '', problem: null }, outcome: null }

/** Why a link cannot be made now, as a message key of `shipment-tracking-link` (null: it can). */
export function makeHeldKey(read: TrackingLinks, busy: Busy): string | null {
  if (!read.mayManage) return 'held.noManage'
  if (read.held) return `held.${read.held}`
  if (busy) return 'held.busy'
  return null
}

/** Why "Send" (to the customer's orders contacts) is held. */
export function sendHeldKey(read: TrackingLinks, busy: Busy): string | null {
  return makeHeldKey(read, busy) ?? (read.recipients.length === 0 ? 'held.noRecipients' : null)
}

/** Why a link cannot be withdrawn. */
export function revokeHeldKey(read: TrackingLinks, state: TrackingLinks['links'][number]['state'], busy: Busy): string | null {
  if (!read.mayManage) return 'held.noManage'
  if (state !== 'LIVE') return 'held.notLive'
  if (busy) return 'held.busy'
  return null
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const emailProblem = (email: string): 'EMPTY' | 'FORMAT' | null => (email.trim() === '' ? 'EMPTY' : EMAIL.test(email.trim()) ? null : 'FORMAT')

/** A refused write in our words. */
export function outcomeOfError(error: unknown): Outcome {
  if (isApiError(error) && error.kind === 'forbidden') return { kind: 'failed', why: 'forbidden' }
  if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'invalid')) return { kind: 'failed', why: 'refused' }
  return { kind: 'failed', why: 'error' }
}

export const LINK_TONE = { LIVE: 'success', REVOKED: 'neutral', USED_UP: 'neutral', EXPIRED: 'neutral', ENDED: 'neutral' } as const
