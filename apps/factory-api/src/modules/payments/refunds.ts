import type { Prisma } from '@nexus/factory-db'
import { dayWords } from '@nexus/factory-domain/accounting/periods'
import { ConflictError, DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { bankReferenceProblem, normaliseBankReference } from '@nexus/factory-domain/payments/payments'
import { PAYMENTS_REFUND, PAYMENTS_VIEW, PAYMENTS_VOID } from '@nexus/factory-domain/payments/permissions'
import { LIVE_REFUND_STATUSES, overpaidOf, paidOnProblem, refundableOnCreditNote, refundAmountProblem, refundMoveProblem, REFUND_STATUSES_BY_VIEW, unplacedOf, type RefundStatus, type RefundView } from '@nexus/factory-domain/payments/refunds'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf } from '../../core/context'
import { serverClock } from '../../core/time'
import { refuseHardLocked } from '../accounting/period-guard'
import { ordersOfInvoices, settleOrders } from '../invoicing/from-shipment/settlement'
import { lockAll, lockMoney } from './locks'
import { allocatedOf, assertMay, officeContextOf, type Reader } from './store'

/**
 * Refunds to customers (B-W2a-61; FIN-127; receivables.prisma Refund; design finance.payments "Refund" pop-up — "Credit
 * note it settles; amount capped at what is still refundable; method", the tile "Refunds to make", Rows ▾ Refunds). The
 * rules are factory-domain payments/refunds. Office only; can() on the refund's company AND its party.
 *
 *   GET   /payments/refunds                     payments.view: the refunds, newest first (view due | paid | closed | all)
 *   GET   /payments/refunds/open                payments.view: "Refunds to make" — the DUE refunds (oldest due first) and
 *                                               the credit notes on what was paid with money left to refund and no
 *                                               refund for it yet (from W1's invoice.refund_due), with the tile's counts
 *   GET   /payments/refunds/:refundId           payments.view: the record (who recorded and paid it: names, inside it)
 *   POST  /payments/refunds                     payments.refund: ONE command records a refund of a credit note
 *                                               (creditNoteId) or of a payment's unplaced part (paymentId: its credit
 *                                               balance), DUE (with a due date when there is one, e.g. 14 days for a
 *                                               consumer's withdrawal, D.Lgs. 206/2005 art. 56) or PAID at once ({paid}); the
 *                                               amount defaults to all that is refundable and never passes it
 *   PATCH /payments/refunds/:refundId           payments.refund: a DUE refund's amount, due date, note (version)
 *   POST  /payments/refunds/:refundId/paid      payments.refund: DUE → PAID with the transfer's value date and the bank's
 *                                               reference (unique in the company: a refund is counted once)
 *   POST  /payments/refunds/:refundId/cancel    payments.refund: DUE → CANCELLED with why (the customer keeps the credit)
 *   POST  /payments/refunds/:refundId/void      payments.void: PAID → VOIDED with why (recorded as paid by mistake)
 *
 * No bank is called: the office makes the transfer in its bank (a payment provider stays W2b, FAKE until then) and
 * records it here. A paid or voided refund dated inside a HARD-locked month is refused in words (B-W2a-39's lock); a
 * refund of a credit note paid or voided moves the order's settlement (REFUND_DUE), announced at the end.
 *
 * Locks: a credit note's refund takes the money locks of its invoice and of the note ('invoice', id order: the trigger
 * takes the note's), a payment's refund the payment's ('payment', as an allocation does); every sum is read under them.
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const dateValue = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)
const live = { in: [...LIVE_REFUND_STATUSES] }
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

export const REFUND_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  creditNoteId: true,
  paymentId: true,
  method: true,
  amount: true,
  currency: true,
  dueDate: true,
  status: true,
  paidOn: true,
  externalRef: true,
  paidAt: true,
  paidById: true,
  cancelledAt: true,
  cancelReason: true,
  voidedAt: true,
  voidReason: true,
  internalNote: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.RefundSelect
export type RefundRow = Prisma.RefundGetPayload<{ select: typeof REFUND_COLUMNS }>

export async function readRefund(db: Reader, refundId: string): Promise<RefundRow | null> {
  if (!isUuid(refundId)) return null
  return db.refund.findUnique({ where: { id: refundId }, select: REFUND_COLUMNS })
}

/** The refund the office may see (else 404) and act on with `permission` (else 403). */
async function officeRefund(caller: CommandCaller, refundId: string, permission: Permission = PAYMENTS_VIEW): Promise<RefundRow> {
  const context = officeContextOf(caller)
  const refund = await caller.withClient((client) => readRefund(client, refundId))
  assertMay(context, PAYMENTS_VIEW, permission, refund, 'Refund')
  return refund!
}

