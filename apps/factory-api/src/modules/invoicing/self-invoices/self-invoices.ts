import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { fromMinorUnits } from '@nexus/factory-domain/core/money'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { INVOICES_MANAGE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import {
  deadlineStateOf,
  integrationLines,
  KIND_WORDS,
  refusalWords,
  selfInvoiceCausale,
  selfInvoiceDeadline,
  selfInvoiceProblems,
  SELF_INVOICE_RULE,
  suggestedKind,
  waitsWords,
  DEFAULT_INTEGRATION_RATE,
  type SelfInvoiceKind,
  type SelfInvoiceStatus,
} from '@nexus/factory-domain/invoicing/self-invoices/self-invoices'
import { convertMinor } from '@nexus/factory-domain/money/currency/convert'
import { EURO } from '@nexus/factory-domain/money/currency/currencies'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { dayRate, noRateWords } from '../../../platform/currency/service'
import { insertDraft, prepareLines, type LineInput } from '../drafts'
import { partyFacts } from '../facts'
import { assertMay, officeContextOf, type Reader } from '../store'
import { readSettings } from '../test-mode/store'
import { refusedDepth, refusingDepth } from '../test-mode/refusals'

/**
 * Self-invoices for foreign purchases (B-W2b-401; FIN-095; design finance.payables section "Self-invoices" and "Create from
 * the supplier invoice"; factory-db tax.prisma SelfInvoice): the list with each one's deadline (no money: the design's), the
 * supplier invoices that may need one with the kind they suggest, making one (ONE command: the SelfInvoice PENDING and its
 * Invoice draft of type TD17/TD18/TD19 to the supplier, in euro at the rate of the supplier invoice's date, at the Italian rate
 * given or 22 %), and cancelling one (its draft deleted with it). It is issued through POST /invoicing/invoices/:id/issue
 * (step-up; its SELF_INVOICE series) and sent to SDI as any invoice; the issue marks it ISSUED (hooks.ts). Everything waits for
 * the company's switch `selfInvoicesOn` at the issue (GATE-ACCOUNTANT; drafts are free, nothing reaches SDI). Reads are
 * invoices.view, writes invoices.manage, both on the company and the supplier; a supplier invoice is read with payables.view.
 */

const LIST_MAX = 500

const SELF_COLUMNS = {
  id: true,
  version: true,
  companyId: true,
  partyId: true,
  supplierInvoiceId: true,
  kind: true,
  deadline: true,
  status: true,
  invoiceId: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  supplierInvoice: { select: { number: true, issueDate: true, receivedOn: true } },
  invoice: { select: { id: true, docType: true, status: true, number: true, issueDate: true } },
} as const satisfies Prisma.SelfInvoiceSelect
type SelfRow = Prisma.SelfInvoiceGetPayload<{ select: typeof SELF_COLUMNS }>

const day = (value: Date): string => value.toISOString().slice(0, 10)

async function viewOf(db: Reader, row: SelfRow, context: OfficeContext, today: string) {
  const party = await db.party.findUnique({ where: { id: row.partyId }, select: { code: true, legalName: true } })
  const on = (await readSettings(db, row.companyId)).selfInvoicesOn
  const scope = { companyId: row.companyId, partyId: row.partyId }
  const status = row.status as SelfInvoiceStatus
  return {
    id: row.id,
    version: row.version,
    companyId: row.companyId,
    partyId: row.partyId,
    supplier: party ?? { code: '', legalName: '' },
    supplierInvoice: { id: row.supplierInvoiceId, number: row.supplierInvoice.number, issueDate: day(row.supplierInvoice.issueDate), receivedOn: day(row.supplierInvoice.receivedOn) },
    kind: row.kind as SelfInvoiceKind,
    kindWords: KIND_WORDS[row.kind as SelfInvoiceKind],
    deadline: day(row.deadline),
    deadlineState: deadlineStateOf(day(row.deadline), today, status),
    status,
    invoice: row.invoice ? { id: row.invoice.id, docType: row.invoice.docType, status: row.invoice.status, number: row.invoice.number, issueDate: row.invoice.issueDate ? day(row.invoice.issueDate) : null } : null,
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    waits: waitsWords(on, 'SELF_INVOICES'),
    can: {
      // A pending self-invoice recorded without its draft: POST /invoicing/self-invoices makes it.
      draft: status === 'PENDING' && row.invoice === null && can(actorOf(context), INVOICES_MANAGE, scope),
      cancel: status === 'PENDING' && can(actorOf(context), INVOICES_MANAGE, scope),
      issue: status === 'PENDING' && on && row.invoice?.status === 'DRAFT' && can(actorOf(context), 'invoices.issue', scope),
    },
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The supplier invoice a self-invoice is about, when the caller may read it (payables.view) and see costs; else 404. */
async function readSupplierInvoice(caller: CommandCaller, context: OfficeContext, supplierInvoiceId: string) {
  const row = isUuid(supplierInvoiceId)
    ? await caller.withClient((client) =>
        client.supplierInvoice.findUnique({
          where: { id: supplierInvoiceId },
          select: { id: true, companyId: true, partyId: true, status: true, kind: true, number: true, issueDate: true, receivedOn: true, currency: true, netTotal: true, party: { select: { legalName: true, country: true } }, lines: { select: { kind: true, description: true, netAmount: true }, orderBy: { seq: 'asc' } } },
        }),
      )
    : null
  const scope = row ? { companyId: row.companyId, partyId: row.partyId } : null
  if (!row || !scope || !can(actorOf(context), 'payables.view', scope) || !can(actorOf(context), 'money.cost', scope)) throw new NotFoundError('Supplier invoice not found.')
  return row
}

/** invoices.view: a company's self-invoices (of the suppliers the caller sees), soonest deadline first. */
export async function listSelfInvoices(caller: CommandCaller, query: { companyId: string; status?: SelfInvoiceStatus | undefined }) {
  const context = officeContextOf(caller)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const where: Prisma.SelfInvoiceWhereInput = { AND: [{ companyId: query.companyId }, query.status ? { status: query.status } : {}, scopeWhere(actorOf(context), INVOICES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SelfInvoiceWhereInput] }
    const rows = await client.selfInvoice.findMany({ where, select: SELF_COLUMNS, orderBy: [{ deadline: 'asc' }, { id: 'asc' }], take: LIST_MAX })
    const on = (await readSettings(client, query.companyId)).selfInvoicesOn
    const views = []
    for (const row of rows) views.push(await viewOf(client, row, context, today))
    return { companyId: query.companyId, selfInvoices: views, selfInvoicesOn: on, waits: waitsWords(on, 'SELF_INVOICES'), rule: SELF_INVOICE_RULE }
  })
}

/** invoices.view: one self-invoice. */
export async function getSelfInvoice(caller: CommandCaller, selfInvoiceId: string) {
  const context = officeContextOf(caller)
  const row = isUuid(selfInvoiceId) ? await caller.withClient((client) => client.selfInvoice.findUnique({ where: { id: selfInvoiceId }, select: SELF_COLUMNS })) : null
  assertMay(context, INVOICES_VIEW, INVOICES_VIEW, row ? { companyId: row.companyId, partyId: row.partyId } : null, 'Self-invoice')
  return { selfInvoice: await caller.withClient((client) => viewOf(client, row!, context, businessDate(serverClock.now()))) }
}

/**
 * invoices.view + payables.view: the company's supplier invoices from suppliers abroad that have no live self-invoice (not
 * voided, not a credit note), newest first, each with the kind it suggests and its deadline.
 */
export async function selfInvoiceCandidates(caller: CommandCaller, query: { companyId: string }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!can(actor, INVOICES_VIEW, { companyId: query.companyId })) throw new NotFoundError('Company not found.')
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const where: Prisma.SupplierInvoiceWhereInput = {
      AND: [
        { companyId: query.companyId, status: { not: 'VOIDED' }, kind: 'INVOICE', party: { country: { not: 'IT' } }, selfInvoices: { none: { status: { not: 'CANCELLED' } } } },
        scopeWhere(actor, 'payables.view', { company: 'companyId', party: 'partyId' }) as Prisma.SupplierInvoiceWhereInput,
      ],
    }
    const rows = await client.supplierInvoice.findMany({
      where,
      select: { id: true, partyId: true, number: true, issueDate: true, receivedOn: true, source: true, currency: true, party: { select: { code: true, legalName: true, country: true } }, lines: { select: { kind: true } } },
      orderBy: [{ receivedOn: 'desc' }, { id: 'desc' }],
      take: LIST_MAX,
    })
    const on = (await readSettings(client, query.companyId)).selfInvoicesOn
    return {
      companyId: query.companyId,
      candidates: rows.map((row) => {
        const deadline = selfInvoiceDeadline(day(row.receivedOn))
        return {
          supplierInvoiceId: row.id,
          partyId: row.partyId,
          supplier: { code: row.party.code, legalName: row.party.legalName, country: row.party.country },
          number: row.number,
          issueDate: day(row.issueDate),
          receivedOn: day(row.receivedOn),
          source: row.source,
          currency: row.currency,
          suggestion: suggestedKind({ country: row.party.country, lineKinds: row.lines.map((line) => line.kind) }),
          deadline,
          deadlineState: deadlineStateOf(deadline, today, 'PENDING'),
        }
      }),
      waits: waitsWords(on, 'SELF_INVOICES'),
      rule: SELF_INVOICE_RULE,
    }
  })
}

