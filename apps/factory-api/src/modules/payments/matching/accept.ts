import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { dayWords } from '@nexus/factory-domain/accounting/periods'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { PAYMENTS_BANK_MATCH } from '@nexus/factory-domain/payments/bank/permissions'
import { differenceOf, planLine, type LineItem } from '@nexus/factory-domain/payments/matching/accept'
import { chosenReasons, MAX_MATCH_ITEMS, type ItemKind } from '@nexus/factory-domain/payments/matching/match'
import { normaliseBankReference, bankReferenceProblem } from '@nexus/factory-domain/payments/payments'
import { PAYMENTS_RECORD, PAYMENTS_VIEW, PAYMENTS_VOID } from '@nexus/factory-domain/payments/permissions'
import { PAYMENTS_WRITE_OFF } from '@nexus/factory-domain/payments/write-offs/permissions'
import { noteOf, WRITE_OFF_REFUSAL_WORDS, type WriteOffReason } from '@nexus/factory-domain/payments/write-offs/write-offs'
import { PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type OfficeContext } from '../../../core/context'
import { honourPeriodLocks } from '../../accounting/period-guard'
import { ordersOfInvoices, ordersOfRequests, settleOrders } from '../../invoicing/from-shipment/settlement'
import { LINE_COLUMNS, MATCH_COLUMNS, type LineRow, type MatchRow } from '../bank/store'
import { lockAll, lockMoney } from '../locks'
import { allocateInCommand, insertPayment, isUniqueViolation, type Allocated } from '../payments'
import { officeContextOf, readPayment } from '../store'
import { toleranceOf } from '../write-offs/sums'
import { reverseWriteOffInCommand, writeOffInCommand } from '../write-offs/write-offs'
import { openItemsOf, partiesOf } from './facts'
import { linesNaming, lockMatching, refreshSuggestions } from './suggest'

/**
 * Accepting what a bank line is (B-W2b-393; FIN-132, FIN-119; design finance.bank sec:match "Accept · choose another ·
 * split · leave unmatched", "Accept all High (ReviewChangesModal)"). A person accepts every match: nothing moves by a
 * suggestion alone.
 *
 *   POST /payments/bank/matches/:matchId/accept     accept a suggestion {version, writeOff?}
 *   POST /payments/bank/lines/:lineId/match         a person's own choice: the party and its items (with amounts: a
 *                                                   split), or a payment typed by hand, or (money out) a supplier
 *                                                   invoice; inserted already accepted, reason CHOSEN_BY_PERSON
 *   POST /payments/bank/matches/accept              accept up to 50 suggestions at once (the sure ones), all or none
 *   POST /payments/bank/matches/:matchId/reverse    take a wrong acceptance back {version, reason}
 *
 * Money in with items, in ONE command: the items' money locks (deposit requests, then invoices), what is open on them
 * read under them, the line placed on them oldest first (planLine), the Payment recorded (the line's amount, its bank
 * reference — or BANKLINE-<line id> when the bank gave none —, received on the value day, else the booking day) and
 * allocated (W1's allocateInCommand: a deposit request it covers becomes PAID, orders settle), the difference written off
 * when the person asks and it is within the tolerance, then the match accepted with that payment. A payment typed by hand
 * (the reconciliation of today's manual work) is accepted as it is; money out names the supplier invoice it paid (its
 * PAID stays payables' action). The line's other suggestions go, and the suggestions of other lines that named the same
 * items or payment are looked at again. Taking back an acceptance that recorded its payment takes back its write-offs and
 * allocations and voids the payment first (W1's rules: a PAID deposit request keeps its money), in the same command.
 *
 * Who: payments.bank.match over the company; money in also payments.record (and payments.writeOff to write off) over
 * the company and the party; money out payables.view; taking a recorded payment back payments.void.
 */

export interface WriteOffAsk {
  readonly reason: WriteOffReason
  readonly note?: string | null | undefined
}

