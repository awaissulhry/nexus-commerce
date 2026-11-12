import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { availableOf, exposureOf, findingsOf, ORDER_STEPS, overLimitBy, usedPercent, type CreditStep } from '@nexus/factory-domain/sales/credit/credit'
import { SALES_CREDIT_CHECKS, SALES_CREDIT_VIEW } from '@nexus/factory-domain/sales/credit/permissions'
import type { CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { newestCheck, planCredit } from './check'
import { mayOn, officeOf, seesPrices } from './access'
import type { Reader } from './reading'

/**
 * A record's credit (B-W2b-304; SAL-148 "credit and overdue shown on the quote", SAL-241): GET
 * /sales/credit/records/:recordType/:recordId (sales.credit.view over each customer's company): for a Quote (its current
 * version), a QuoteVersion, a SalesOrder, a WorkOrder (the customers of its cells), a Shipment or a PortalOrderRequest —
 * per customer: the reading now (limit, open orders, open invoices, overdue, what the record adds when it is not counted
 * yet, exposure, available, the share used, over by), what a check of the record's step would answer now, the hold in
 * force with its request for a yes, the record's checks (newest first, at most 20) and what the reader may do. Amounts
 * only with the price grain. No limit: `limit` null and nothing held (no check, as before).
 */

export const RECORD_TYPES = ['Quote', 'QuoteVersion', 'SalesOrder', 'WorkOrder', 'Shipment', 'PortalOrderRequest'] as const
export type CreditRecordType = (typeof RECORD_TYPES)[number]

interface Resolved {
  readonly recordType: Exclude<CreditRecordType, 'Quote'>
  readonly recordId: string
  readonly label: string
  readonly companyId: string
  readonly step: CreditStep
  readonly parties: readonly string[]
  /** What the record adds when it is not counted yet, and the order left out of the open orders for it. */
  readonly subject: { readonly amount: number; readonly currency: string } | null
  readonly exclude: readonly string[]
}

async function resolve(db: Reader, recordType: CreditRecordType, recordId: string): Promise<Resolved | null> {
  switch (recordType) {
    case 'Quote':
    case 'QuoteVersion': {
      const version =
        recordType === 'Quote'
          ? await (async () => {
              const quote = await db.quote.findUnique({ where: { id: recordId }, select: { id: true, currentRevision: true } })
              return quote ? db.quoteVersion.findFirst({ where: { quoteId: quote.id, revision: quote.currentRevision }, select: { id: true } }) : null
            })()
          : { id: recordId }
      if (!version) return null
      const row = await db.quoteVersion.findUnique({ where: { id: version.id }, select: { id: true, partyId: true, revision: true, status: true, grossAmount: true, currency: true, quote: { select: { number: true, companyId: true } } } })
      if (!row) return null
      const ordered = row.status === 'ACCEPTED' ? await db.salesOrder.findFirst({ where: { quoteVersionId: row.id }, select: { id: true } }) : null
      return { recordType: 'QuoteVersion', recordId: row.id, label: `${row.quote.number} rev. ${row.revision}`, companyId: row.quote.companyId, step: 'QUOTE', parties: [row.partyId], subject: ordered ? null : { amount: row.grossAmount, currency: row.currency }, exclude: [] }
    }
    case 'SalesOrder': {
      const order = await db.salesOrder.findUnique({ where: { id: recordId }, select: { id: true, number: true, companyId: true, partyId: true, status: true, grossAmount: true, currency: true } })
      if (!order) return null
      const last = await db.creditCheck.findFirst({ where: { recordType: 'SalesOrder', recordId: order.id }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], select: { step: true } })
      const waiting = order.status === 'PENDING_APPROVAL'
      return { recordType: 'SalesOrder', recordId: order.id, label: order.number, companyId: order.companyId, step: (last?.step as CreditStep | undefined) ?? 'ORDER', parties: [order.partyId], subject: waiting ? { amount: order.grossAmount, currency: order.currency } : null, exclude: waiting ? [order.id] : [] }
    }
    case 'WorkOrder': {
      const workOrder = await db.workOrder.findUnique({ where: { id: recordId }, select: { id: true, number: true, companyId: true } })
      if (!workOrder) return null
      const cells = await db.workOrderSize.findMany({ where: { workOrderId: workOrder.id, partyId: { not: null } }, select: { partyId: true }, distinct: ['partyId'] })
      return { recordType: 'WorkOrder', recordId: workOrder.id, label: workOrder.number, companyId: workOrder.companyId, step: 'RELEASE', parties: cells.map((cell) => cell.partyId!).sort(), subject: null, exclude: [] }
    }
    case 'Shipment': {
      const shipment = await db.shipment.findUnique({ where: { id: recordId }, select: { id: true, number: true, companyId: true, salesOrder: { select: { partyId: true } } } })
      if (!shipment) return null
      return { recordType: 'Shipment', recordId: shipment.id, label: shipment.number, companyId: shipment.companyId, step: 'SHIPMENT', parties: shipment.salesOrder ? [shipment.salesOrder.partyId] : [], subject: null, exclude: [] }
    }
    case 'PortalOrderRequest': {
      const request = await db.portalOrderRequest.findUnique({ where: { id: recordId }, select: { id: true, number: true, companyId: true, partyId: true } })
      if (!request) return null
      return { recordType: 'PortalOrderRequest', recordId: request.id, label: request.number ?? 'Order request', companyId: request.companyId, step: 'PORTAL', parties: [request.partyId], subject: null, exclude: [] }
    }
  }
}