export interface CreateSelfInvoiceInput {
  readonly supplierInvoiceId: string
  readonly kind: SelfInvoiceKind
  /** The Italian rate the integration takes (22, 10, 5, 4); default 22 (UNVERIFIED). */
  readonly vatRatePct?: string | undefined
}

const LINE_KIND: Readonly<Record<string, 'GOODS' | 'SERVICE'>> = Object.freeze({ GOODS: 'GOODS', CHARGE: 'GOODS', SERVICE: 'SERVICE', SUBCONTRACT: 'SERVICE' })

/**
 * invoices.manage (on the company and the supplier) with payables.view and money.cost: the self-invoice of a supplier invoice,
 * PENDING, with its draft (TD17/TD18/TD19, in euro); a pending one recorded without a draft gets its draft (same kind). 409 in words: voided, a credit note, an Italian supplier, TD18 outside the
 * EU, one live already, nothing to integrate, no euro rate of the invoice's date.
 */
export async function createSelfInvoice(caller: CommandCaller, body: CreateSelfInvoiceInput, idempotencyKey: string | undefined) {
  const context = officeContextOf(caller)
  const supplier = await readSupplierInvoice(caller, context, body.supplierInvoiceId)
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, { companyId: supplier.companyId, partyId: supplier.partyId }, 'Supplier invoice')
  const live = await caller.withClient((client) => client.selfInvoice.findFirst({ where: { supplierInvoiceId: supplier.id, status: { not: 'CANCELLED' } }, select: { id: true, status: true, kind: true, invoiceId: true } }))
  // A pending self-invoice recorded without its draft (an import, the seed) gets its draft here, of its own kind.
  const waiting = live && live.status === 'PENDING' && live.invoiceId === null ? live : null
  if (waiting && waiting.kind !== body.kind) throw refusedDepth('SELF_INVOICE', `This supplier invoice's self-invoice is a ${waiting.kind}: make its draft as ${waiting.kind}, or cancel it first.`)
  const problems = selfInvoiceProblems({ status: supplier.status, kind: supplier.kind, country: supplier.party.country, netTotal: supplier.netTotal, live: live !== null && waiting === null, selfKind: body.kind })
  if (problems.length > 0) throw refusedDepth('SELF_INVOICE', problems.map(refusalWords).join(' '))
  const issueDate = day(supplier.issueDate)
  let toEuro = (minor: number): number => minor
  if (supplier.currency !== EURO) {
    const rate = await caller.withClient((client) => dayRate(client, EURO, supplier.currency, issueDate))
    if (!rate) throw refusedDepth('NO_RATE', `The supplier invoice is in ${supplier.currency}: a self-invoice is in euro at the rate of its date. ${noRateWords(EURO, supplier.currency, issueDate)}`)
    toEuro = (minor: number): number => convertMinor(minor, supplier.currency, EURO, rate)
  }
  const reference = `fattura n. ${supplier.number} del ${issueDate.slice(8, 10)}/${issueDate.slice(5, 7)}/${issueDate.slice(0, 4)}`
  const kinds = new Set(supplier.lines.map((line) => LINE_KIND[line.kind] ?? 'GOODS'))
  const lineKind: 'GOODS' | 'SERVICE' = body.kind === 'TD17' ? 'SERVICE' : kinds.size === 1 ? [...kinds][0]! : 'GOODS'
  const lines: LineInput[] = integrationLines(supplier.lines, supplier.netTotal, reference, toEuro).map((line) => ({
    kind: lineKind,
    description: line.description,
    quantity: '1',
    unitPrice: fromMinorUnits(line.netEur, EURO).toFixed(2),
    vatRatePct: body.vatRatePct ?? DEFAULT_INTEGRATION_RATE,
  }))
  const profile = await caller.withClient(async (client) => (await partyFacts(client, supplier.partyId, businessDate(serverClock.now()), serverClock.now()))?.profile ?? null)
  const prepared = prepareLines(lines, profile)
  const deadline = selfInvoiceDeadline(day(supplier.receivedOn))
  const { result } = await refusingDepth(() =>
    command(caller, { name: 'invoices.createSelfInvoice', idempotencyKey, input: body }, async (tools) => {
      const invoiceId = newId()
      const selfInvoiceId = waiting?.id ?? newId()
      if (waiting) {
        const rows = await tools.tx.$queryRaw<{ invoiceId: string | null; status: string }[]>`SELECT "invoiceId", status::text AS status FROM "SelfInvoice" WHERE id = ${waiting.id}::uuid FOR UPDATE`
        if (rows[0]?.status !== 'PENDING' || rows[0].invoiceId !== null) throw refusedDepth('SELF_INVOICE', 'This self-invoice got its draft meanwhile: read it again.')
      }
      await insertDraft(
        tools,
        {
          id: invoiceId,
          companyId: supplier.companyId,
          buyerPartyId: supplier.partyId,
          docType: body.kind,
          priceBasis: 'NET',
          currency: EURO,
          salesOrderId: null,
          depositRequestId: null,
          causale: selfInvoiceCausale(body.kind, supplier.number, issueDate, supplier.party.legalName),
          documentRefs: null,
          payment: null,
          internalNote: null,
        },
        prepared,
      )
      if (waiting) {
        await tools.tx.selfInvoice.update({ where: { id: waiting.id }, data: { invoiceId, version: { increment: 1 } }, select: { id: true } })
      } else {
        await tools.tx.selfInvoice.create({
          data: { id: selfInvoiceId, companyId: supplier.companyId, partyId: supplier.partyId, supplierInvoiceId: supplier.id, kind: body.kind, deadline: new Date(`${deadline}T00:00:00.000Z`), status: 'PENDING', invoiceId, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
          select: { id: true },
        })
      }
      const action = waiting ? ('DRAFTED' as const) : ('CREATED' as const)
      tools.audit({ action: 'invoices.createSelfInvoice', recordType: 'SelfInvoice', recordId: selfInvoiceId, companyId: supplier.companyId, after: { supplierInvoiceId: supplier.id, kind: body.kind, ...(waiting ? { drafted: true } : { deadline }), invoiceId, lines: prepared.length, vatRatePct: body.vatRatePct ?? DEFAULT_INTEGRATION_RATE, currency: supplier.currency } })
      tools.emit({ type: 'self_invoice.changed', subject: selfInvoiceId, companyId: supplier.companyId, payload: { selfInvoiceId, companyId: supplier.companyId, supplierInvoiceId: supplier.id, kind: body.kind, action, invoiceId } })
      return { selfInvoice: await viewOf(tools.tx, (await tools.tx.selfInvoice.findUniqueOrThrow({ where: { id: selfInvoiceId }, select: SELF_COLUMNS })), context, businessDate(tools.now)) }
    }),
  )
  return result
}

