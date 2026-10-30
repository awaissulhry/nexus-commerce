import type { Prisma } from '@nexus/factory-db'
import { dayWords } from '@nexus/factory-domain/accounting/periods'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { PAYABLES_MANAGE, PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import { actionProblems, isTyped, OPEN_STATUSES, PAYABLES_LIMITS, TILES, typedSupplierProblem, vatSummaryOf, type InvoiceSource, type InvoiceStatus, type Tile } from '@nexus/factory-domain/payables/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { serverClock } from '../../core/time'
import { refuseHardLocked } from '../accounting/period-guard'
import { prepareFileCopy, recordGeneratedFile, type PreparedGeneratedFile } from '../../platform/files/files'
import { processFiles } from '../../platform/files/service'
import { rematchInCommand } from './matching'
import { actorIdOf, dayDate, dayOf, INVOICE_COLUMNS, invoiceInCommand, mayOn, officeInvoice, officeOf, readLines, RECORD, scopeOf, seesCost, type InvoiceRow, type LineRow, type Reader } from './store'
import { detailOf, namesOf, summaryOf, unacceptedOf, type DetailView, type SummaryView } from './views'

/**
 * Supplier and subcontractor invoices (B-W2a-62; FIN-136; design finance.payables, SCR-153 "Supplier invoices": the
 * tiles To handle, the grid, the record's Lines tab; "Add foreign invoice"). Office only; every write is ONE command on
 * the invoice (its version bump holds the row; the …_money_w2a_guards hold the same rules as the last word).
 *
 *   list     the invoices the caller reaches, newest first; a tile is a saved filter (New from SDI, Differences to
 *            check, To approve, Due this week)
 *   register a typed invoice (source MANUAL "Add foreign invoice", or EMAIL: one sent by e-mail), from its PDF: the
 *            supplier's number, dates, sums and lines as printed; the PDF (an e-mail's attachment or an upload) is
 *            copied onto the invoice as a fiscal document. An Italian supplier's invoice arrives through SDI (./sdi.ts)
 *            and is never typed.
 *   correct  a typed invoice while received or disputed: its header, its lines (add, change, remove), its PDF; an SDI
 *            invoice only has its lines' kind and mapping changed. Every change redoes the match (./matching.ts).
 *   map      a line to the purchase order line it bills (goods, or a charge), or the subcontract order whose work it
 *            bills; none: a service (an invoice without PO)
 *   void     a typed invoice typed by mistake or a duplicate (an SDI one is answered by the supplier's credit note)
 *   dispute  ask the supplier for a credit note (a reason); reopen it when settled
 */

const now = (): Date => serverClock.now()
const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const refuse = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The supplier invoice is not valid as it stands.', problems)

/** A 409 in words with the refusal's code at `refusal/<CODE>`. */
export class RefusedError extends ConflictError {
  override name = 'RefusedError'
  override readonly issues: readonly Issue[]
  constructor(refusals: readonly { readonly code: string; readonly message: string }[]) {
    super(refusals.map((refusal) => refusal.message).join(' '))
    this.issues = refusals.map((refusal) => ({ path: `refusal/${refusal.code}`, message: refusal.message }))
  }
}

export const viewerOf = (caller: CommandCaller) => {
  const context = officeOf(caller)
  return { userId: context.actorId, seesCost: seesCost(context) }
}

/** The record as the answers show it, read again in the command. */
export async function detailInCommand(tools: Pick<CommandTools, 'tx' | 'context'>, invoiceId: string): Promise<DetailView> {
  const invoice = await invoiceInCommand(tools.tx, invoiceId)
  const context = tools.context
  const viewer = context.audience === 'office' ? { userId: context.actorId, seesCost: seesCost(context) } : { userId: '', seesCost: false }
  return detailOf(tools.tx, invoice, viewer)
}

// ---- reads ------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  readonly status?: InvoiceStatus | undefined
  readonly matchStatus?: string | undefined
  readonly source?: InvoiceSource | undefined
  readonly kind?: 'INVOICE' | 'CREDIT_NOTE' | undefined
  readonly tile?: Tile | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The Sunday that ends this week (Europe/Rome): the "Due this week" tile counts what falls due by then, overdue included. */
export function weekEnd(at: Date): string {
  const today = businessDate(at)
  const day = new Date(`${today}T00:00:00.000Z`)
  const offset = (7 - day.getUTCDay()) % 7
  return new Date(day.getTime() + offset * 86_400_000).toISOString().slice(0, 10)
}

const OUTSIDE = { withinTolerance: false, acceptedAt: null } satisfies Prisma.SupplierInvoiceMatchWhereInput

export function tileWhere(tile: Tile, at: Date): Prisma.SupplierInvoiceWhereInput {
  switch (tile) {
    case 'NEW_FROM_SDI':
      return { source: 'SDI', status: 'RECEIVED', matchStatus: 'PENDING' }
    case 'DIFFERENCES':
      return { status: 'RECEIVED', matches: { some: OUTSIDE } }
    case 'TO_APPROVE':
      return { status: 'RECEIVED', matchStatus: { in: ['MATCHED', 'NO_PO', 'DIFFERENCES'] }, matches: { none: OUTSIDE } }
    case 'DUE_THIS_WEEK':
      return { status: { in: ['RECEIVED', 'APPROVED', 'DISPUTED'] }, dueDate: { lte: dayDate(weekEnd(at)) } }
  }
}

/** payables.view: the invoices the caller reaches, newest first (a cursor of ids), and how many match. */
export async function listInvoices(caller: CommandCaller, query: ListQuery): Promise<{ items: SummaryView[]; nextCursor: string | null; count: number }> {
  const context = officeOf(caller)
  const q = blank(query.q)
  const base: Prisma.SupplierInvoiceWhereInput[] = [
    scopeOf(context),
    query.companyId ? { companyId: query.companyId } : {},
    query.partyId ? { partyId: query.partyId } : {},
    query.status ? { status: query.status } : {},
    query.matchStatus ? { matchStatus: query.matchStatus as Prisma.SupplierInvoiceWhereInput['matchStatus'] } : {},
    query.source ? { source: query.source } : {},
    query.kind ? { kind: query.kind } : {},
    query.tile ? tileWhere(query.tile, now()) : {},
    q
      ? {
          OR: [
            { number: { contains: q, mode: 'insensitive' } },
            { sdiIdentifier: { contains: q, mode: 'insensitive' } },
            { party: { code: { contains: q, mode: 'insensitive' } } },
            { party: { legalName: { contains: q, mode: 'insensitive' } } },
            { lines: { some: { description: { contains: q, mode: 'insensitive' } } } },
          ],
        }
      : {},
  ]
  return caller.withClient(async (client) => {
    const rows = await client.supplierInvoice.findMany({
      where: { AND: [...base, query.cursor ? { id: { lt: query.cursor } } : {}] },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: { ...INVOICE_COLUMNS, _count: { select: { lines: true } } },
    })
    const page = rows.slice(0, query.limit)
    const names = await namesOf(client, page)
    const unaccepted = await unacceptedOf(client, page.map((row) => row.id))
    const count = await client.supplierInvoice.count({ where: { AND: base } })
    return { items: page.map((row) => summaryOf(row, names, unaccepted.get(row.id) ?? 0, row._count.lines)), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null, count }
  })
}

/** payables.view: the tiles (design: "Each tile shows 0 when the answer is zero"), per the caller's reach. */
export async function invoiceCounts(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly partyId?: string | undefined }) {
  const context = officeOf(caller)
  const at = now()
  const base: Prisma.SupplierInvoiceWhereInput[] = [scopeOf(context), query.companyId ? { companyId: query.companyId } : {}, query.partyId ? { partyId: query.partyId } : {}]
  return caller.withClient(async (client) => {
    const counts: Record<Tile, number> = { NEW_FROM_SDI: 0, DIFFERENCES: 0, TO_APPROVE: 0, DUE_THIS_WEEK: 0 }
    for (const tile of TILES) counts[tile] = await client.supplierInvoice.count({ where: { AND: [...base, tileWhere(tile, at)] } })
    return { newFromSdi: counts.NEW_FROM_SDI, differences: counts.DIFFERENCES, toApprove: counts.TO_APPROVE, dueThisWeek: counts.DUE_THIS_WEEK, weekEnds: weekEnd(at), readAt: at.toISOString() }
  })
}

