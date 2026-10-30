import type { Prisma } from '@nexus/factory-db'
import { dayWords } from '@nexus/factory-domain/accounting/periods'
import { ConflictError, DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, isBusinessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { markMoney, asMoney } from '@nexus/factory-domain/money/marked'
import { bankReferenceProblem, normaliseBankReference, openOnDeposit, openOnInvoice, planAllocations, voidProblems, type AllocationAsk, type AllocationTarget } from '@nexus/factory-domain/payments/payments'
import { PAYMENTS_RECORD, PAYMENTS_VIEW, PAYMENTS_VOID } from '@nexus/factory-domain/payments/permissions'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf } from '../../core/context'
import { serverClock } from '../../core/time'
import { ordersOfInvoices, ordersOfRequests, settleOrders } from '../invoicing/from-shipment/settlement'
import { refuseHardLocked } from '../accounting/period-guard'
import { markDepositPaid } from '../sales/deposits/deposits'
import { lockAll, lockMoney } from './locks'
import { refundedOf } from './refunds'
import { allocatedOf, assertMay, officeContextOf, officePayment, paymentDetail, placedOn, readPayment, targetLabels, type PaymentDetail, type PaymentRow, type Reader } from './store'

/**
 * Payments received (B-W1-28; FIN-121, FIN-122; Q12: bank transfers; A2 SCR-082): record a transfer (its bank reference
 * unique in the company: a transfer counts once), allocate it to deposit requests and issued TD01/TD24 invoices (never
 * past what it has left, nor past what a target is open for: the rest stays unallocated, on account), take an
 * allocation back (a reversal row: the ledger is append-only), void a payment typed by mistake once nothing is
 * allocated. A deposit request whose allocations cover it becomes PAID in the same command (markDepositPaid, sales/deposits).
 *
 * Locks (payments/locks.ts, the …_money_guards triggers' order): the payment (a new row, or command()'s version bump on
 * it, then its money lock), then its targets in id order (deposit requests, then invoices); every sum is read under them.
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const dateValue = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)
export const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

export interface AllocationInput {
  readonly depositRequestId?: string | undefined
  readonly invoiceId?: string | undefined
  /** Minor units; absent: as much as fits. */
  readonly amount?: number | undefined
}

/** One allocation written, for the answer and the events. */
export interface Allocated {
  readonly allocationId: string
  readonly target: AllocationTarget
  readonly targetId: string
  readonly amount: number
}

const requestLabel = (number: string | null) => (number ? `deposit request of order ${number}` : 'deposit request')

/**
 * Inside a command that holds the payment (a new row, or its version bump): allocates it to the targets, in order,
 * under the payment's lock and the targets' (sorted). Refuses (409, every problem) a target of another company or party,
 * not open, in another currency, or an amount that passes a cap; an ask without an amount takes what fits. A deposit
 * request it covers becomes PAID. Returns the allocations written.
 */
