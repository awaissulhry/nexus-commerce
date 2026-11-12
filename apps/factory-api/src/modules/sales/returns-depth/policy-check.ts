import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_RETURNS_MANAGE } from '@nexus/factory-domain/sales/returns/permissions'
import {
  channelOfParty,
  channelWords,
  deadlineOf,
  DEPTH_LIMITS,
  POLICY_CHANNELS,
  windowCheckOf,
  withdrawalOf,
  type PolicyChannel,
  type WindowCheck,
  type WithdrawalLine,
} from '@nexus/factory-domain/sales/returns-depth/rules'
import { NO_POLICY, type ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { mayOn, officeOf, officeReturn } from '../returns/access'
import { policyOf } from '../returns/policy'
import { returnableRows, soldKeyOf, type SoldKey } from '../returns/returnable'
import { lockReturn, touchReturn } from '../returns/rma'
import { asDay, dayOf, dayOrNull, readLines, soldFactsOf, lineKeyOf, type Reader, type RmaRow } from '../returns/store'
import { livePolicyOf, policyUse, policyView, type PolicyRow, type PolicyView } from './store'

/**
 * The policy check (B-W2b-341; SAL-338 "Return policy check", SAL-337 "Return deadline on the RMA"; design returns.new
 * "Deadline for the goods (policy)"): which of the company's return policies applies (its channel follows the customer:
 * a private person buys as a consumer at a distance, an organisation as a business; the office may name the other one),
 * each line's delivery day against the policy's window, the consumer's right of withdrawal (Codice del Consumo art. 52)
 * only where it applies (standard goods sold at a distance, within 14 days of delivery: never made to measure or
 * personalised, art. 59), and the deadline for the goods that follows.
 *
 *   POST /sales/returns/policy-check      (sales.returns.manage) the check of a return being made (the customer and the
 *                                         lines of New return): writes nothing
 *   POST /sales/returns/:returnId/policy  (sales.returns.manage) an AUTHORISED return checked and bound to the policy: the
 *                                         RMA names it (policyId), says whether it is a consumer's withdrawal, and its
 *                                         deadline becomes the authorisation day + the policy's days (or the day named,
 *                                         today or later). A line outside the window is taken back only with the reason
 *                                         in words (a courtesy: the audit row keeps it); a withdrawal that does not
 *                                         apply is refused with why. Again while AUTHORISED (a newer policy, another
 *                                         channel); never once the goods arrived (the guard's rule).
 *
 * Without a live policy for the channel the return follows W2a's sales settings (modules/sales/returns/policy.ts) as
 * before: the check says so, and a return is bound to a policy only when one is live. The wording of the withdrawal is
 * the lawyer's to confirm (the policy's withdrawalWords as typed).
 */

export interface CheckLine extends SoldKey {
  readonly seq: number | null
}

export interface PolicyCheck {
  readonly channel: PolicyChannel
  /** Where the channel came from: the customer's kind, or named by the office. */
  readonly channelFrom: 'CUSTOMER' | 'NAMED'
  /** The live policy for the channel (null: none; W2a's sales settings apply). */
  readonly policy: PolicyView | null
  /** W2a's return policy in force (the sales settings), when no policy is live for the channel. */
  readonly fallback: { readonly windowDays: number | null; readonly goodsDueDays: number | null } | null
  readonly lines: { readonly index: number; readonly seq: number | null; readonly window: WindowCheck; readonly madeToMeasure: boolean; readonly personalised: boolean }[]
  readonly outsideWindow: boolean
  readonly withdrawal: { readonly applies: boolean; readonly why: string[]; readonly notes: string[]; readonly asked: boolean }
  /** The deadline the policy gives from `from` (the authorisation day, or today for a return being made). */
  readonly goodsDueBy: BusinessDate | null
  readonly warnings: Issue[]
  readonly problems: Issue[]
}

/** What makes each order line not a standard good (made to measure, personalised, an order that says no withdrawal). */
async function standardOf(db: Reader, orderLineIds: readonly string[]): Promise<Map<string, { madeToMeasure: boolean; personalised: boolean; orderSaysNone: boolean }>> {
  const out = new Map<string, { madeToMeasure: boolean; personalised: boolean; orderSaysNone: boolean }>()
  if (orderLineIds.length === 0) return out
  const ids = [...new Set(orderLineIds)]
  const lines = await db.salesOrderLine.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, orderId: true } })
  const orders = lines.length ? await db.salesOrder.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.orderId))] } }, select: { id: true, noWithdrawal: true } }) : []
  const options = await db.salesOrderLineOption.findMany({ where: { lineId: { in: ids }, freeText: { not: null } }, select: { lineId: true } })
  const artwork = await db.storedFile.findMany({ where: { recordType: 'SalesOrderLine', recordId: { in: ids }, category: 'ARTWORK', status: { not: 'DELETED' } }, select: { recordId: true } })
  const noWithdrawal = new Map(orders.map((order) => [order.id, order.noWithdrawal]))
  const personal = new Set([...options.map((row) => row.lineId), ...artwork.map((row) => row.recordId)])
  for (const line of lines) out.set(line.id, { madeToMeasure: line.kind === 'MADE_TO_MEASURE', personalised: personal.has(line.id), orderSaysNone: noWithdrawal.get(line.orderId) ?? false })
  return out
}