// ---- what may be refunded ---------------------------------------------------------------------------------------------

const NOTE_COLUMNS = { id: true, companyId: true, buyerPartyId: true, docType: true, status: true, number: true, issueDate: true, currency: true, grossTotal: true, creditOfId: true } as const

/** A credit note and what it may still refund (its invoice's overpayment, its own and its invoice's live refunds). */
export async function creditNoteRefundable(db: Reader, creditNoteId: string, except: string | null = null) {
  const note = isUuid(creditNoteId) ? await db.invoice.findUnique({ where: { id: creditNoteId }, select: NOTE_COLUMNS }) : null
  if (!note || note.docType !== 'TD04' || !note.creditOfId) return null
  const invoice = await db.invoice.findUnique({ where: { id: note.creditOfId }, select: { id: true, docType: true, number: true, grossTotal: true } })
  if (!invoice) return null
  const creditedGross = (await db.invoice.aggregate({ where: { creditOfId: invoice.id, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } }))._sum.grossTotal ?? 0
  const paid = invoice.docType === 'TD02' ? invoice.grossTotal : ((await db.paymentAllocation.aggregate({ where: { invoiceId: invoice.id }, _sum: { amount: true } }))._sum.amount ?? 0)
  const refunds = await db.refund.findMany({ where: { status: live, creditNote: { creditOfId: invoice.id }, ...(except ? { id: { not: except } } : {}) }, select: { creditNoteId: true, amount: true } })
  const liveOnNote = refunds.filter((row) => row.creditNoteId === note.id).reduce((sum, row) => sum + row.amount, 0)
  const liveOnInvoice = refunds.reduce((sum, row) => sum + row.amount, 0)
  const overpaid = overpaidOf({ docType: invoice.docType, grossTotal: invoice.grossTotal, creditedGross, paid })
  return { note, invoice, overpaid, liveOnNote, liveOnInvoice, refundable: refundableOnCreditNote({ noteGross: note.grossTotal, liveOnNote, overpaid, liveOnInvoice }) }
}

/** A payment's live refunds (DUE or PAID), but `except`. */
export async function refundedOf(db: Reader, paymentId: string, except: string | null = null): Promise<number> {
  return (await db.refund.aggregate({ where: { paymentId, status: live, ...(except ? { id: { not: except } } : {}) }, _sum: { amount: true } }))._sum.amount ?? 0
}

/** A payment and its unplaced part (what a refund of it may take). */
export async function paymentRefundable(db: Reader, paymentId: string, except: string | null = null) {
  const payment = isUuid(paymentId) ? await db.payment.findUnique({ where: { id: paymentId }, select: { id: true, companyId: true, partyId: true, status: true, amount: true, currency: true, receivedOn: true, externalRef: true } }) : null
  if (!payment) return null
  const allocated = await allocatedOf(db, payment.id)
  const refunded = await refundedOf(db, payment.id, except)
  return { payment, allocated, refunded, refundable: unplacedOf({ status: payment.status, amount: payment.amount, allocated, refunded }) }
}

const noteWords = (note: { number: string | null }) => `credit note ${note.number ?? '(draft)'}`
const paymentWords = (payment: { receivedOn: Date; externalRef: string }) => `payment received on ${dayWords(payment.receivedOn.toISOString().slice(0, 10))} (${payment.externalRef})`

// ---- views ------------------------------------------------------------------------------------------------------------