/** payables.view: one invoice with its lines, match, approval, payment and files. */
export async function getInvoice(caller: CommandCaller, invoiceId: string): Promise<{ invoice: DetailView }> {
  const { invoice } = await officeInvoice(caller, invoiceId)
  return { invoice: await caller.withClient((client) => detailOf(client, invoice, viewerOf(caller))) }
}

// ---- mapping a line -----------------------------------------------------------------------------------------------------

export interface Mapping {
  readonly kind: 'GOODS' | 'SUBCONTRACT' | 'SERVICE' | 'CHARGE'
  readonly siteId: string | null
  readonly purchaseOrderLineId: string | null
  readonly subcontractOrderId: string | null
}

const ORDER_OPEN_TO_BILL = ['SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED']
const SUBCONTRACT_OPEN_TO_BILL = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED']

/**
 * The order a line is mapped to, checked in the caller's scope: a purchase order line of the invoice's supplier and
 * company, sent (not a draft, not cancelled), in the invoice's currency (a GOODS line, or a CHARGE that bills it); or a
 * subcontract order of that workshop and company, issued (a SUBCONTRACT line). None: the line keeps its kind (a GOODS or
 * SUBCONTRACT line without order waits for one; SERVICE and CHARGE need none).
 */
export async function mappingOf(
  db: Reader,
  invoice: { readonly companyId: string; readonly partyId: string; readonly currency: string },
  input: { readonly kind?: Mapping['kind'] | undefined; readonly purchaseOrderLineId?: string | null | undefined; readonly subcontractOrderId?: string | null | undefined },
  current: Mapping,
  path: string,
): Promise<Mapping> {
  const purchaseOrderLineId = input.purchaseOrderLineId !== undefined ? input.purchaseOrderLineId : input.subcontractOrderId ? null : current.purchaseOrderLineId
  const subcontractOrderId = input.subcontractOrderId !== undefined ? input.subcontractOrderId : input.purchaseOrderLineId ? null : current.subcontractOrderId
  if (purchaseOrderLineId && subcontractOrderId) throw refuse([{ path, message: 'A line bills one order: a purchase order line or a subcontract order, not both.' }])
  if (purchaseOrderLineId) {
    const line = isUuid(purchaseOrderLineId)
      ? await db.purchaseOrderLine.findUnique({ where: { id: purchaseOrderLineId }, select: { id: true, siteId: true, partyId: true, cancelledAt: true, purchaseOrder: { select: { number: true, companyId: true, status: true, currency: true } } } })
      : null
    if (!line || line.partyId !== invoice.partyId || line.purchaseOrder.companyId !== invoice.companyId) throw refuse([{ path: `${path}/purchaseOrderLineId`, message: "Not a purchase order line of the invoice's supplier and company." }])
    if (!ORDER_OPEN_TO_BILL.includes(line.purchaseOrder.status)) throw refuse([{ path: `${path}/purchaseOrderLineId`, message: `Purchase order ${line.purchaseOrder.number} is ${line.purchaseOrder.status.toLowerCase()}: an invoice bills an order that was sent.` }])
    if (line.purchaseOrder.currency !== invoice.currency) throw refuse([{ path: `${path}/purchaseOrderLineId`, message: `Purchase order ${line.purchaseOrder.number} is in ${line.purchaseOrder.currency}, the invoice in ${invoice.currency}: they cannot be matched.` }])
    const kind = input.kind ?? (current.kind === 'CHARGE' ? 'CHARGE' : 'GOODS')
    if (kind !== 'GOODS' && kind !== 'CHARGE') throw refuse([{ path: `${path}/kind`, message: 'A line on a purchase order line is goods (or a charge that bills it).' }])
    return { kind, siteId: line.siteId, purchaseOrderLineId: line.id, subcontractOrderId: null }
  }
  if (subcontractOrderId) {
    const order = isUuid(subcontractOrderId) ? await db.subcontractOrder.findUnique({ where: { id: subcontractOrderId }, select: { id: true, siteId: true, partyId: true, companyId: true, number: true, status: true, currency: true } }) : null
    if (!order || order.partyId !== invoice.partyId || order.companyId !== invoice.companyId) throw refuse([{ path: `${path}/subcontractOrderId`, message: "Not a subcontract order of the invoice's workshop and company." }])
    if (!SUBCONTRACT_OPEN_TO_BILL.includes(order.status)) throw refuse([{ path: `${path}/subcontractOrderId`, message: `Subcontract order ${order.number} is ${order.status.toLowerCase()}: an invoice bills an order that was issued.` }])
    if (order.currency !== invoice.currency) throw refuse([{ path: `${path}/subcontractOrderId`, message: `Subcontract order ${order.number} is in ${order.currency}, the invoice in ${invoice.currency}: they cannot be matched.` }])
    if (input.kind !== undefined && input.kind !== 'SUBCONTRACT') throw refuse([{ path: `${path}/kind`, message: 'A line on a subcontract order is the workshop’s work (SUBCONTRACT).' }])
    return { kind: 'SUBCONTRACT', siteId: order.siteId, purchaseOrderLineId: null, subcontractOrderId: order.id }
  }
  const kind = input.kind ?? current.kind
  return { kind, siteId: null, purchaseOrderLineId: null, subcontractOrderId: null }
}

