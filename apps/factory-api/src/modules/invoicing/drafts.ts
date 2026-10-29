import type { Prisma } from '@nexus/factory-db'
import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { depositInvoiceDraft, depositTreatment } from '@nexus/factory-domain/invoicing/deposit'
import { computeInvoiceTotals, lineProblems, MAX_INVOICE_LINES, storedVatOf, treatmentOf, type CoreLine, type InvoiceDocType, type InvoiceTotals } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_MANAGE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { STANDARD_VAT_RATE } from '@nexus/factory-domain/tax/vat-rates'
import { decideVatTreatment, type CustomerTaxProfile, type VatTreatment } from '@nexus/factory-domain/tax/vat-treatment'
import { TaxRuleError } from '@nexus/factory-domain/tax/rules'
import type { PriceBasis } from '@nexus/factory-domain/tax/vat-summary'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { serverClock } from '../../core/time'
import { billToFrom, depositInvoicedGross, partyFacts, paymentTermsOf } from './facts'
import { assertMay, invoiceDetail, officeContextOf, officeInvoice, readInvoice, type InvoiceDetail, type InvoiceRow } from './store'

/**
 * Draft invoices (B-W1-28 invoice core; FIN-054, FIN-061, FIN-098, FIN-099): create one (generic TD01/TD24, or a TD02
 * from a deposit request's paid amount), change its text and lines, delete it. Every change of a draft recomputes its
 * totals from its lines (factory-domain invoicing computeInvoiceTotals) and refreshes its billTo from the buyer's tax
 * identity in force today; a line without its own VAT gets the treatment the VAT rules decide for the buyer (FIN-098:
 * Italian VAT, or N3.2 to an EU business with a VIES proof, N3.1 for an export). Each write is ONE command on the
 * Invoice (its version is the edit-conflict guard and its bump locks the row); only a DRAFT changes (the database
 * refuses the rest: DPR 633/1972 art. 26).
 */

export interface LineInput {
  readonly kind?: 'GOODS' | 'SERVICE' | undefined
  readonly description: string
  readonly itemCode?: string | null | undefined
  readonly quantity: string
  readonly uom?: string | null | undefined
  readonly unitPrice?: string | undefined
  readonly discountPct?: string | null | undefined
  /** The VAT, when not the one the rules decide: a rate ("22"), or a Natura with its law. */
  readonly vatRatePct?: string | undefined
  readonly vatNature?: string | null | undefined
  readonly vatLegalRef?: string | null | undefined
  readonly salesOrderLineId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly ddtId?: string | null | undefined
}

export interface PaymentInput {
  /** ModalitaPagamento: MP05 bank transfer (the default), MP01 cash, MP12 Ri.Ba.… */
  readonly method?: string | undefined
  readonly dueDate?: string | null | undefined
  readonly iban?: string | null | undefined
}