/** The sources the rows name, their numbers and dates (three reads, whatever the count). */
async function sourcesOf(db: Reader, rows: readonly Pick<RefundRow, 'creditNoteId' | 'paymentId' | 'partyId'>[]) {
  const noteIds = [...new Set(rows.flatMap((row) => (row.creditNoteId ? [row.creditNoteId] : [])))]
  const paymentIds = [...new Set(rows.flatMap((row) => (row.paymentId ? [row.paymentId] : [])))]
  const notes = noteIds.length ? await db.invoice.findMany({ where: { id: { in: noteIds } }, select: { id: true, number: true, issueDate: true, creditOfId: true, creditOf: { select: { number: true, docType: true } } } }) : []
  const payments = paymentIds.length ? await db.payment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, receivedOn: true, externalRef: true } }) : []
  const parties = await db.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })
  return { notes: new Map(notes.map((row) => [row.id, row])), payments: new Map(payments.map((row) => [row.id, row])), parties: new Map(parties.map((row) => [row.id, row])) }
}

function refundRowView(row: RefundRow, sources: Awaited<ReturnType<typeof sourcesOf>>) {
  const note = row.creditNoteId ? sources.notes.get(row.creditNoteId) : undefined
  const payment = row.paymentId ? sources.payments.get(row.paymentId) : undefined
  const party = sources.parties.get(row.partyId)
  return {
    id: row.id,
    version: row.version,
    companyId: row.companyId,
    partyId: row.partyId,
    party: { code: party?.code ?? '', legalName: party?.legalName ?? '' },
    source: row.creditNoteId ? ('CREDIT_NOTE' as const) : ('PAYMENT' as const),
    creditNote: note ? { id: note.id, number: note.number, issueDate: day(note.issueDate), creditOfId: note.creditOfId, creditOfNumber: note.creditOf?.number ?? null, creditOfDocType: note.creditOf?.docType ?? null } : null,
    payment: payment ? { id: payment.id, receivedOn: day(payment.receivedOn)!, externalRef: payment.externalRef } : null,
    method: row.method,
    amount: asMoney('price', row.amount),
    currency: row.currency,
    dueDate: day(row.dueDate),
    status: row.status as RefundStatus,
    paidOn: day(row.paidOn),
    externalRef: row.externalRef,
    paidAt: row.paidAt ? toUtcIso(row.paidAt) : null,
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    voidedAt: row.voidedAt ? toUtcIso(row.voidedAt) : null,
    voidReason: row.voidReason,
    internalNote: row.internalNote,
    createdAt: toUtcIso(row.createdAt),
  }
}

/** The refund record: its facts, its source, who recorded and paid it (names inside the one record). */
export async function refundDetail(db: Reader, row: RefundRow) {
  const view = refundRowView(row, await sourcesOf(db, [row]))
  const ids = [...new Set([row.createdById, row.paidById].filter((value): value is string => value !== null))]
  const people = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' } }) : []
  return { ...view, createdById: row.createdById, paidById: row.paidById, people: people.map((user) => ({ id: user.id, name: user.displayName })) }
}
export type RefundDetail = Awaited<ReturnType<typeof refundDetail>>

// ---- reads ------------------------------------------------------------------------------------------------------------

export async function getRefund(caller: CommandCaller, refundId: string): Promise<{ refund: RefundDetail }> {
  const refund = await officeRefund(caller, refundId)
  return { refund: await caller.withClient((client) => refundDetail(client, refund)) }
}

export interface ListRefundsQuery {
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  readonly view?: RefundView | undefined
  /** The refunds of one credit note, or of one payment (its record). */
  readonly creditNoteId?: string | undefined
  readonly paymentId?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The refunds the caller may see, newest first. */
export async function listRefunds(caller: CommandCaller, query: ListRefundsQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.RefundWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PAYMENTS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.RefundWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.creditNoteId ? { creditNoteId: query.creditNoteId } : {},
      query.paymentId ? { paymentId: query.paymentId } : {},
      { status: { in: [...REFUND_STATUSES_BY_VIEW[query.view ?? 'all']] } },
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.refund.findMany({ where, orderBy: { id: 'desc' }, take: query.limit + 1, select: REFUND_COLUMNS })
    const page = rows.slice(0, query.limit)
    const sources = await sourcesOf(client, page)
    return { refunds: page.map((row) => refundRowView(row, sources)), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null }
  })
}

const OPEN_LIMIT = 500

/**
 * "Refunds to make" (the tile and its rows): the DUE refunds, oldest due first, and the issued credit notes whose invoice
 * was paid beyond what it is worth now with money left to refund (no refund, or not all of it) — newest 500.
 */
