import { toUtcIso } from '@nexus/factory-domain/core/time'
import { MATCH_SETTINGS, matchWords, sameFacts } from '@nexus/factory-domain/payables/match'
import { actionProblems, approvalProblems, isTyped, type InvoiceKind, type InvoiceSource, type InvoiceStatus } from '@nexus/factory-domain/payables/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { MatchStatus } from '@nexus/factory-domain/payables/match'
import { freshMatch } from './matching'
import { dayOf, peopleNames, preparationOf, readLines, readMatches, type InvoiceRow, type LineRow, type Reader } from './store'

/**
 * What the answers show of a supplier invoice (design finance.payables: the grid's row; the record's Lines, Match,
 * Approval and Payment tabs, the files "as received"). Every amount and price is marked with the cost grain in the
 * contract and dropped for a caller without it; the match's words name prices only for a caller with it.
 */

const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))
const text = (value: { toString(): string } | null): string | null => (value === null ? null : value.toString())

/** The money-holding JSON as received (VAT summary, payment terms): plain rows, marked in the contract. */
interface VatRow {
  rate: string | null
  nature: string | null
  taxable: number
  vat: number
}
const vatRows = (value: unknown): VatRow[] =>
  Array.isArray(value)
    ? value
        .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
        .map((row) => ({ rate: typeof row.rate === 'string' ? row.rate : null, nature: typeof row.nature === 'string' ? row.nature : null, taxable: typeof row.taxable === 'number' ? row.taxable : 0, vat: typeof row.vat === 'number' ? row.vat : 0 }))
    : []
const termsOf = (value: unknown) => {
  if (!value || typeof value !== 'object') return null
  const terms = value as { condition?: unknown; installments?: unknown }
  const installments = Array.isArray(terms.installments) ? terms.installments : []
  return {
    condition: typeof terms.condition === 'string' ? terms.condition : null,
    installments: installments
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map((row) => ({
        method: typeof row.method === 'string' ? row.method : null,
        amount: asMoney('cost', typeof row.amount === 'number' ? row.amount : null),
        dueDate: typeof row.dueDate === 'string' ? row.dueDate : null,
        iban: typeof row.iban === 'string' ? `${row.iban.slice(0, 4)}…${row.iban.slice(-4)}` : null,
      })),
  }
}

export interface Names {
  readonly companies: Map<string, { code: string; name: string }>
  readonly parties: Map<string, { code: string; name: string; country: string }>
}

export async function namesOf(db: Reader, invoices: readonly Pick<InvoiceRow, 'companyId' | 'partyId'>[]): Promise<Names> {
  const companies = await db.company.findMany({ where: { id: { in: [...new Set(invoices.map((row) => row.companyId))] } }, select: { id: true, code: true, legalName: true } })
  const parties = await db.party.findMany({ where: { id: { in: [...new Set(invoices.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true, country: true } })
  return {
    companies: new Map(companies.map((row) => [row.id, { code: row.code, name: row.legalName }])),
    parties: new Map(parties.map((row) => [row.id, { code: row.code, name: row.legalName, country: row.country }])),
  }
}

/** Differences outside the tolerance nobody accepted, per invoice. */
export async function unacceptedOf(db: Reader, invoiceIds: readonly string[]): Promise<Map<string, number>> {
  if (invoiceIds.length === 0) return new Map()
  const rows = await db.supplierInvoiceMatch.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: [...invoiceIds] }, withinTolerance: false, acceptedAt: null }, _count: { _all: true } })
  return new Map(rows.map((row) => [row.invoiceId, row._count._all]))
}

