import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import type { IssueProblem } from '../checks'

/**
 * The monthly invoice run (B-W2b-396; FIN-068 "Monthly invoice run"; design finance.invoices pop-up "Monthly invoice
 * run": customers with deferred invoicing, a preview per customer, a CheckList per invoice, "Issue and send n invoices"),
 * pure. The deferred invoices of a month are one session (DPR 633/1972 art. 21 c.4 lett. a: by the 15th of the next month):
 *
 *   PREVIEW   the office picks the customers of a company and a month; the run takes in each customer's loose TD24
 *             drafts of the month and makes its deferred invoice (TD24 of every DDT of the month still to invoice) as a
 *             draft that names the run. Picking again adds the new customers' drafts and lets go (keeps as drafts) those
 *             of the ones no longer picked; deleting a preview lets go every draft.
 *   ISSUED    the office issues the run (step-up): every draft whose checks pass gets its number, its files and its send
 *             to SDI (test mode while the company is in it), one after the other; a draft that does not pass is let go
 *             from the run, stays a draft with its problems, and is named in the answer. The run is then ISSUED and frozen
 *             (factory-db InvoiceRun, B-W2b-369: issued only with no draft left in it).
 * A customer is in one live preview of a month at a time (a second one would find its DDTs held by the first's draft).
 */

export const RUN_STATUSES = ['PREVIEW', 'ISSUED'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
/** The database's limit of customers per run. */
export const RUN_MAX_CUSTOMERS = 1000
/** How many customers one request picks (each makes a draft in the same command). */
export const RUN_PICK_MAX = 200

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/** The run's month as its first day (InvoiceRun.month). */
export const monthStartOf = (month: string): BusinessDate => `${month}-01`
export const monthOfDay = (day: BusinessDate): string => day.slice(0, 7)

/** Why a run cannot be made for this month, or null: a month (YYYY-MM) not after today's. */
export function runMonthProblem(month: string, today: BusinessDate, path = 'body/month'): Issue | null {
  if (!MONTH.test(month)) return { path, message: 'The month of the DDTs, YYYY-MM (2026-10).' }
  if (month > monthOfDay(today)) return { path, message: `${month} has not started: a run invoices the DDTs of this month or an earlier one.` }
  return null
}

/** The customers picked, each once, checked: 1 to RUN_PICK_MAX per request. */
export function pickProblems(partyIds: readonly string[], path = 'body/partyIds'): Issue[] {
  const issues: Issue[] = []
  if (partyIds.length === 0) issues.push({ path, message: 'Pick at least one customer.' })
  if (new Set(partyIds).size !== partyIds.length) issues.push({ path, message: 'Each customer once.' })
  if (partyIds.length > RUN_PICK_MAX) issues.push({ path, message: `At most ${RUN_PICK_MAX} customers in one request: pick the rest in another run.` })
  return issues
}

export interface RunInvoiceFacts {
  readonly invoiceId: string
  readonly partyId: string
  readonly status: string
  readonly problems: readonly IssueProblem[]
}

/** Which drafts of the run an issue takes (no problem), and which it lets go (with their problems). */
export function runIssuePlan(invoices: readonly RunInvoiceFacts[]): { readonly ready: RunInvoiceFacts[]; readonly held: RunInvoiceFacts[]; readonly issued: RunInvoiceFacts[] } {
  const drafts = invoices.filter((invoice) => invoice.status === 'DRAFT')
  return { ready: drafts.filter((invoice) => invoice.problems.length === 0), held: drafts.filter((invoice) => invoice.problems.length > 0), issued: invoices.filter((invoice) => invoice.status !== 'DRAFT') }
}

/** The run in words: its state and what it holds. */
export function runWords(status: RunStatus, month: string, counts: { readonly drafts: number; readonly ready: number; readonly issued: number }): string {
  if (status === 'ISSUED') return `The run of ${month} is issued: ${counts.issued} invoice${counts.issued === 1 ? '' : 's'}.`
  if (counts.drafts === 0) return `The run of ${month} holds no draft: pick customers with DDTs to invoice.`
  return `The run of ${month} previews ${counts.drafts} deferred invoice${counts.drafts === 1 ? '' : 's'}: ${counts.ready} ready to issue${counts.drafts > counts.ready ? `, ${counts.drafts - counts.ready} with something to fix (left out when the run is issued)` : ''}.`
}
