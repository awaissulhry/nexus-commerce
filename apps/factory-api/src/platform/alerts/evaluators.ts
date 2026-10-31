import type { Prisma } from '@nexus/factory-db'
import { thresholdOf, type RuleKind } from '@nexus/factory-domain/alerts/kinds'
import { daysBetween, placeCovers, type Finding, type RulePlace } from '@nexus/factory-domain/alerts/rules'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { notInvoiced } from '@nexus/factory-domain/invoicing/from-shipment/shipped'
import { HOLD_SUBJECT_TYPES, type HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import { OPEN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { plusCalendarDays } from '@nexus/factory-domain/timers/rules'
import type { CommandTx } from '../../core/command'
import { ddtDeadlines } from '../../modules/invoicing/from-shipment/deadlines'
import { invoicedOf, readDdts, shippedOf } from '../../modules/invoicing/from-shipment/store'
import { readSubjects } from '../../modules/quality/holds/store'

/**
 * What each kind of rule watches (B-W2a-33; factory-domain alerts/kinds), read in the tenant's system scope: the records a
 * rule with these numbers and this place finds now. Reads only, through the owning modules' reads where one exists (the
 * holds' subjects, the shipped-not-invoiced DDTs); at most FIND_LIMIT records per rule and pass (the next pass reads on).
 * `only`: the records of a recheck after an event (their ids). Nothing here carries money.
 *
 *   CONDITION kinds   `find` → the records that meet the condition now (each raises an alert, or keeps it open)
 *   DATE kinds        `dated` → the records with the date the rule watches, within the horizon of timers to set
 */

export const FIND_LIMIT = 500
/** A DATE rule sets timers for dates at most this many days after its own lead (the scheduler sets the next ones later). */
export const TIMER_HORIZON_DAYS = 60

export interface RuleInput extends RulePlace {
  readonly threshold: unknown
}

export interface DatedRecord {
  readonly recordType: string
  readonly recordId: string
  readonly label: string
  readonly scope: Finding['scope']
  /** The date the rule watches (YYYY-MM-DD). */
  readonly date: BusinessDate
}

type Find = (tx: CommandTx, rule: RuleInput, now: Date, only?: readonly string[]) => Promise<Finding[]>
type Dated = (tx: CommandTx, rule: RuleInput, now: Date, only?: readonly string[]) => Promise<DatedRecord[]>

const idIn = (only: readonly string[] | undefined) => (only ? { id: { in: [...only] } } : {})
const placeWhere = (rule: RulePlace, site = true): Record<string, unknown> => ({ ...(rule.companyId ? { companyId: rule.companyId } : {}), ...(site && rule.siteId ? { siteId: rule.siteId } : {}) })
const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const asDate = (date: BusinessDate): Date => new Date(`${date}T00:00:00.000Z`)
const HOUR = 3_600_000

/** ORDER_LATE_RISK: open orders past their promise, and orders still being made promised within N days. */
const orderLateRisk: Find = async (tx, rule, now, only) => {
  const { daysBeforePromise } = thresholdOf('ORDER_LATE_RISK', rule.threshold) as { daysBeforePromise: number }
  const today = businessDate(now)
  const rows = await tx.salesOrder.findMany({
    where: { ...idIn(only), ...placeWhere(rule, false), status: { in: [...OPEN_STATUSES] }, promiseDate: { lte: asDate(plusCalendarDays(today, daysBeforePromise)) } },
    orderBy: [{ promiseDate: 'asc' }, { id: 'asc' }],
    take: FIND_LIMIT,
    select: { id: true, number: true, companyId: true, partyId: true, status: true, promiseDate: true },
  })
  const findings: Finding[] = []
  for (const row of rows) {
    if (row.promiseDate === null) continue
    const promiseDate = dayOf(row.promiseDate)
    const daysLeft = daysBetween(today, promiseDate)
    const late = daysLeft < 0
    // At risk only while still being made (W1's rule): a READY or PARTLY_SHIPPED order is late or nothing.
    if (!late && row.status !== 'CONFIRMED' && row.status !== 'IN_PRODUCTION') continue
    findings.push({ recordType: 'SalesOrder', recordId: row.id, label: row.number, scope: { companyId: row.companyId, siteId: null, partyId: row.partyId }, facts: { promiseDate, daysLeft, late, status: row.status, daysBeforePromise } })
  }
  return findings
}

/** A hold's label: its first record's code or number, and how many more. */
async function holdLabel(tx: CommandTx, subjectType: string, subjectIds: readonly string[]): Promise<string> {
  const type = (HOLD_SUBJECT_TYPES as readonly string[]).includes(subjectType) ? (subjectType as HoldSubjectType) : null
  const first = type && subjectIds[0] ? (await readSubjects(tx, type, [subjectIds[0]]))[0] : undefined
  const head = first?.label ?? subjectType
  return subjectIds.length > 1 ? `${head} +${subjectIds.length - 1}` : head
}

/** HOLD_TOO_LONG: quality holds still ACTIVE N hours after they were placed. */
const holdTooLong: Find = async (tx, rule, now, only) => {
  const { hours } = thresholdOf('HOLD_TOO_LONG', rule.threshold) as { hours: number }
  const rows = await tx.qualityHold.findMany({
    where: { ...idIn(only), ...placeWhere(rule), status: 'ACTIVE', placedAt: { lte: new Date(now.getTime() - hours * HOUR) } },
    orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
    take: FIND_LIMIT,
    select: { id: true, companyId: true, siteId: true, subjectType: true, subjectIds: true, reasonCode: true, placedAt: true },
  })
  const findings: Finding[] = []
  for (const row of rows) {
    findings.push({
      recordType: 'QualityHold',
      recordId: row.id,
      label: await holdLabel(tx, row.subjectType, row.subjectIds),
      scope: { companyId: row.companyId, siteId: row.siteId, partyId: null },
      facts: { hours: Math.floor((now.getTime() - row.placedAt.getTime()) / HOUR), threshold: hours, subjectType: row.subjectType, subjects: row.subjectIds.length, reasonCode: row.reasonCode, placedAt: row.placedAt.toISOString() },
    })
  }
  return findings
}

/** MATERIAL_SHORT: the planning run's open SHORT exceptions of released or started work orders (one alert per work order). */
const materialShort: Find = async (tx, rule, _now, only) => {
  const exceptions = await tx.planningException.findMany({
    where: { ...placeWhere(rule), kind: 'SHORT', status: { not: 'RESOLVED' }, recordType: 'WorkOrder', ...(only ? { recordId: { in: [...only] } } : {}) },
    orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
    take: FIND_LIMIT,
    select: { recordId: true, itemId: true },
  })
  const ids = [...new Set(exceptions.map((row) => row.recordId).filter((id): id is string => id !== null))]
  if (ids.length === 0) return []
  const orders = await tx.workOrder.findMany({ where: { id: { in: ids }, status: { in: ['RELEASED', 'IN_PROGRESS'] } }, select: { id: true, number: true, companyId: true, siteId: true } })
  const itemIds = [...new Set(exceptions.map((row) => row.itemId).filter((id): id is string => id !== null))]
  const items = new Map((itemIds.length ? await tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true } }) : []).map((item) => [item.id, item.code]))
  return orders.map((order) => {
    const short = [...new Set(exceptions.filter((row) => row.recordId === order.id && row.itemId).map((row) => items.get(row.itemId!) ?? ''))].filter(Boolean).sort()
    return {
      recordType: 'WorkOrder',
      recordId: order.id,
      label: order.number,
      scope: { companyId: order.companyId, siteId: order.siteId, partyId: null },
      facts: { item: short.slice(0, 3).join(', ') + (short.length > 3 ? ` +${short.length - 3}` : ''), materials: short.length },
    }
  })
}

