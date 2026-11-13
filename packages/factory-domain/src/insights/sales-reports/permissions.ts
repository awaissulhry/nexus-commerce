import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Sales reports (apps/factory-api modules/insights/sales-reports; B-W2b-348; design sales.reports SCR-250), in the sales area,
 * office only. Checked with can() against the screen's company. The page needs this permission; each figure ALSO needs the
 * records' own view over each record it counts (orders.view for the order intake and the backlog, quotes.view for the quote
 * figures, sales.returns.view for the returns), and every amount the price grain (money.price), so a role sees the figures of
 * the records it may see and an amount only with the price grain. Quote speed on Sales › Quotes reads with quotes.view alone
 * (the Quotes page's own permission).
 *
 * Read only: nothing here writes, so no command, audit row or event. No figure names or counts a person.
 */
export const SALES_REPORTS_DEFINITIONS = definePermissions('sales', {
  'reports.view': {
    risk: 'read',
    description:
      'See the sales reports of a company: the period in five numbers, the order intake by week or month split by customer, style or season, the backlog by promise week, the return reasons by reason, style, size, colour and customer, the records behind each figure, and their print view (each figure only from the orders, quotes and returns you may see; amounts only with the price grain).',
  },
})

export const SALES_REPORTS_VIEW = 'sales.reports.view' satisfies Permission

export const SALES_REPORTS_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_REPORTS_VIEW])

/**
 * Who holds it (auth/roles/templates): sales (the monthly sales review), finance (intake and backlog values) and the
 * production manager (the backlog by promise week, the return reasons). Office only; the owner and read-only from every().
 * The production manager holds no price grain: pieces and counts, never an amount.
 */
export const SALES_REPORTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  sales: [SALES_REPORTS_VIEW],
  finance: [SALES_REPORTS_VIEW],
  production_manager: [SALES_REPORTS_VIEW],
})