export async function openRefunds(caller: CommandCaller, query: { companyId?: string | undefined; partyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const due = await client.refund.findMany({
      where: { AND: [scopeWhere(actor, PAYMENTS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.RefundWhereInput, query.companyId ? { companyId: query.companyId } : {}, query.partyId ? { partyId: query.partyId } : {}, { status: 'DUE' }] },
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: OPEN_LIMIT,
      select: REFUND_COLUMNS,
    })
    const notes = await client.invoice.findMany({
      where: { AND: [scopeWhere(actor, PAYMENTS_VIEW, { company: 'companyId', party: 'buyerPartyId' }) as Prisma.InvoiceWhereInput, query.companyId ? { companyId: query.companyId } : {}, query.partyId ? { buyerPartyId: query.partyId } : {}, { docType: 'TD04', status: { notIn: ['DRAFT', 'REJECTED'] }, creditOfId: { not: null } }] },
      orderBy: [{ issueDate: 'desc' }, { id: 'desc' }],
      take: OPEN_LIMIT,
      select: { ...NOTE_COLUMNS, buyer: { select: { code: true, legalName: true } } },
    })
    const invoiceIds = [...new Set(notes.map((note) => note.creditOfId!))]
    const invoices = invoiceIds.length ? await client.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, docType: true, number: true, grossTotal: true, salesOrder: { select: { number: true } } } }) : []
    const credited = invoiceIds.length ? await client.invoice.groupBy({ by: ['creditOfId'], where: { creditOfId: { in: invoiceIds }, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } }) : []
    const paid = invoiceIds.length ? await client.paymentAllocation.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: invoiceIds } }, _sum: { amount: true } }) : []
    const refunds = invoiceIds.length ? await client.refund.findMany({ where: { status: live, creditNote: { creditOfId: { in: invoiceIds } } }, select: { creditNoteId: true, amount: true, creditNote: { select: { creditOfId: true } } } }) : []
    const toRefund = notes.flatMap((note) => {
      const invoice = invoices.find((row) => row.id === note.creditOfId)
      if (!invoice) return []
      const overpaid = overpaidOf({
        docType: invoice.docType,
        grossTotal: invoice.grossTotal,
        creditedGross: credited.find((row) => row.creditOfId === invoice.id)?._sum.grossTotal ?? 0,
        paid: invoice.docType === 'TD02' ? invoice.grossTotal : (paid.find((row) => row.invoiceId === invoice.id)?._sum.amount ?? 0),
      })
      const liveOnNote = refunds.filter((row) => row.creditNoteId === note.id).reduce((sum, row) => sum + row.amount, 0)
      const liveOnInvoice = refunds.filter((row) => row.creditNote?.creditOfId === invoice.id).reduce((sum, row) => sum + row.amount, 0)
      const refundable = refundableOnCreditNote({ noteGross: note.grossTotal, liveOnNote, overpaid, liveOnInvoice })
      if (refundable <= 0) return []
      return [
        {
          creditNoteId: note.id,
          number: note.number,
          issueDate: day(note.issueDate),
          companyId: note.companyId,
          partyId: note.buyerPartyId,
          party: { code: note.buyer.code, legalName: note.buyer.legalName },
          currency: note.currency,
          grossTotal: asMoney('price', note.grossTotal),
          creditOfId: invoice.id,
          creditOfNumber: invoice.number,
          creditOfDocType: invoice.docType,
          orderNumber: invoice.salesOrder?.number ?? null,
          refundedAmount: asMoney('price', liveOnNote),
          refundableAmount: asMoney('price', refundable),
        },
      ]
    })
    const sources = await sourcesOf(client, due)
    return {
      counts: { refundsDue: due.length, creditNotesToRefund: toRefund.length },
      refundsDue: due.map((row) => refundRowView(row, sources)),
      creditNotesToRefund: toRefund,
      asOf: toUtcIso(serverClock.now()),
    }
  })
}

// ---- record -----------------------------------------------------------------------------------------------------------

export interface RecordRefundInput {
  readonly creditNoteId?: string | undefined
  readonly paymentId?: string | undefined
  /** Minor units; absent: all that is refundable. */
  readonly amount?: number | undefined
  readonly dueDate?: string | null | undefined
  readonly internalNote?: string | null | undefined
  /** Recorded as made already: the transfer's value date and the bank's reference. */
  readonly paid?: { readonly paidOn: string; readonly externalRef: string } | undefined
}

