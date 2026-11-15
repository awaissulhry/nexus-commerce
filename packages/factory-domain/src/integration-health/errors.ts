/**
 * The error queue's rules (B-W2b-415; PLT-201; design admin.connections sec:errors, pop:error-item), pure: the API and the
 * web share them. One IntegrationErrorItem per failed source row (factory-db privacy-ops.prisma):
 *
 *   OUTBOX    an event the relay gave up on (DEAD: `publish_failed`), or one whose background job ran out of tries
 *             (`job_failed`: a handler; `dispatch_failed`: the dispatcher)
 *   WEBHOOK   a received webhook whose processing failed (`processing_failed`) or whose signature did not hold
 *             (`signature_mismatch`: never processed)
 *   CALL      a gateway call that failed (`provider_error`, `network_error`), timed out (`timeout`) or was refused for a
 *             reason a person must act on (`account_paused`, `account_disabled`, `fake_in_production`); a refusal the
 *             caller's job retries by itself (rate limit, an open circuit, the gateway's Redis down) is not an error
 *
 * Retry sends the message again ONCE: a dead event back to its relay, a failed webhook back to processing, a background
 * job run again. A failed call is sent again from where it started (its record, or the job that made it, which tries
 * again by itself); "Edit and retry" opens that place. Dismiss keeps the item with who, when and why.
 */

export const ERROR_SOURCES = ['OUTBOX', 'WEBHOOK', 'CALL'] as const
export type ErrorSource = (typeof ERROR_SOURCES)[number]

export const ERROR_STATES = ['OPEN', 'RETRIED', 'DISMISSED'] as const
export type ErrorState = (typeof ERROR_STATES)[number]

/** The reasons the factory names itself (a provider's own code is shown as it came, with its text). */
export const ERROR_REASONS = [
  'publish_failed',
  'job_failed',
  'dispatch_failed',
  'processing_failed',
  'signature_mismatch',
  'timeout',
  'provider_error',
  'network_error',
  'account_paused',
  'account_disabled',
  'fake_in_production',
] as const
export type ErrorReason = (typeof ERROR_REASONS)[number]

export function isKnownReason(code: string): code is ErrorReason {
  return (ERROR_REASONS as readonly string[]).includes(code)
}

/** Call refusals that are errors (a person acts); the others are retried by the caller's own job. */
export const CALL_REFUSALS_COLLECTED = ['account_paused', 'account_disabled', 'fake_in_production'] as const

/** A connection's test call is never an error of the queue. */
export const TEST_OPERATION = 'connection.test'

/** Why Retry is held, as a code (the web says it in words). */
export const RETRY_HELD = ['DISMISSED', 'WAITING', 'SIGNATURE', 'FROM_RECORD'] as const
export type RetryHeld = (typeof RETRY_HELD)[number]

export interface RetryFacts {
  readonly source: ErrorSource
  readonly state: ErrorState
  readonly reasonCode: string
}

/**
 * Whether Retry may send the item again now: null, or why not. DISMISSED is final; RETRIED waits for its result (the item
 * comes back OPEN with one more try when it fails again); a webhook whose signature failed is never processed; a failed
 * call is sent again from where it started.
 */
export function retryHeldOf(item: RetryFacts): RetryHeld | null {
  if (item.state === 'DISMISSED') return 'DISMISSED'
  if (item.state === 'RETRIED') return 'WAITING'
  if (item.source === 'WEBHOOK' && item.reasonCode === 'signature_mismatch') return 'SIGNATURE'
  if (item.source === 'CALL') return 'FROM_RECORD'
  return null
}

/** Dismiss: only an item that is not dismissed yet. */
export function dismissHeldOf(item: Pick<RetryFacts, 'state'>): 'DISMISSED' | null {
  return item.state === 'DISMISSED' ? 'DISMISSED' : null
}

export const DISMISS_REASON = Object.freeze({ min: 3, max: 500 })

/** A dismiss reason's problem as a code, or null: trimmed 3-500 characters. */
export function dismissReasonProblem(reason: string | null | undefined): 'REQUIRED' | 'TOO_SHORT' | 'TOO_LONG' | null {
  const text = (reason ?? '').trim()
  if (text === '') return 'REQUIRED'
  if (text.length < DISMISS_REASON.min) return 'TOO_SHORT'
  if (text.length > DISMISS_REASON.max) return 'TOO_LONG'
  return null
}

/** Where a failed call is fixed and sent again ("Edit and retry"), by its operation's first word; null: nowhere to go. */
export const FIX_PLACES = ['invoices', 'shipments', 'mail', 'customers', 'files', 'rates'] as const
export type FixPlace = (typeof FIX_PLACES)[number]

const FIX_BY_AREA: Readonly<Record<string, FixPlace>> = Object.freeze({
  sdi: 'invoices',
  invoicing: 'invoices',
  parcel: 'shipments',
  shipping: 'shipments',
  mail: 'mail',
  email: 'mail',
  vat: 'customers',
  files: 'files',
  currency: 'rates',
  ecb: 'rates',
})

export function fixPlaceOf(source: ErrorSource, operation: string): FixPlace | null {
  if (source !== 'CALL') return null
  const area = operation.split('.')[0] ?? ''
  return FIX_BY_AREA[area] ?? null
}

/** The item's key (one per source row): `<outbox | webhook | call>:<sourceId>`. */
export function errorKeyOf(source: ErrorSource, sourceId: string): string {
  return `${source.toLowerCase()}:${sourceId}`
}

/** The text the queue keeps of a provider's message: one line, at most 2000 characters (null when there is none). */
export function reasonTextOf(text: string | null | undefined): string | null {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line === '' ? null : line.slice(0, 2000)
}

/** A reason code as the database keeps it: a code of 1-80 characters (letters, digits, `_ . -`), else `provider_error`. */
export function reasonCodeOf(code: string | null | undefined): string {
  const value = (code ?? '').trim()
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : 'provider_error'
}