interface PreparedLine {
  readonly core: CoreLine
  readonly salesOrderLineId: string | null
  readonly size: string | null
  readonly ddtId: string | null
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The VAT the rules decide for this buyer and kind of supply (FIN-098). */
function decidedVat(profile: CustomerTaxProfile | null, kind: 'GOODS' | 'SERVICE', path: string): VatTreatment | Issue {
  if (profile === null) return { path, message: "The customer has no tax identity in force: give the line its VAT, or add the customer's tax identity." }
  try {
    return decideVatTreatment({ customer: profile, supply: kind === 'SERVICE' ? 'SERVICES' : 'GOODS', rate: STANDARD_VAT_RATE, goodsLeaveEu: true }).treatment
  } catch (error) {
    if (error instanceof TaxRuleError) return { path, message: error.message }
    throw error
  }
}

const isIssue = (value: VatTreatment | Issue): value is Issue => 'path' in value

/** The lines of a request as the core computes them, with every problem (400). */
export function prepareLines(lines: readonly LineInput[], profile: CustomerTaxProfile | null, path = 'body/lines'): PreparedLine[] {
  const issues: Issue[] = []
  if (lines.length > MAX_INVOICE_LINES) issues.push({ path, message: `At most ${MAX_INVOICE_LINES} lines.` })
  const prepared = lines.map((line, index): PreparedLine | null => {
    const at = `${path}/${index}`
    const kind = line.kind ?? 'GOODS'
    if (line.unitPrice === undefined) {
      issues.push({ path: `${at}/unitPrice`, message: 'Send the unit price.' })
      return null
    }
    let vat: VatTreatment | Issue
    if (line.vatRatePct !== undefined || line.vatNature !== undefined) {
      const stored = { vatRatePct: line.vatRatePct ?? '0', vatNature: blankToNull(line.vatNature), vatLegalRef: blankToNull(line.vatLegalRef) }
      vat = treatmentOf(stored) ?? { path: `${at}/vatRatePct`, message: 'A VAT rate of 22, 10, 5 or 4, or 0 with its Natura (N1 … N7) and the law that says why.' }
    } else {
      vat = decidedVat(profile, kind, `${at}/vatRatePct`)
    }
    if (isIssue(vat)) {
      issues.push(vat)
      return null
    }
    const core: CoreLine = {
      kind,
      description: line.description.trim(),
      itemCode: blankToNull(line.itemCode),
      quantity: line.quantity,
      uom: blankToNull(line.uom),
      unitPrice: line.unitPrice,
      discountPct: blankToNull(line.discountPct),
      vat,
    }
    issues.push(...lineProblems(core, at))
    return { core, salesOrderLineId: line.salesOrderLineId ?? null, size: blankToNull(line.size), ddtId: line.ddtId ?? null }
  })
  if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'These lines cannot be saved.', issues)
  return prepared as PreparedLine[]
}

/** The order lines and DDTs the lines name must be the buyer's (and the company's, and the order's when it names one). */
async function checkSources(db: CommandTx, invoice: { companyId: string; buyerPartyId: string; salesOrderId: string | null }, lines: readonly PreparedLine[], path = 'body/lines'): Promise<void> {
  const issues: Issue[] = []
  for (const [index, line] of lines.entries()) {
    if (line.salesOrderLineId) {
      const row = isUuid(line.salesOrderLineId) ? await db.salesOrderLine.findUnique({ where: { id: line.salesOrderLineId }, select: { partyId: true, companyId: true, orderId: true } }) : null
      if (!row || row.partyId !== invoice.buyerPartyId || row.companyId !== invoice.companyId || (invoice.salesOrderId !== null && row.orderId !== invoice.salesOrderId)) {
        issues.push({ path: `${path}/${index}/salesOrderLineId`, message: "Not a line of this customer's order." })
      }
    }
    if (line.ddtId) {
      const row = isUuid(line.ddtId) ? await db.ddt.findUnique({ where: { id: line.ddtId }, select: { partyId: true, companyId: true } }) : null
      if (!row || row.partyId !== invoice.buyerPartyId || row.companyId !== invoice.companyId) issues.push({ path: `${path}/${index}/ddtId`, message: "Not a DDT of this customer and company." })
    }
  }
  if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'These lines name documents of another customer.', issues)
}

/** Invoice.paymentTerms for a total: one instalment of the whole amount (TP02), or none. */
export function termsFor(payment: PaymentInput | null, gross: number): Prisma.InputJsonValue | null {
  if (payment === null) return null
  return {
    condition: 'TP02',
    installments: [{ method: payment.method ?? 'MP05', amount: gross, ...(payment.dueDate ? { dueDate: payment.dueDate } : {}), ...(payment.iban ? { iban: payment.iban.replace(/\s+/g, '').toUpperCase() } : {}) }],
  }
}

/** The payment terms of an invoice as the input that made them (to rebuild them for a new total). */
function paymentInputOf(stored: unknown): PaymentInput | null {
  const terms = paymentTermsOf(stored)
  const first = terms?.installments[0]
  return first ? { method: first.method, dueDate: first.dueDate ?? null, iban: first.iban ?? null } : null
}

/** The totals columns of an invoice row. */
const totalsData = (totals: InvoiceTotals) => ({
  netTotal: totals.netTotal,
  vatTotal: totals.vatTotal,
  grossTotal: totals.grossTotal,
  vatSummary: totals.vatSummary as unknown as Prisma.InputJsonValue,
  stampDutyAmount: totals.stampDutyAmount,
})

