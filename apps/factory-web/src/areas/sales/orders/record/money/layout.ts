/**
 * F-OM-101 (order MONEY tab, 10-design §1–§2; 18-lead-settles L6) — the tab's layout, without a screen.
 *
 * Room, not screen: the tab root is the Production kit's size container (`fw-pt`, view/production/production.css, reused IN PLACE)
 * and every section chooses by the ROOM the tab has (S < 720 · M 720–1279 · L ≥ 1280: production/layout.ts holds the numbers,
 * money.css the same), so opening or closing the thread dock re-lays the tab at once. Five sections, top to bottom, that STACK at
 * every width (L6: pairs only inside Totals and Margin), under the tab's one answer line:
 *
 *   Totals (#totals)                         what the order is worth, what came in, what is left, what is missing to settle it
 *   Payments (#payments)                     the ONE payment plan: the deposit is its first step (#deposit, #schedule land here)
 *   Invoices & credit notes (#invoices)      every bill of this order (invoices.view)
 *   Price check (#price-check)               our price beside the customer's (the price grain)
 *   Margin (#margin)                         the margin grain
 */

export const MONEY_SECTIONS = ['totals', 'payments', 'invoices', 'price-check', 'margin'] as const
export type MoneySectionId = (typeof MONEY_SECTIONS)[number]

/** The addresses of the two cards that went into Payments (the deposit cards and the payment schedule): elements at its top. */
export const PAYMENTS_ALIASES = ['deposit', 'schedule'] as const

/** The rooms of the Payments list (px of the list's own width): 4 columns from 560, 5 from 1000, 6 from 1500 (money.css the same). */
export const PLAN_COLUMNS_FROM = Object.freeze({ four: 560, five: 1000, six: 1500 })
