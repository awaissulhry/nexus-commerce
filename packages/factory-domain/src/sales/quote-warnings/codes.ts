/**
 * B-W2b-294 (SAL-147; QT1:01, QT1:02): the customer and product warnings' codes (sales/quote-warnings rules). The line rules'
 * are also a send check of a quote (sales/quotes/send SEND_CHECK_CODES lists them) when api sales/line-checks finds one; an
 * overdue account is said in the quote's Warnings only (the send's credit check is B-W2b-304's). No imports: send.ts reads it
 * without the rules.
 */
export const LINE_RULE_CODES = ['PRIVATE_LABEL', 'OUTSIDE_RELEASED_SCOPE', 'STYLE_PHASE_OUT', 'NOT_SOLD_IN_MARKET', 'BLOCKED_MATERIAL'] as const
export const WARNING_CODES = [...LINE_RULE_CODES, 'ACCOUNT_OVERDUE'] as const
export type WarningCode = (typeof WARNING_CODES)[number]