/** Replaces the draft's lines (inside the draft's command), with their computed amounts. */
async function writeLines(tools: CommandTools, invoice: { id: string; buyerPartyId: string }, lines: readonly PreparedLine[], totals: InvoiceTotals): Promise<void> {
  await tools.tx.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } })
  for (const [index, line] of lines.entries()) {
    const amounts = totals.lines[index]!
    const vat = storedVatOf(line.core.vat)
    await tools.tx.invoiceLine.create({
      data: {
        id: newId(),
        invoiceId: invoice.id,
        buyerPartyId: invoice.buyerPartyId,
        seq: index + 1,
        kind: line.core.kind,
        description: line.core.description,
        itemCode: line.core.itemCode ?? null,
        quantity: line.core.quantity,
        uom: line.core.uom ?? null,
        unitPrice: line.core.unitPrice,
        discountPct: line.core.discountPct ?? null,
        netAmount: amounts.netAmount,
        grossAmount: amounts.grossAmount,
        vatRatePct: vat.vatRatePct,
        vatNature: vat.vatNature,
        vatLegalRef: vat.vatLegalRef,
        salesOrderLineId: line.salesOrderLineId,
        size: line.size,
        ddtId: line.ddtId,
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
  }
}

const auditedTotals = (totals: Pick<InvoiceTotals, 'netTotal' | 'vatTotal' | 'grossTotal'>) => ({
  netTotal: markMoney('price', totals.netTotal),
  vatTotal: markMoney('price', totals.vatTotal),
  grossTotal: markMoney('price', totals.grossTotal),
})

// ---- create ---------------------------------------------------------------------------------------------------------

export interface CreateDraftInput {
  readonly companyId: string
  readonly buyerPartyId: string
  readonly docType: 'TD01' | 'TD24'
  readonly priceBasis?: PriceBasis | undefined
  readonly salesOrderId?: string | null | undefined
  readonly causale?: string | null | undefined
  readonly documentRefs?: readonly { readonly number: string; readonly date?: string | null | undefined }[] | undefined
  readonly payment?: PaymentInput | null | undefined
  readonly internalNote?: string | null | undefined
  readonly lines: readonly LineInput[]
}

/** The new draft's row and lines, inside a command (the generic route and the deposit flows). */
export async function insertDraft(
  tools: CommandTools,
  draft: { id: string; companyId: string; buyerPartyId: string; docType: InvoiceDocType; priceBasis: PriceBasis; currency: string; salesOrderId: string | null; depositRequestId: string | null; causale: string | null; documentRefs: Prisma.InputJsonValue | null; payment: PaymentInput | null; internalNote: string | null },
  lines: readonly PreparedLine[],
): Promise<InvoiceTotals> {
  const totals = computeInvoiceTotals(lines.map((line) => line.core), draft.priceBasis, draft.currency)
  const facts = await partyFacts(tools.tx, draft.buyerPartyId, businessDate(tools.now), tools.now)
  const billTo = facts ? billToFrom(facts).billTo : null
  const terms = termsFor(draft.payment, totals.grossTotal)
  await tools.tx.invoice.create({
    data: {
      id: draft.id,
      companyId: draft.companyId,
      buyerPartyId: draft.buyerPartyId,
      docType: draft.docType,
      priceBasis: draft.priceBasis,
      currency: draft.currency,
      billTo: (billTo ?? {}) as Prisma.InputJsonValue,
      ...totalsData(totals),
      ...(terms === null ? {} : { paymentTerms: terms }),
      causale: draft.causale,
      ...(draft.documentRefs === null ? {} : { documentRefs: draft.documentRefs }),
      salesOrderId: draft.salesOrderId,
      depositRequestId: draft.depositRequestId,
      internalNote: draft.internalNote,
      createdById: actorIdOf(tools),
    },
    select: { id: true },
  })
  await writeLines(tools, { id: draft.id, buyerPartyId: draft.buyerPartyId }, lines, totals)
  tools.audit({
    action: 'invoices.createDraft',
    recordType: 'Invoice',
    recordId: draft.id,
    companyId: draft.companyId,
    after: { docType: draft.docType, status: 'DRAFT', buyerPartyId: draft.buyerPartyId, basis: draft.priceBasis, depositRequestId: draft.depositRequestId, salesOrderId: draft.salesOrderId, lines: lines.length, ...auditedTotals(totals) },
  })
  tools.emit({ type: 'invoice.draft_saved', subject: draft.id, companyId: draft.companyId, payload: { invoiceId: draft.id, docType: draft.docType, created: true } })
  return totals
}

const refsJson = (refs: CreateDraftInput['documentRefs']): Prisma.InputJsonValue | null =>
  refs === undefined || refs.length === 0 ? null : refs.map((ref) => ({ kind: 'PURCHASE_ORDER', number: ref.number.trim(), ...(ref.date ? { date: ref.date } : {}) }))

/** invoices.manage: a generic draft (TD01, TD24) for a customer of a company, with its first lines. */
export async function createDraft(caller: CommandCaller, body: CreateDraftInput, idempotencyKey?: string): Promise<{ invoice: InvoiceDetail }> {
  const context = officeContextOf(caller)
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, { companyId: body.companyId, partyId: body.buyerPartyId }, 'Customer')
  const plan = await caller.withClient(async (client) => {
    const [company, party] = [await client.company.findUnique({ where: { id: body.companyId }, select: { id: true, currency: true } }), await client.party.findUnique({ where: { id: body.buyerPartyId }, select: { id: true, companyId: true, status: true } })]
    if (!company) throw new NotFoundError('Company not found.')
    if (!party || (party.companyId !== null && party.companyId !== company.id)) throw new NotFoundError('Customer not found.')
    if (body.salesOrderId) {
      const order = isUuid(body.salesOrderId) ? await client.salesOrder.findUnique({ where: { id: body.salesOrderId }, select: { companyId: true, partyId: true } }) : null
      if (!order || order.companyId !== body.companyId || order.partyId !== body.buyerPartyId) throw new ValidationError('Not an order of this customer and company.', [{ path: 'body/salesOrderId', message: 'Expected an order of this customer and company.' }])
    }
    const facts = await partyFacts(client, body.buyerPartyId, businessDate(serverClock.now()), serverClock.now())
    return { currency: company.currency, profile: facts?.profile ?? null }
  })
  const lines = prepareLines(body.lines, plan.profile)
  const { result } = await command(caller, { name: 'invoices.createDraft', idempotencyKey, input: body }, async (tools) => {
    const id = newId()
    await checkSources(tools.tx, { companyId: body.companyId, buyerPartyId: body.buyerPartyId, salesOrderId: body.salesOrderId ?? null }, lines)
    await insertDraft(
      tools,
      {
        id,
        companyId: body.companyId,
        buyerPartyId: body.buyerPartyId,
        docType: body.docType,
        priceBasis: body.priceBasis ?? 'NET',
        currency: plan.currency,
        salesOrderId: body.salesOrderId ?? null,
        depositRequestId: null,
        causale: blankToNull(body.causale),
        documentRefs: refsJson(body.documentRefs),
        payment: body.payment ?? null,
        internalNote: blankToNull(body.internalNote),
      },
      lines,
    )
    return { invoice: await invoiceDetail(tools.tx, (await readInvoice(tools.tx, id))!) }
  })
  return result
}

// ---- the deposit invoice draft ------------------------------------------------------------------------------------

/** What a deposit request still has paid and not invoiced (its allocations less its issued TD02s), and when it was paid. */
export async function depositNotInvoiced(db: CommandTx, depositRequestId: string): Promise<{ paid: number; invoiced: number; lastPaidOn: string | null }> {
  const allocations = await db.paymentAllocation.findMany({ where: { depositRequestId }, select: { amount: true, payment: { select: { receivedOn: true } } } })
  const paid = allocations.reduce((sum, row) => sum + row.amount, 0)
  const lastPaidOn = allocations.filter((row) => row.amount > 0).map((row) => row.payment.receivedOn.toISOString().slice(0, 10)).sort().at(-1) ?? null
  return { paid, invoiced: await depositInvoicedGross(db, depositRequestId, null), lastPaidOn }
}

/**
 * Inside a command: the TD02 draft of `amount` (VAT included) for a deposit request, paid on `paidOn`, taxed as its
 * goods are for the buyer (factory-domain invoicing/deposit). Returns its id.
 */
export async function insertDepositDraft(tools: CommandTools, request: { id: string; companyId: string; partyId: string; currency: string; depositPct: string | null; orderId: string | null }, amount: number, paidOn: string): Promise<string> {
  const facts = await partyFacts(tools.tx, request.partyId, businessDate(tools.now), tools.now)
  const treatment = facts?.profile ? depositTreatment(facts.profile) : { problem: 'The customer has no tax identity in force: add it before the deposit invoice.' }
  if ('problem' in treatment) throw new DomainError('conflict', treatment.problem, [{ path: 'party/taxIdentity', message: treatment.problem }])
  const order = request.orderId ? await tools.tx.salesOrder.findUnique({ where: { id: request.orderId }, select: { number: true, orderDate: true, customerRef: true } }) : null
  const draft = depositInvoiceDraft({ amount, currency: request.currency, treatment: treatment.treatment, paidOn, depositPct: request.depositPct, order: order ? { number: order.number, date: order.orderDate.toISOString().slice(0, 10) } : null })
  const id = newId()
  await insertDraft(
    tools,
    {
      id,
      companyId: request.companyId,
      buyerPartyId: request.partyId,
      docType: 'TD02',
      priceBasis: draft.priceBasis,
      currency: request.currency,
      salesOrderId: request.orderId,
      depositRequestId: request.id,
      causale: draft.causale,
      documentRefs: order?.customerRef ? [{ kind: 'PURCHASE_ORDER', number: order.customerRef }] : null,
      payment: null,
      internalNote: null,
    },
    draft.lines.map((core) => ({ core, salesOrderLineId: null, size: null, ddtId: null })),
  )
  return id
}

const REQUEST_SELECT = { id: true, companyId: true, partyId: true, currency: true, amount: true, status: true, fiscalDocument: true, fiscalRule: true, depositPct: true, orderId: true } as const

export async function readDepositRequest(db: CommandTx, depositRequestId: string) {
  if (!isUuid(depositRequestId)) return null
  const row = await db.depositRequest.findUnique({ where: { id: depositRequestId }, select: REQUEST_SELECT })
  return row ? { ...row, depositPct: row.depositPct === null ? null : row.depositPct.toFixed(4) } : null
}

/**
 * invoices.manage: the TD02 draft of what a deposit request has been paid and not yet invoiced (a payment recorded
 * without its deposit invoice; A2 SCR-080 "Deposit invoice (TD02)"). Issued like any draft.
 */
export async function createDepositDraft(caller: CommandCaller, body: { depositRequestId: string }, idempotencyKey?: string): Promise<{ invoice: InvoiceDetail }> {
  const context = officeContextOf(caller)
  const request = await caller.withClient((client) => readDepositRequest(client, body.depositRequestId))
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, request ? { companyId: request.companyId, partyId: request.partyId } : null, 'Deposit request')
  if (request!.fiscalDocument !== 'TD02') throw new InvalidStateError(`The deposit request needs no deposit invoice (rule ${request!.fiscalRule}).`)
  const { result } = await command(caller, { name: 'invoices.createDepositDraft', idempotencyKey, input: body }, async (tools) => {
    const current = (await readDepositRequest(tools.tx, body.depositRequestId))!
    if (current.status !== 'OPEN' && current.status !== 'PAID') throw new InvalidStateError(`The deposit request is ${current.status}; a deposit invoice is for an OPEN or PAID request.`)
    const { paid, invoiced, lastPaidOn } = await depositNotInvoiced(tools.tx, current.id)
    const drafts = await tools.tx.invoice.count({ where: { depositRequestId: current.id, status: 'DRAFT' } })
    if (drafts > 0) throw new DomainError('conflict', 'This deposit request has a draft deposit invoice already: issue or delete it first.')
    if (paid - invoiced <= 0 || lastPaidOn === null) throw new DomainError('conflict', 'Nothing paid on this deposit request is waiting for a deposit invoice.')
    const id = await insertDepositDraft(tools, current, paid - invoiced, lastPaidOn)
    return { invoice: await invoiceDetail(tools.tx, (await readInvoice(tools.tx, id))!) }
  })
  return result
}

