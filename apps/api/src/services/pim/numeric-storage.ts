/** Product and ChannelListing numeric storage limits from schema.prisma. Reject loss of precision. */
const decimalFields: Record<string, { precision: number; scale: number }> = {
  basePrice: { precision: 10, scale: 2 }, costPrice: { precision: 10, scale: 2 },
  minPrice: { precision: 10, scale: 2 }, maxPrice: { precision: 10, scale: 2 },
  minMargin: { precision: 5, scale: 2 }, weightValue: { precision: 10, scale: 3 },
  dimLength: { precision: 10, scale: 2 }, dimWidth: { precision: 10, scale: 2 }, dimHeight: { precision: 10, scale: 2 },
  price: { precision: 10, scale: 2 },
}

export function numericStorageError(field: string, value: number): string | null {
  if (!Number.isFinite(value)) return 'Enter a finite number'
  if (value < 0) return 'Must be ≥ 0'
  if (['totalStock', 'lowStockThreshold', 'quantity'].includes(field)) {
    return !Number.isInteger(value) || value > 2147483647 ? 'Enter a whole number from 0 to 2147483647' : null
  }
  const decimal = decimalFields[field]
  if (!decimal) return null
  if (Number(value.toFixed(decimal.scale)) !== value) return `Use at most ${decimal.scale} decimal places; the value has not been rounded or saved`
  if (value >= 10 ** (decimal.precision - decimal.scale)) return 'The value exceeds this field’s storage limit'
  return null
}
