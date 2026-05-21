/**
 * OX.0 — currency-aware order-total formatting + "Awaiting payment"
 * guard for Amazon PENDING orders.
 *
 * Why: Amazon SP-API ListOrders withholds OrderTotal for PENDING orders.
 * Until the order transitions out of Pending, our DB has totalPrice=0.
 * Amazon's own UI shows "Awaiting payment verification" rather than
 * "€0.00" — we mirror that so prior-orders widgets and list rows don't
 * look broken.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  GBP: '£',
  USD: '$',
}

export type OrderTotalDisplay =
  | { kind: 'amount'; symbol: string; amount: string; trailingCode: string | null }
  | { kind: 'pending' }

export function formatOrderTotal(input: {
  totalPrice: number | string | null | undefined
  currencyCode: string | null | undefined
  status: string | null | undefined
}): OrderTotalDisplay {
  const amount = Number(input.totalPrice ?? 0)
  const status = String(input.status ?? '').toUpperCase()
  if (amount === 0 && status === 'PENDING') {
    return { kind: 'pending' }
  }
  const code = (input.currencyCode ?? 'EUR').toUpperCase()
  const symbol = CURRENCY_SYMBOLS[code] ?? ''
  return {
    kind: 'amount',
    symbol,
    amount: amount.toFixed(2),
    trailingCode: symbol ? null : code,
  }
}

export function orderTotalString(input: Parameters<typeof formatOrderTotal>[0]): string {
  const d = formatOrderTotal(input)
  if (d.kind === 'pending') return 'Awaiting payment'
  return d.trailingCode ? `${d.amount} ${d.trailingCode}` : `${d.symbol}${d.amount}`
}