async function customerOf(db: Reader, context: OfficeContext, at: Resolved, partyId: string, now: Date) {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, legalName: true } })
  const company = await db.company.findUnique({ where: { id: at.companyId }, select: { id: true, code: true } })
  const plan = await planCredit(db, { step: at.step, partyId, companyId: at.companyId, subject: at.subject, exclude: at.exclude, now, askers: [context.actorId] })
  const steps: CreditStep[] = at.recordType === 'SalesOrder' ? [...ORDER_STEPS] : [at.step]
  const rows = await db.creditCheck.findMany({ where: { recordType: at.recordType, recordId: at.recordId, partyId, step: { in: steps } }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], take: 20 })
  const people = [...new Set(rows.flatMap((row) => (row.createdById ? [row.createdById] : [])))]
  const names = new Map((people.length === 0 ? [] : await db.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  const last = rows[0] ? await newestCheck(db, { step: rows[0].step as CreditStep, recordType: at.recordType, recordId: at.recordId, partyId }) : null
  const task = last?.pendingTaskId ? await db.approvalTask.findUnique({ where: { id: last.pendingTaskId }, select: { id: true, status: true, approverRoleId: true, approverUserId: true, requestedAt: true, dueAt: true } }) : null
  const role = task?.approverRoleId ? await db.role.findUnique({ where: { id: task.approverRoleId }, select: { name: true } }) : null
  const approverUser = task?.approverUserId ? await db.user.findUnique({ where: { id: task.approverUserId }, select: { displayName: true } }) : null
  const reading = plan?.reading ?? null
  const may = mayOn(context, SALES_CREDIT_CHECKS, { companyId: at.companyId, partyId })
  return {
    party: { id: partyId, code: party?.code ?? '', name: party?.legalName ?? '' },
    company: { id: at.companyId, code: company?.code ?? '' },
    currency: reading?.currency ?? null,
    limit: asMoney('price', reading?.limit ?? null),
    openOrders: asMoney('price', reading?.openOrders ?? null),
    openInvoices: asMoney('price', reading?.openInvoices ?? null),
    overdue: asMoney('price', reading?.overdue ?? null),
    subject: asMoney('price', reading ? reading.subject : null),
    exposure: asMoney('price', reading ? exposureOf(reading) : null),
    available: asMoney('price', reading ? availableOf(reading) : null),
    overLimitBy: asMoney('price', reading ? overLimitBy(reading) : null),
    usedPct: reading && seesPrices(context) ? usedPercent(reading) : null,
    onHold: reading?.onHold ?? false,
    findings: reading ? findingsOf(reading) : [],
    wouldBe: plan?.result ?? null,
    held: last?.held
      ? {
          checkId: last.id,
          step: rows[0]!.step as CreditStep,
          checkedAt: toUtcIso(last.checkedAt),
          request: task ? { taskId: task.id, status: task.status, approver: role?.name ?? approverUser?.displayName ?? null, requestedAt: toUtcIso(task.requestedAt), dueAt: task.dueAt ? toUtcIso(task.dueAt) : null } : null,
        }
      : null,
    checks: rows.map((row) => ({
      id: row.id,
      step: row.step as CreditStep,
      result: row.result,
      words: row.words,
      checkedAt: toUtcIso(row.checkedAt),
      by: row.createdById ? (names.get(row.createdById) ?? null) : null,
      overridesCheckId: row.overridesCheckId,
      overrideTaskId: row.overrideTaskId,
      currency: row.currency,
      exposure: asMoney('price', row.exposureAmount),
      limit: asMoney('price', row.limitAmount),
      overdue: asMoney('price', row.overdueAmount),
    })),
    may: { checkAgain: may && last?.held === true, ask: may && last?.held === true && !last.pendingTaskId },
  }
}

/** GET /sales/credit/records/:recordType/:recordId (sales.credit.view). */
export async function recordCredit(caller: CommandCaller, recordType: string, recordId: string) {
  const context = officeOf(caller)
  if (!(RECORD_TYPES as readonly string[]).includes(recordType)) throw new ValidationError('Credit is read for a quote, an order, a work order, a shipment or a portal order request.', [{ path: 'params/recordType', message: `One of ${RECORD_TYPES.join(', ')}.` }])
  if (!isUuid(recordId)) throw new NotFoundError('Record not found.')
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const at = await resolve(db, recordType as CreditRecordType, recordId)
    if (!at) throw new NotFoundError('Record not found.')
    const visible = at.parties.filter((partyId) => mayOn(context, SALES_CREDIT_VIEW, { companyId: at.companyId, partyId }))
    if (at.parties.length > 0 && visible.length === 0) throw new NotFoundError('Record not found.')
    const customers = []
    for (const partyId of visible) customers.push(await customerOf(db, context, at, partyId, now))
    return { record: { type: at.recordType, id: at.recordId, label: at.label, step: at.step }, customers, readAt: toUtcIso(now) }
  })
}
