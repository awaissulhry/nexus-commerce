/**
 * RX.6 — the ToS-compliance linter for copy sent to buyers (review-rule notes, buyer messages), moved out of
 * routes/orders-reviews.routes.ts (/review-rules/lint answers exactly as before) so the buyer-message door uses it too.
 * Amazon and eBay forbid incentivising reviews, external links and asking for positive reviews.
 */

export interface LintIssue {
  severity: 'error' | 'warn'
  message: string
  match?: string
}

const RULES: Array<{ re: RegExp; severity: 'error' | 'warn'; message: string }> = [
  { re: /\b(discount|coupon|voucher|refund|free|gift|reward|incentive|cashback|rebate|sconto|buono|omaggio|gratis)\b/i, severity: 'error', message: 'Possible incentive — offering anything in exchange for a review violates marketplace policy.' },
  { re: /\b(positive|5[- ]?star|five[- ]?star|good review|great review|recensione positiva|cinque stelle)\b/i, severity: 'error', message: 'Do not ask specifically for positive / 5-star reviews — requests must be neutral.' },
  { re: /(https?:\/\/|www\.)[^\s]+/i, severity: 'warn', message: 'External link — Amazon prohibits links to non-Amazon sites in buyer messages.' },
  { re: /\b(remove|change|update|edit)\b[^.]*\breview\b/i, severity: 'warn', message: 'Asking a customer to remove/change a review is against policy.' },
]

/** The issues of one text; none for an empty one. */
export function lintBuyerCopy(text: string): LintIssue[] {
  if (!text.trim()) return []
  const issues: LintIssue[] = []
  for (const r of RULES) {
    const m = text.match(r.re)
    if (m) issues.push({ severity: r.severity, message: r.message, match: m[0] })
  }
  return issues
}