export async function allocateInCommand(tools: CommandTools, payment: Pick<PaymentRow, 'id' | 'companyId' | 'partyId' | 'currency' | 'amount' | 'status'>, asks: readonly AllocationInput[], path = 'body/allocations', options: { readonly settle?: boolean } = {}): Promise<Allocated[]> {
  const { tx, context } = tools
  if (asks.length === 0) return []
  if (payment.status !== 'RECEIVED') throw new InvalidStateError(`The payment is ${payment.status}; it pays nothing.`)
  const issues: Issue[] = []
  asks.forEach((ask, index) => {
    if ((ask.depositRequestId === undefined) === (ask.invoiceId === undefined)) issues.push({ path: `${path}/${index}`, message: 'Name one deposit request or one invoice.' })
  })
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  await lockMoney(tx, context, 'payment', payment.id)
  await lockAll(tx, context, 'deposit', asks.flatMap((ask) => (ask.depositRequestId ? [ask.depositRequestId] : [])))
  await lockAll(tx, context, 'invoice', asks.flatMap((ask) => (ask.invoiceId ? [ask.invoiceId] : [])))

  const planned: AllocationAsk[] = []
  const requests = new Map<string, { amount: number; orderId: string | null }>()
  for (const [index, ask] of asks.entries()) {
    const at = `${path}/${index}`
    if (ask.depositRequestId !== undefined) {
      const request = isUuid(ask.depositRequestId) ? await tx.depositRequest.findUnique({ where: { id: ask.depositRequestId }, select: { id: true, companyId: true, partyId: true, status: true, currency: true, amount: true, orderId: true, order: { select: { number: true } } } }) : null
      if (!request || request.companyId !== payment.companyId || request.partyId !== payment.partyId) {
        issues.push({ path: `${at}/depositRequestId`, message: "Not a deposit request of this payment's customer and company." })
        continue
      }
      const label = requestLabel(request.order?.number ?? null)
      if (request.status !== 'OPEN') issues.push({ path: `${at}/depositRequestId`, message: `The ${label} is ${request.status}: payments go to an OPEN request.` })
      else if (request.currency !== payment.currency) issues.push({ path: `${at}/depositRequestId`, message: `The ${label} is in ${request.currency}, the payment in ${payment.currency}.` })
      else {
        const allocated = (await tx.paymentAllocation.aggregate({ where: { depositRequestId: request.id }, _sum: { amount: true } }))._sum.amount ?? 0
        requests.set(request.id, { amount: request.amount, orderId: request.orderId })
        planned.push({ target: 'DEPOSIT_REQUEST', targetId: request.id, open: openOnDeposit(request.amount, allocated), amount: ask.amount, path: at, label })
      }
      continue
    }
    const invoice = isUuid(ask.invoiceId!) ? await tx.invoice.findUnique({ where: { id: ask.invoiceId! }, select: { id: true, companyId: true, buyerPartyId: true, status: true, docType: true, number: true, currency: true, grossTotal: true } }) : null
    if (!invoice || invoice.companyId !== payment.companyId || invoice.buyerPartyId !== payment.partyId) {
      issues.push({ path: `${at}/invoiceId`, message: "Not an invoice of this payment's customer and company." })
      continue
    }
    const label = `invoice ${invoice.number ?? '(draft)'}`
    if (invoice.status === 'DRAFT') issues.push({ path: `${at}/invoiceId`, message: `The ${label} is a draft: a payment goes to an issued invoice.` })
    else if (invoice.docType !== 'TD01' && invoice.docType !== 'TD24') {
      issues.push({ path: `${at}/invoiceId`, message: invoice.docType === 'TD02' ? `The ${label} is a deposit invoice: it is paid through its deposit request.` : `The ${label} is a credit note: it is not paid.` })
    } else if (invoice.currency !== payment.currency) issues.push({ path: `${at}/invoiceId`, message: `The ${label} is in ${invoice.currency}, the payment in ${payment.currency}.` })
    else {
      const credited = (await tx.invoice.aggregate({ where: { creditOfId: invoice.id, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } }))._sum.grossTotal ?? 0
      const allocated = (await tx.paymentAllocation.aggregate({ where: { invoiceId: invoice.id }, _sum: { amount: true } }))._sum.amount ?? 0
      planned.push({ target: 'INVOICE', targetId: invoice.id, open: openOnInvoice(invoice.grossTotal, credited, allocated), amount: ask.amount, path: at, label })
    }
  }
  if (issues.length > 0) throw new DomainError('conflict', issues.length === 1 ? issues[0]!.message : 'These allocations cannot be made.', issues)
  // B-W2a-61: a live refund of the payment's unplaced part (its credit balance) holds that money too.
  const unallocated = payment.amount - (await allocatedOf(tx, payment.id)) - (await refundedOf(tx, payment.id))
  const plan = planAllocations(unallocated, planned, payment.currency)
  if (plan.issues.length > 0) throw new DomainError('conflict', plan.issues.length === 1 ? plan.issues[0]!.message : 'These allocations cannot be made.', plan.issues)

  const written: Allocated[] = []
  for (const allocation of plan.allocations) {
    const id = newId()
    await tx.paymentAllocation.create({
      data: {
        id,
        companyId: payment.companyId,
        partyId: payment.partyId,
        paymentId: payment.id,
        ...(allocation.target === 'INVOICE' ? { invoiceId: allocation.targetId } : { depositRequestId: allocation.targetId }),
        amount: allocation.amount,
        createdAt: tools.now,
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
    tools.audit({ action: 'payments.allocate', recordType: 'PaymentAllocation', recordId: id, companyId: payment.companyId, after: { paymentId: payment.id, target: allocation.target, targetId: allocation.targetId, amount: markMoney('price', allocation.amount) } })
    tools.emit({ type: 'payment.allocated', subject: payment.id, companyId: payment.companyId, payload: { paymentId: payment.id, allocationId: id, target: allocation.target, targetId: allocation.targetId } })
    written.push({ allocationId: id, ...allocation })
  }
  for (const [requestId, request] of requests) {
    const allocated = (await tx.paymentAllocation.aggregate({ where: { depositRequestId: requestId }, _sum: { amount: true } }))._sum.amount ?? 0
    if (allocated >= request.amount) await markDepositPaid(tools, { id: requestId, companyId: payment.companyId, partyId: payment.partyId, orderId: request.orderId })
  }
  // B-W1-51: the orders these targets are about may become settled (the balance paid), announced at the end. A caller that
  // does more after the allocation (deposits.ts issues the TD02 first) announces them itself, at its own end.
  if (options.settle !== false) {
    await settleOrders(tools, [
      ...(await ordersOfInvoices(tx, written.flatMap((allocation) => (allocation.target === 'INVOICE' ? [allocation.targetId] : [])))),
      ...(await ordersOfRequests(tx, written.flatMap((allocation) => (allocation.target === 'DEPOSIT_REQUEST' ? [allocation.targetId] : [])))),
    ])
  }
  return written
}

// ---- record -----------------------------------------------------------------------------------------------------------

export interface RecordPaymentInput {
  readonly companyId: string
  readonly partyId: string
  readonly amount?: number | undefined
  readonly currency?: string | undefined
  readonly receivedOn: string
  readonly externalRef: string
  readonly internalNote?: string | null | undefined
  readonly allocations?: readonly AllocationInput[] | undefined
}

export interface CheckedPayment {
  readonly companyId: string
  readonly partyId: string
  readonly amount: number
  readonly currency: string
  readonly receivedOn: string
  readonly externalRef: string
  readonly internalNote: string | null
}

/** The facts of a payment to record, checked (400 / 404 / 409 for a reference counted already). */
export async function checkPayment(caller: CommandCaller, body: Omit<RecordPaymentInput, 'allocations'>): Promise<CheckedPayment> {
  const issues: Issue[] = []
  if (body.amount === undefined) issues.push({ path: 'body/amount', message: 'Send the amount received.' })
  else if (!Number.isSafeInteger(body.amount) || body.amount <= 0) issues.push({ path: 'body/amount', message: 'An amount above 0, in minor units (cents).' })
  const referenceProblem = bankReferenceProblem(body.externalRef)
  if (referenceProblem) issues.push({ path: 'body/externalRef', message: referenceProblem })
  const today = businessDate(serverClock.now())
  if (!isBusinessDate(body.receivedOn)) issues.push({ path: 'body/receivedOn', message: 'Expected the value date, YYYY-MM-DD.' })
  else if (body.receivedOn > today) issues.push({ path: 'body/receivedOn', message: 'The money arrived on a day that has not come yet: check the value date.' })
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const externalRef = normaliseBankReference(body.externalRef)!
  return caller.withClient(async (client) => {
    const [company, party] = [await client.company.findUnique({ where: { id: body.companyId }, select: { id: true, currency: true } }), await client.party.findUnique({ where: { id: body.partyId }, select: { id: true, companyId: true } })]
    if (!company) throw new NotFoundError('Company not found.')
    if (!party || (party.companyId !== null && party.companyId !== company.id)) throw new NotFoundError('Customer not found.')
    const currency = body.currency ?? company.currency
    if (currency !== 'EUR') throw new ValidationError('Payments are recorded in euro (W1).', [{ path: 'body/currency', message: 'Expected EUR.' }])
    await refuseCountedReference(client, company.id, externalRef)
    return { companyId: company.id, partyId: party.id, amount: body.amount!, currency, receivedOn: body.receivedOn, externalRef, internalNote: blankToNull(body.internalNote) }
  })
}

/** A bank reference already recorded in the company: 409 saying when (A2 SCR-082: "This reference was recorded on 3 Nov"). */
async function refuseCountedReference(db: Reader, companyId: string, externalRef: string): Promise<void> {
  const existing = await db.payment.findFirst({ where: { companyId, externalRef }, select: { id: true, receivedOn: true, createdAt: true } })
  if (existing) {
    const on = existing.createdAt.toISOString().slice(0, 10)
    throw new DomainError('conflict', `This bank reference was recorded on ${on} (payment ${existing.id}, received ${existing.receivedOn.toISOString().slice(0, 10)}): a transfer is counted once.`, [{ path: 'body/externalRef', message: 'Recorded already.' }])
  }
}

/** Inside a command: the Payment row RECEIVED, audited, with its event. */
export async function insertPayment(tools: CommandTools, payment: CheckedPayment): Promise<PaymentRow> {
  // B-W2a-F1: a day inside a HARD period lock is refused in words (409) before the database's Payment_period_lock.
  await refuseHardLocked(tools.tx, tools.context, [
    { companyId: payment.companyId, day: payment.receivedOn, refused: `the payment received on ${dayWords(payment.receivedOn)} (bank reference ${payment.externalRef}) is not recorded`, path: 'body/receivedOn' },
  ])
  const id = newId()
  await tools.tx.payment.create({
    data: { id, companyId: payment.companyId, partyId: payment.partyId, method: 'BANK_TRANSFER', amount: payment.amount, currency: payment.currency, receivedOn: dateValue(payment.receivedOn), externalRef: payment.externalRef, internalNote: payment.internalNote, createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools) },
    select: { id: true },
  })
  tools.audit({ action: 'payments.record', recordType: 'Payment', recordId: id, companyId: payment.companyId, after: { partyId: payment.partyId, method: 'BANK_TRANSFER', amount: markMoney('price', payment.amount), currency: payment.currency, receivedOn: payment.receivedOn, externalRef: payment.externalRef } })
  tools.emit({ type: 'payment.recorded', subject: id, companyId: payment.companyId, payload: { paymentId: id, partyId: payment.partyId, method: 'BANK_TRANSFER' } })
  return (await readPayment(tools.tx, id))!
}

/** A unique key the payment hit (the same reference recorded meanwhile): 409. */
export async function recordingCommand<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work()
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('This bank reference was just recorded by someone else: a transfer is counted once.')
    throw error
  }
}

