import type { ApprovalField, PreviewChange } from '@nexus/factory-domain/approvals/rules'
import { parsePreview } from '@nexus/factory-domain/approvals/rules'
import { fromMinorUnits, isCurrencyCode } from '@nexus/factory-domain/core/money'
import { CREDIT_WITHOUT_RETURN_STATUSES } from '@nexus/factory-domain/sales/returns-depth/rules'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import type { ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { creditWithoutReturnInCommand } from '../../../modules/sales/returns-depth/credit-write'
import { currencyOf, lineKeyOf, lineValue, soldFactsOf } from '../../../modules/sales/returns/store'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * CREDIT_WITHOUT_RETURN (B-W2b-341; SAL-342 "Credit without return", design rma.credit "Credit without return (W2b, within
 * the approval limit)"): a return line credited without the goods coming back, before it is written. Its subject is the
 * ReturnLine; the credit asked is the request's change `creditAmount` (the price grain), with `disposition` null →
 * CREDIT_ONLY and `creditWithoutReturn` false → true. At the ask, modules/sales/returns-depth/credit.ts hands the credit to
 * read() for the one command (withAskedCredit: the request does not exist yet); afterwards read() takes it from the request,
 * and a credited line its own credit (a rule's test over the latest lines).
 *
 * The fingerprint covers the line as it stands (what comes back, what arrived, its decision, its version) and the RMA's
 * state: pieces that arrive, a decision, a change of the line or a closed RMA before the yes make the request STALE. The
 * facts its rules test: the credit (the price grain; in the line's currency), its currency, the pieces, the customer's
 * reason, the customer's and the site's codes. On the yes (onApproved, the approver's command) the credit is written as the
 * office would have written it (modules/sales/returns-depth/credit-write.ts), decided by the person who asked. Only its
 * module asks (no generic ask): the amount is the module's.
 */

export const CREDIT_WITHOUT_RETURN_RECORD = 'ReturnLine'

const PENDING = new Map<string, number>()

/** The credit of a request being asked, for read() inside the ask's command (the request does not exist yet). */
export async function withAskedCredit<Result>(lineId: string, creditAmount: number, work: () => Promise<Result>): Promise<Result> {
  PENDING.set(lineId, creditAmount)
  try {
    return await work()
  } finally {
    PENDING.delete(lineId)
  }
}

/** The change entries of a request: the credit asked (price grain), the decision and the flag. */
export function creditChanges(creditAmount: number): PreviewChange[] {
  return [
    { field: 'disposition', from: null, to: 'CREDIT_ONLY', grain: null },
    { field: 'creditWithoutReturn', from: false, to: true, grain: null },
    { field: 'creditAmount', from: null, to: creditAmount, grain: 'price' },
  ]
}

/** The credit a request asked (its change entry), or null. */
export function askedCreditOf(preview: unknown): number | null {
  const change = parsePreview(preview).changes.find((entry) => entry.field === 'creditAmount')
  return typeof change?.to === 'number' && Number.isSafeInteger(change.to) ? change.to : null
}

const LINE_SELECT = {
  id: true,
  returnId: true,
  seq: true,
  description: true,
  quantity: true,
  receivedQuantity: true,
  disposition: true,
  creditWithoutReturn: true,
  creditAmount: true,
  invoiceLineId: true,
  salesOrderLineId: true,
  size: true,
  unitPrice: true,
  discountPct: true,
  reasonCode: true,
  version: true,
} as const

async function askedOf(client: Reader, lineId: string): Promise<number | null> {
  const task = await client.approvalTask.findFirst({ where: { kind: 'CREDIT_WITHOUT_RETURN', recordType: CREDIT_WITHOUT_RETURN_RECORD, recordId: lineId, status: 'PENDING' }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: { preview: true } })
  return task ? askedCreditOf(task.preview) : null
}

async function readSubject(client: Reader, lineId: string): Promise<ApprovalSubject | null> {
  const line = await client.returnLine.findUnique({ where: { id: lineId }, select: LINE_SELECT })
  if (!line) return null
  const rma = await client.returnAuthorisation.findUnique({ where: { id: line.returnId }, select: { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true } })
  if (!rma) return null
  const party = await client.party.findUnique({ where: { id: rma.partyId }, select: { code: true } })
  const site = await client.site.findUnique({ where: { id: rma.siteId }, select: { code: true } })
  const sold = (await soldFactsOf(client, [line])).get(lineKeyOf(line))
  const currency = currencyOf(sold)
  const value = lineValue(sold, line.quantity)
  const amount = PENDING.get(lineId) ?? (await askedOf(client, lineId)) ?? (line.creditWithoutReturn ? line.creditAmount : value)
  const pieces = line.quantity === 1 ? '1 piece' : `${line.quantity} pieces`
  const held = !CREDIT_WITHOUT_RETURN_STATUSES.includes(rma.status as ReturnStatus)
    ? `Return ${rma.number} is ${rma.status.toLowerCase()}: nothing more is credited on it.`
    : line.disposition !== null
      ? `Line ${line.seq} of ${rma.number} is decided already.`
      : line.receivedQuantity > 0
        ? `Pieces of line ${line.seq} of ${rma.number} arrived: they are decided at the inspection.`
        : null
  return {
    companyId: rma.companyId,
    siteId: rma.siteId,
    label: `${rma.number} line ${line.seq}`,
    summary: `${rma.number} line ${line.seq} (${party?.code ?? 'customer'}): credit ${pieces} without the goods coming back`.slice(0, 500),
    facts: {
      creditValue: amount !== null && currency && isCurrencyCode(currency) ? fromMinorUnits(amount, currency).toFixed() : null,
      currency,
      pieces: line.quantity,
      reasonCode: line.reasonCode,
      customerCode: party?.code ?? null,
      siteCode: site?.code ?? null,
    },
    snapshot: {
      returnId: rma.id,
      number: rma.number,
      status: rma.status,
      seq: line.seq,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
      disposition: line.disposition,
      creditWithoutReturn: line.creditWithoutReturn,
      invoiceLineId: line.invoiceLineId,
      salesOrderLineId: line.salesOrderLineId,
      size: line.size,
      unitPrice: line.unitPrice === null ? null : line.unitPrice.toString(),
      discountPct: line.discountPct === null ? null : line.discountPct.toString(),
      reasonCode: line.reasonCode,
      version: line.version,
    },
    changes: creditChanges(amount ?? 0),
    held,
  }
}

export const CREDIT_WITHOUT_RETURN_KIND: ApprovalKindDefinition = Object.freeze({
  kind: 'CREDIT_WITHOUT_RETURN',
  recordType: CREDIT_WITHOUT_RETURN_RECORD,
  label: { en: 'Credit without return', it: 'Accredito senza reso' },
  view: SALES_RETURNS_VIEW,
  ask: null,
  fields: Object.freeze<ApprovalField[]>([
    { id: 'creditValue', label: { en: 'credit', it: 'accredito' }, kind: 'number', grain: 'price', min: 0 },
    { id: 'currency', label: { en: 'currency', it: 'valuta' }, kind: 'text' },
    { id: 'pieces', label: { en: 'pieces', it: 'pezzi' }, kind: 'number', unit: null, min: 0 },
    { id: 'reasonCode', label: { en: 'reason code', it: 'codice motivo' }, kind: 'text' },
    { id: 'customerCode', label: { en: 'customer code', it: 'codice cliente' }, kind: 'text' },
    { id: 'siteCode', label: { en: 'site code', it: 'codice sede' }, kind: 'text' },
  ]),
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    // The RMA first, then the line: the order every return command takes them in.
    await tx.$queryRaw`SELECT 1 FROM "ReturnAuthorisation" WHERE id = (SELECT "returnId" FROM "ReturnLine" WHERE id = ${recordId}::uuid) FOR UPDATE`
    await tx.$queryRaw`SELECT 1 FROM "ReturnLine" WHERE id = ${recordId}::uuid FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.returnLine.findMany({ where: companyId ? { rma: { companyId } } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  async onApproved(tools: CommandTools, task: TaskRef) {
    const request = await tools.tx.approvalTask.findUnique({ where: { id: task.id }, select: { preview: true } })
    const creditAmount = request ? askedCreditOf(request.preview) : null
    if (creditAmount === null) throw new Error(`approvals: request ${task.id} names no credit`)
    await creditWithoutReturnInCommand(tools, { lineId: task.recordId, creditAmount, decidedById: task.requestedById ?? task.decidedById!, taskId: task.id })
  },
})
