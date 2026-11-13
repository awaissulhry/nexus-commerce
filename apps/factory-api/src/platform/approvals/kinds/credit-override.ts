import { creditFacts, CREDIT_OVERRIDE_FIELDS, findingsOf, FINDING_WORDS, OVERRIDE_CHANGES, STEP_WORDS, type CreditReading, type CreditStep } from '@nexus/factory-domain/sales/credit/credit'
import { SALES_CREDIT_VIEW } from '@nexus/factory-domain/sales/credit/permissions'
import type { CommandTools, CommandTx } from '../../../core/command'
import { overrideInCommand } from '../../../modules/sales/credit/override'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * CREDIT_OVERRIDE (B-W2b-304; SAL-237, SAL-241, SAL-244; plan "an override is a CREDIT_OVERRIDE task through the approval
 * engine"): a step held for credit — an order being made (it waits as PENDING_APPROVAL), a work order's release, a shipment
 * leaving — let through with a yes. Its subject is the HOLD check (record type CreditCheck, factory-db's rule: an override
 * row names an APPROVED request about that check). Only its module asks (modules/sales/credit: at the hold, or "Ask for a
 * yes"); the company's CREDIT_OVERRIDE rules also make a check HOLD instead of WARN (factory-domain sales/credit).
 *
 * The facts its rules test: the step, over the limit (yes / no) and by how much, the exposure, the limit, invoices overdue
 * (yes / no) and how much, a credit hold, the currency, the customer's code (money facts with the price grain). The
 * fingerprint covers the check, whether it is still the newest of its record and step, and the subject as it stands (a
 * waiting order's lines changed, a newer check, a cancelled order: STALE). On the yes (the approver's command) a new check
 * names the HOLD and the request, and a waiting order goes on (modules/sales/credit/override.ts).
 */

export const CREDIT_OVERRIDE_RECORD = 'CreditCheck'

const CHECK_SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  step: true,
  recordType: true,
  recordId: true,
  currency: true,
  openOrdersAmount: true,
  openInvoicesAmount: true,
  overdueAmount: true,
  subjectAmount: true,
  exposureAmount: true,
  limitAmount: true,
  onHold: true,
  result: true,
  overridesCheckId: true,
  checkedAt: true,
} as const

interface Subject {
  readonly label: string
  readonly siteId: string | null
  readonly state: Record<string, unknown>
}

async function subjectOf(client: Reader, recordType: string, recordId: string): Promise<Subject | null> {
  switch (recordType) {
    case 'SalesOrder': {
      const order = await client.salesOrder.findUnique({ where: { id: recordId }, select: { number: true, status: true, grossAmount: true, version: true } })
      return order ? { label: order.number, siteId: null, state: { status: order.status, grossAmount: order.grossAmount, version: order.version } } : null
    }
    case 'WorkOrder': {
      const workOrder = await client.workOrder.findUnique({ where: { id: recordId }, select: { number: true, status: true, siteId: true, version: true } })
      return workOrder ? { label: workOrder.number, siteId: workOrder.siteId, state: { status: workOrder.status, version: workOrder.version } } : null
    }
    case 'Shipment': {
      const shipment = await client.shipment.findUnique({ where: { id: recordId }, select: { number: true, status: true, siteId: true } })
      return shipment ? { label: shipment.number, siteId: shipment.siteId, state: { status: shipment.status } } : null
    }
    case 'PortalOrderRequest': {
      const request = await client.portalOrderRequest.findUnique({ where: { id: recordId }, select: { number: true, status: true, version: true } })
      return request ? { label: request.number ?? 'Order request', siteId: null, state: { status: request.status, version: request.version } } : null
    }
    case 'QuoteVersion': {
      const version = await client.quoteVersion.findUnique({ where: { id: recordId }, select: { revision: true, status: true, quote: { select: { number: true } } } })
      return version ? { label: `${version.quote.number} rev. ${version.revision}`, siteId: null, state: { status: version.status } } : null
    }
    default:
      return null
  }
}

async function readSubject(client: Reader, checkId: string): Promise<ApprovalSubject | null> {
  const check = await client.creditCheck.findUnique({ where: { id: checkId }, select: CHECK_SELECT })
  if (!check) return null
  const subject = await subjectOf(client, check.recordType, check.recordId)
  if (!subject) return null
  const party = await client.party.findUnique({ where: { id: check.partyId }, select: { code: true } })
  const newest = await client.creditCheck.findFirst({ where: { step: check.step, recordType: check.recordType, recordId: check.recordId, partyId: check.partyId }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], select: { id: true } })
  const overridden = await client.creditCheck.findFirst({ where: { overridesCheckId: check.id }, select: { id: true } })
  const reading: CreditReading = { currency: check.currency, openOrders: check.openOrdersAmount, openInvoices: check.openInvoicesAmount, overdue: check.overdueAmount, subject: check.subjectAmount, limit: check.limitAmount, onHold: check.onHold }
  const step = check.step as CreditStep
  const found = findingsOf(reading).map((finding) => FINDING_WORDS[finding].en).join(', ') || 'held for credit'
  const code = party?.code ?? 'customer'
  const held =
    check.result !== 'HOLD' || check.overridesCheckId !== null
      ? `This credit check of ${subject.label} is not a hold.`
      : overridden
        ? `${subject.label} was let through with a yes already.`
        : newest?.id !== check.id
          ? `${subject.label} was checked again since: the newest check is the one to decide.`
          : null
  return {
    companyId: check.companyId,
    siteId: subject.siteId,
    label: `${subject.label} · ${code}`,
    summary: `${subject.label} (${code}) is held at ${STEP_WORDS[step].en}: ${found}. Let it through?`.slice(0, 500),
    facts: creditFacts(reading, step, party?.code ?? null),
    snapshot: {
      checkId: check.id,
      step: check.step,
      recordType: check.recordType,
      recordId: check.recordId,
      result: check.result,
      newestCheckId: newest?.id ?? null,
      overriddenBy: overridden?.id ?? null,
      subject: subject.state,
    },
    changes: [...OVERRIDE_CHANGES],
    held,
  }
}

export const CREDIT_OVERRIDE_KIND: ApprovalKindDefinition = Object.freeze({
  kind: 'CREDIT_OVERRIDE',
  recordType: CREDIT_OVERRIDE_RECORD,
  label: { en: 'Credit override', it: 'Deroga al fido' },
  view: SALES_CREDIT_VIEW,
  ask: null,
  fields: CREDIT_OVERRIDE_FIELDS,
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    // A waiting order's row: its lines cannot change between the re-read and the yes.
    await tx.$queryRaw`SELECT 1 FROM "SalesOrder" WHERE id = (SELECT "recordId" FROM "CreditCheck" WHERE id = ${recordId}::uuid AND "recordType" = 'SalesOrder') FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.creditCheck.findMany({ where: { result: 'HOLD', overridesCheckId: null, ...(companyId ? { companyId } : {}) }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  async onApproved(tools: CommandTools, task: TaskRef) {
    await overrideInCommand(tools, task)
  },
  // B-W2b-377 (B-W2b-361's gap): the held order, quote, work order or shipment opens, not the check's panels.
  async parent(client: Reader, recordId: string) {
    const check = await client.creditCheck.findUnique({ where: { id: recordId }, select: { recordType: true, recordId: true } })
    if (!check) return null
    if (check.recordType !== 'QuoteVersion') return { type: check.recordType, id: check.recordId }
    const version = await client.quoteVersion.findUnique({ where: { id: check.recordId }, select: { quoteId: true } })
    return version ? { type: 'Quote', id: version.quoteId } : null
  },
})