/**
 * The check of `lines` (what comes back) for one customer of one company: the policy of the channel, each line's window
 * and the withdrawal. `from` is the day the deadline counts from.
 */
export async function checkPolicy(db: Reader, input: { readonly companyId: string; readonly partyId: string; readonly channel?: PolicyChannel | null | undefined; readonly withdrawal: boolean; readonly lines: readonly CheckLine[]; readonly from: BusinessDate; readonly now: Date }): Promise<PolicyCheck> {
  const today = businessDate(input.now)
  const party = await db.party.findUnique({ where: { id: input.partyId }, select: { kind: true } })
  if (!party) throw new NotFoundError('Customer not found.')
  const channel = input.channel ?? channelOfParty(party.kind)
  const live = await livePolicyOf(db, input.companyId, channel)
  const policy = live ? policyView(live, (await policyUse(db, [live.id])).get(live.id) ?? 0) : null
  const inForce = live ? null : await policyOf(db, input.companyId)
  const windowDays = live ? live.windowDays : (inForce?.windowDays ?? null)
  const rows = await returnableRows(db, { companyId: input.companyId, partyId: input.partyId }, NO_POLICY, input.now)
  const byKey = new Map(rows.map((row) => [soldKeyOf(row), row]))
  // The order line each line names (an invoice line's own), for what makes a good not standard.
  const sold = await soldFactsOf(db, input.lines.map((line) => ({ salesOrderLineId: line.salesOrderLineId, invoiceLineId: line.invoiceLineId })))
  const orderLineOf = (line: CheckLine): string | null => sold.get(lineKeyOf(line))?.orderLine?.id ?? line.salesOrderLineId
  const standard = await standardOf(db, input.lines.flatMap((line) => { const id = orderLineOf(line); return id ? [id] : [] }))
  const warnings: Issue[] = []
  const problems: Issue[] = []
  const checked = input.lines.map((line, index) => {
    const row = byKey.get(soldKeyOf(line)) ?? rows.find((entry) => line.invoiceLineId !== null && entry.invoiceLineId === line.invoiceLineId)
    const window = windowCheckOf(row?.deliveredOn ?? null, today, windowDays, line.seq)
    if (window.words) warnings.push({ path: `lines/${index}`, message: window.words })
    const facts = standard.get(orderLineOf(line) ?? '') ?? { madeToMeasure: false, personalised: false, orderSaysNone: false }
    return { index, seq: line.seq, window, ...facts, deliveredOn: row?.deliveredOn ?? null }
  })
  const withdrawalLines: WithdrawalLine[] = checked.map((line) => ({ seq: line.seq, deliveredOn: line.deliveredOn, madeToMeasure: line.madeToMeasure, personalised: line.personalised, orderSaysNone: line.orderSaysNone }))
  const withdrawal = withdrawalOf({ channel, today, lines: withdrawalLines })
  if (input.withdrawal && !withdrawal.applies) problems.push(...withdrawal.why.map((message) => ({ path: 'withdrawal', message })))
  if (input.withdrawal && !live) problems.push({ path: 'withdrawal', message: `The company has no live return policy for ${channelWords(channel)}: make one in Sales settings (with the withdrawal words) first.` })
  if (!live) warnings.push({ path: 'policy', message: `No live return policy for ${channelWords(channel)}: the sales settings' return policy applies.` })
  const goodsDueDays = live ? live.goodsDueDays : (inForce?.goodsDueDays ?? null)
  return {
    channel,
    channelFrom: input.channel ? 'NAMED' : 'CUSTOMER',
    policy,
    fallback: inForce ? { windowDays: inForce.windowDays, goodsDueDays: inForce.goodsDueDays } : null,
    lines: checked.map(({ index, seq, window, madeToMeasure, personalised }) => ({ index, seq, window, madeToMeasure, personalised })),
    outsideWindow: checked.some((line) => !line.window.inWindow),
    withdrawal: { applies: withdrawal.applies, why: [...withdrawal.why], notes: [...withdrawal.notes], asked: input.withdrawal },
    goodsDueBy: deadlineOf(input.from, goodsDueDays),
    warnings,
    problems,
  }
}

