import type { Issue } from '../core/errors'
import type { OutboundStatus, SuppressionReason } from '../email/rules'

/**
 * The mail delivery log and the blocked addresses (B-W2a-41; PLT-149; design admin.connections "Delivery log and
 * blocked addresses"), pure:
 *
 *   - where a mail is, in five words the log filters by: WAITING (queued or being sent), SENT (the provider took it, no
 *     word back yet), DELIVERED, PROBLEM (bounced or complained: the address is blocked) and FAILED (never left: refused
 *     or out of tries). The time shown is the time of its latest state.
 *   - addresses are masked for readers who do not manage the company's mail (`a•••@cliente.example`): the domain stays,
 *     so the reader knows whose mail it was; the person in full only with email.manage.
 *   - a blocked address (Suppression) is never deleted: it is the record of why mail stopped. Unblocking keeps the row
 *     and moves its address aside to `~unblocked:<row id>:<address>` (factory-db has no lifted column yet, a schema
 *     need named in the step notes), so every send (which looks the address up) finds nothing, a later bounce blocks the
 *     address again in a new row, and the unblocked row still says what it was, when and why it was unblocked (audit).
 */

export const DELIVERY_STATES = ['WAITING', 'SENT', 'DELIVERED', 'PROBLEM', 'FAILED'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** The statuses of each state (for a filter). */
export const STATUSES_OF: Readonly<Record<DeliveryState, readonly OutboundStatus[]>> = Object.freeze({
  WAITING: ['QUEUED', 'SENDING'],
  SENT: ['SENT'],
  DELIVERED: ['DELIVERED'],
  PROBLEM: ['BOUNCED', 'COMPLAINED'],
  FAILED: ['FAILED'],
})

export function deliveryStateOf(status: OutboundStatus): DeliveryState {
  for (const state of DELIVERY_STATES) if (STATUSES_OF[state].includes(status)) return state
  return 'WAITING'
}

/** The time of a mail's latest state: the problem, the delivery, the send, else when it was queued. */
export function deliveryTimeOf(row: {
  readonly status: OutboundStatus
  readonly queuedAt: Date
  readonly sentAt: Date | null
  readonly deliveredAt: Date | null
  readonly bouncedAt: Date | null
  readonly complainedAt: Date | null
  readonly failedAt: Date | null
}): Date {
  switch (row.status) {
    case 'COMPLAINED':
      return row.complainedAt ?? row.bouncedAt ?? row.deliveredAt ?? row.sentAt ?? row.queuedAt
    case 'BOUNCED':
      return row.bouncedAt ?? row.deliveredAt ?? row.sentAt ?? row.queuedAt
    case 'DELIVERED':
      return row.deliveredAt ?? row.sentAt ?? row.queuedAt
    case 'SENT':
      return row.sentAt ?? row.queuedAt
    case 'FAILED':
      return row.failedAt ?? row.queuedAt
    default:
      return row.queuedAt
  }
}

/** `ada.esempio@cliente.example` → `a•••@cliente.example`; something that is not an address → `•••`. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@')
  if (at <= 0) return '•••'
  return `${address[0]}•••${address.slice(at)}`
}

/** The stored address of an unblocked row: moved aside so no send finds it, still readable. */
export const UNBLOCKED_PREFIX = '~unblocked:'
export const unblockedAddress = (suppressionId: string, address: string): string => `${UNBLOCKED_PREFIX}${suppressionId}:${address}`
export const isUnblocked = (stored: string): boolean => stored.startsWith(UNBLOCKED_PREFIX)

/** The address a row is about, unblocked or not. */
export function addressOfSuppression(stored: string): string {
  if (!isUnblocked(stored)) return stored
  const rest = stored.slice(UNBLOCKED_PREFIX.length)
  const colon = rest.indexOf(':')
  return colon < 0 ? rest : rest.slice(colon + 1)
}

export const UNBLOCK_REASON_MIN = 3
export const UNBLOCK_REASON_MAX = 500

/** What stops an unblock: a row already unblocked, no reason. */
export function unblockProblems(input: { readonly address: string; readonly reason: string }): Issue[] {
  const problems: Issue[] = []
  if (isUnblocked(input.address)) problems.push({ path: 'suppression/unblocked', message: 'This address was unblocked already: mail may go to it.' })
  if (input.reason.trim().length < UNBLOCK_REASON_MIN) problems.push({ path: 'body/reason', message: 'Say why mail may go to this address again (for example: the customer fixed their mailbox).' })
  return problems
}

/** Why an address is blocked, in words (the log and the confirm). */
export const BLOCK_REASON_WORDS: Readonly<Record<SuppressionReason, string>> = Object.freeze({
  BOUNCE: 'the mail bounced for good (the mailbox does not exist or refuses mail)',
  COMPLAINT: 'the recipient marked our mail as spam',
  MANUAL: 'a person stopped mail to it',
})