// ---- change a draft -------------------------------------------------------------------------------------------------

/** A command on a DRAFT invoice: its version guards it and locks its row; refused (409) once it is issued. */
async function onDraft<Result>(caller: CommandCaller, invoice: InvoiceRow, spec: { name: `invoices.${string}`; idempotencyKey: string | undefined; input: unknown; version: number | undefined }, work: (tools: CommandTools, current: InvoiceRow) => Promise<Result>): Promise<Result> {
  const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: spec.input, record: { type: 'Invoice', id: invoice.id, ...(spec.version === undefined ? {} : { expectedVersion: spec.version }) } }, async (tools) => {
    const current = (await readInvoice(tools.tx, invoice.id))!
    if (current.status !== 'DRAFT') throw new InvalidStateError(`The invoice is ${current.status} (number ${current.number}); an issued invoice never changes: a credit note corrects it (DPR 633/1972 art. 26).`)
    return work(tools, current)
  })
  return result
}

/** Recomputes a draft's totals, payment terms and billTo after its lines or basis changed. */
async function refreshDraft(tools: CommandTools, current: InvoiceRow, lines: readonly PreparedLine[], basis: PriceBasis, payment: PaymentInput | null): Promise<InvoiceTotals> {
  const totals = computeInvoiceTotals(lines.map((line) => line.core), basis, current.currency)
  const facts = await partyFacts(tools.tx, current.buyerPartyId, businessDate(tools.now), tools.now)
  const billTo = facts ? billToFrom(facts).billTo : null
  const terms = termsFor(payment, totals.grossTotal)
  await writeLines(tools, current, lines, totals)
  await tools.tx.invoice.update({
    where: { id: current.id },
    data: { priceBasis: basis, ...totalsData(totals), ...(terms === null ? {} : { paymentTerms: terms }), billTo: (billTo ?? {}) as Prisma.InputJsonValue },
    select: { id: true },
  })
  // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
  if (terms === null && current.paymentTerms !== null) await tools.tx.$executeRaw`UPDATE "Invoice" SET "paymentTerms" = NULL WHERE "id" = ${current.id}::uuid`
  return totals
}

