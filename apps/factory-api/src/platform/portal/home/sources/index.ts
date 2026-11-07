import type { FastifyInstance, FastifyRequest } from 'fastify'
import { homeCountProblems, type HomeCountDefinition } from '@nexus/factory-domain/portal/home/counts'
import { NOTIFICATION_COUNTS } from './notifications'
import { PURCHASE_ORDER_COUNTS } from './purchase-orders'
import { SUBCONTRACT_JOB_COUNTS } from './subcontract-jobs'
import { TASK_COUNTS } from './tasks'
// B-W2b-175: a customer's orders (open, in production, shipping this week, on the way).
import { SALES_ORDER_COUNTS } from '../../../../modules/sales/portal-orders/home'
// B-W2b-185: the customer's open and late invoices (Finance and Admin).
import { PAYMENT_COUNTS } from '../../../../modules/payments/online/home'
// B-W2b-178: a customer's new documents (since the last visit, until opened).
import { CUSTOMER_DOCUMENT_COUNTS } from '../../../../modules/sales/portal-documents/home'
// B-W2b-184: approvals to give and revised orders to re-confirm.
import { APPROVAL_COUNTS } from '../../../approvals-out/home'

/**
 * Where a partner's Home counts come from (B-W2b-167; plan W2b-3 "Sources": "Home counts through a sources folder like the
 * tasks"): one file per source in this folder, one line in the list below (a merge point). A source declares its counts
 * (factory-domain portal/home/counts.ts: key, area, partner kinds, words) and reads them for one request, in the session's
 * party scope (row-level security), as the person sees them. A count it cannot read is null ("shows nothing, never 0").
 * Later steps add theirs: open orders, in production, shipping this week (B-W2b-175), to confirm, late (B-W2b-174), …
 */
export interface HomeSource {
  readonly name: string
  readonly counts: readonly HomeCountDefinition[]
  read(app: FastifyInstance, request: FastifyRequest, now: Date): Promise<Readonly<Record<string, number | null>>>
}

export const HOME_SOURCES: readonly HomeSource[] = Object.freeze([
  // B-W2b-167: what waits for the person (the one task list) and their unread notifications.
  TASK_COUNTS,
  NOTIFICATION_COUNTS,
  // B-W2b-175: a customer's orders.
  SALES_ORDER_COUNTS,
  // B-W2b-174: the supplier's purchase orders to confirm and late.
  PURCHASE_ORDER_COUNTS,
  // B-W2b-185: invoices to pay and overdue (customers' Finance and Admin; null for everyone else).
  PAYMENT_COUNTS,
  // B-W2b-176: the workshop's jobs to accept, kits to confirm, ready to send back, late.
  SUBCONTRACT_JOB_COUNTS,
  // B-W2b-178: a customer's new documents.
  CUSTOMER_DOCUMENT_COUNTS,
  // B-W2b-184: approvals to give and revised orders to re-confirm.
  APPROVAL_COUNTS,
])

const problems = homeCountProblems(HOME_SOURCES.flatMap((source) => source.counts))
if (problems.length > 0) throw new Error(`Portal home counts are not valid: ${problems.join('; ')}`)
