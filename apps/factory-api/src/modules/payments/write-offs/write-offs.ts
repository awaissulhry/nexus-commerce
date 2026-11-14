import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { openOnInvoice } from '@nexus/factory-domain/payments/payments'
import { PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import { PAYMENTS_WRITE_OFF } from '@nexus/factory-domain/payments/write-offs/permissions'
import { MAX_WRITE_OFF_NOTE, noteOf, WRITE_OFF_KIND_WORDS, WRITE_OFF_REASON_WORDS, WRITE_OFF_REFUSAL_WORDS, writeOffProblem, type WriteOffKind, type WriteOffReason, type WriteOffRefusal } from '@nexus/factory-domain/payments/write-offs/write-offs'
import { RECEIVABLES_SETTINGS_MANAGE, RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID } from '../../../core/context'
import { mayEveryCompany } from '../../receivables/store'
import { lockMoney } from '../locks'
import { refundedOf } from '../refunds'
import { allocatedOf, officeContextOf, officePayment, readPayment, type Reader } from '../store'
import { overpaymentWrittenOff, toleranceOf, underpaymentWrittenOff } from './sums'

/**
 * Small differences written off (B-W2b-393; FIN-119; design finance.payments rec allocation "small difference → write-off
 * within tolerance"):
 *
 *   GET  /payments/:paymentId/write-offs                  payments.view: the payment's write-offs (and reversals), what
 *                                                         it could write off now (its leftover, each short invoice) with
 *                                                         the tolerance in force
 *   POST /payments/:paymentId/write-offs                  payments.writeOff: {kind, allocationId (UNDERPAYMENT), reason,
 *                                                         note?}: the WHOLE difference — the payment's leftover
 *                                                         (OVERPAYMENT), or what the allocation's invoice is still open
 *                                                         for (UNDERPAYMENT) — within the tolerance
 *   POST /payments/:paymentId/write-offs/:writeOffId/reverse  payments.writeOff: {note}: a reversal row
 *   GET  /payments/write-offs/tolerance?companyId         receivables.view: the tolerance in force and where it comes from
 *   PUT  /payments/write-offs/tolerance                   receivables.settings.manage: {companyId (null: every company),
 *                                                         amount (null: none), version?}: on the company's receivables
 *                                                         settings row (which must exist: the receivables settings make it)
 *                                                         or the tenant-wide one (made with its defaults when missing)
 *
 * Under the money locks (payment, then the invoice), every sum read under them; refusals 409 `writeOff/<CODE>` in words
 * (factory-domain write-offs). Accepting a bank line writes off at matching through writeOffInCommand (matching/accept.ts).
 */

const refused = (code: WriteOffRefusal): DomainError => new DomainError('conflict', WRITE_OFF_REFUSAL_WORDS[code], [{ path: `writeOff/${code}`, message: WRITE_OFF_REFUSAL_WORDS[code] }])
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string => (tools.context.audience === 'office' ? tools.context.actorId : SYSTEM_ACTOR_ID)

export interface WriteOffRow {
  readonly companyId: string
  readonly partyId: string
  readonly paymentId: string
  readonly kind: WriteOffKind
  /** UNDERPAYMENT: the allocation short-paying the invoice. */
  readonly allocationId: string | null
  /** UNDERPAYMENT: that invoice (for the event). */
  readonly invoiceId: string | null
  readonly amount: number
  readonly reason: WriteOffReason
  readonly note: string | null
  readonly tolerance: number
}

/** Inside a command that holds the money locks and checked the difference: the write-off, audited, with its event. */
export async function writeOffInCommand(tools: CommandTools, row: WriteOffRow): Promise<string> {
  const id = newId()
  await tools.tx.paymentWriteOff.create({
    data: { id, companyId: row.companyId, partyId: row.partyId, paymentId: row.paymentId, allocationId: row.allocationId, kind: row.kind, amount: row.amount, reason: row.reason, note: row.note, toleranceAmount: row.tolerance, writtenOffById: actorIdOf(tools), createdAt: tools.now },
    select: { id: true },
  })
  tools.audit({ action: 'payments.writeOff', recordType: 'PaymentWriteOff', recordId: id, companyId: row.companyId, after: { paymentId: row.paymentId, kind: row.kind, allocationId: row.allocationId, amount: markMoney('price', row.amount), reason: row.reason, tolerance: markMoney('price', row.tolerance) }, ...(row.note ? { reason: row.note } : {}) })
  tools.emit({ type: 'payment.written_off', subject: row.paymentId, companyId: row.companyId, payload: { writeOffId: id, paymentId: row.paymentId, partyId: row.partyId, kind: row.kind, invoiceId: row.invoiceId } })
  return id
}

/** Inside a command: a write-off still standing taken back by a reversal row (the same kind and allocation). */
export async function reverseWriteOffInCommand(tools: CommandTools, writeOffId: string, note: string): Promise<string> {
  const original = await tools.tx.paymentWriteOff.findUnique({ where: { id: writeOffId }, select: { id: true, companyId: true, partyId: true, paymentId: true, allocationId: true, kind: true, amount: true, reason: true, toleranceAmount: true, reversalOfId: true, reversals: { select: { id: true } } } })
  if (!original) throw new NotFoundError('Write-off not found.')
  if (original.reversalOfId) throw refused('A_REVERSAL')
  if (original.reversals.length > 0) throw refused('REVERSED_ALREADY')
  const id = newId()
  await tools.tx.paymentWriteOff.create({
    data: { id, companyId: original.companyId, partyId: original.partyId, paymentId: original.paymentId, allocationId: original.allocationId, kind: original.kind, amount: -original.amount, reason: original.reason, note: note.slice(0, MAX_WRITE_OFF_NOTE), toleranceAmount: original.toleranceAmount, reversalOfId: original.id, writtenOffById: actorIdOf(tools), createdAt: tools.now },
    select: { id: true },
  })
  tools.audit({ action: 'payments.writeOffReverse', recordType: 'PaymentWriteOff', recordId: id, companyId: original.companyId, after: { paymentId: original.paymentId, reversalOfId: original.id, kind: original.kind, amount: markMoney('price', -original.amount) }, reason: note })
  tools.emit({ type: 'payment.write_off_reversed', subject: original.paymentId, companyId: original.companyId, payload: { writeOffId: id, reversalOfId: original.id, paymentId: original.paymentId, partyId: original.partyId, kind: original.kind } })
  return id
}

/** What a payment could write off now: its leftover, and what each invoice it short-pays is still open for. */
async function differencesOf(db: Reader, payment: { readonly id: string; readonly amount: number; readonly status: string }) {
  const leftover = payment.status === 'RECEIVED' ? payment.amount - (await allocatedOf(db, payment.id)) - (await refundedOf(db, payment.id)) - (await overpaymentWrittenOff(db, payment.id)) : 0
  const allocations = await db.paymentAllocation.findMany({ where: { paymentId: payment.id, invoiceId: { not: null } }, select: { id: true, invoiceId: true, reversalOfId: true } })
  const reversed = new Set(allocations.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
  const live = allocations.filter((row) => row.reversalOfId === null && !reversed.has(row.id))
  const short: { allocationId: string; invoiceId: string; number: string | null; open: number }[] = []
  for (const allocation of live) {
    const invoice = await db.invoice.findUnique({ where: { id: allocation.invoiceId! }, select: { id: true, number: true, grossTotal: true } })
    if (!invoice) continue
    const credited = (await db.invoice.aggregate({ where: { creditOfId: invoice.id, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } }))._sum.grossTotal ?? 0
    const paid = (await db.paymentAllocation.aggregate({ where: { invoiceId: invoice.id }, _sum: { amount: true } }))._sum.amount ?? 0
    const open = openOnInvoice(invoice.grossTotal, credited, paid + (await underpaymentWrittenOff(db, invoice.id)))
    if (open > 0 && !short.some((entry) => entry.invoiceId === invoice.id)) short.push({ allocationId: allocation.id, invoiceId: invoice.id, number: invoice.number, open })
  }
  return { leftover: Math.max(0, leftover), short }
}

/** GET /payments/:paymentId/write-offs. */
export async function listWriteOffs(caller: CommandCaller, paymentId: string) {
  const payment = await officePayment(caller, paymentId, PAYMENTS_VIEW)
  return caller.withClient(async (db) => {
    const rows = await db.paymentWriteOff.findMany({ where: { paymentId: payment.id }, select: { id: true, kind: true, allocationId: true, amount: true, reason: true, note: true, toleranceAmount: true, reversalOfId: true, writtenOffById: true, createdAt: true, allocation: { select: { invoiceId: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const reversed = new Set(rows.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
    const tolerance = await toleranceOf(db, payment.companyId)
    const differences = await differencesOf(db, payment)
    const within = (amount: number) => tolerance.amount !== null && amount > 0 && amount <= tolerance.amount
    return {
      paymentId: payment.id,
      tolerance: { amount: asMoney('price', tolerance.amount), source: tolerance.source },
      writeOffs: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        kindWords: WRITE_OFF_KIND_WORDS[row.kind],
        allocationId: row.allocationId,
        invoiceId: row.allocation?.invoiceId ?? null,
        amount: asMoney('price', row.amount),
        reason: row.reason,
        reasonWords: WRITE_OFF_REASON_WORDS[row.reason],
        note: row.note,
        toleranceAmount: asMoney('price', row.toleranceAmount),
        reversalOfId: row.reversalOfId,
        reversed: reversed.has(row.id),
        writtenOffById: row.writtenOffById,
        createdAt: toUtcIso(row.createdAt),
      })),
      // What may be written off now (each the whole difference), and whether it is within the tolerance.
      possible: [
        ...(differences.leftover > 0 ? [{ kind: 'OVERPAYMENT' as const, allocationId: null, invoiceId: null, number: null, amount: asMoney('price', differences.leftover), withinTolerance: within(differences.leftover) }] : []),
        ...differences.short.map((entry) => ({ kind: 'UNDERPAYMENT' as const, allocationId: entry.allocationId, invoiceId: entry.invoiceId, number: entry.number, amount: asMoney('price', entry.open), withinTolerance: within(entry.open) })),
      ],
    }
  })
}

/** POST /payments/:paymentId/write-offs: the whole difference written off, within the tolerance. */
export async function writeOffPayment(caller: CommandCaller, paymentId: string, body: { readonly kind: WriteOffKind; readonly allocationId?: string | undefined; readonly reason: WriteOffReason; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const payment = await officePayment(caller, paymentId, PAYMENTS_WRITE_OFF)
  const note = noteOf(body.note)
  if ((body.kind === 'UNDERPAYMENT') !== (body.allocationId !== undefined)) throw new ValidationError('A write-off of a little less names the allocation whose invoice it closes; one of a little more names none.', [{ path: 'body/allocationId', message: body.kind === 'UNDERPAYMENT' ? 'Required.' : 'Leave it out.' }])
  const { result } = await command(caller, { name: 'payments.writeOff', idempotencyKey, input: { paymentId, ...body }, record: { type: 'Payment', id: payment.id } }, async (tools) => {
    const { tx } = tools
    await lockMoney(tx, tools.context, 'payment', payment.id)
    const current = (await readPayment(tx, payment.id))!
    if (current.status !== 'RECEIVED') throw refused('NOT_RECEIVED')
    let amount: number
    let invoiceId: string | null = null
    if (body.kind === 'UNDERPAYMENT') {
      const allocation = isUuid(body.allocationId!) ? await tx.paymentAllocation.findFirst({ where: { id: body.allocationId!, paymentId: payment.id }, select: { id: true, invoiceId: true, reversalOfId: true } }) : null
      if (!allocation || !allocation.invoiceId || allocation.reversalOfId || (await tx.paymentAllocation.findFirst({ where: { reversalOfId: allocation.id }, select: { id: true } }))) throw refused('NOT_AN_INVOICE_ALLOCATION')
      invoiceId = allocation.invoiceId
      await lockMoney(tx, tools.context, 'invoice', invoiceId)
      amount = (await differencesOf(tx, current)).short.find((entry) => entry.invoiceId === invoiceId)?.open ?? 0
    } else amount = (await differencesOf(tx, current)).leftover
    const tolerance = (await toleranceOf(tx, current.companyId)).amount
    const problem = writeOffProblem({ amount, tolerance, reason: body.reason, note })
    if (problem) throw refused(problem)
    const id = await writeOffInCommand(tools, { companyId: current.companyId, partyId: current.partyId, paymentId: current.id, kind: body.kind, allocationId: body.allocationId ?? null, invoiceId, amount, reason: body.reason, note, tolerance: tolerance! })
    return { writeOffId: id, paymentId: current.id, kind: body.kind, amount: asMoney('price', amount) }
  })
  return result
}

/** POST /payments/:paymentId/write-offs/:writeOffId/reverse. */
export async function reverseWriteOff(caller: CommandCaller, paymentId: string, writeOffId: string, body: { readonly note: string }, idempotencyKey?: string) {
  const payment = await officePayment(caller, paymentId, PAYMENTS_WRITE_OFF)
  const note = noteOf(body.note)
  if (!note) throw refused('NOTE_NEEDED')
  const { result } = await command(caller, { name: 'payments.writeOffReverse', idempotencyKey, input: { paymentId, writeOffId, note }, record: { type: 'Payment', id: payment.id } }, async (tools) => {
    await lockMoney(tools.tx, tools.context, 'payment', payment.id)
    const original = isUuid(writeOffId) ? await tools.tx.paymentWriteOff.findFirst({ where: { id: writeOffId, paymentId: payment.id }, select: { id: true, allocation: { select: { invoiceId: true } } } }) : null
    if (!original) throw new NotFoundError('Write-off not found.')
    if (original.allocation?.invoiceId) await lockMoney(tools.tx, tools.context, 'invoice', original.allocation.invoiceId)
    const id = await reverseWriteOffInCommand(tools, original.id, note)
    return { writeOffId: id, reversalOfId: original.id, paymentId: payment.id }
  })
  return result
}

// ---- the tolerance ------------------------------------------------------------------------------------------------------

/** GET /payments/write-offs/tolerance?companyId. */
export async function getTolerance(caller: CommandCaller, query: { readonly companyId: string }) {
  const context = officeContextOf(caller)
  if (!can(actorOf(context), RECEIVABLES_VIEW, { companyId: query.companyId })) throw new NotFoundError('Company not found.')
  return caller.withClient(async (db) => {
    const rows = await db.receivablesSettings.findMany({ where: { OR: [{ companyId: query.companyId }, { companyId: null }] }, select: { id: true, companyId: true, version: true, writeOffToleranceAmount: true } })
    const company = rows.find((row) => row.companyId === query.companyId) ?? null
    const tenant = rows.find((row) => row.companyId === null) ?? null
    const inForce = await toleranceOf(db, query.companyId)
    const view = (row: typeof company) => (row ? { settingsId: row.id, version: row.version, amount: asMoney('price', row.writeOffToleranceAmount) } : null)
    return {
      companyId: query.companyId,
      inForce: { amount: asMoney('price', inForce.amount), source: inForce.source },
      company: view(company),
      tenant: view(tenant),
      mayChange: can(actorOf(context), RECEIVABLES_SETTINGS_MANAGE, { companyId: query.companyId }),
    }
  })
}

/** PUT /payments/write-offs/tolerance. */
export async function putTolerance(caller: CommandCaller, body: { readonly companyId: string | null; readonly amount?: number | null | undefined; readonly version?: number | undefined }, idempotencyKey?: string) {
  const amount = body.amount ?? null
  const context = officeContextOf(caller)
  const may = body.companyId === null ? mayEveryCompany(context, RECEIVABLES_SETTINGS_MANAGE) : can(actorOf(context), RECEIVABLES_SETTINGS_MANAGE, { companyId: body.companyId })
  if (!may) throw new ForbiddenError(body.companyId === null ? 'The tolerance of every company is changed only by a role over every company.' : undefined)
  const { result } = await command(caller, { name: 'payments.writeOffTolerance', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    if (tools.context.audience === 'platform') throw new ForbiddenError()
    const id = body.companyId ?? tools.context.tenantId
    await tx.$queryRaw`SELECT id FROM "ReceivablesSettings" WHERE id = ${id}::uuid FOR UPDATE`
    const row = await tx.receivablesSettings.findUnique({ where: { id }, select: { id: true, companyId: true, version: true, writeOffToleranceAmount: true } })
    if (amount !== null && amount < 0) throw new ValidationError('A tolerance of 0 or more.', [{ path: 'body/amount', message: 'At least 0.' }])
    if (row && (body.version === undefined || body.version !== row.version)) throw new DomainError('conflict', `These settings changed since they were read; they are now at version ${row.version}. Reload them and change them again.`, [{ path: 'body/version', message: `The current version is ${row.version}.` }])
    if (!row && body.companyId !== null) throw new InvalidStateError("This company has no receivables settings of its own: save them first (Finance › Settings › Receivables), or set the tolerance for every company.")
    if (!row && body.version !== undefined) throw new DomainError('conflict', 'These settings do not exist yet: send no version to make them.', [{ path: 'body/version', message: 'Leave it out for new settings.' }])
    const saved = row
      ? await tx.receivablesSettings.update({ where: { id }, data: { writeOffToleranceAmount: amount, version: row.version + 1, updatedAt: tools.now }, select: { id: true, version: true } })
      : await tx.receivablesSettings.create({ data: { id, companyId: null, writeOffToleranceAmount: amount, createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools) }, select: { id: true, version: true } })
    tools.audit({ action: 'payments.writeOffTolerance', recordType: 'ReceivablesSettings', recordId: id, companyId: body.companyId, before: { writeOffToleranceAmount: markMoney('price', row?.writeOffToleranceAmount ?? null) }, after: { writeOffToleranceAmount: markMoney('price', amount) } })
    tools.emit({ type: 'write_off_tolerance.changed', subject: id, companyId: body.companyId, payload: { settingsId: id, companyId: body.companyId, set: amount !== null } })
    return { settingsId: saved.id, version: saved.version }
  })
  return { ...result, tolerance: body.companyId === null ? null : await getTolerance(caller, { companyId: body.companyId }) }
}