/** APPROVAL_OVERDUE: quote approval requests still PENDING N hours after they were asked (one alert per quote). */
const approvalOverdue: Find = async (tx, rule, now, only) => {
  const { hours } = thresholdOf('APPROVAL_OVERDUE', rule.threshold) as { hours: number }
  const approvals = await tx.quoteApproval.findMany({ where: { status: 'PENDING', createdAt: { lte: new Date(now.getTime() - hours * HOUR) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: FIND_LIMIT, select: { versionId: true, createdAt: true } })
  if (approvals.length === 0) return []
  const versions = await tx.quoteVersion.findMany({ where: { id: { in: approvals.map((row) => row.versionId) }, ...(only ? { quoteId: { in: [...only] } } : {}) }, select: { id: true, quoteId: true } })
  const quotes = await tx.quote.findMany({ where: { id: { in: [...new Set(versions.map((row) => row.quoteId))] }, ...placeWhere(rule, false) }, select: { id: true, number: true, companyId: true, partyId: true } })
  const findings: Finding[] = []
  for (const quote of quotes) {
    const asked = approvals.filter((approval) => versions.some((version) => version.id === approval.versionId && version.quoteId === quote.id)).map((approval) => approval.createdAt.getTime())
    if (asked.length === 0) continue
    const oldest = Math.min(...asked)
    findings.push({ recordType: 'Quote', recordId: quote.id, label: quote.number, scope: { companyId: quote.companyId, siteId: null, partyId: quote.partyId }, facts: { hours: Math.floor((now.getTime() - oldest) / HOUR), threshold: hours, askedAt: new Date(oldest).toISOString() } })
  }
  return findings
}

/**
 * PO_NOT_CONFIRMED: purchase orders still SENT (no answer) past the time the supplier was asked to answer by — the order's
 * CURRENT confirm-by (B-W2a-52 sets it at the send, the office may move it: the alert follows it, B-W2a-69). An order sent
 * without a confirm-by (before B-W2a-52) is due the rule's N days after it went out.
 */
const poNotConfirmed: Find = async (tx, rule, now, only) => {
  const { days } = thresholdOf('PO_NOT_CONFIRMED', rule.threshold) as { days: number }
  const rows = await tx.purchaseOrder.findMany({
    where: {
      ...idIn(only),
      ...placeWhere(rule),
      status: 'SENT',
      OR: [{ confirmBy: { lte: now } }, { confirmBy: null, sentAt: { lte: new Date(now.getTime() - days * 24 * HOUR) } }],
    },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    take: FIND_LIMIT,
    select: { id: true, number: true, companyId: true, siteId: true, partyId: true, sentAt: true, confirmBy: true },
  })
  return rows
    .filter((row) => row.sentAt !== null)
    .map((row) => ({
      recordType: 'PurchaseOrder',
      recordId: row.id,
      label: row.number,
      scope: { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId },
      facts: {
        days: Math.floor((now.getTime() - row.sentAt!.getTime()) / (24 * HOUR)),
        threshold: days,
        sentOn: businessDate(row.sentAt!),
        // The deadline the alert followed (null: none was asked; the rule's days then).
        confirmBy: row.confirmBy ? row.confirmBy.toISOString() : null,
      },
    }))
}

/**
 * INTEGRATION_FAILING (B-W2b-24; the design's built-in "integration failing"; the same health as Security & health's
 * "Needs attention"): ACTIVE connections whose last call failed after their last success (the gateway keeps lastOkAt, at
 * most a minute stale, and lastErrorAt), with no call that worked for the rule's hours — since the last success, or, when
 * none ever worked, since the connection was set up. A paused or disabled connection is a person's choice: no alert, and
 * an open one clears. A tenant-wide connection (no company) is seen by holders of integrations.view over every company.
 */
const integrationFailing: Find = async (tx, rule, now, only) => {
  const { hours } = thresholdOf('INTEGRATION_FAILING', rule.threshold) as { hours: number }
  const since = new Date(now.getTime() - hours * HOUR)
  const company = rule.companyId ? { OR: [{ companyId: rule.companyId }, { companyId: null }] } : {}
  const rows = await tx.integrationAccount.findMany({
    where: { ...idIn(only), ...company, status: 'ACTIVE', lastErrorAt: { not: null }, OR: [{ lastOkAt: null, createdAt: { lte: since } }, { lastOkAt: { lte: since } }] },
    orderBy: [{ lastErrorAt: 'desc' }, { id: 'asc' }],
    take: FIND_LIMIT,
    select: { id: true, label: true, provider: true, companyId: true, lastOkAt: true, lastErrorAt: true, createdAt: true },
  })
  return rows
    .filter((row) => row.lastOkAt === null || row.lastErrorAt!.getTime() > row.lastOkAt.getTime())
    .map((row) => ({
      recordType: 'IntegrationAccount',
      recordId: row.id,
      label: row.label,
      scope: { companyId: row.companyId, siteId: null, partyId: null },
      facts: {
        hours: Math.floor((now.getTime() - (row.lastOkAt ?? row.createdAt).getTime()) / HOUR),
        threshold: hours,
        never: row.lastOkAt === null,
        provider: row.provider,
        lastErrorAt: row.lastErrorAt!.toISOString(),
      },
    }))
}

/** CERTIFICATE_EXPIRING: VALID certificates whose last valid day comes within the rule's lead and the timers' horizon; a renewed one (B-W2a-66: its successor linked) leaves the window. */
const certificatesExpiring: Dated = async (tx, rule, now, only) => {
  const { daysBefore } = thresholdOf('CERTIFICATE_EXPIRING', rule.threshold) as { daysBefore: number }
  const today = businessDate(now)
  // A company's rule watches its certificates and the shared ones (no company).
  const company = rule.companyId ? { OR: [{ companyId: rule.companyId }, { companyId: null }] } : {}
  const rows = await tx.certificate.findMany({
    where: { ...idIn(only), ...company, status: 'VALID', successorId: null, validTo: { gte: asDate(today), lte: asDate(plusCalendarDays(today, daysBefore + TIMER_HORIZON_DAYS)) } },
    orderBy: [{ validTo: 'asc' }, { id: 'asc' }],
    take: FIND_LIMIT,
    select: { id: true, number: true, companyId: true, validTo: true },
  })
  return rows.map((row) => ({ recordType: 'Certificate', recordId: row.id, label: row.number, scope: { companyId: row.companyId, siteId: null, partyId: null }, date: dayOf(row.validTo) }))
}

/**
 * INVOICE_DEADLINE: the live DDTs of shipped (or delivered) shipments with goods no issued invoice bills, each with the last
 * day to invoice them by its customer's preset (B-W2a-54, the invoicing module's ddtDeadlines: monthly → the 15th of the
 * month after the DDT's, DPR 633/1972 art. 21 c.4 lett. a; per shipment → the DDT's 12 days, then that 15th).
 */
const invoiceDeadlines: Dated = async (tx, rule, now, only) => {
  const today = businessDate(now)
  const where: Prisma.DdtWhereInput = { ...idIn(only), ...placeWhere(rule), cancellations: { none: {} }, shipment: { status: { in: ['SHIPPED', 'DELIVERED'] } } }
  const ddts = await readDdts(tx, where, FIND_LIMIT)
  const rows = notInvoiced(await shippedOf(tx, ddts), await invoicedOf(tx, ddts.map((ddt) => ddt.id)))
  const open = new Set(rows.filter((row) => row.notInvoiced.gt(0)).map((row) => row.ddtId))
  const waiting = ddts.filter((ddt) => open.has(ddt.id) && !ddt.cancelled)
  const deadlines = await ddtDeadlines(tx, waiting, today)
  return waiting.map((ddt) => ({ recordType: 'Ddt', recordId: ddt.id, label: ddt.number, scope: { companyId: ddt.companyId, siteId: null, partyId: ddt.partyId }, date: deadlines.get(ddt.id)!.dueBy }))
}

export const FINDERS: Readonly<Partial<Record<RuleKind, Find>>> = Object.freeze({
  ORDER_LATE_RISK: orderLateRisk,
  HOLD_TOO_LONG: holdTooLong,
  MATERIAL_SHORT: materialShort,
  APPROVAL_OVERDUE: approvalOverdue,
  PO_NOT_CONFIRMED: poNotConfirmed,
  // B-W2b-24: the connections' health.
  INTEGRATION_FAILING: integrationFailing,
})

export const DATED: Readonly<Partial<Record<RuleKind, Dated>>> = Object.freeze({
  CERTIFICATE_EXPIRING: certificatesExpiring,
  INVOICE_DEADLINE: invoiceDeadlines,
})

/** A rule's findings within its place (the place filter beyond the query's company and site). */
export async function findFor(kind: RuleKind, tx: CommandTx, rule: RuleInput, now: Date, only?: readonly string[]): Promise<Finding[]> {
  const find = FINDERS[kind]
  if (!find) return []
  return (await find(tx, rule, now, only)).filter((finding) => placeCovers(rule, finding.scope))
}

/** A DATE rule's dated records within its place. */
export async function datedFor(kind: RuleKind, tx: CommandTx, rule: RuleInput, now: Date, only?: readonly string[]): Promise<DatedRecord[]> {
  const dated = DATED[kind]
  if (!dated) return []
  return (await dated(tx, rule, now, only)).filter((record) => placeCovers(rule, record.scope))
}