export interface ItemAsk {
  readonly invoiceId?: string | undefined
  readonly depositRequestId?: string | undefined
  /** Minor units (a split); absent: what fits, oldest first. */
  readonly amount?: number | undefined
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string => (tools.context.audience === 'office' ? tools.context.actorId : SYSTEM_ACTOR_ID)
const day = (value: Date): string => value.toISOString().slice(0, 10)

/** 403 unless the caller may do `permission` over the company and party (the bank's own check came first). */
function mayOn(context: OfficeContext, permission: Permission, companyId: string, partyId: string): void {
  if (!can(actorOf(context), permission, { companyId, partyId })) throw new ForbiddenError()
}

/** The checks of the kind of match (money in with items, a payment, money out) for this caller. */
function assertMayAccept(context: OfficeContext, line: Pick<LineRow, 'companyId' | 'amount'>, match: { readonly partyId: string; readonly items: number; readonly paymentId: string | null; readonly supplierInvoiceId: string | null }, writeOff: WriteOffAsk | undefined): void {
  if (!can(actorOf(context), PAYMENTS_BANK_MATCH, { companyId: line.companyId })) throw new ForbiddenError()
  if (line.amount > 0) {
    mayOn(context, PAYMENTS_VIEW, line.companyId, match.partyId)
    if (match.items > 0) mayOn(context, PAYMENTS_RECORD, line.companyId, match.partyId)
    if (writeOff) mayOn(context, PAYMENTS_WRITE_OFF, line.companyId, match.partyId)
  } else mayOn(context, PAYABLES_VIEW, line.companyId, match.partyId)
}

const writeOffRefused = (code: keyof typeof WRITE_OFF_REFUSAL_WORDS): DomainError => new DomainError('conflict', WRITE_OFF_REFUSAL_WORDS[code], [{ path: `writeOff/${code}`, message: WRITE_OFF_REFUSAL_WORDS[code] }])

/** The bank reference the recorded payment carries: the line's (one form), else one made of the line's id. */
function paymentReferenceOf(line: Pick<LineRow, 'id' | 'bankReference'>): string {
  const own = normaliseBankReference(line.bankReference)
  return own !== null && bankReferenceProblem(own) === null ? own : `BANKLINE-${line.id.toUpperCase()}`
}

/** The line, read in the command under its company's matching lock, with no live acceptance yet. */
async function openLine(tools: CommandTools, lineId: string): Promise<LineRow> {
  const line = await tools.tx.bankLine.findUnique({ where: { id: lineId }, select: LINE_COLUMNS })
  if (!line) throw new NotFoundError('Bank line not found.')
  await lockMatching(tools.tx, tools.context, line.companyId)
  const live = await tools.tx.bankMatch.findFirst({ where: { bankLineId: line.id, acceptedAt: { not: null }, reversedAt: null }, select: { id: true } })
  if (live) throw new ConflictError('This bank line is matched already: take that acceptance back first.')
  return line
}

/**
 * Money in with items, inside the command: locks, what is open, the plan, the payment and its allocations, the write-off.
 * Answers the payment's id.
 */
async function recordForLine(tools: CommandTools, line: LineRow, partyId: string, asks: readonly { readonly kind: ItemKind; readonly id: string; readonly amount?: number | undefined }[], writeOff: WriteOffAsk | undefined, override: PeriodLockOverride | undefined): Promise<string> {
  const { tx } = tools
  if (line.currency !== 'EUR') throw new ConflictError(`Payments are recorded in euro (W1): this line is in ${line.currency}. Record it by hand once payments in other currencies come.`)
  await lockAll(tx, tools.context, 'deposit', asks.filter((ask) => ask.kind === 'DEPOSIT_REQUEST').map((ask) => ask.id))
  await lockAll(tx, tools.context, 'invoice', asks.filter((ask) => ask.kind === 'INVOICE').map((ask) => ask.id))
  const open = await openItemsOf(tx, line.companyId, { invoiceIds: asks.filter((ask) => ask.kind === 'INVOICE').map((ask) => ask.id), depositRequestIds: asks.filter((ask) => ask.kind === 'DEPOSIT_REQUEST').map((ask) => ask.id) })
  const labels = await tx.invoice.findMany({ where: { id: { in: asks.filter((ask) => ask.kind === 'INVOICE').map((ask) => ask.id) } }, select: { id: true, number: true, buyerPartyId: true, currency: true } })
  const issues: Issue[] = []
  const items: LineItem[] = asks.map((ask, index) => {
    const found = open.find((item) => item.id === ask.id)
    if (found && (found.partyId !== partyId || found.currency !== line.currency)) issues.push({ path: `items/${index}`, message: "Not an open item of this line's customer in its currency." })
    const label = ask.kind === 'INVOICE' ? `invoice ${labels.find((row) => row.id === ask.id)?.number ?? '(not issued)'}` : `deposit request${found?.number ? ` of order ${found.number}` : ''}`
    return { kind: ask.kind, id: ask.id, open: found && found.partyId === partyId ? found.open : 0, amount: ask.amount, label, path: `items/${index}` }
  })
  const plan = planLine(line.amount, items, line.currency)
  const all = [...issues, ...plan.issues]
  if (all.length > 0) throw new DomainError('conflict', all.length === 1 ? all[0]!.message : 'This line cannot be placed on these items.', all)
  if (plan.allocations.length === 0) throw new ConflictError('This line places nothing on these items.')
  const tolerance = (await toleranceOf(tx, line.companyId)).amount
  const difference = differenceOf(plan, tolerance)
  if (writeOff) {
    if (difference.kind === null) throw writeOffRefused('NOTHING_LEFT')
    if (difference.refusal) throw writeOffRefused(difference.refusal)
    if (writeOff.reason === 'OTHER' && noteOf(writeOff.note) === null) throw writeOffRefused('NOTE_NEEDED')
  }
  const externalRef = paymentReferenceOf(line)
  const counted = await tx.payment.findFirst({ where: { companyId: line.companyId, externalRef }, select: { id: true, createdAt: true } })
  if (counted) throw new DomainError('conflict', `This bank reference was recorded on ${businessDate(counted.createdAt)} as payment ${counted.id}: choose that payment for the line instead of recording it again.`, [{ path: 'line/RECORDED_ALREADY', message: 'Recorded already.' }])
  const today = businessDate(tools.now)
  const value = line.valueOn ? day(line.valueOn) : null
  const receivedOn = value !== null && value <= today ? value : day(line.bookedOn)
  const payment = await insertPayment(tools, { companyId: line.companyId, partyId, amount: line.amount, currency: line.currency, receivedOn, externalRef, method: 'BANK_TRANSFER', internalNote: null }, override)
  const written: Allocated[] = await allocateInCommand(tools, payment, plan.allocations.map((allocation) => (allocation.kind === 'INVOICE' ? { invoiceId: allocation.id, amount: allocation.amount } : { depositRequestId: allocation.id, amount: allocation.amount })), 'items')
  if (writeOff && difference.kind !== null) {
    const allocationId = difference.kind === 'UNDERPAYMENT' ? (written.find((entry) => entry.targetId === difference.invoiceId)?.allocationId ?? null) : null
    await writeOffInCommand(tools, { companyId: line.companyId, partyId, paymentId: payment.id, kind: difference.kind, allocationId, invoiceId: difference.invoiceId, amount: difference.amount, reason: writeOff.reason, note: noteOf(writeOff.note), tolerance: tolerance! })
  }
  return payment.id
}

/** After an acceptance: the line's other suggestions go; other lines naming the same things are looked at again. */
async function afterAcceptance(tools: CommandTools, line: LineRow, match: { readonly id: string; readonly invoiceIds: readonly string[]; readonly depositRequestIds: readonly string[]; readonly paymentId: string | null }): Promise<void> {
  await tools.tx.bankMatch.deleteMany({ where: { bankLineId: line.id, acceptedAt: null, id: { not: match.id } } })
  const others = (await linesNaming(tools.tx, line.companyId, { invoiceIds: match.invoiceIds, depositRequestIds: match.depositRequestIds, paymentIds: match.paymentId ? [match.paymentId] : [] })).filter((id) => id !== line.id)
  await refreshSuggestions(tools, line.companyId, others)
}

interface AcceptInput {
  readonly writeOff?: WriteOffAsk | undefined
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

/** Accepts one suggestion inside a command (its row locked by the caller). Answers what it recorded. */
async function acceptInCommand(tools: CommandTools, match: MatchRow, input: AcceptInput): Promise<{ paymentId: string | null; recorded: boolean }> {
  if (match.acceptedAt !== null) throw new ConflictError(match.reversedAt ? 'This match was taken back: choose again for the line.' : 'This match is accepted already.')
  const line = await openLine(tools, match.bankLineId)
  const items = match.invoiceIds.length + match.depositRequestIds.length
  if (input.writeOff && !(line.amount > 0 && items > 0)) throw writeOffRefused('NOTHING_LEFT')
  let paymentId = match.paymentId
  let recorded = false
  if (line.amount > 0 && items > 0) {
    paymentId = await recordForLine(tools, line, match.partyId, [...match.invoiceIds.map((id) => ({ kind: 'INVOICE' as const, id })), ...match.depositRequestIds.map((id) => ({ kind: 'DEPOSIT_REQUEST' as const, id }))], input.writeOff, input.periodLockOverride)
    recorded = true
  } else if (paymentId) {
    const payment = await readPayment(tools.tx, paymentId)
    if (!payment || payment.status !== 'RECEIVED' || payment.amount !== line.amount || payment.currency !== line.currency) throw new ConflictError('The payment this match names is no longer one of this line (voided or changed): look again.')
  }
  await tools.tx.bankMatch.update({ where: { id: match.id }, data: { acceptedAt: tools.now, acceptedById: actorIdOf(tools), ...(recorded ? { paymentId } : {}) }, select: { id: true } })
  tools.audit({ action: 'payments.bank.accept', recordType: 'BankMatch', recordId: match.id, companyId: line.companyId, after: { bankLineId: line.id, partyId: match.partyId, confidence: match.confidence, reasons: match.reasons, invoiceIds: match.invoiceIds, depositRequestIds: match.depositRequestIds, paymentId, supplierInvoiceId: match.supplierInvoiceId, recorded, amount: markMoney('price', line.amount) } })
  tools.emit({ type: 'bank_match.accepted', subject: match.id, companyId: line.companyId, payload: { matchId: match.id, bankLineId: line.id, partyId: match.partyId, paymentId, supplierInvoiceId: match.supplierInvoiceId, recorded, chosenByPerson: match.reasons.includes('CHOSEN_BY_PERSON') } })
  await afterAcceptance(tools, line, { id: match.id, invoiceIds: match.invoiceIds, depositRequestIds: match.depositRequestIds, paymentId })
  return { paymentId, recorded }
}

/** A suggestion the office may see (404) and accept (403). */
async function officeMatch(caller: CommandCaller, matchId: string, writeOff: WriteOffAsk | undefined): Promise<{ match: MatchRow; line: LineRow }> {
  const context = officeContextOf(caller)
  const found = isUuid(matchId) ? await caller.withClient(async (db) => {
    const match = await db.bankMatch.findUnique({ where: { id: matchId }, select: MATCH_COLUMNS })
    const line = match ? await db.bankLine.findUnique({ where: { id: match.bankLineId }, select: LINE_COLUMNS }) : null
    return match && line ? { match, line } : null
  }) : null
  if (!found || !can(actorOf(context), 'payments.bank.view', { companyId: found.line.companyId })) throw new NotFoundError('Match not found.')
  assertMayAccept(context, found.line, { partyId: found.match.partyId, items: found.match.invoiceIds.length + found.match.depositRequestIds.length, paymentId: found.match.paymentId, supplierInvoiceId: found.match.supplierInvoiceId }, writeOff)
  return found
}

/** The database's own words when a bank rule refused a write (…_bank_bridge_w2b_guards: check_violation 'bank: …'). */
function bankRuleRefusal(error: unknown): string | null {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  return cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('bank: ') ? cause.originalMessage : null
}

/**
 * A unique key the acceptance hit (the line or the payment accepted meanwhile), or a bank rule a race reached before the
 * command's own check (a match accepted or taken back meanwhile): 409 in words, never a 500.
 */
async function accepting<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work()
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('This line or this payment was just matched by someone else: look again.')
    if (bankRuleRefusal(error)) throw new ConflictError('This match changed meanwhile (accepted or taken back by someone else): look again.')
    throw error
  }
}

