import type { IssueProblem } from '@nexus/factory-domain/invoicing/checks'
import { returnCreditProblems, type CreditedReturnLine } from '@nexus/factory-domain/invoicing/credit-note/from-return'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { InvoiceRow, LineRow, Reader } from '../store'

/**
 * The checks before a credit note that credits a customer return is issued (B-W2a-61; FIN-070), in words: the RMA of the
 * note's company, the credited invoice the one the return line names, Σ pieces credited ≤ the pieces authorised (the
 * …_money_w2a_guards trigger holds these at issue, under the return lines' locks: these say it first, as a 409), and
 * never more money than the line's decided credit (the trigger does not count money). Called by from-shipment/checks.ts
 * for every TD04 (the issue, the pre-check, the SDI resend checks).
 */
export async function returnCreditIssueProblems(db: Reader, invoice: InvoiceRow, lines: readonly LineRow[]): Promise<IssueProblem[]> {
  if (invoice.docType !== 'TD04') return []
  const own = lines.filter((line) => line.returnLineId !== null)
  if (own.length === 0) return []
  const ids = [...new Set(own.map((line) => line.returnLineId!))].sort()
  const returned = await db.returnLine.findMany({ where: { id: { in: ids } }, select: { id: true, seq: true, quantity: true, creditAmount: true, invoiceLineId: true, returnId: true } })
  const rmas = await db.returnAuthorisation.findMany({ where: { id: { in: [...new Set(returned.map((line) => line.returnId))] } }, select: { id: true, number: true, companyId: true } })
  const billed = await db.invoiceLine.findMany({ where: { id: { in: returned.flatMap((line) => (line.invoiceLineId ? [line.invoiceLineId] : [])) } }, select: { id: true, invoiceId: true } })
  const others = await db.invoiceLine.findMany({
    where: { returnLineId: { in: ids }, invoiceId: { not: invoice.id }, invoice: { docType: 'TD04', status: { not: 'DRAFT' } } },
    select: { returnLineId: true, quantity: true, netAmount: true },
  })
  const facts: CreditedReturnLine[] = returned.map((line) => {
    const rma = rmas.find((row) => row.id === line.returnId)
    const elsewhere = others.filter((row) => row.returnLineId === line.id)
    const here = own.filter((row) => row.returnLineId === line.id)
    return {
      id: line.id,
      seq: line.seq,
      rmaNumber: rma?.number ?? '?',
      rmaCompanyId: rma?.companyId ?? '',
      quantity: line.quantity,
      creditAmount: line.creditAmount,
      billedOnInvoiceId: line.invoiceLineId ? (billed.find((row) => row.id === line.invoiceLineId)?.invoiceId ?? null) : null,
      otherPieces: elsewhere.reduce((sum, row) => sum.plus(row.quantity.toString()), new Dec(0)).toString(),
      otherNet: elsewhere.reduce((sum, row) => sum + row.netAmount, 0),
      thisPieces: here.reduce((sum, row) => sum.plus(row.quantity.toString()), new Dec(0)).toString(),
      thisNet: here.reduce((sum, row) => sum + row.netAmount, 0),
    }
  })
  return returnCreditProblems({ companyId: invoice.companyId, creditOfId: invoice.creditOfId, currency: invoice.currency }, facts)
}