/** invoices.manage: replaces a draft's lines (the totals follow). */
export async function replaceLines(caller: CommandCaller, invoiceId: string, body: { version?: number | undefined; lines: readonly LineInput[] }, idempotencyKey?: string): Promise<{ invoice: InvoiceDetail }> {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_MANAGE)
  const profile = await caller.withClient(async (client) => (await partyFacts(client, invoice.buyerPartyId, businessDate(serverClock.now()), serverClock.now()))?.profile ?? null)
  const lines = prepareLines(body.lines, profile)
  return onDraft(caller, invoice, { name: 'invoices.replaceLines', idempotencyKey, input: { invoiceId, ...body }, version: body.version }, async (tools, current) => {
    await checkSources(tools.tx, current, lines)
    const totals = await refreshDraft(tools, current, lines, current.priceBasis, paymentInputOf(current.paymentTerms))
    tools.audit({ recordType: 'Invoice', recordId: current.id, companyId: current.companyId, before: auditedTotals(current), after: { lines: lines.length, ...auditedTotals(totals) } })
    tools.emit({ type: 'invoice.draft_saved', subject: current.id, companyId: current.companyId, payload: { invoiceId: current.id, docType: current.docType, created: false } })
    return { invoice: await invoiceDetail(tools.tx, (await readInvoice(tools.tx, current.id))!) }
  })
}