// ---- register a typed invoice --------------------------------------------------------------------------------------------

export interface LineInput {
  readonly kind?: Mapping['kind'] | undefined
  readonly description: string
  readonly itemCode?: string | null | undefined
  readonly quantity?: string | null | undefined
  readonly uom?: string | null | undefined
  readonly unitPrice?: string | null | undefined
  readonly discountPct?: string | null | undefined
  /** Required; optional in the type only because a money field is (its grain decides whether it may be sent). */
  readonly netAmount?: number | undefined
  readonly vatRatePct: string
  readonly vatNature?: string | null | undefined
  readonly purchaseOrderLineId?: string | null | undefined
  readonly subcontractOrderId?: string | null | undefined
}

export interface CreateInput {
  readonly companyId: string
  readonly partyId: string
  readonly source: 'MANUAL' | 'EMAIL'
  readonly kind?: 'INVOICE' | 'CREDIT_NOTE' | undefined
  readonly docType?: string | null | undefined
  readonly number: string
  readonly issueDate: string
  readonly receivedOn?: string | undefined
  readonly currency?: string | undefined
  readonly netTotal?: number | undefined
  readonly vatTotal?: number | undefined
  readonly grossTotal?: number | undefined
  readonly withholdingAmount?: number | null | undefined
  readonly stampDutyAmount?: number | null | undefined
  readonly dueDate?: string | null | undefined
  readonly creditOfId?: string | null | undefined
  /** The PDF: a file the caller can read (an e-mail's attachment, an upload), copied onto the invoice. */
  readonly fileId?: string | null | undefined
  /** The mail it came with (source EMAIL), for the record. */
  readonly inboundEmailId?: string | null | undefined
  readonly internalNote?: string | null | undefined
  readonly lines: readonly LineInput[]
}

const SUPPLYING_ROLES = ['SUPPLIER', 'SUBCONTRACTOR']

/** The supplier: a supplier or subcontractor of the company (or of every company), not an Italian one (it comes by SDI). */
async function supplierOf(db: Reader, partyId: string, companyId: string): Promise<{ id: string; country: string; currency: string; code: string }> {
  const party = isUuid(partyId) ? await db.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, companyId: true, roles: true, country: true, currency: true } }) : null
  if (!party || (party.companyId !== null && party.companyId !== companyId)) throw refuse([{ path: 'body/partyId', message: 'Not a supplier of this company you can see.' }])
  if (!party.roles.some((role) => SUPPLYING_ROLES.includes(role))) throw refuse([{ path: 'body/partyId', message: 'The party supplies nothing to us: give it the SUPPLIER or SUBCONTRACTOR role first.' }])
  return party
}

/** The same supplier's number twice: once per year (any state but voided), and once per number and date at all. */
async function duplicateProblem(db: Reader, input: { companyId: string; partyId: string; number: string; issueDate: string }, except: string | null): Promise<string | null> {
  const year = input.issueDate.slice(0, 4)
  const rows = await db.supplierInvoice.findMany({
    where: { companyId: input.companyId, partyId: input.partyId, number: input.number, issueDate: { gte: dayDate(`${year}-01-01`), lte: dayDate(`${year}-12-31`) }, ...(except ? { id: { not: except } } : {}) },
    select: { id: true, issueDate: true, status: true, source: true },
  })
  const same = rows.find((row) => dayOf(row.issueDate) === input.issueDate)
  if (same && same.status === 'VOIDED') return `Invoice ${input.number} of ${dayWords(input.issueDate)} of this supplier was registered and voided: the same number and date cannot be registered again (correct a typed invoice instead of voiding it).`
  const live = rows.find((row) => row.status !== 'VOIDED')
  return live ? `Invoice ${input.number} of this supplier is already registered for ${year} (${dayOf(live.issueDate)}, ${live.source === 'SDI' ? 'from SDI' : 'typed'}, ${live.status.toLowerCase()}).` : null
}

async function creditedOf(db: Reader, creditOfId: string, invoice: { companyId: string; partyId: string }): Promise<string> {
  const credited = isUuid(creditOfId) ? await db.supplierInvoice.findUnique({ where: { id: creditOfId }, select: { id: true, companyId: true, partyId: true, kind: true } }) : null
  if (!credited || credited.companyId !== invoice.companyId || credited.partyId !== invoice.partyId || credited.kind !== 'INVOICE') throw refuse([{ path: 'body/creditOfId', message: "Not an invoice of this supplier and company (a credit note credits an invoice)." }])
  return credited.id
}

/** The PDF copied onto the invoice, outside any transaction (platform/files prepareFileCopy). */
async function preparePdf(caller: CommandCaller, fileId: string, target: { companyId: string; invoiceId: string }): Promise<PreparedGeneratedFile & { sourceFileId: string }> {
  const source = await caller.withClient((client) => client.storedFile.findUnique({ where: { id: fileId }, select: { id: true, contentType: true, status: true } }))
  if (!source) throw refuse([{ path: 'body/fileId', message: 'Not a file you can read.' }])
  if (source.contentType !== 'application/pdf') throw refuse([{ path: 'body/fileId', message: "The supplier invoice's copy is a PDF." }])
  return prepareFileCopy(processFiles(), caller, fileId, { companyId: target.companyId, recordType: RECORD, recordId: target.invoiceId, kind: 'FISCAL_ARCHIVE' })
}

function lineData(input: LineInput, mapping: Mapping, at: { seq: number }) {
  return {
    seq: at.seq,
    kind: mapping.kind,
    description: input.description.trim(),
    itemCode: blank(input.itemCode),
    quantity: input.quantity ?? null,
    uom: blank(input.uom),
    unitPrice: input.unitPrice ?? null,
    discountPct: input.discountPct ?? null,
    netAmount: input.netAmount ?? 0,
    vatRatePct: input.vatRatePct,
    vatNature: blank(input.vatNature),
    siteId: mapping.siteId,
    purchaseOrderLineId: mapping.purchaseOrderLineId,
    subcontractOrderId: mapping.subcontractOrderId,
  }
}