/** The value date and the bank's reference of a refund made, checked (400), the reference in one form. */
function checkPaid(paid: { paidOn: string; externalRef: string }, at = 'body'): { paidOn: string; externalRef: string } {
  const issues: Issue[] = []
  const dateProblem = paidOnProblem(paid.paidOn, businessDate(serverClock.now()))
  if (dateProblem) issues.push({ path: `${at}/paidOn`, message: dateProblem })
  const referenceProblem = bankReferenceProblem(paid.externalRef)
  if (referenceProblem) issues.push({ path: `${at}/externalRef`, message: referenceProblem })
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  return { paidOn: paid.paidOn, externalRef: normaliseBankReference(paid.externalRef)! }
}

/** A bank reference already on a refund of the company: 409 saying when. */
async function refuseCountedRefund(db: Reader, companyId: string, externalRef: string, path: string): Promise<void> {
  const existing = await db.refund.findFirst({ where: { companyId, externalRef }, select: { id: true, paidOn: true } })
  if (existing) throw new DomainError('conflict', `This bank reference is recorded already on the refund paid on ${existing.paidOn ? dayWords(existing.paidOn.toISOString().slice(0, 10)) : '?'} (refund ${existing.id}): a refund is counted once.`, [{ path, message: 'Recorded already.' }])
}

async function counted<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work()
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('This bank reference was just recorded on another refund: a refund is counted once.')
    throw error
  }
}

/** The refund's period lock (a HARD-locked month refuses a bank date in it), in words before the database's. */
async function refuseLockedRefund(tools: CommandTools, companyId: string, paidOn: string, externalRef: string, what: string, path: string): Promise<void> {
  await refuseHardLocked(tools.tx, tools.context, [{ companyId, day: paidOn, refused: `the refund ${what} on ${dayWords(paidOn)} (bank reference ${externalRef}) is not recorded`, path }])
}