export interface UpdateDraftInput {
  readonly version?: number | undefined
  readonly priceBasis?: PriceBasis | undefined
  readonly causale?: string | null | undefined
  readonly documentRefs?: CreateDraftInput['documentRefs'] | null
  readonly payment?: PaymentInput | null | undefined
  readonly internalNote?: string | null | undefined
}

/** invoices.manage: a draft's text, references, payment terms and price basis (the totals follow a new basis). */
export async function updateDraft(caller: CommandCaller, invoiceId: string, body: UpdateDraftInput, idempotencyKey?: string): Promise<{ invoice: InvoiceDetail }> {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_MANAGE)
  return onDraft(caller, invoice, { name: 'invoices.updateDraft', idempotencyKey, input: { invoiceId, ...body }, version: body.version }, async (tools, current) => {
    const rows = await tools.tx.invoiceLine.findMany({ where: { invoiceId: current.id }, orderBy: { seq: 'asc' }, select: { kind: true, description: true, itemCode: true, quantity: true, uom: true, unitPrice: true, discountPct: true, vatRatePct: true, vatNature: true, vatLegalRef: true, salesOrderLineId: true, size: true, ddtId: true, netAmount: true, grossAmount: true } })
    const lines: PreparedLine[] = rows.map((row) => ({
      core: {
        kind: row.kind,
        description: row.description,
        itemCode: row.itemCode,
        quantity: row.quantity.toFixed(4),
        uom: row.uom,
        unitPrice: row.unitPrice.toFixed(6),
        discountPct: row.discountPct === null ? null : row.discountPct.toFixed(4),
        vat: treatmentOf({ vatRatePct: row.vatRatePct.toFixed(2), vatNature: row.vatNature, vatLegalRef: row.vatLegalRef })!,
        deduction: row.kind === 'DEPOSIT_DEDUCTION' ? { netAmount: row.netAmount, grossAmount: row.grossAmount ?? row.netAmount } : null,
      },
      salesOrderLineId: row.salesOrderLineId,
      size: row.size,
      ddtId: row.ddtId,
    }))
    const payment = body.payment === undefined ? paymentInputOf(current.paymentTerms) : body.payment
    const totals = await refreshDraft(tools, current, lines, body.priceBasis ?? current.priceBasis, payment)
    const data: Prisma.InvoiceUncheckedUpdateInput = {
      ...(body.causale !== undefined ? { causale: blankToNull(body.causale) } : {}),
      ...(body.documentRefs !== undefined && refsJson(body.documentRefs ?? undefined) !== null ? { documentRefs: refsJson(body.documentRefs ?? undefined)! } : {}),
      ...(body.internalNote !== undefined ? { internalNote: blankToNull(body.internalNote) } : {}),
    }
    if (Object.keys(data).length > 0) await tools.tx.invoice.update({ where: { id: current.id }, data, select: { id: true } })
    if (body.documentRefs !== undefined && refsJson(body.documentRefs ?? undefined) === null) await tools.tx.$executeRaw`UPDATE "Invoice" SET "documentRefs" = NULL WHERE "id" = ${current.id}::uuid`
    tools.audit({
      recordType: 'Invoice',
      recordId: current.id,
      companyId: current.companyId,
      before: { basis: current.priceBasis, causale: current.causale, internalNote: current.internalNote, ...auditedTotals(current) },
      after: { basis: body.priceBasis ?? current.priceBasis, causale: body.causale === undefined ? current.causale : blankToNull(body.causale), internalNote: body.internalNote === undefined ? current.internalNote : blankToNull(body.internalNote), ...auditedTotals(totals) },
    })
    tools.emit({ type: 'invoice.draft_saved', subject: current.id, companyId: current.companyId, payload: { invoiceId: current.id, docType: current.docType, created: false } })
    return { invoice: await invoiceDetail(tools.tx, (await readInvoice(tools.tx, current.id))!) }
  })
}

/** invoices.manage: deletes a draft and its lines (it has no number: no gap). An issued invoice is never deleted. */
export async function deleteDraft(caller: CommandCaller, invoiceId: string, query: { version?: number | undefined }, idempotencyKey?: string): Promise<{ deleted: true; id: string }> {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_MANAGE)
  return onDraft(caller, invoice, { name: 'invoices.deleteDraft', idempotencyKey, input: { invoiceId, ...query }, version: query.version }, async (tools, current) => {
    await tools.tx.invoiceLine.deleteMany({ where: { invoiceId: current.id } })
    await tools.tx.invoice.delete({ where: { id: current.id }, select: { id: true } })
    tools.audit({ recordType: 'Invoice', recordId: current.id, companyId: current.companyId, before: { docType: current.docType, status: 'DRAFT', buyerPartyId: current.buyerPartyId, ...auditedTotals(current) } })
    tools.emit({ type: 'invoice.draft_deleted', subject: current.id, companyId: current.companyId, payload: { invoiceId: current.id, docType: current.docType } })
    return { deleted: true as const, id: current.id }
  })
}