/**
 * invoices.manage: cancels a PENDING self-invoice, why (3-500 characters), in ONE command: it lets its draft go and the draft is
 * deleted (no number: no gap). An issued self-invoice is never cancelled here (409: its correction stays with the accountant).
 */
export async function cancelSelfInvoice(caller: CommandCaller, selfInvoiceId: string, body: { version: number; reason: string }, idempotencyKey: string | undefined) {
  const context = officeContextOf(caller)
  const row = isUuid(selfInvoiceId) ? await caller.withClient((client) => client.selfInvoice.findUnique({ where: { id: selfInvoiceId }, select: SELF_COLUMNS })) : null
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, row ? { companyId: row.companyId, partyId: row.partyId } : null, 'Self-invoice')
  if (row!.status === 'ISSUED') throw refusedDepth('SELF_INVOICE_ISSUED', `The self-invoice is issued (${row!.invoice?.number ?? ''}): it is never cancelled; its correction stays with the accountant.`)
  if (row!.status === 'CANCELLED') throw new InvalidStateError('The self-invoice is cancelled already.')
  const { result } = await refusingDepth(() =>
    command(caller, { name: 'invoices.cancelSelfInvoice', idempotencyKey, input: { selfInvoiceId, ...body }, record: { type: 'SelfInvoice', id: selfInvoiceId, expectedVersion: body.version } }, async (tools) => {
      const current = (await tools.tx.selfInvoice.findUniqueOrThrow({ where: { id: selfInvoiceId }, select: SELF_COLUMNS }))
      if (current.status !== 'PENDING') throw new InvalidStateError(`The self-invoice is ${current.status}.`)
      const draft = current.invoice
      if (draft && draft.status !== 'DRAFT') throw refusedDepth('SELF_INVOICE_ISSUED', `Its invoice ${draft.number ?? ''} is issued: the self-invoice is not cancelled.`)
      await tools.tx.selfInvoice.update({ where: { id: selfInvoiceId }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason.trim(), invoiceId: null }, select: { id: true } })
      if (draft) {
        await tools.tx.invoiceLine.deleteMany({ where: { invoiceId: draft.id } })
        await tools.tx.invoice.delete({ where: { id: draft.id }, select: { id: true } })
        tools.audit({ action: 'invoices.deleteDraft', recordType: 'Invoice', recordId: draft.id, companyId: current.companyId, before: { docType: draft.docType, status: 'DRAFT', buyerPartyId: current.partyId }, reason: 'its self-invoice was cancelled' })
        tools.emit({ type: 'invoice.draft_deleted', subject: draft.id, companyId: current.companyId, payload: { invoiceId: draft.id, docType: draft.docType } })
      }
      tools.audit({ action: 'invoices.cancelSelfInvoice', recordType: 'SelfInvoice', recordId: selfInvoiceId, companyId: current.companyId, before: { status: 'PENDING', invoiceId: current.invoiceId }, after: { status: 'CANCELLED', reason: body.reason.trim() } })
      tools.emit({ type: 'self_invoice.changed', subject: selfInvoiceId, companyId: current.companyId, payload: { selfInvoiceId, companyId: current.companyId, supplierInvoiceId: current.supplierInvoiceId, kind: current.kind, action: 'CANCELLED', invoiceId: null } })
      return { selfInvoice: await viewOf(tools.tx, (await tools.tx.selfInvoice.findUniqueOrThrow({ where: { id: selfInvoiceId }, select: SELF_COLUMNS })), context, businessDate(tools.now)) }
    }),
  )
  return result
}