/** payments.refund: records a refund of a credit note or of a payment's unplaced part, DUE or PAID. */
export async function recordRefund(caller: CommandCaller, body: RecordRefundInput, idempotencyKey?: string): Promise<{ refund: RefundDetail }> {
  const context = officeContextOf(caller)
  if ((body.creditNoteId === undefined) === (body.paymentId === undefined)) {
    throw new ValidationError('A refund pays back one thing: a credit note (creditNoteId) or the money of a payment not placed (paymentId).', [{ path: 'body', message: 'One of creditNoteId or paymentId.' }])
  }
  const scope = await caller.withClient(async (client) => {
    if (body.creditNoteId !== undefined) {
      const note = isUuid(body.creditNoteId) ? await client.invoice.findUnique({ where: { id: body.creditNoteId }, select: { companyId: true, buyerPartyId: true, docType: true } }) : null
      return note && note.docType === 'TD04' ? { companyId: note.companyId, partyId: note.buyerPartyId } : null
    }
    const payment = isUuid(body.paymentId!) ? await client.payment.findUnique({ where: { id: body.paymentId! }, select: { companyId: true, partyId: true } }) : null
    return payment ? { companyId: payment.companyId, partyId: payment.partyId } : null
  })
  assertMay(context, PAYMENTS_VIEW, PAYMENTS_REFUND, scope, body.creditNoteId !== undefined ? 'Credit note' : 'Payment')
  const paid = body.paid ? checkPaid(body.paid, 'body/paid') : null
  if (paid) await caller.withClient((client) => refuseCountedRefund(client, scope.companyId, paid.externalRef, 'body/paid/externalRef'))

  return counted(async () => {
    const { result } = await command(caller, { name: 'payments.recordRefund', idempotencyKey, input: body }, async (tools) => {
      const { tx } = tools
      let source: { companyId: string; partyId: string; currency: string; refundable: number; words: string; creditNoteId: string | null; paymentId: string | null }
      if (body.creditNoteId !== undefined) {
        const head = await tx.invoice.findUnique({ where: { id: body.creditNoteId }, select: { id: true, creditOfId: true } })
        if (!head) throw new NotFoundError('Credit note not found.')
        await lockAll(tx, tools.context, 'invoice', [head.id, ...(head.creditOfId ? [head.creditOfId] : [])])
        const facts = await creditNoteRefundable(tx, head.id)
        if (!facts) throw new InvalidStateError('This credit note names no invoice it credits: nothing to refund.')
        if (facts.note.status === 'DRAFT') throw new InvalidStateError('The credit note is a draft: issue it first, then refund what it credits.')
        if (facts.note.status === 'REJECTED') throw new InvalidStateError(`Credit note ${facts.note.number} was rejected by SDI and counts as never issued: correct it and send it again before refunding it.`)
        source = { companyId: facts.note.companyId, partyId: facts.note.buyerPartyId, currency: facts.note.currency, refundable: facts.refundable, words: noteWords(facts.note), creditNoteId: facts.note.id, paymentId: null }
      } else {
        await lockMoney(tx, tools.context, 'payment', body.paymentId!)
        const facts = (await paymentRefundable(tx, body.paymentId!))!
        if (facts.payment.status !== 'RECEIVED') throw new InvalidStateError(`The payment is ${facts.payment.status}: it has nothing to refund.`)
        source = { companyId: facts.payment.companyId, partyId: facts.payment.partyId, currency: facts.payment.currency, refundable: facts.refundable, words: paymentWords(facts.payment), creditNoteId: null, paymentId: facts.payment.id }
      }
      const amount = body.amount ?? source.refundable
      const problem = refundAmountProblem(amount, source.refundable, source.currency, source.words)
      if (problem) throw new DomainError('conflict', problem, [{ path: 'body/amount', message: problem }])
      if (paid) await refuseLockedRefund(tools, source.companyId, paid.paidOn, paid.externalRef, 'paid', 'body/paid/paidOn')
      const id = newId()
      await tx.refund.create({
        data: {
          id,
          companyId: source.companyId,
          partyId: source.partyId,
          creditNoteId: source.creditNoteId,
          paymentId: source.paymentId,
          method: 'BANK_TRANSFER',
          amount,
          currency: source.currency,
          dueDate: body.dueDate ? dateValue(body.dueDate) : null,
          status: paid ? 'PAID' : 'DUE',
          ...(paid ? { paidOn: dateValue(paid.paidOn), externalRef: paid.externalRef, paidAt: tools.now, paidById: actorIdOf(tools) } : {}),
          internalNote: blankToNull(body.internalNote),
          createdAt: tools.now,
          updatedAt: tools.now,
          createdById: actorIdOf(tools),
        },
        select: { id: true },
      })
      tools.audit({
        action: 'payments.recordRefund',
        recordType: 'Refund',
        recordId: id,
        companyId: source.companyId,
        after: { partyId: source.partyId, source: source.creditNoteId ? 'CREDIT_NOTE' : 'PAYMENT', sourceId: source.creditNoteId ?? source.paymentId, amount: markMoney('price', amount), currency: source.currency, status: paid ? 'PAID' : 'DUE', dueDate: body.dueDate ?? null, ...(paid ? { paidOn: paid.paidOn, externalRef: paid.externalRef } : {}) },
      })
      tools.emit({ type: 'refund.recorded', subject: id, companyId: source.companyId, payload: { refundId: id, partyId: source.partyId, source: source.creditNoteId ? 'CREDIT_NOTE' : 'PAYMENT', sourceId: (source.creditNoteId ?? source.paymentId)!, status: paid ? 'PAID' : 'DUE' } })
      // A refund paid of a credit note gives the money back: the order's settlement (REFUND_DUE) may change.
      if (paid && source.creditNoteId) await settleOrders(tools, await ordersOfInvoices(tx, [source.creditNoteId]))
      return { refund: await refundDetail(tx, (await readRefund(tx, id))!) }
    })
    return result
  })
}

// ---- change, pay, cancel, void ----------------------------------------------------------------------------------------

/** The refund locked as the trigger locks it (its credit note and invoice, or its payment); then read again. */
async function lockRefund(tools: CommandTools, refund: RefundRow): Promise<void> {
  if (refund.creditNoteId) {
    const note = await tools.tx.invoice.findUnique({ where: { id: refund.creditNoteId }, select: { creditOfId: true } })
    await lockAll(tools.tx, tools.context, 'invoice', [refund.creditNoteId, ...(note?.creditOfId ? [note.creditOfId] : [])])
  } else await lockMoney(tools.tx, tools.context, 'payment', refund.paymentId!)
}

