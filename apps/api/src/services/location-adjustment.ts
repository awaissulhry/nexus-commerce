export type LocationAdjustmentCode =
  | 'FBA_READ_ONLY'
  | 'SHOPIFY_SYNCED_READ_ONLY'
  | 'INVALID_VALUE'
  | 'BELOW_RESERVED'

export class LocationAdjustmentError extends Error {
  code: LocationAdjustmentCode
  constructor(code: LocationAdjustmentCode, message: string) {
    super(message)
    this.name = 'LocationAdjustmentError'
    this.code = code
  }
}

export interface ComputeAdjustmentInput {
  locationType: string
  currentQuantity: number
  currentReserved: number
  /** requested absolute new on-hand */
  value: number
}

/**
 * Pure: validate an absolute on-hand "set" for one location and return the
 * signed delta to apply (or a noop). Read-only location types and invalid
 * inputs throw LocationAdjustmentError so the route can map .code → 400.
 */
export function computeLocationAdjustment(
  input: ComputeAdjustmentInput,
): { change: number; noop: false } | { change: 0; noop: true } {
  const { locationType, currentQuantity, currentReserved, value } = input

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