/** POST /payments/bank/matches/:matchId/accept. */
export async function acceptMatch(caller: CommandCaller, matchId: string, body: AcceptInput & { readonly version: number }, idempotencyKey?: string) {
  const { match } = await officeMatch(caller, matchId, body.writeOff)
  // An accepted (or taken back) match is frozen: say so before the command touches its row.
  if (match.acceptedAt !== null) throw new ConflictError(match.reversedAt ? 'This match was taken back: choose again for the line.' : 'This match is accepted already.')
  return accepting(async () => {
    const { result } = await command(caller, { name: 'payments.bank.accept', idempotencyKey, input: { matchId, ...body }, record: { type: 'BankMatch', id: match.id, expectedVersion: body.version } }, async (tools) => {
      const current = (await tools.tx.bankMatch.findUnique({ where: { id: match.id }, select: MATCH_COLUMNS }))!
      const done = await acceptInCommand(tools, current, body)
      return { matchId: match.id, bankLineId: match.bankLineId, ...done }
    })
    return result
  })
}

export interface ChooseBody extends AcceptInput {
  readonly partyId: string
  readonly items?: readonly ItemAsk[] | undefined
  readonly paymentId?: string | undefined
  readonly supplierInvoiceId?: string | undefined
}

/** POST /payments/bank/lines/:lineId/match: a person's own choice, accepted at once. */
export async function chooseMatch(caller: CommandCaller, lineId: string, body: ChooseBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const line = isUuid(lineId) ? await caller.withClient((db) => db.bankLine.findUnique({ where: { id: lineId }, select: LINE_COLUMNS })) : null
  if (!line || !can(actorOf(context), 'payments.bank.view', { companyId: line.companyId })) throw new NotFoundError('Bank line not found.')
  const items = body.items ?? []
  const issues: Issue[] = []
  items.forEach((item, index) => {
    if ((item.invoiceId === undefined) === (item.depositRequestId === undefined)) issues.push({ path: `body/items/${index}`, message: 'Name one invoice or one deposit request.' })
  })
  const kinds = [items.length > 0, body.paymentId !== undefined, body.supplierInvoiceId !== undefined].filter(Boolean).length
  if (kinds !== 1) issues.push({ path: 'body', message: 'Name the items the line pays, or the payment it is, or (money out) the supplier invoice it paid: one of them.' })
  if (line.amount > 0 && body.supplierInvoiceId !== undefined) issues.push({ path: 'body/supplierInvoiceId', message: 'Money in pays customer items, not a supplier invoice.' })
  if (line.amount < 0 && body.supplierInvoiceId === undefined) issues.push({ path: 'body/supplierInvoiceId', message: 'Money out names the supplier invoice it paid.' })
  if (items.length > MAX_MATCH_ITEMS) issues.push({ path: 'body/items', message: `At most ${MAX_MATCH_ITEMS} items.` })
  const ids = items.map((item) => item.invoiceId ?? item.depositRequestId)
  if (new Set(ids).size !== ids.length) issues.push({ path: 'body/items', message: 'Each item once.' })
  if (body.writeOff && items.length === 0) issues.push({ path: 'body/writeOff', message: 'A difference is written off only when the line pays items.' })
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  assertMayAccept(context, line, { partyId: body.partyId, items: items.length, paymentId: body.paymentId ?? null, supplierInvoiceId: body.supplierInvoiceId ?? null }, body.writeOff)
  return accepting(async () => {
    const { result } = await command(caller, { name: 'payments.bank.choose', idempotencyKey, input: { lineId, ...body } }, async (tools) => {
      const current = await openLine(tools, line.id)
      const asks = items.map((item) => (item.invoiceId ? { kind: 'INVOICE' as const, id: item.invoiceId, amount: item.amount } : { kind: 'DEPOSIT_REQUEST' as const, id: item.depositRequestId!, amount: item.amount }))
      let paymentId: string | null = body.paymentId ?? null
      let open = 0
      let numbers: (string | null)[] = []
      if (asks.length > 0) {
        const found = await openItemsOf(tools.tx, current.companyId, { invoiceIds: asks.filter((ask) => ask.kind === 'INVOICE').map((ask) => ask.id), depositRequestIds: asks.filter((ask) => ask.kind === 'DEPOSIT_REQUEST').map((ask) => ask.id) })
        open = found.filter((item) => item.partyId === body.partyId).reduce((sum, item) => sum + item.open, 0)
        numbers = found.map((item) => item.number)
        paymentId = await recordForLine(tools, current, body.partyId, asks, body.writeOff, body.periodLockOverride)
      } else if (paymentId) {
        const payment = isUuid(paymentId) ? await readPayment(tools.tx, paymentId) : null
        if (!payment || payment.companyId !== current.companyId || payment.partyId !== body.partyId) throw new NotFoundError("Not a payment of this customer and company.")
        if (payment.status !== 'RECEIVED' || payment.amount !== current.amount || payment.currency !== current.currency) throw new ConflictError(`A bank line is the payment of its own amount: this payment is ${payment.status} for another amount or currency.`)
        open = payment.amount
        numbers = [payment.externalRef]
      } else {
        const invoice = isUuid(body.supplierInvoiceId!) ? await tools.tx.supplierInvoice.findUnique({ where: { id: body.supplierInvoiceId! }, select: { id: true, companyId: true, partyId: true, kind: true, status: true, currency: true, number: true, grossTotal: true, withholdingAmount: true } }) : null
        if (!invoice || invoice.companyId !== current.companyId || invoice.partyId !== body.partyId) throw new NotFoundError('Not a supplier invoice of this supplier and company.')
        if (invoice.kind !== 'INVOICE' || invoice.status === 'VOIDED' || invoice.currency !== current.currency) throw new ConflictError(`Money out pays a supplier's invoice that is not voided, in ${current.currency}.`)
        open = invoice.grossTotal - (invoice.withholdingAmount ?? 0)
        numbers = [invoice.number]
      }
      const [party] = await partiesOf(tools.tx, current.companyId, [body.partyId])
      if (!party) throw new NotFoundError('Party not found.')
      const { reasons, confidence } = chosenReasons(current, { partyId: body.partyId, open, numbers }, party, (await toleranceOf(tools.tx, current.companyId)).amount)
      const matchId = newId()
      const invoiceIds = asks.filter((ask) => ask.kind === 'INVOICE').map((ask) => ask.id)
      const depositRequestIds = asks.filter((ask) => ask.kind === 'DEPOSIT_REQUEST').map((ask) => ask.id)
      await tools.tx.bankMatch.create({
        data: { id: matchId, companyId: current.companyId, bankLineId: current.id, partyId: body.partyId, invoiceIds, depositRequestIds, paymentId, supplierInvoiceId: body.supplierInvoiceId ?? null, confidence, reasons, acceptedAt: tools.now, acceptedById: actorIdOf(tools), createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools) },
        select: { id: true },
      })
      const recorded = asks.length > 0
      tools.audit({ action: 'payments.bank.choose', recordType: 'BankMatch', recordId: matchId, companyId: current.companyId, after: { bankLineId: current.id, partyId: body.partyId, confidence, reasons, invoiceIds, depositRequestIds, paymentId, supplierInvoiceId: body.supplierInvoiceId ?? null, recorded, amount: markMoney('price', current.amount) } })
      tools.emit({ type: 'bank_match.accepted', subject: matchId, companyId: current.companyId, payload: { matchId, bankLineId: current.id, partyId: body.partyId, paymentId, supplierInvoiceId: body.supplierInvoiceId ?? null, recorded, chosenByPerson: true } })
      await afterAcceptance(tools, current, { id: matchId, invoiceIds, depositRequestIds, paymentId })
      return { matchId, bankLineId: current.id, paymentId, recorded }
    })
    return result
  })
}

