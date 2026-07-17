/**
 * EPF1.2 (D-02/D-03) — invoice amount policy, pure. The default invoice is
 * deposit-aware (net − payments already received, floored at 0) and EVERY
 * invoice — default or explicit — is capped so Σ invoices never exceeds the
 * order's net. The route turns a refusal into a 400 carrying the remaining
 * invoiceable amount.
 */

export type InvoiceAmountResult =
  | { ok: true; amountCents: number }
  | { ok: false; reason: "nothing-invoiceable" | "exceeds-net"; remainingInvoiceableCents: number };

export function resolveInvoiceAmount(
  netCents: number,
  paidCents: number,
  invoicedCents: number,
  requestedCents?: number,
): InvoiceAmountResult {
  const remainingInvoiceableCents = Math.max(0, netCents - invoicedCents);
  // default: what's still unpaid on the order (deposits already received are deducted)
  const amountCents = requestedCents ?? Math.max(0, netCents - paidCents);
  if (amountCents <= 0) return { ok: false, reason: "nothing-invoiceable", remainingInvoiceableCents };
  if (invoicedCents + amountCents > netCents) return { ok: false, reason: "exceeds-net", remainingInvoiceableCents };
  return { ok: true, amountCents };
}