export interface CheckBody {
  readonly companyId: string
  readonly partyId: string
  readonly channel?: PolicyChannel | null | undefined
  readonly withdrawal?: boolean | undefined
  readonly lines: readonly { readonly invoiceLineId?: string | null | undefined; readonly salesOrderLineId?: string | null | undefined; readonly size?: string | null | undefined }[]
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** POST /sales/returns/policy-check */
export async function previewPolicy(caller: CommandCaller, body: CheckBody) {
  const context = officeOf(caller)
  if (!isUuid(body.companyId) || !isUuid(body.partyId) || !mayOn(context, SALES_RETURNS_MANAGE, { companyId: body.companyId, partyId: body.partyId })) throw new NotFoundError('Customer not found.')
  const now = serverClock.now()
  const check = await caller.withClient((client) =>
    checkPolicy(client, { companyId: body.companyId, partyId: body.partyId, channel: body.channel, withdrawal: body.withdrawal ?? false, lines: body.lines.map((line) => ({ invoiceLineId: line.invoiceLineId ?? null, salesOrderLineId: line.salesOrderLineId ?? null, size: blank(line.size), seq: null })), from: businessDate(now), now }),
  )
  return { check: { ...check, ok: check.problems.length === 0 } }
}

export interface ApplyBody {
  readonly version: number
  readonly channel?: PolicyChannel | null | undefined
  readonly withdrawal?: boolean | undefined
  /** The deadline named instead of the policy's (today or later); null: no deadline; left out: the policy's. */
  readonly goodsDueBy?: BusinessDate | null | undefined
  /** Why a line outside the policy's window is taken back anyway (required then). */
  readonly reason?: string | null | undefined
}

/** Inside a command: the RMA (locked, AUTHORISED) checked and bound to its live policy. */
export async function applyPolicyInCommand(tools: CommandTools, rma: RmaRow, body: Omit<ApplyBody, 'version'>): Promise<{ check: PolicyCheck; policy: PolicyRow }> {
  const { tx, now } = tools
  const today = businessDate(now)
  const lines = await readLines(tx, rma.id)
  const authorisedOn = rma.authorisedAt ? businessDate(rma.authorisedAt) : today
  const check = await checkPolicy(tx, {
    companyId: rma.companyId,
    partyId: rma.partyId,
    channel: body.channel,
    withdrawal: body.withdrawal ?? false,
    lines: lines.map((line) => ({ invoiceLineId: line.invoiceLineId, salesOrderLineId: line.salesOrderLineId, size: line.size, seq: line.seq })),
    from: authorisedOn,
    now,
  })
  const problems: Issue[] = [...check.problems.map((problem) => ({ ...problem, path: `body/${problem.path}` }))]
  const reason = blank(body.reason)
  if (check.outsideWindow && !reason) problems.push({ path: 'body/reason', message: `${check.lines.filter((line) => !line.window.inWindow).map((line) => line.window.words).join(' ')} Say why it is taken back anyway.` })
  if (reason && reason.length > DEPTH_LIMITS.reason) problems.push({ path: 'body/reason', message: `At most ${DEPTH_LIMITS.reason} characters.` })
  if (body.goodsDueBy && body.goodsDueBy < today) problems.push({ path: 'body/goodsDueBy', message: 'The deadline for the goods is today or later.' })
  if (problems.length > 0) {
    const conflict = problems.every((problem) => problem.path === 'body/withdrawal')
    if (conflict) throw new DomainError('conflict', problems.length === 1 ? problems[0]!.message : 'The right of withdrawal does not apply to this return.', problems)
    throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The return cannot be checked against the policy like this.', problems)
  }
  const live = check.policy ? await tx.returnPolicy.findUnique({ where: { id: check.policy.id }, select: { id: true } }) : null
  if (!live || !check.policy) throw new DomainError('conflict', `The company has no live return policy for ${channelWords(check.channel)}: make one in Sales settings, or leave the return under the sales settings' policy.`, [{ path: 'body/channel', message: 'No live policy for this channel.' }])
  const goodsDueBy = body.goodsDueBy === undefined ? check.goodsDueBy : body.goodsDueBy
  const withdrawal = body.withdrawal ?? false
  await touchReturn(tools, rma, { policyId: live.id, withdrawal, goodsDueBy: goodsDueBy ? asDay(goodsDueBy) : null })
  tools.audit({
    action: 'returnsDepth.checkPolicy',
    recordType: 'ReturnAuthorisation',
    recordId: rma.id,
    companyId: rma.companyId,
    siteId: rma.siteId,
    before: { policyId: rma.policyId, withdrawal: rma.withdrawal, goodsDueBy: dayOrNull(rma.goodsDueBy) },
    after: { policyId: live.id, channel: check.channel, withdrawal, goodsDueBy, outsideWindow: check.lines.filter((line) => !line.window.inWindow).map((line) => line.seq) },
    ...(reason ? { reason } : {}),
  })
  tools.emit({ type: 'return.policy_checked', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, policyId: live.id, channel: check.channel, withdrawal, goodsDueBy, outsideWindow: check.outsideWindow } })
  const policy = (await livePolicyOf(tx, rma.companyId, check.channel))!
  return { check: { ...check, goodsDueBy }, policy }
}

/** POST /sales/returns/:returnId/policy */
export async function applyPolicy(caller: CommandCaller, returnId: string, body: ApplyBody, idempotencyKey?: string) {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  if (body.channel !== undefined && body.channel !== null && !POLICY_CHANNELS.includes(body.channel)) throw new ValidationError('Business customers, or consumers who bought at a distance.', [{ path: 'body/channel', message: 'B2B or CONSUMER_DISTANCE.' }])
  if (seen.status === 'REQUESTED') throw new InvalidStateError(`Return ${seen.number} is requested: authorise it first (the deadline counts from the authorisation).`)
  const { result } = await command(caller, { name: 'returnsDepth.applyPolicy', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const rma = await lockReturn(tools, seen.id, body.version, ['AUTHORISED'] as ReturnStatus[], 'it is checked against the return policy (before the goods arrive)')
    const { check } = await applyPolicyInCommand(tools, rma, body)
    return { check: { ...check, ok: true }, goodsDueBy: check.goodsDueBy }
  })
  return result
}

export const deadlineDay = (rma: Pick<RmaRow, 'goodsDueBy'>): BusinessDate | null => (rma.goodsDueBy ? dayOf(rma.goodsDueBy) : null)
