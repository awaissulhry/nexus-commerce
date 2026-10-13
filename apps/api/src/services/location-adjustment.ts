export type LocationAdjustmentCode =
  | 'FBA_READ_ONLY'
  | 'SHOPIFY_SYNCED_READ_ONLY'
  | 'INVALID_VALUE'
  | 'BELOW_RESERVED'
  | 'STALE_ON_HAND'

export class LocationAdjustmentError extends Error {
  code: LocationAdjustmentCode
  /** STALE_ON_HAND only: the on-hand the server holds now, so the person can see it and save again. */
  current?: number
  constructor(code: LocationAdjustmentCode, message: string, current?: number) {
    super(message)
    this.name = 'LocationAdjustmentError'
    this.code = code
    if (current !== undefined) this.current = current
  }
}

/** The refusal's words when the on-hand moved after the person read it. */
export const staleOnHandMessage = (current: number, expected: number) =>
  `On hand changed from ${expected} to ${current} while you were editing (a sale, a return or another person). Nothing was saved: check the new number and save again.`

/**
 * The one rule for a person's absolute "set on-hand to N" — the inventory editor, the Stock page's FBM cell and
 * Claude's set-stock alike: the caller sends the on-hand it SAW (`expected`) beside the new value, and the movement
 * is booked only against that number.
 *  - The on-hand is still the one the person saw → the movement is value − current, as before.
 *  - The on-hand moved in between (a sale, a return, another tab) → refused STALE_ON_HAND with the current number:
 *    nothing is booked over a movement the person never saw, so the sale is kept and the person decides again on
 *    the real number. (Booking the typed change on top instead would turn a retried save into a second movement.)
 *  - The value is already there → nothing to book, stale or not: the same save sent twice books nothing.
 * `expected` omitted (a caller from before this rule): the delta against the fresh read, as before.
 */
export function checkSeenOnHand(input: { current: number; expected?: number; value: number }): void {
  const { current, expected, value } = input
  if (expected === undefined) return
  if (!Number.isInteger(expected) || expected < 0) {
    throw new LocationAdjustmentError('INVALID_VALUE', 'The on-hand you saw must be a whole number of 0 or more.')
  }
  if (expected !== current && value !== current) {
    throw new LocationAdjustmentError('STALE_ON_HAND', staleOnHandMessage(current, expected), current)
  }
}

export interface ComputeAdjustmentInput {
  locationType: string
  currentQuantity: number
  currentReserved: number
  /** requested absolute new on-hand */
  value: number
  /** the on-hand the person saw when they typed `value` (checkSeenOnHand); omitted = no check */
  expected?: number
}

/**
 * Pure: validate an absolute on-hand "set" for one location and return the
 * signed delta to apply (or a noop). Read-only location types and invalid
 * inputs throw LocationAdjustmentError so the route can map .code → 400.
 */
export function computeLocationAdjustment(
  input: ComputeAdjustmentInput,
): { change: number; noop: false } | { change: 0; noop: true } {
  const { locationType, currentQuantity, currentReserved, value, expected } = input

  if (locationType === 'AMAZON_FBA') {
    throw new LocationAdjustmentError(
      'FBA_READ_ONLY',
      'FBA stock cannot be edited directly — Amazon is the source of truth.',
    )
  }
  if (locationType === 'SHOPIFY_LOCATION') {
    throw new LocationAdjustmentError(
      'SHOPIFY_SYNCED_READ_ONLY',
      'Shopify location stock is synced from Shopify and is read-only here.',
    )
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new LocationAdjustmentError(
      'INVALID_VALUE',
      'On-hand must be a whole number of 0 or more.',
    )
  }
  checkSeenOnHand({ current: currentQuantity, expected, value })
  if (value < currentReserved) {
    throw new LocationAdjustmentError(
      'BELOW_RESERVED',
      `Can't set on-hand below the ${currentReserved} unit(s) currently reserved.`,
    )
  }
  const change = value - currentQuantity
  if (change === 0) return { change: 0, noop: true }
  return { change, noop: false }
}
