import { freightProblems } from '@nexus/factory-domain/invoicing/charges/charges'
import type { IssueProblem } from '@nexus/factory-domain/invoicing/checks'
import { creditProblems } from '@nexus/factory-domain/invoicing/credit-note/credit-note'
import { deductionProblems } from '@nexus/factory-domain/invoicing/from-shipment/deductions'
import { ddtInvoiceProblems, type DdtFacts } from '@nexus/factory-domain/invoicing/from-shipment/shipped'
import type { InvoiceRow, LineRow, Reader } from '../store'
import { creditedInvoiceOf, depositInvoicesOf, freightBilledOf, freightOf, invoicedOf, readDdts, shippedOf } from './store'

/**
 * The checks of B-W1-51 that the issue adds to the invoice core's (facts.ts reviewIssue: the "Before you issue" panel,
 * the issue's pre-check and its check again under the locks, and a rejected invoice's resend), each problem in words:
 *
 *   DDT_*            the DDTs the lines name: not cancelled, their goods shipped, never billed beyond what they carried
 *                    less what OTHER issued invoices bill (TD01, TD24; shipped/ddtInvoiceProblems);
 *   DEDUCTION_*      the deposit invoices deducted: issued TD02s of the company, not rejected, never deducted beyond their
 *                    net less their credit notes (from-shipment/deductions);
 *   CREDIT_*         a TD04: its reason, the invoice it credits (issued, not rejected, not a credit note) and what is still
 *                    creditable (credit-note).
 *   CHARGE_FREIGHT_* B-W2a-54: a FREIGHT charge naming a DDT — billed once per shipment (no other issued invoice bills
 *                    it), at the figure the shipment holds now (charges/freightProblems).
 * And the references the FatturaPA pre-check needs to build the file as it will be issued: the DDTs (number and date,
 * each line's DDT when there are several) and the credited invoice.
 */

export interface IssueReferences {
  readonly ddts: { readonly number: string; readonly date: string }[]
  /** Line id → its DDT's number. */
  readonly ddtNumbers: ReadonlyMap<string, string>
  readonly credits: { readonly number: string; readonly issueDate: string } | null
  /** Deposit invoice id → its number and date. */
  readonly deposits: ReadonlyMap<string, { readonly number: string; readonly issueDate: string }>
}

export async function issueReferences(db: Reader, invoice: InvoiceRow, lines: readonly LineRow[]): Promise<IssueReferences> {
  const ddtIds = [...new Set(lines.flatMap((line) => (line.ddtId ? [line.ddtId] : [])))]
  const ddts = ddtIds.length > 0 ? await readDdts(db, { id: { in: ddtIds } }) : []
  const ddtNumbers = new Map(lines.flatMap((line) => {
    const ddt = ddts.find((entry) => entry.id === line.ddtId)
    return ddt ? [[line.id, ddt.number] as const] : []
  }))
  const credited = invoice.creditOfId ? await db.invoice.findUnique({ where: { id: invoice.creditOfId }, select: { number: true, issueDate: true } }) : null
  const depositIds = [...new Set(lines.flatMap((line) => (line.depositInvoiceId ? [line.depositInvoiceId] : [])))]
  const deposits = depositIds.length > 0 ? await db.invoice.findMany({ where: { id: { in: depositIds } }, select: { id: true, number: true, issueDate: true } }) : []
  return {
    ddts: ddts.map((ddt) => ({ number: ddt.number, date: ddt.date })),
    ddtNumbers,
    credits: credited && credited.number && credited.issueDate ? { number: credited.number, issueDate: credited.issueDate.toISOString().slice(0, 10) } : null,
    deposits: new Map(deposits.flatMap((row) => (row.number && row.issueDate ? [[row.id, { number: row.number, issueDate: row.issueDate.toISOString().slice(0, 10) }] as const] : []))),
  }
}

/** The B-W1-51 problems of an invoice about to be issued (or resent), read now in `db`. */
export async function shippedAndMoneyProblems(db: Reader, invoice: InvoiceRow, lines: readonly LineRow[]): Promise<IssueProblem[]> {
  const problems: IssueProblem[] = []
  if (invoice.docType === 'TD01' || invoice.docType === 'TD24') {
    const ddtIds = [...new Set(lines.flatMap((line) => (line.ddtId ? [line.ddtId] : [])))]
    if (ddtIds.length > 0) {
      const ddts = await readDdts(db, { id: { in: ddtIds } })
      const facts = new Map<string, DdtFacts>(ddts.map((ddt) => [ddt.id, { id: ddt.id, number: ddt.number, cancelled: ddt.cancelled, shipmentStatus: ddt.shipmentStatus }]))
      const others = (await invoicedOf(db, ddtIds, invoice.id)).filter((line) => !line.draft)
      problems.push(
        ...ddtInvoiceProblems(
          lines.map((line) => ({ seq: line.seq, kind: line.kind, ddtId: line.ddtId, salesOrderLineId: line.salesOrderLineId, size: line.size, quantity: line.quantity.toFixed(4) })),
          facts,
          await shippedOf(db, ddts),
          others,
        ),
      )
    }
    const freight = lines.flatMap((line, index) => (line.kind === 'CHARGE' && line.chargeKind === 'FREIGHT' && line.ddtId ? [{ index, ddtId: line.ddtId, netAmount: line.netAmount }] : []))
    if (freight.length > 0) {
      const freightDdts = [...new Set(freight.map((line) => line.ddtId))]
      const rows = await readDdts(db, { id: { in: freightDdts } })
      const others = (await freightBilledOf(db, freightDdts, invoice.id)).filter((row) => !row.draft)
      problems.push(...freightProblems(freight, new Map(rows.map((row) => [row.id, freightOf(row)])), others, invoice.priceBasis, invoice.currency))
    }
    const deducted = lines.flatMap((line, index) => (line.kind === 'DEPOSIT_DEDUCTION' && line.depositInvoiceId ? [{ index, depositInvoiceId: line.depositInvoiceId, netAmount: line.netAmount }] : []))
    if (deducted.length > 0) {
      const deposits = await depositInvoicesOf(db, { ids: deducted.map((line) => line.depositInvoiceId) }, { deductions: 'issued', except: invoice.id })
      problems.push(...deductionProblems(invoice.companyId, deducted, new Map(deposits.map((deposit) => [deposit.id, deposit])), invoice.currency))
    }
  }
  if (invoice.docType === 'TD04') {
    const credited = invoice.creditOfId ? await creditedInvoiceOf(db, invoice.creditOfId, invoice.id) : null
    problems.push(...creditProblems({ causale: invoice.causale, netTotal: invoice.netTotal, grossTotal: invoice.grossTotal }, credited))
  }
  return problems
}