/** payments.record: records a bank transfer received, and allocates it when asked, in one command. */
export async function recordPayment(caller: CommandCaller, body: RecordPaymentInput, idempotencyKey?: string): Promise<{ payment: PaymentDetail }> {
  const context = officeContextOf(caller)
  assertMay(context, PAYMENTS_VIEW, PAYMENTS_RECORD, { companyId: body.companyId, partyId: body.partyId }, 'Customer')
  const checked = await checkPayment(caller, body)
  return recordingCommand(async () => {
    const { result } = await command(caller, { name: 'payments.record', idempotencyKey, input: body }, async (tools) => {
      const payment = await insertPayment(tools, checked)
      await allocateInCommand(tools, payment, body.allocations ?? [])
      return { payment: await paymentDetail(tools.tx, (await readPayment(tools.tx, payment.id))!) }
    })
    return result
  })
}

// ---- read -------------------------------------------------------------------------------------------------------------

export async function getPayment(caller: CommandCaller, paymentId: string): Promise<{ payment: PaymentDetail }> {
  const payment = await officePayment(caller, paymentId)
  return { payment: await caller.withClient((client) => paymentDetail(client, payment)) }
}

export interface ListPaymentsQuery {
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  readonly status?: 'RECEIVED' | 'VOIDED' | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The payments the caller may see (its companies and parties), newest first. */
export async function listPayments(caller: CommandCaller, query: ListPaymentsQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.PaymentWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PAYMENTS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.PaymentWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.status ? { status: query.status } : {},
      query.from ? { receivedOn: { gte: dateValue(query.from) } } : {},
      query.to ? { receivedOn: { lte: dateValue(query.to) } } : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  const rows = await caller.withClient((client) =>
    client.payment.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: { id: true, companyId: true, partyId: true, method: true, amount: true, currency: true, receivedOn: true, externalRef: true, status: true, createdAt: true, party: { select: { legalName: true } }, allocations: { select: { amount: true, invoiceId: true, depositRequestId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    }),
  )
  const page = rows.slice(0, query.limit)
  const labels = await caller.withClient((client) => targetLabels(client, page.flatMap((row) => row.allocations)))
  // B-W2a-61: what live refunds take of each payment's unplaced part.
  const refunds = page.length === 0 ? [] : await caller.withClient((client) => client.refund.groupBy({ by: ['paymentId'], where: { paymentId: { in: page.map((row) => row.id) }, status: { in: ['DUE', 'PAID'] } }, _sum: { amount: true } }))
  return {
    payments: page.map((row) => {
      const allocated = row.allocations.reduce((sum, allocation) => sum + allocation.amount, 0)
      const refunded = refunds.find((entry) => entry.paymentId === row.id)?._sum.amount ?? 0
      return {
        id: row.id,
        companyId: row.companyId,
        partyId: row.partyId,
        partyName: row.party.legalName,
        method: row.method,
        amount: asMoney('price', row.amount),
        allocated: asMoney('price', allocated),
        unallocated: asMoney('price', row.status === 'VOIDED' ? 0 : row.amount - allocated - refunded),
        refunded: asMoney('price', refunded),
        currency: row.currency,
        receivedOn: row.receivedOn.toISOString().slice(0, 10),
        externalRef: row.externalRef,
        status: row.status,
        placedOn: placedOn(row.allocations, labels),
        createdAt: toUtcIso(row.createdAt),
      }
    }),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  }
}

// ---- allocate, reverse, void ------------------------------------------------------------------------------------------

/** payments.record: allocates more of a payment (the version read guards it). */
export async function allocatePayment(caller: CommandCaller, paymentId: string, body: { version?: number | undefined; allocations: readonly AllocationInput[] }, idempotencyKey?: string): Promise<{ payment: PaymentDetail }> {
  const payment = await officePayment(caller, paymentId, PAYMENTS_RECORD)
  const { result } = await command(caller, { name: 'payments.allocate', idempotencyKey, input: { paymentId, ...body }, record: { type: 'Payment', id: payment.id, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } }, async (tools) => {
    const current = (await readPayment(tools.tx, payment.id))!
    await allocateInCommand(tools, current, body.allocations)
    return { payment: await paymentDetail(tools.tx, (await readPayment(tools.tx, payment.id))!) }
  })
  return result
}

/** payments.record: takes an allocation back with a reversal row (why, in the note). A PAID deposit request keeps its. */
export async function reverseAllocation(caller: CommandCaller, paymentId: string, allocationId: string, body: { note: string }, idempotencyKey?: string): Promise<{ payment: PaymentDetail }> {
  const payment = await officePayment(caller, paymentId, PAYMENTS_RECORD)
  const note = blankToNull(body.note)
  if (!note) throw new ValidationError('Say why the allocation is taken back.', [{ path: 'body/note', message: 'Required.' }])
  const { result } = await command(caller, { name: 'payments.reverseAllocation', idempotencyKey, input: { paymentId, allocationId, note }, record: { type: 'Payment', id: payment.id } }, async (tools) => {
    const original = isUuid(allocationId) ? await tools.tx.paymentAllocation.findFirst({ where: { id: allocationId, paymentId: payment.id }, select: { id: true, amount: true, invoiceId: true, depositRequestId: true, reversalOfId: true } }) : null
    if (!original) throw new NotFoundError('Allocation not found.')
    await lockMoney(tools.tx, tools.context, 'payment', payment.id)
    if (original.invoiceId) await lockMoney(tools.tx, tools.context, 'invoice', original.invoiceId)
    else await lockMoney(tools.tx, tools.context, 'deposit', original.depositRequestId!)
    if (original.reversalOfId) throw new InvalidStateError('This row is a reversal itself; it is not taken back.')
    if (await tools.tx.paymentAllocation.findFirst({ where: { reversalOfId: original.id }, select: { id: true } })) throw new InvalidStateError('This allocation is taken back already.')
    if (original.depositRequestId) {
      const request = await tools.tx.depositRequest.findUnique({ where: { id: original.depositRequestId }, select: { status: true } })
      if (request?.status === 'PAID') throw new InvalidStateError('The deposit request is PAID with this payment: its allocations stay (a refund is a credit note and a refund, W2).')
    }
    const id = newId()
    await tools.tx.paymentAllocation.create({
      data: { id, companyId: payment.companyId, partyId: payment.partyId, paymentId: payment.id, invoiceId: original.invoiceId, depositRequestId: original.depositRequestId, amount: -original.amount, reversalOfId: original.id, note, createdAt: tools.now, createdById: actorIdOf(tools) },
      select: { id: true },
    })
    // B-W1-51: taking money back unsettles a settled order (order.unsettled), announced at the end.
    await settleOrders(tools, original.invoiceId ? await ordersOfInvoices(tools.tx, [original.invoiceId]) : await ordersOfRequests(tools.tx, [original.depositRequestId!]))
    const target: AllocationTarget = original.invoiceId ? 'INVOICE' : 'DEPOSIT_REQUEST'
    const targetId = (original.invoiceId ?? original.depositRequestId)!
    tools.audit({ action: 'payments.reverseAllocation', recordType: 'PaymentAllocation', recordId: id, companyId: payment.companyId, after: { paymentId: payment.id, reversalOfId: original.id, target, targetId, amount: markMoney('price', -original.amount) }, reason: note })
    tools.emit({ type: 'payment.allocation_reversed', subject: payment.id, companyId: payment.companyId, payload: { paymentId: payment.id, allocationId: id, reversalOfId: original.id, target, targetId } })
    return { payment: await paymentDetail(tools.tx, (await readPayment(tools.tx, payment.id))!) }
  })
  return result
}

/** payments.void: voids a payment typed by mistake, once its allocations add up to 0 (reverse them first). */
export async function voidPayment(caller: CommandCaller, paymentId: string, body: { version?: number | undefined; reason: string }, idempotencyKey?: string): Promise<{ payment: PaymentDetail }> {
  const payment = await officePayment(caller, paymentId, PAYMENTS_VOID)
  const reason = blankToNull(body.reason)
  if (!reason) throw new ValidationError('Say why the payment is voided.', [{ path: 'body/reason', message: 'Required.' }])
  const { result } = await command(caller, { name: 'payments.void', idempotencyKey, input: { paymentId, ...body }, record: { type: 'Payment', id: payment.id, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } }, async (tools) => {
    await lockMoney(tools.tx, tools.context, 'payment', payment.id)
    const current = (await readPayment(tools.tx, payment.id))!
    const problems = voidProblems({ status: current.status, allocated: await allocatedOf(tools.tx, current.id), refunded: await refundedOf(tools.tx, current.id) })
    if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
    // B-W2a-F1: a payment received inside a HARD period lock is not voided: 409 in words before the database's.
    const receivedOn = current.receivedOn.toISOString().slice(0, 10)
    await refuseHardLocked(tools.tx, tools.context, [{ companyId: current.companyId, day: receivedOn, refused: `the payment received on ${dayWords(receivedOn)} (bank reference ${current.externalRef}) is not voided`, path: 'paymentId' }])
    await tools.tx.payment.update({ where: { id: current.id }, data: { status: 'VOIDED', voidedAt: tools.now, voidReason: reason }, select: { id: true } })
    tools.audit({ recordType: 'Payment', recordId: current.id, companyId: current.companyId, before: { status: 'RECEIVED' }, after: { status: 'VOIDED' }, reason })
    tools.emit({ type: 'payment.voided', subject: current.id, companyId: current.companyId, payload: { paymentId: current.id } })
    return { payment: await paymentDetail(tools.tx, (await readPayment(tools.tx, current.id))!) }
  })
  return result
}