function refuseMove(refund: RefundRow, to: 'PAID' | 'CANCELLED' | 'VOIDED' | 'CHANGED'): void {
  const problem = refundMoveProblem(refund.status as RefundStatus, to)
  if (problem) throw new InvalidStateError(problem)
}

export interface ChangeRefundInput {
  readonly version: number
  readonly amount?: number | undefined
  readonly dueDate?: string | null | undefined
  readonly internalNote?: string | null | undefined
}

/** payments.refund: a DUE refund's amount (never above what is refundable), due date or note. */
export async function changeRefund(caller: CommandCaller, refundId: string, body: ChangeRefundInput, idempotencyKey?: string): Promise<{ refund: RefundDetail }> {
  const refund = await officeRefund(caller, refundId, PAYMENTS_REFUND)
  refuseMove(refund, 'CHANGED')
  const fields = (['amount', 'dueDate', 'internalNote'] as const).filter((field) => body[field] !== undefined)
  if (fields.length === 0) throw new ValidationError('Send what changes: the amount, the due date or the note.', [{ path: 'body', message: 'Nothing to change.' }])
  const { result } = await command(caller, { name: 'payments.changeRefund', idempotencyKey, input: { refundId, ...body }, record: { type: 'Refund', id: refund.id, expectedVersion: body.version } }, async (tools) => {
    await lockRefund(tools, refund)
    const current = (await readRefund(tools.tx, refund.id))!
    refuseMove(current, 'CHANGED')
    if (body.amount !== undefined && body.amount > current.amount) {
      const refundable = current.creditNoteId ? ((await creditNoteRefundable(tools.tx, current.creditNoteId, current.id))?.refundable ?? 0) : ((await paymentRefundable(tools.tx, current.paymentId!, current.id))?.refundable ?? 0)
      const problem = refundAmountProblem(body.amount, refundable, current.currency, 'source of this refund')
      if (problem) throw new DomainError('conflict', problem, [{ path: 'body/amount', message: problem }])
    } else if (body.amount !== undefined && (!Number.isSafeInteger(body.amount) || body.amount <= 0)) {
      throw new ValidationError('A refund of more than 0, in minor units (cents).', [{ path: 'body/amount', message: 'Above 0.' }])
    }
    await tools.tx.refund.update({
      where: { id: current.id },
      data: {
        ...(body.amount !== undefined ? { amount: body.amount } : {}),
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate ? dateValue(body.dueDate) : null } : {}),
        ...(body.internalNote !== undefined ? { internalNote: blankToNull(body.internalNote) } : {}),
        updatedAt: tools.now,
      },
      select: { id: true },
    })
    tools.audit({
      recordType: 'Refund',
      recordId: current.id,
      companyId: current.companyId,
      before: { amount: markMoney('price', current.amount), dueDate: day(current.dueDate), internalNote: current.internalNote },
      after: { ...(body.amount !== undefined ? { amount: markMoney('price', body.amount) } : {}), ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}), ...(body.internalNote !== undefined ? { internalNote: blankToNull(body.internalNote) } : {}) },
    })
    tools.emit({ type: 'refund.changed', subject: current.id, companyId: current.companyId, payload: { refundId: current.id, fields: [...fields] } })
    return { refund: await refundDetail(tools.tx, (await readRefund(tools.tx, current.id))!) }
  })
  return result
}