/** POST /payments/bank/matches/accept: up to 50 suggestions at once (the sure ones), all or none. */
export async function acceptMany(caller: CommandCaller, body: { readonly companyId: string; readonly matches: readonly { readonly matchId: string; readonly version: number }[]; readonly writeOff?: WriteOffAsk | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  if (!can(actorOf(context), 'payments.bank.view', { companyId: body.companyId })) throw new NotFoundError('Company not found.')
  const found = await caller.withClient((db) => db.bankMatch.findMany({ where: { id: { in: body.matches.map((entry) => entry.matchId).filter(isUuid) }, companyId: body.companyId }, select: MATCH_COLUMNS }))
  const lines = await caller.withClient((db) => db.bankLine.findMany({ where: { id: { in: found.map((row) => row.bankLineId) } }, select: LINE_COLUMNS }))
  const issues: Issue[] = []
  body.matches.forEach((entry, index) => {
    const row = found.find((match) => match.id === entry.matchId)
    if (!row) issues.push({ path: `body/matches/${index}`, message: 'Not a match of this company.' })
    else if (row.version !== entry.version) issues.push({ path: `body/matches/${index}/version`, message: `It changed since it was read; it is now at version ${row.version}.` })
  })
  if (new Set(body.matches.map((entry) => entry.matchId)).size !== body.matches.length) issues.push({ path: 'body/matches', message: 'Each match once.' })
  if (new Set(found.map((row) => row.bankLineId)).size !== found.length) issues.push({ path: 'body/matches', message: 'One match per line.' })
  if (issues.length > 0) throw new DomainError('conflict', issues.length === 1 ? issues[0]!.message : 'These matches cannot be accepted together.', issues)
  for (const row of found) {
    const line = lines.find((entry) => entry.id === row.bankLineId)!
    const items = row.invoiceIds.length + row.depositRequestIds.length
    assertMayAccept(context, line, { partyId: row.partyId, items, paymentId: row.paymentId, supplierInvoiceId: row.supplierInvoiceId }, body.writeOff && line.amount > 0 && items > 0 ? body.writeOff : undefined)
  }
  return accepting(async () => {
    const { result } = await command(caller, { name: 'payments.bank.acceptMany', idempotencyKey, input: body }, async (tools) => {
      const accepted: { matchId: string; bankLineId: string; paymentId: string | null; recorded: boolean }[] = []
      const tolerance = (await toleranceOf(tools.tx, body.companyId)).amount
      for (const entry of body.matches) {
        // Each row at the version read (command() guards one record; the batch checks each the same way).
        const bumped = await tools.tx.bankMatch.updateMany({ where: { id: entry.matchId, version: entry.version }, data: { version: entry.version + 1 } })
        if (bumped.count !== 1) throw new ConflictError('A match changed since it was read: look again.')
        const row = (await tools.tx.bankMatch.findUnique({ where: { id: entry.matchId }, select: MATCH_COLUMNS }))!
        const line = lines.find((candidate) => candidate.id === row.bankLineId)!
        const items = row.invoiceIds.length + row.depositRequestIds.length
        // The write-off goes with each match whose difference it may close; the others keep theirs (placed later).
        let writeOff: WriteOffAsk | undefined
        if (body.writeOff && line.amount > 0 && items > 0) {
          const open = await openItemsOf(tools.tx, line.companyId, { invoiceIds: row.invoiceIds, depositRequestIds: row.depositRequestIds })
          const plan = planLine(line.amount, open.map((item, index) => ({ kind: item.kind, id: item.id, open: item.open, label: item.number ?? item.kind, path: `items/${index}` })), line.currency)
          const difference = differenceOf(plan, tolerance)
          writeOff = difference.kind !== null && difference.refusal === null && plan.issues.length === 0 ? body.writeOff : undefined
        }
        accepted.push({ matchId: row.id, bankLineId: row.bankLineId, ...(await acceptInCommand(tools, row, { writeOff })) })
      }
      return { companyId: body.companyId, accepted }
    })
    return result
  })
}

/** POST /payments/bank/matches/:matchId/reverse: a wrong acceptance taken back (its payment voided first). */
export async function reverseMatch(caller: CommandCaller, matchId: string, body: { readonly version: number; readonly reason: string; readonly periodLockOverride?: PeriodLockOverride | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const { match, line } = await officeMatch(caller, matchId, undefined)
  const recordedPayment = match.paymentId !== null && match.invoiceIds.length + match.depositRequestIds.length > 0
  if (recordedPayment) mayOn(context, PAYMENTS_VOID, line.companyId, match.partyId)
  const reason = body.reason.trim()
  if (reason === '') throw new ValidationError('Say why the acceptance is taken back.', [{ path: 'body/reason', message: 'Required.' }])
  // A taken-back match is frozen, a suggestion has nothing to take back: say so before the command touches its row.
  if (match.acceptedAt === null || match.reversedAt !== null) throw new InvalidStateError(match.reversedAt ? 'This acceptance is taken back already.' : 'This match is a suggestion: nothing to take back.')
  return accepting(() => reverseInCommand(caller, match, line, body, reason, recordedPayment, idempotencyKey))
}

async function reverseInCommand(caller: CommandCaller, match: MatchRow, line: LineRow, body: { readonly version: number; readonly periodLockOverride?: PeriodLockOverride | undefined }, reason: string, recordedPayment: boolean, idempotencyKey?: string) {
  const { result } = await command(caller, { name: 'payments.bank.reverse', idempotencyKey, input: { matchId: match.id, ...body, reason }, record: { type: 'BankMatch', id: match.id, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const current = (await tx.bankMatch.findUnique({ where: { id: match.id }, select: MATCH_COLUMNS }))!
    if (current.acceptedAt === null || current.reversedAt !== null) throw new InvalidStateError(current.reversedAt ? 'This acceptance is taken back already.' : 'This match is a suggestion: nothing to take back.')
    await lockMatching(tx, tools.context, line.companyId)
    let voided = false
    if (recordedPayment) {
      const paymentId = current.paymentId!
      await lockMoney(tx, tools.context, 'payment', paymentId)
      const allocations = await tx.paymentAllocation.findMany({ where: { paymentId }, select: { id: true, amount: true, invoiceId: true, depositRequestId: true, reversalOfId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      const reversedIds = new Set(allocations.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
      const live = allocations.filter((row) => row.reversalOfId === null && !reversedIds.has(row.id))
      await lockAll(tx, tools.context, 'deposit', live.flatMap((row) => (row.depositRequestId ? [row.depositRequestId] : [])))
      await lockAll(tx, tools.context, 'invoice', live.flatMap((row) => (row.invoiceId ? [row.invoiceId] : [])))
      if ((await tx.refund.count({ where: { paymentId, status: { in: ['DUE', 'PAID'] } } })) > 0) throw new InvalidStateError('Part of this payment is refunded or due to be: cancel or void the refund first, then take the acceptance back.')
      const paidRequests = await tx.depositRequest.findMany({ where: { id: { in: live.flatMap((row) => (row.depositRequestId ? [row.depositRequestId] : [])) }, status: 'PAID' }, select: { id: true } })
      if (paidRequests.length > 0) throw new InvalidStateError('A deposit request this payment paid is PAID: its money stays (a refund is a credit note and a refund).')
      // Its write-offs still standing, then its allocations, are taken back (append-only rows), then the payment is voided.
      for (const writeOff of await tx.paymentWriteOff.findMany({ where: { paymentId, reversalOfId: null, reversals: { none: {} } }, select: { id: true } })) {
        await reverseWriteOffInCommand(tools, writeOff.id, `The bank line's acceptance was taken back: ${reason}`)
      }
      for (const allocation of live) {
        const id = newId()
        await tx.paymentAllocation.create({ data: { id, companyId: line.companyId, partyId: current.partyId, paymentId, invoiceId: allocation.invoiceId, depositRequestId: allocation.depositRequestId, amount: -allocation.amount, reversalOfId: allocation.id, note: reason, createdAt: tools.now, createdById: actorIdOf(tools) }, select: { id: true } })
        const target = allocation.invoiceId ? ('INVOICE' as const) : ('DEPOSIT_REQUEST' as const)
        const targetId = (allocation.invoiceId ?? allocation.depositRequestId)!
        tools.audit({ action: 'payments.reverseAllocation', recordType: 'PaymentAllocation', recordId: id, companyId: line.companyId, after: { paymentId, reversalOfId: allocation.id, target, targetId, amount: markMoney('price', -allocation.amount) }, reason })
        tools.emit({ type: 'payment.allocation_reversed', subject: paymentId, companyId: line.companyId, payload: { paymentId, allocationId: id, reversalOfId: allocation.id, target, targetId } })
      }
      await settleOrders(tools, [...(await ordersOfInvoices(tx, live.flatMap((row) => (row.invoiceId ? [row.invoiceId] : [])))), ...(await ordersOfRequests(tx, live.flatMap((row) => (row.depositRequestId ? [row.depositRequestId] : []))))])
      const payment = (await readPayment(tx, paymentId))!
      const receivedOn = day(payment.receivedOn)
      await honourPeriodLocks(tools, [{ companyId: line.companyId, day: receivedOn, refused: `the payment received on ${dayWords(receivedOn)} (bank reference ${payment.externalRef}) is not voided`, path: 'matchId', record: { type: 'Payment', id: paymentId } }], body.periodLockOverride)
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'VOIDED', voidedAt: tools.now, voidReason: reason, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ recordType: 'Payment', recordId: paymentId, companyId: line.companyId, before: { status: 'RECEIVED' }, after: { status: 'VOIDED' }, reason })
      tools.emit({ type: 'payment.voided', subject: paymentId, companyId: line.companyId, payload: { paymentId } })
      voided = true
    }
    await tx.bankMatch.update({ where: { id: current.id }, data: { reversedAt: tools.now, reversedById: actorIdOf(tools), reverseReason: reason }, select: { id: true } })
    tools.audit({ action: 'payments.bank.reverse', recordType: 'BankMatch', recordId: current.id, companyId: line.companyId, before: { acceptedAt: current.acceptedAt!.toISOString() }, after: { reversed: true, paymentId: current.paymentId, voided }, reason })
    tools.emit({ type: 'bank_match.reversed', subject: current.id, companyId: line.companyId, payload: { matchId: current.id, bankLineId: line.id, partyId: current.partyId, paymentId: current.paymentId, voided } })
    // The line is to match again; other lines that named the same items may fit again.
    const others = await linesNaming(tx, line.companyId, { invoiceIds: current.invoiceIds, depositRequestIds: current.depositRequestIds, paymentIds: current.paymentId ? [current.paymentId] : [] })
    await refreshSuggestions(tools, line.companyId, [...new Set([line.id, ...others])])
    return { matchId: current.id, bankLineId: line.id, paymentId: current.paymentId, voided }
  })
  return result
}
