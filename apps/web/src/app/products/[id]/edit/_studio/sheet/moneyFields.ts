/**
 * A sheet NUMBER that is money (Owner 1A, 2026-10-13: "99.75" sat next to "105" in Base price, so the digits of a
 * right-aligned column did not line up). The field list carries no money flag, so the key decides: a number whose key
 * names a price — the master's `basePrice` / `costPrice` / `minPrice` / `maxPrice`, a channel's `list_price`,
 * `purchasable_offer__our_price`, `…__value_with_tax`, Shopify's `compare_at_price` — draws two decimals.
 *
 * Display only. The cell's value, its editor, copy, paste and export keep the stored number, so "105.00" never has to be
 * parsed back. A stored value with more decimals keeps them (99.999 stays 99.999): the screen never hides precision.
 */
const MONEY_KEY = /(^|_)(price|value_with_tax)(_|$)|Price$/

export const isMoneyColumn = (col: { key: string; kind: string }): boolean => col.kind === 'number' && MONEY_KEY.test(col.key)

const decimalsOf = (n: number): number => {
  const text = String(Math.abs(n))
  const dot = text.indexOf('.')
  return dot === -1 || /e/i.test(text) ? 0 : Math.min(text.length - dot - 1, 6)
}

/** "105.00", "1,234.50", "99.999" — the same in every browser (grid audit 1A); null when the value is not a number. */
export function moneyText(value: unknown): string | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return null
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, decimalsOf(n)) }).format(n)
}
