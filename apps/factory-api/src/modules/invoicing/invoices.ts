import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { InvoiceDocType, InvoiceStatus } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { paymentTermsOf } from './facts'
import { balanceOf, filesPending, invoiceDetail, officeContextOf, officeInvoice, type InvoiceDetail } from './store'

/**
 * Reading invoices (A2 SCR-080 "All invoices", SCR-081 the record): the invoices, deposit invoices and credit notes the
 * caller may see (its companies and customers, scopeWhere), newest first, with the list's filters (type, status,
 * customer, company, the issue date's period). Amounts only with money.price (the contract marks them). Each row also
 * answers what is paid, credited and still open on it and its due date (the screens' payment column: unpaid, part
 * paid, paid, overdue), the invoice it credits and its order.
 */

export async function getInvoice(caller: CommandCaller, invoiceId: string): Promise<{ invoice: InvoiceDetail }> {
  const invoice = await officeInvoice(caller, invoiceId)
  return { invoice: await caller.withClient((client) => invoiceDetail(client, invoice)) }
}

export interface ListInvoicesQuery {
  readonly docType?: InvoiceDocType | undefined
  readonly status?: InvoiceStatus | undefined
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  readonly depositRequestId?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

export async function listInvoices(caller: CommandCaller, query: ListInvoicesQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.InvoiceWhereInput = {
    AND: [
      scopeWhere(actorOf(context), INVOICES_VIEW, { company: 'companyId', party: 'buyerPartyId' }) as Prisma.InvoiceWhereInput,
      query.docType ? { docType: query.docType } : {},
      query.status ? { status: query.status } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.partyId ? { buyerPartyId: query.partyId } : {},
      query.depositRequestId ? { depositRequestId: query.depositRequestId } : {},
      query.from ? { issueDate: { gte: day(query.from) } } : {},
      query.to ? { issueDate: { lte: day(query.to) } } : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  const rows = await caller.withClient((client) =>
    client.invoice.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        docType: true,
        status: true,
        number: true,
        issueDate: true,
        companyId: true,
        buyerPartyId: true,
        currency: true,
        netTotal: true,
        vatTotal: true,
        grossTotal: true,
        depositRequestId: true,
        xmlFileId: true,
        pdfFileId: true,
        paymentTerms: true,
        creditOfId: true,
        salesOrderId: true,
        version: true,
        createdAt: true,
        buyer: { select: { legalName: true } },
      },
    }),
  )
  const page = rows.slice(0, query.limit)
  const ids = page.map((row) => row.id)
  const [paid, credited] =
    ids.length === 0
      ? [new Map<string, number>(), new Map<string, number>()]
      : await caller.withClient(async (client) => [
          new Map((await client.paymentAllocation.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: ids } }, _sum: { amount: true } })).map((entry) => [entry.invoiceId!, entry._sum.amount ?? 0])),
          new Map((await client.invoice.groupBy({ by: ['creditOfId'], where: { creditOfId: { in: ids }, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } })).map((entry) => [entry.creditOfId!, entry._sum.grossTotal ?? 0])),
        ])
  return {
    invoices: page.map((row) => {
      const paidAmount = paid.get(row.id) ?? 0
      const creditedAmount = credited.get(row.id) ?? 0
      const balance = balanceOf(row, paidAmount, creditedAmount)
      const due = paymentTermsOf(row.paymentTerms)?.installments.find((installment) => typeof installment.dueDate === 'string')?.dueDate ?? null
      return {
        id: row.id,
        docType: row.docType,
        status: row.status,
        number: row.number,
        issueDate: row.issueDate ? row.issueDate.toISOString().slice(0, 10) : null,
        companyId: row.companyId,
        buyerPartyId: row.buyerPartyId,
        partyName: row.buyer.legalName,
        currency: row.currency,
        netTotal: asMoney('price', row.netTotal),
        vatTotal: asMoney('price', row.vatTotal),
        grossTotal: asMoney('price', row.grossTotal),
        depositRequestId: row.depositRequestId,
        creditOfId: row.creditOfId,
        salesOrderId: row.salesOrderId,
        filesPending: filesPending(row),
        paidAmount: asMoney('price', paidAmount),
        creditedAmount: asMoney('price', creditedAmount),
        openAmount: asMoney('price', balance.open),
        dueDate: due,
        version: row.version,
        createdAt: toUtcIso(row.createdAt),
      }
    }),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  }
}