export function summaryOf(row: InvoiceRow, names: Names, unaccepted: number, lines: number) {
  const company = names.companies.get(row.companyId)
  const party = names.parties.get(row.partyId)
  return {
    id: row.id,
    company: { id: row.companyId, code: company?.code ?? '?', name: company?.name ?? '?' },
    supplier: { id: row.partyId, code: party?.code ?? '?', name: party?.name ?? '?', country: party?.country ?? '?' },
    source: row.source as InvoiceSource,
    kind: row.kind as InvoiceKind,
    docType: row.docType,
    number: row.number,
    issueDate: dayOf(row.issueDate)!,
    receivedOn: dayOf(row.receivedOn)!,
    currency: row.currency,
    netTotal: asMoney('cost', row.netTotal),
    vatTotal: asMoney('cost', row.vatTotal),
    grossTotal: asMoney('cost', row.grossTotal),
    status: row.status as InvoiceStatus,
    matchStatus: row.matchStatus as MatchStatus,
    /** Differences outside the tolerance nobody accepted yet. */
    differencesToCheck: unaccepted,
    approved: row.approvedAt !== null,
    approvedAt: iso(row.approvedAt),
    dueDate: dayOf(row.dueDate),
    paidOn: dayOf(row.paidOn),
    lines,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

const FILE_REF = { id: true, originalName: true, contentType: true, sizeBytes: true, sha256: true, status: true, kind: true } as const

async function lineView(db: Reader, line: LineRow) {
  const order = line.purchaseOrderLineId
    ? await db.purchaseOrderLine.findUnique({ where: { id: line.purchaseOrderLineId }, select: { id: true, seq: true, quantity: true, uom: true, item: { select: { code: true, name: true } }, purchaseOrder: { select: { id: true, number: true } } } })
    : null
  const subcontract = line.subcontractOrderId ? await db.subcontractOrder.findUnique({ where: { id: line.subcontractOrderId }, select: { id: true, number: true, workOrderId: true } }) : null
  return {
    id: line.id,
    seq: line.seq,
    kind: line.kind,
    description: line.description,
    itemCode: line.itemCode,
    quantity: text(line.quantity),
    uom: line.uom,
    unitPrice: asMoney('cost', text(line.unitPrice)),
    discountPct: text(line.discountPct),
    netAmount: asMoney('cost', line.netAmount),
    vatRatePct: line.vatRatePct.toString(),
    vatNature: line.vatNature,
    siteId: line.siteId,
    purchaseOrderLine: order
      ? { id: order.id, orderId: order.purchaseOrder.id, orderNumber: order.purchaseOrder.number, seq: order.seq, item: order.item, quantity: order.quantity.toString(), uom: order.uom }
      : null,
    subcontractOrder: subcontract ? { id: subcontract.id, number: subcontract.number, workOrderId: subcontract.workOrderId } : null,
    version: line.version,
  }
}

async function linesOf(db: Reader, lines: readonly LineRow[]) {
  const out = []
  for (const line of lines) out.push(await lineView(db, line))
  return out
}

/** The record: header, files, lines, the three-way match per line, approval, payment and what may be done now. */
export async function detailOf(db: Reader, invoice: InvoiceRow, viewer: { readonly userId: string; readonly seesCost: boolean }) {
  const lines = await readLines(db, invoice.id)
  const matches = await readMatches(db, invoice.id)
  const names = await namesOf(db, [invoice])
  const people = await peopleNames(db, [invoice.createdById, invoice.approvedById, invoice.disputedById, ...matches.map((row) => row.acceptedById)])
  const files = await db.storedFile.findMany({ where: { id: { in: [invoice.xmlFileId, invoice.pdfFileId].filter((value): value is string => value !== null) } }, select: FILE_REF })
  const fileOf = (id: string | null) => (id === null ? null : (files.find((file) => file.id === id) ?? null))
  const creditOf = invoice.creditOfId ? await db.supplierInvoice.findUnique({ where: { id: invoice.creditOfId }, select: { id: true, number: true, issueDate: true } }) : null
  const credits = await db.supplierInvoice.findMany({ where: { creditOfId: invoice.id }, select: { id: true, number: true, issueDate: true, status: true }, orderBy: { issueDate: 'asc' } })
  const unaccepted = matches.filter((row) => !row.withinTolerance && row.acceptedAt === null).length
  const linesNet = isTyped(invoice.source as InvoiceSource) ? lines.reduce((total, line) => total + line.netAmount, 0) : null
  const { mappedByIds, acceptedByIds } = await preparationOf(db, invoice.id)
  const facts = {
    number: invoice.number,
    status: invoice.status as InvoiceStatus,
    source: invoice.source as InvoiceSource,
    kind: invoice.kind as InvoiceKind,
    matchStatus: invoice.matchStatus as MatchStatus,
    createdById: invoice.createdById,
    mappedByIds,
    acceptedByIds,
    xmlFileId: invoice.xmlFileId,
    unaccepted,
    linesNet,
    netTotal: invoice.netTotal,
    lines: lines.length,
  }
  const approval = approvalProblems(facts, viewer.userId)
  const held = actionProblems(facts)

  const matchViews = []
  for (const row of matches) {
    const line = lines.find((entry) => entry.id === row.invoiceLineId)!
    const fresh = await freshMatch(db, invoice, line)
    const unit = fresh?.goods?.orderLine.uom ?? 'PCS'
    const stored = {
      invoicedQuantity: row.invoicedQuantity.toString(),
      receivedQuantity: row.receivedQuantity.toString(),
      orderedUnitPrice: row.orderedUnitPrice.toString(),
      invoicedUnitPrice: row.invoicedUnitPrice.toString(),
      differenceAmount: row.differenceAmount,
      withinTolerance: row.withinTolerance,
    }
    const receipt = row.goodsReceiptLineId
      ? await db.goodsReceiptLine.findUnique({ where: { id: row.goodsReceiptLineId }, select: { id: true, receipt: { select: { id: true, number: true, supplierDdtNumber: true, supplierDdtDate: true } } } })
      : null
    const verdict = row.withinTolerance ? 'WITHIN' : (fresh?.match.verdict ?? 'DIFFERENCE')
    const words = fresh
      ? matchWords({ ...fresh.match, ...stored, verdict: verdict === 'WITHIN' ? 'WITHIN' : verdict }, unit, { prices: viewer.seesCost })
      : { en: 'The order is no longer readable', it: "L'ordine non è più leggibile" }
    matchViews.push({
      id: row.id,
      invoiceLineId: row.invoiceLineId,
      lineSeq: line.seq,
      purchaseOrderLineId: row.purchaseOrderLineId,
      subcontractOrderId: row.subcontractOrderId,
      order: fresh?.goods
        ? { kind: 'PURCHASE_ORDER' as const, id: fresh.goods.orderLine.orderId, number: fresh.goods.orderLine.orderNumber, lineSeq: fresh.goods.orderLine.seq, item: fresh.goods.orderLine.item }
        : fresh?.subcontract
          ? { kind: 'SUBCONTRACT_ORDER' as const, id: fresh.subcontract.order.id, number: fresh.subcontract.order.number, lineSeq: null, item: null }
          : null,
      receipt: receipt ? { receiptLineId: receipt.id, receiptId: receipt.receipt.id, number: receipt.receipt.number, supplierDdtNumber: receipt.receipt.supplierDdtNumber, supplierDdtDate: dayOf(receipt.receipt.supplierDdtDate) } : null,
      unit,
      orderedQuantity: fresh?.match.orderedQuantity ?? null,
      orderedUnitPrice: asMoney('cost', stored.orderedUnitPrice),
      receivedQuantity: stored.receivedQuantity,
      invoicedQuantity: stored.invoicedQuantity,
      invoicedUnitPrice: asMoney('cost', stored.invoicedUnitPrice),
      differenceAmount: asMoney('cost', row.differenceAmount),
      quantityTolerancePct: row.quantityTolerancePct.toString(),
      priceTolerancePct: row.priceTolerancePct.toString(),
      withinTolerance: row.withinTolerance,
      verdict,
      words,
      /** The goods, the order or other invoices changed since this match: match again. */
      stale: fresh ? !sameFacts(stored, fresh.match) : true,
      accepted: row.acceptedAt ? { at: toUtcIso(row.acceptedAt), by: { id: row.acceptedById!, name: people.get(row.acceptedById!) ?? null }, note: row.acceptNote! } : null,
      version: row.version,
    })
  }

  const company = names.companies.get(invoice.companyId)
  const party = names.parties.get(invoice.partyId)
  const person = (id: string | null) => (id === null ? null : { id, name: people.get(id) ?? null })
  return {
    ...summaryOf(invoice, names, unaccepted, lines.length),
    company: { id: invoice.companyId, code: company?.code ?? '?', name: company?.name ?? '?' },
    supplier: { id: invoice.partyId, code: party?.code ?? '?', name: party?.name ?? '?', country: party?.country ?? '?' },
    sdiIdentifier: invoice.sdiIdentifier,
    sdiFileName: invoice.sdiFileName,
    withholdingAmount: asMoney('cost', invoice.withholdingAmount),
    stampDutyAmount: asMoney('cost', invoice.stampDutyAmount),
    vatSummary: asMoney('cost', vatRows(invoice.vatSummary)),
    paymentTerms: termsOf(invoice.paymentTerms),
    creditOf: creditOf ? { id: creditOf.id, number: creditOf.number, issueDate: dayOf(creditOf.issueDate)! } : null,
    credits: credits.map((row) => ({ id: row.id, number: row.number, issueDate: dayOf(row.issueDate)!, status: row.status as InvoiceStatus })),
    files: { xml: fileOf(invoice.xmlFileId), pdf: fileOf(invoice.pdfFileId) },
    registeredBy: invoice.createdById === null ? null : person(invoice.createdById),
    lines: await linesOf(db, lines),
    matches: matchViews,
    tolerance: { basis: MATCH_SETTINGS.basis, quantityTolerancePct: MATCH_SETTINGS.quantityTolerancePct, priceTolerancePct: MATCH_SETTINGS.priceTolerancePct, decided: MATCH_SETTINGS.decided, words: MATCH_SETTINGS.words },
    approval: {
      approvedAt: iso(invoice.approvedAt),
      approvedBy: person(invoice.approvedById),
      note: invoice.approvalNote,
      /** Whether the viewer may approve it now (their permission is the route's), and why not, in words. */
      ready: approval.length === 0,
      problems: approval,
    },
    dispute: invoice.disputedAt ? { at: toUtcIso(invoice.disputedAt), by: person(invoice.disputedById), reason: invoice.disputeReason! } : null,
    payment: { dueDate: dayOf(invoice.dueDate), paidOn: dayOf(invoice.paidOn), paymentRef: invoice.paymentRef },
    voided: invoice.voidedAt ? { at: toUtcIso(invoice.voidedAt), reason: invoice.voidReason! } : null,
    internalNote: invoice.internalNote,
    actions: held,
  }
}

export type DetailView = Awaited<ReturnType<typeof detailOf>>
export type SummaryView = ReturnType<typeof summaryOf>