/** payables.manage: a typed invoice (MANUAL, EMAIL) from its PDF, matched at once. */
export async function createInvoice(caller: CommandCaller, input: CreateInput, idempotencyKey?: string): Promise<{ invoice: DetailView }> {
  const context = officeOf(caller)
  if (!mayOn(context, PAYABLES_MANAGE, { companyId: input.companyId, partyId: input.partyId })) throw new ForbiddenError()
  const today = businessDate(now())
  const receivedOn = input.receivedOn ?? today
  const problems: Issue[] = []
  if (input.issueDate > today) problems.push({ path: 'body/issueDate', message: 'The invoice is dated in the future.' })
  if (receivedOn > today) problems.push({ path: 'body/receivedOn', message: 'The day it was received is in the future.' })
  if (receivedOn < input.issueDate) problems.push({ path: 'body/receivedOn', message: 'It was received before it was issued.' })
  if (input.kind !== 'CREDIT_NOTE' && input.creditOfId) problems.push({ path: 'body/creditOfId', message: 'Only a credit note names the invoice it credits.' })
  if (input.source === 'MANUAL' && input.inboundEmailId) problems.push({ path: 'body/inboundEmailId', message: 'A mail is named for an invoice that came by e-mail (source EMAIL).' })
  for (const [index, line] of input.lines.entries()) if (line.netAmount === undefined) problems.push({ path: `body/lines/${index}/netAmount`, message: "The line's net amount, as printed." })
  if (problems.length > 0) throw refuse(problems)
  const party = await caller.withClient((client) => supplierOf(client, input.partyId, input.companyId))
  const italian = typedSupplierProblem(party.country)
  if (italian) throw new RefusedError([{ code: 'COMES_THROUGH_SDI', message: italian }])
  const invoiceId = newId()
  const pdf = input.fileId ? await preparePdf(caller, input.fileId, { companyId: input.companyId, invoiceId }) : null
  const currency = input.currency ?? party.currency

  const { result } = await command(caller, { name: 'payables.register', idempotencyKey, input: { ...input, invoiceId, pdf: pdf ? { sha256: pdf.sha256, sourceFileId: pdf.sourceFileId } : null } }, async (tools) => {
    const { tx } = tools
    const company = await tx.company.findUnique({ where: { id: input.companyId }, select: { id: true } })
    if (!company) throw new NotFoundError('Company not found.')
    const duplicate = await duplicateProblem(tx, { companyId: input.companyId, partyId: party.id, number: input.number.trim(), issueDate: input.issueDate }, null)
    if (duplicate) throw new RefusedError([{ code: 'DUPLICATE', message: duplicate }])
    const creditOfId = input.creditOfId ? await creditedOf(tx, input.creditOfId, { companyId: input.companyId, partyId: party.id }) : null
    await refuseHardLocked(tx, tools.context, [{ companyId: input.companyId, day: receivedOn, refused: `supplier invoice ${input.number} received on ${dayWords(receivedOn)} is not registered`, path: 'body/receivedOn' }])
    const header = { companyId: input.companyId, partyId: party.id, currency }
    const lines: { data: ReturnType<typeof lineData> }[] = []
    for (const [index, line] of input.lines.entries()) {
      const mapping = await mappingOf(tx, header, line, { kind: line.kind ?? 'GOODS', siteId: null, purchaseOrderLineId: null, subcontractOrderId: null }, `body/lines/${index}`)
      lines.push({ data: lineData(line, mapping, { seq: index + 1 }) })
    }
    const vatSummary = vatSummaryOf(lines.map((line) => ({ netAmount: line.data.netAmount, vatRatePct: line.data.vatRatePct, vatNature: line.data.vatNature })))
    const netTotal = input.netTotal ?? lines.reduce((total, line) => total + line.data.netAmount, 0)
    const vatTotal = input.vatTotal ?? vatSummary.reduce((total, row) => total + row.vat, 0)
    const grossTotal = input.grossTotal ?? netTotal + vatTotal
    if (netTotal < 0 || vatTotal < 0 || grossTotal < 0) throw refuse([{ path: 'body/netTotal', message: 'A supplier invoice adds up to 0 or more (a credit note is registered as one, with positive amounts).' }])
    await tx.supplierInvoice.create({
      data: {
        id: invoiceId,
        companyId: input.companyId,
        partyId: party.id,
        source: input.source,
        kind: input.kind ?? 'INVOICE',
        docType: blank(input.docType),
        number: input.number.trim(),
        issueDate: dayDate(input.issueDate),
        receivedOn: dayDate(receivedOn),
        currency,
        netTotal,
        vatTotal,
        grossTotal,
        withholdingAmount: input.withholdingAmount ?? null,
        stampDutyAmount: input.stampDutyAmount ?? null,
        vatSummary,
        dueDate: input.dueDate ? dayDate(input.dueDate) : null,
        creditOfId,
        internalNote: blank(input.internalNote),
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
    for (const line of lines) await tx.supplierInvoiceLine.create({ data: { id: newId(), partyId: party.id, invoiceId, ...line.data, createdById: actorIdOf(tools) }, select: { id: true } })
    if (pdf) {
      const file = await recordGeneratedFile(tools, pdf, { details: { file: 'supplier invoice (PDF)', number: input.number.trim(), copiedFrom: pdf.sourceFileId } })
      await tx.supplierInvoice.update({ where: { id: invoiceId }, data: { pdfFileId: file.id }, select: { id: true } })
    }
    tools.audit({
      action: 'payables.register',
      recordType: RECORD,
      recordId: invoiceId,
      companyId: input.companyId,
      after: { source: input.source, kind: input.kind ?? 'INVOICE', number: input.number.trim(), issueDate: input.issueDate, receivedOn, currency, totals: markMoney('cost', { netTotal, vatTotal, grossTotal }), lines: lines.length, inboundEmailId: input.inboundEmailId ?? null, pdf: pdf !== null },
    })
    const outcome = await rematchInCommand(tools, invoiceId)
    tools.emit({
      type: 'supplier_invoice.received',
      subject: invoiceId,
      companyId: input.companyId,
      payload: { supplierInvoiceId: invoiceId, partyId: party.id, source: input.source, kind: input.kind ?? 'INVOICE', status: 'RECEIVED', matchStatus: outcome.matchStatus, lines: lines.length, mapped: lines.filter((line) => line.data.purchaseOrderLineId || line.data.subcontractOrderId).length },
    })
    return { invoice: await detailInCommand(tools, invoiceId) }
  })
  return result
}

// ---- change ------------------------------------------------------------------------------------------------------------

export interface PatchInput {
  readonly version: number
  readonly docType?: string | null | undefined
  readonly number?: string | undefined
  readonly issueDate?: string | undefined
  readonly receivedOn?: string | undefined
  readonly netTotal?: number | undefined
  readonly vatTotal?: number | undefined
  readonly grossTotal?: number | undefined
  readonly withholdingAmount?: number | null | undefined
  readonly stampDutyAmount?: number | null | undefined
  readonly dueDate?: string | null | undefined
  readonly creditOfId?: string | null | undefined
  readonly fileId?: string | undefined
  readonly internalNote?: string | null | undefined
}

const TYPED_FIELDS = ['docType', 'number', 'issueDate', 'receivedOn', 'netTotal', 'vatTotal', 'grossTotal', 'withholdingAmount', 'stampDutyAmount', 'dueDate', 'creditOfId', 'fileId'] as const

/** payables.manage: a typed invoice's header corrected (received or disputed); the internal note of any invoice. */
export async function patchInvoice(caller: CommandCaller, invoiceId: string, input: PatchInput, idempotencyKey?: string): Promise<{ invoice: DetailView }> {
  const { invoice: seen } = await officeInvoice(caller, invoiceId, PAYABLES_MANAGE)
  const typedChange = TYPED_FIELDS.filter((field) => input[field] !== undefined)
  if (typedChange.length > 0) {
    const held = actionProblems({ number: seen.number, status: seen.status as InvoiceStatus, source: seen.source as InvoiceSource }).edit
    if (held) throw new RefusedError([{ code: seen.source === 'SDI' ? 'FROM_SDI' : 'NOT_OPEN', message: held }])
  }
  const pdf = input.fileId ? await preparePdf(caller, input.fileId, { companyId: seen.companyId, invoiceId }) : null
  const { result } = await command(
    caller,
    { name: 'payables.change', idempotencyKey, input: { invoiceId, ...input, pdf: pdf ? { sha256: pdf.sha256 } : null }, record: { type: 'SupplierInvoice', id: invoiceId, expectedVersion: input.version } },
    async (tools) => {
      const { tx } = tools
      const before = await invoiceInCommand(tx, invoiceId)
      if (typedChange.length > 0) {
        const held = actionProblems({ number: before.number, status: before.status as InvoiceStatus, source: before.source as InvoiceSource }).edit
        if (held) throw new RefusedError([{ code: 'NOT_OPEN', message: held }])
      }
      const issueDate = input.issueDate ?? dayOf(before.issueDate)!
      const receivedOn = input.receivedOn ?? dayOf(before.receivedOn)!
      const today = businessDate(tools.now)
      const problems: Issue[] = []
      if (issueDate > today) problems.push({ path: 'body/issueDate', message: 'The invoice is dated in the future.' })
      if (receivedOn > today) problems.push({ path: 'body/receivedOn', message: 'The day it was received is in the future.' })
      if (receivedOn < issueDate) problems.push({ path: 'body/receivedOn', message: 'It was received before it was issued.' })
      if (input.creditOfId && before.kind !== 'CREDIT_NOTE') problems.push({ path: 'body/creditOfId', message: 'Only a credit note names the invoice it credits.' })
      if (problems.length > 0) throw refuse(problems)
      const number = input.number?.trim() ?? before.number
      if (input.number !== undefined || input.issueDate !== undefined) {
        const duplicate = await duplicateProblem(tx, { companyId: before.companyId, partyId: before.partyId, number, issueDate }, invoiceId)
        if (duplicate) throw new RefusedError([{ code: 'DUPLICATE', message: duplicate }])
      }
      const journal = ['number', 'issueDate', 'receivedOn', 'netTotal', 'vatTotal', 'grossTotal', 'withholdingAmount', 'stampDutyAmount', 'docType'].some((field) => input[field as keyof PatchInput] !== undefined)
      if (journal) {
        const days = [...new Set([dayOf(before.receivedOn)!, receivedOn])]
        await refuseHardLocked(tx, tools.context, days.map((day) => ({ companyId: before.companyId, day, refused: `supplier invoice ${before.number} received on ${dayWords(day)} is not changed`, path: 'body/receivedOn' })))
      }
      const creditOfId = input.creditOfId === undefined ? undefined : input.creditOfId ? await creditedOf(tx, input.creditOfId, before) : null
      const data: Prisma.SupplierInvoiceUncheckedUpdateInput = {
        ...(input.docType !== undefined ? { docType: blank(input.docType) } : {}),
        ...(input.number !== undefined ? { number } : {}),
        ...(input.issueDate !== undefined ? { issueDate: dayDate(issueDate) } : {}),
        ...(input.receivedOn !== undefined ? { receivedOn: dayDate(receivedOn) } : {}),
        ...(input.netTotal !== undefined ? { netTotal: input.netTotal } : {}),
        ...(input.vatTotal !== undefined ? { vatTotal: input.vatTotal } : {}),
        ...(input.grossTotal !== undefined ? { grossTotal: input.grossTotal } : {}),
        ...(input.withholdingAmount !== undefined ? { withholdingAmount: input.withholdingAmount } : {}),
        ...(input.stampDutyAmount !== undefined ? { stampDutyAmount: input.stampDutyAmount } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? dayDate(input.dueDate) : null } : {}),
        ...(creditOfId !== undefined ? { creditOfId } : {}),
        ...(input.internalNote !== undefined ? { internalNote: blank(input.internalNote) } : {}),
      }
      if (Object.keys(data).length > 0) await tx.supplierInvoice.update({ where: { id: invoiceId }, data, select: { id: true } })
      if (pdf) {
        const file = await recordGeneratedFile(tools, pdf, { details: { file: 'supplier invoice (PDF)', number, copiedFrom: pdf.sourceFileId } })
        await tx.supplierInvoice.update({ where: { id: invoiceId }, data: { pdfFileId: file.id }, select: { id: true } })
      }
      const fields = Object.keys(input).filter((key) => key !== 'version')
      tools.audit({
        action: 'payables.change',
        recordType: RECORD,
        recordId: invoiceId,
        companyId: before.companyId,
        before: markMoney('cost', Object.fromEntries(fields.map((field) => [field, field === 'fileId' ? before.pdfFileId : (before as Record<string, unknown>)[field] ?? null]))),
        after: markMoney('cost', Object.fromEntries(fields.map((field) => [field, (input as unknown as Record<string, unknown>)[field] ?? null]))),
      })
      const after = await invoiceInCommand(tx, invoiceId)
      tools.emit({ type: 'supplier_invoice.changed', subject: invoiceId, companyId: before.companyId, payload: { supplierInvoiceId: invoiceId, partyId: before.partyId, status: after.status, matchStatus: after.matchStatus, fields } })
      return { invoice: await detailInCommand(tools, invoiceId) }
    },
  )
  return result
}

// ---- lines ------------------------------------------------------------------------------------------------------------

export interface LinePatch {
  readonly version: number
  readonly kind?: Mapping['kind'] | undefined
  readonly purchaseOrderLineId?: string | null | undefined
  readonly subcontractOrderId?: string | null | undefined
  readonly description?: string | undefined
  readonly itemCode?: string | null | undefined
  readonly quantity?: string | null | undefined
  readonly uom?: string | null | undefined
  readonly unitPrice?: string | null | undefined
  readonly discountPct?: string | null | undefined
  readonly netAmount?: number | undefined
  readonly vatRatePct?: string | undefined
  readonly vatNature?: string | null | undefined
}

const FIGURES = ['description', 'itemCode', 'quantity', 'uom', 'unitPrice', 'discountPct', 'netAmount', 'vatRatePct', 'vatNature'] as const

/** The typed invoice's VAT summary follows its lines (an SDI one keeps what SDI said). */
async function refreshTypedSummary(tx: CommandTx, invoice: InvoiceRow): Promise<void> {
  if (!isTyped(invoice.source as InvoiceSource)) return
  const lines = await readLines(tx, invoice.id)
  const vatSummary = vatSummaryOf(lines.map((line) => ({ netAmount: line.netAmount, vatRatePct: line.vatRatePct.toString(), vatNature: line.vatNature })))
  await tx.supplierInvoice.update({ where: { id: invoice.id }, data: { vatSummary }, select: { id: true } })
}

async function lineCommand(
  caller: CommandCaller,
  invoiceId: string,
  name: 'payables.addLine' | 'payables.changeLine' | 'payables.removeLine',
  input: { readonly version: number } & Record<string, unknown>,
  idempotencyKey: string | undefined,
  work: (tools: CommandTools, invoice: InvoiceRow) => Promise<{ fields: string[]; journal: boolean }>,
): Promise<{ invoice: DetailView }> {
  const { invoice: seen } = await officeInvoice(caller, invoiceId, PAYABLES_MANAGE)
  const held = actionProblems({ number: seen.number, status: seen.status as InvoiceStatus, source: seen.source as InvoiceSource }).map
  if (held) throw new RefusedError([{ code: 'NOT_OPEN', message: held }])
  const { result } = await command(caller, { name, idempotencyKey, input: { invoiceId, ...input }, record: { type: 'SupplierInvoice', id: invoiceId, expectedVersion: input.version } }, async (tools) => {
    const invoice = await invoiceInCommand(tools.tx, invoiceId)
    if (!OPEN_STATUSES.includes(invoice.status as InvoiceStatus)) throw new RefusedError([{ code: 'NOT_OPEN', message: actionProblems({ number: invoice.number, status: invoice.status as InvoiceStatus, source: invoice.source as InvoiceSource }).map! }])
    const { fields, journal } = await work(tools, invoice)
    if (journal) await refuseHardLocked(tools.tx, tools.context, [{ companyId: invoice.companyId, day: dayOf(invoice.receivedOn)!, refused: `supplier invoice ${invoice.number} received on ${dayWords(dayOf(invoice.receivedOn)!)} is not changed`, path: 'body' }])
    if (journal) await refreshTypedSummary(tools.tx, invoice)
    const outcome = await rematchInCommand(tools, invoiceId)
    tools.emit({ type: 'supplier_invoice.changed', subject: invoiceId, companyId: invoice.companyId, payload: { supplierInvoiceId: invoiceId, partyId: invoice.partyId, status: invoice.status, matchStatus: outcome.matchStatus, fields } })
    return { invoice: await detailInCommand(tools, invoiceId) }
  })
  return result
}

const typedOnly = (invoice: InvoiceRow) => {
  if (!isTyped(invoice.source as InvoiceSource)) throw new RefusedError([{ code: 'FROM_SDI', message: `Invoice ${invoice.number} came through SDI: its lines are what SDI delivered (only their kind and mapping change).` }])
}

/** payables.manage: a line added to a typed invoice. */
export function addLine(caller: CommandCaller, invoiceId: string, input: LineInput & { readonly version: number }, idempotencyKey?: string) {
  return lineCommand(caller, invoiceId, 'payables.addLine', input as unknown as { version: number } & Record<string, unknown>, idempotencyKey, async (tools, invoice) => {
    typedOnly(invoice)
    if (input.netAmount === undefined) throw refuse([{ path: 'body/netAmount', message: "The line's net amount, as printed." }])
    const lines = await readLines(tools.tx, invoiceId)
    if (lines.length >= PAYABLES_LIMITS.lines) throw refuse([{ path: 'body', message: `A supplier invoice has at most ${PAYABLES_LIMITS.lines} lines.` }])
    const mapping = await mappingOf(tools.tx, invoice, input, { kind: input.kind ?? 'GOODS', siteId: null, purchaseOrderLineId: null, subcontractOrderId: null }, 'body')
    const seq = lines.reduce((max, line) => Math.max(max, line.seq), 0) + 1
    const id = newId()
    await tools.tx.supplierInvoiceLine.create({ data: { id, partyId: invoice.partyId, invoiceId, ...lineData(input, mapping, { seq }), createdById: actorIdOf(tools) }, select: { id: true } })
    tools.audit({ action: 'payables.addLine', recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, after: { lineId: id, seq, kind: mapping.kind, description: input.description.trim(), figures: markMoney('cost', { netAmount: input.netAmount, unitPrice: input.unitPrice ?? null }), purchaseOrderLineId: mapping.purchaseOrderLineId, subcontractOrderId: mapping.subcontractOrderId } })
    return { fields: ['lines'], journal: true }
  })
}

/** payables.manage: a line's kind and mapping (any invoice while open); its figures (a typed invoice only). */
export function patchLine(caller: CommandCaller, invoiceId: string, lineId: string, input: LinePatch, idempotencyKey?: string) {
  return lineCommand(caller, invoiceId, 'payables.changeLine', { lineId, ...input } as unknown as { version: number } & Record<string, unknown>, idempotencyKey, async (tools, invoice) => {
    const line = isUuid(lineId) ? await tools.tx.supplierInvoiceLine.findUnique({ where: { id: lineId }, select: { id: true, invoiceId: true, kind: true, siteId: true, purchaseOrderLineId: true, subcontractOrderId: true, netAmount: true, unitPrice: true, description: true, seq: true } }) : null
    if (!line || line.invoiceId !== invoiceId) throw new NotFoundError('Line not found.')
    const figures = FIGURES.filter((field) => input[field] !== undefined)
    if (figures.length > 0) typedOnly(invoice)
    const mapping = await mappingOf(tools.tx, invoice, input, { kind: line.kind, siteId: line.siteId, purchaseOrderLineId: line.purchaseOrderLineId, subcontractOrderId: line.subcontractOrderId }, 'body')
    const data: Prisma.SupplierInvoiceLineUncheckedUpdateInput = {
      kind: mapping.kind,
      siteId: mapping.siteId,
      purchaseOrderLineId: mapping.purchaseOrderLineId,
      subcontractOrderId: mapping.subcontractOrderId,
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.itemCode !== undefined ? { itemCode: blank(input.itemCode) } : {}),
      ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      ...(input.uom !== undefined ? { uom: blank(input.uom) } : {}),
      ...(input.unitPrice !== undefined ? { unitPrice: input.unitPrice } : {}),
      ...(input.discountPct !== undefined ? { discountPct: input.discountPct } : {}),
      ...(input.netAmount !== undefined ? { netAmount: input.netAmount } : {}),
      ...(input.vatRatePct !== undefined ? { vatRatePct: input.vatRatePct } : {}),
      ...(input.vatNature !== undefined ? { vatNature: blank(input.vatNature) } : {}),
      version: { increment: 1 },
    }
    await tools.tx.supplierInvoiceLine.update({ where: { id: lineId }, data, select: { id: true } })
    const fields = [...figures, ...(input.kind !== undefined || input.purchaseOrderLineId !== undefined || input.subcontractOrderId !== undefined ? ['mapping'] : [])]
    tools.audit({
      action: 'payables.changeLine',
      recordType: RECORD,
      recordId: invoiceId,
      companyId: invoice.companyId,
      before: markMoney('cost', { lineId, seq: line.seq, kind: line.kind, purchaseOrderLineId: line.purchaseOrderLineId, subcontractOrderId: line.subcontractOrderId, netAmount: line.netAmount, unitPrice: line.unitPrice?.toString() ?? null }),
      after: markMoney('cost', { lineId, seq: line.seq, kind: mapping.kind, purchaseOrderLineId: mapping.purchaseOrderLineId, subcontractOrderId: mapping.subcontractOrderId, ...Object.fromEntries(figures.map((field) => [field, input[field] ?? null])) }),
    })
    return { fields: [`lines/${line.seq}`, ...fields], journal: figures.length > 0 }
  })
}

/** payables.manage: a typed invoice's line removed. */
export function removeLine(caller: CommandCaller, invoiceId: string, lineId: string, input: { readonly version: number }, idempotencyKey?: string) {
  return lineCommand(caller, invoiceId, 'payables.removeLine', { lineId, ...input }, idempotencyKey, async (tools, invoice) => {
    typedOnly(invoice)
    const line = isUuid(lineId) ? await tools.tx.supplierInvoiceLine.findUnique({ where: { id: lineId }, select: { id: true, invoiceId: true, seq: true, description: true, netAmount: true } }) : null
    if (!line || line.invoiceId !== invoiceId) throw new NotFoundError('Line not found.')
    await tools.tx.supplierInvoiceMatch.deleteMany({ where: { invoiceLineId: lineId } })
    await tools.tx.supplierInvoiceLine.delete({ where: { id: lineId }, select: { id: true } })
    tools.audit({ action: 'payables.removeLine', recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, before: { lineId, seq: line.seq, description: line.description, figures: markMoney('cost', { netAmount: line.netAmount }) } })
    return { fields: [`lines/${line.seq}`], journal: true }
  })
}

/** payables.manage: every goods or subcontract line without an order becomes a service ("an invoice without PO"). */
export function markWithoutOrder(caller: CommandCaller, invoiceId: string, input: { readonly version: number }, idempotencyKey?: string) {
  return lineCommand(caller, invoiceId, 'payables.changeLine', { ...input, withoutOrder: true }, idempotencyKey, async (tools, invoice) => {
    const lines = (await readLines(tools.tx, invoiceId)).filter((line: LineRow) => (line.kind === 'GOODS' || line.kind === 'SUBCONTRACT') && line.purchaseOrderLineId === null && line.subcontractOrderId === null)
    if (lines.length === 0) throw new RefusedError([{ code: 'NOTHING_UNMAPPED', message: 'Every goods line is on an order already.' }])
    await tools.tx.supplierInvoiceLine.updateMany({ where: { id: { in: lines.map((line) => line.id) } }, data: { kind: 'SERVICE', version: { increment: 1 } } })
    tools.audit({ action: 'payables.withoutOrder', recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, after: { lines: lines.map((line) => line.seq), kind: 'SERVICE' } })
    return { fields: ['mapping'], journal: false }
  })
}

/** payables.manage: the match done again now (the goods may have arrived, an order line changed). */
export async function matchAgain(caller: CommandCaller, invoiceId: string, input: { readonly version: number }, idempotencyKey?: string): Promise<{ invoice: DetailView }> {
  const { invoice: seen } = await officeInvoice(caller, invoiceId, PAYABLES_MANAGE)
  const held = actionProblems({ number: seen.number, status: seen.status as InvoiceStatus, source: seen.source as InvoiceSource }).map
  if (held) throw new RefusedError([{ code: 'NOT_OPEN', message: held }])
  const { result } = await command(caller, { name: 'payables.match', idempotencyKey, input: { invoiceId, ...input }, record: { type: 'SupplierInvoice', id: invoiceId, expectedVersion: input.version } }, async (tools) => {
    await rematchInCommand(tools, invoiceId, { announce: true })
    return { invoice: await detailInCommand(tools, invoiceId) }
  })
  return result
}

// ---- dispute, reopen, void ------------------------------------------------------------------------------------------------

async function stateCommand(
  caller: CommandCaller,
  invoiceId: string,
  name: 'payables.dispute' | 'payables.reopen' | 'payables.void',
  input: { readonly version: number; readonly reason?: string | undefined },
  idempotencyKey: string | undefined,
  move: (invoice: InvoiceRow) => { refusal: string | null; data: Prisma.SupplierInvoiceUncheckedUpdateInput; event: 'supplier_invoice.disputed' | 'supplier_invoice.reopened' | 'supplier_invoice.voided' },
): Promise<{ invoice: DetailView }> {
  const { invoice: seen } = await officeInvoice(caller, invoiceId, PAYABLES_MANAGE)
  const first = move(seen).refusal
  if (first) throw new RefusedError([{ code: 'NOT_ALLOWED_NOW', message: first }])
  const { result } = await command(caller, { name, idempotencyKey, input: { invoiceId, ...input }, record: { type: 'SupplierInvoice', id: invoiceId, expectedVersion: input.version } }, async (tools) => {
    const invoice = await invoiceInCommand(tools.tx, invoiceId)
    const planned = move(invoice)
    if (planned.refusal) throw new RefusedError([{ code: 'NOT_ALLOWED_NOW', message: planned.refusal }])
    await tools.tx.supplierInvoice.update({ where: { id: invoiceId }, data: planned.data, select: { id: true } })
    const after = await invoiceInCommand(tools.tx, invoiceId)
    tools.audit({ action: name, recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, ...(input.reason ? { reason: input.reason.trim() } : {}), before: { status: invoice.status }, after: { status: after.status } })
    tools.emit({ type: planned.event, subject: invoiceId, companyId: invoice.companyId, payload: { supplierInvoiceId: invoiceId, partyId: invoice.partyId, status: after.status, matchStatus: after.matchStatus } })
    return { invoice: await detailInCommand(tools, invoiceId) }
  })
  return result
}

/** payables.manage: disputed with the supplier ("Reject with reason": a credit note is asked). */
export function disputeInvoice(caller: CommandCaller, invoiceId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  return stateCommand(caller, invoiceId, 'payables.dispute', input, idempotencyKey, (invoice) => ({
    refusal: actionProblems({ number: invoice.number, status: invoice.status as InvoiceStatus, source: invoice.source as InvoiceSource }).dispute,
    data: { status: 'DISPUTED', disputedAt: now(), disputedById: context.actorId, disputeReason: input.reason.trim() },
    event: 'supplier_invoice.disputed',
  }))
}

/** payables.manage: a disputed invoice back to be matched and approved (the supplier answered). */
export function reopenInvoice(caller: CommandCaller, invoiceId: string, input: { readonly version: number; readonly reason?: string | undefined }, idempotencyKey?: string) {
  return stateCommand(caller, invoiceId, 'payables.reopen', input, idempotencyKey, (invoice) => ({
    refusal: actionProblems({ number: invoice.number, status: invoice.status as InvoiceStatus, source: invoice.source as InvoiceSource }).reopen,
    data: { status: 'RECEIVED', disputedAt: null, disputedById: null, disputeReason: null },
    event: 'supplier_invoice.reopened',
  }))
}

/** payables.manage: a typed invoice typed by mistake (or a duplicate) voided with a reason. */
export function voidInvoice(caller: CommandCaller, invoiceId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  return stateCommand(caller, invoiceId, 'payables.void', input, idempotencyKey, (invoice) => ({
    refusal: actionProblems({ number: invoice.number, status: invoice.status as InvoiceStatus, source: invoice.source as InvoiceSource }).void,
    data: { status: 'VOIDED', voidedAt: now(), voidReason: input.reason.trim(), disputedAt: null, disputedById: null, disputeReason: null },
    event: 'supplier_invoice.voided',
  }))
}

// ---- what a line may be mapped to ---------------------------------------------------------------------------------------

/** payables.view: the supplier's purchase order lines and subcontract orders of the invoice's company a line may bill. */
export async function mappingCandidates(caller: CommandCaller, invoiceId: string, query: { readonly q?: string | undefined }) {
  const { invoice } = await officeInvoice(caller, invoiceId, PAYABLES_VIEW)
  const q = blank(query.q)
  return caller.withClient(async (client) => {
    const lines = await client.purchaseOrderLine.findMany({
      where: {
        partyId: invoice.partyId,
        cancelledAt: null,
        purchaseOrder: { companyId: invoice.companyId, currency: invoice.currency, status: { in: ORDER_OPEN_TO_BILL as Prisma.EnumPurchaseOrderStatusFilter['in'] } },
        ...(q ? { OR: [{ purchaseOrder: { number: { contains: q, mode: 'insensitive' } } }, { item: { code: { contains: q, mode: 'insensitive' } } }, { item: { name: { contains: q, mode: 'insensitive' } } }, { supplierArticleCode: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      select: { id: true, seq: true, siteId: true, quantity: true, uom: true, supplierArticleCode: true, item: { select: { code: true, name: true } }, purchaseOrder: { select: { id: true, number: true, status: true, orderDate: true } } },
      orderBy: [{ purchaseOrder: { orderDate: 'desc' } }, { seq: 'asc' }],
      take: 100,
    })
    const orders = await client.subcontractOrder.findMany({
      where: { partyId: invoice.partyId, companyId: invoice.companyId, currency: invoice.currency, status: { in: SUBCONTRACT_OPEN_TO_BILL as Prisma.EnumSubcontractOrderStatusFilter['in'] }, ...(q ? { number: { contains: q, mode: 'insensitive' } } : {}) },
      select: { id: true, number: true, siteId: true, status: true, workOrderId: true, orderDate: true },
      orderBy: { orderDate: 'desc' },
      take: 50,
    })
    return {
      purchaseOrderLines: lines.map((line) => ({ id: line.id, orderId: line.purchaseOrder.id, orderNumber: line.purchaseOrder.number, orderStatus: line.purchaseOrder.status, seq: line.seq, siteId: line.siteId, item: line.item, supplierArticleCode: line.supplierArticleCode, quantity: line.quantity.toString(), uom: line.uom })),
      subcontractOrders: orders.map((order) => ({ id: order.id, number: order.number, status: order.status, siteId: order.siteId, workOrderId: order.workOrderId })),
    }
  })
}