/** payments.refund: DUE → PAID, the transfer's value date and the bank's reference (the office made it in its bank). */
export async function payRefund(caller: CommandCaller, refundId: string, body: { version: number; paidOn: string; externalRef: string }, idempotencyKey?: string): Promise<{ refund: RefundDetail }> {
  const refund = await officeRefund(caller, refundId, PAYMENTS_REFUND)
  refuseMove(refund, 'PAID')
  const paid = checkPaid(body)
  await caller.withClient((client) => refuseCountedRefund(client, refund.companyId, paid.externalRef, 'body/externalRef'))
  return counted(async () => {
    const { result } = await command(caller, { name: 'payments.payRefund', idempotencyKey, input: { refundId, ...body }, record: { type: 'Refund', id: refund.id, expectedVersion: body.version } }, async (tools) => {
      await lockRefund(tools, refund)
      const current = (await readRefund(tools.tx, refund.id))!
      refuseMove(current, 'PAID')
      await refuseLockedRefund(tools, current.companyId, paid.paidOn, paid.externalRef, 'paid', 'body/paidOn')
      await tools.tx.refund.update({ where: { id: current.id }, data: { status: 'PAID', paidOn: dateValue(paid.paidOn), externalRef: paid.externalRef, paidAt: tools.now, paidById: actorIdOf(tools), updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'Refund', recordId: current.id, companyId: current.companyId, before: { status: 'DUE' }, after: { status: 'PAID', paidOn: paid.paidOn, externalRef: paid.externalRef, amount: markMoney('price', current.amount) } })
      tools.emit({ type: 'refund.paid', subject: current.id, companyId: current.companyId, payload: { refundId: current.id, partyId: current.partyId } })
      if (current.creditNoteId) await settleOrders(tools, await ordersOfInvoices(tools.tx, [current.creditNoteId]))
      return { refund: await refundDetail(tools.tx, (await readRefund(tools.tx, current.id))!) }
    })
    return result
  })
}

/** payments.refund: DUE → CANCELLED with why (the customer keeps the credit, or it was settled otherwise). */
export async function cancelRefund(caller: CommandCaller, refundId: string, body: { version: number; reason: string }, idempotencyKey?: string): Promise<{ refund: RefundDetail }> {
  const refund = await officeRefund(caller, refundId, PAYMENTS_REFUND)
  refuseMove(refund, 'CANCELLED')
  const reason = blankToNull(body.reason)
  if (!reason) throw new ValidationError('Say why the refund is not paid.', [{ path: 'body/reason', message: 'Required.' }])
  const { result } = await command(caller, { name: 'payments.cancelRefund', idempotencyKey, input: { refundId, ...body }, record: { type: 'Refund', id: refund.id, expectedVersion: body.version } }, async (tools) => {
    await lockRefund(tools, refund)
    const current = (await readRefund(tools.tx, refund.id))!
    refuseMove(current, 'CANCELLED')
    await tools.tx.refund.update({ where: { id: current.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: reason, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'Refund', recordId: current.id, companyId: current.companyId, before: { status: 'DUE' }, after: { status: 'CANCELLED' }, reason })
    tools.emit({ type: 'refund.cancelled', subject: current.id, companyId: current.companyId, payload: { refundId: current.id, partyId: current.partyId } })
    return { refund: await refundDetail(tools.tx, (await readRefund(tools.tx, current.id))!) }
  })
  return result
}

/** payments.void: PAID → VOIDED with why (recorded as paid by mistake). The money is owed again (or refundable again). */
export async function voidRefund(caller: CommandCaller, refundId: string, body: { version: number; reason: string }, idempotencyKey?: string): Promise<{ refund: RefundDetail }> {
  const refund = await officeRefund(caller, refundId, PAYMENTS_VOID)
  refuseMove(refund, 'VOIDED')
  const reason = blankToNull(body.reason)
  if (!reason) throw new ValidationError('Say why the refund is voided.', [{ path: 'body/reason', message: 'Required.' }])
  const { result } = await command(caller, { name: 'payments.voidRefund', idempotencyKey, input: { refundId, ...body }, record: { type: 'Refund', id: refund.id, expectedVersion: body.version } }, async (tools) => {
    await lockRefund(tools, refund)
    const current = (await readRefund(tools.tx, refund.id))!
    refuseMove(current, 'VOIDED')
    await refuseLockedRefund(tools, current.companyId, day(current.paidOn)!, current.externalRef ?? '', 'paid', 'refundId')
    await tools.tx.refund.update({ where: { id: current.id }, data: { status: 'VOIDED', voidedAt: tools.now, voidReason: reason, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'Refund', recordId: current.id, companyId: current.companyId, before: { status: 'PAID' }, after: { status: 'VOIDED', amount: markMoney('price', current.amount) }, reason })
    tools.emit({ type: 'refund.voided', subject: current.id, companyId: current.companyId, payload: { refundId: current.id, partyId: current.partyId } })
    if (current.creditNoteId) await settleOrders(tools, await ordersOfInvoices(tools.tx, [current.creditNoteId]))
    return { refund: await refundDetail(tools.tx, (await readRefund(tools.tx, current.id))!) }
  })
  return result
}
