import type { Prisma } from '@nexus/factory-db'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { depositFiscalOf } from '@nexus/factory-domain/sales/deposits/deposits'
import { amendmentDiff, type OrderSnapshot } from '@nexus/factory-domain/sales/amendments/amendments'
import { frozenProblems, type OrderFreezeStage } from '@nexus/factory-domain/sales/order-changes/freeze'
import { extraDepositOf, feeMinorOf, PENITENTIAL_FISCAL_REASON, PENITENTIAL_KIND, PENITENTIAL_OFF_WORDS, pricedInputProblems, pricedPartsOf, type PricedInput, type PricedPart } from '@nexus/factory-domain/sales/order-changes/priced'
import { addDays, type DepositKind } from '@nexus/factory-domain/sales/quotes/quotes'
import { DEPOSIT_DUE_DAYS } from '@nexus/factory-domain/sales/quotes/terms'
import type { CommandTools } from '../../../core/command'
import { materialsOfRemovedLines, planInCommand } from '../customer-materials/store'
import { caparraPenitenzialeOn, ORDER_DEPOSIT_ONLY, penitentialFiscal } from '../deposits/deposits'
import type { AmendmentPlan } from '../orders/amend'
import type { OrderRow } from '../orders/store'
import { quotePartyOf } from '../quotes/store'
import { frozenChangesOf } from './freeze'
import { askChangeYes, pendingChangeYes, type ChangeFacts } from './yes'

/**
 * What an order change adds to W2a's amendment (B-W2b-309; SAL-218, SAL-219, SAL-221, SAL-190, SAL-306), called by
 * modules/sales/orders/amend.ts `amendInCommand` in its own command, in three places:
 *
 *   before the writes   one change at a time (a change whose yes still waits holds the next one); the company's freeze rules
 *                       against the change (BLOCKED refused; CHANGE_REQUEST refused unless the change is priced); the
 *                       customer-supplied rows of a line the change removes (removed first, refused when something of them
 *                       was received, used or returned)
 *   the amendment row   a priced change's parts (one per line whose net moved, in the office's words when given) and its
 *                       fee; the extra deposit of a bigger order (the order's own percent of the gross growth unless the
 *                       office names one; its kind the order's deposit's, a caparra penitenziale only while switched on);
 *                       the new yes (SALES_ORDER_CHANGE) when a rule holds — all named on the append-only row
 *   after               sales_order.change_priced; the order's customer-supplied rows of the lines it changed planned again
 *                       when the order keeps them (customer_material rows follow the sizes)
 *
 * A split (B-W2b-303: lines move to new orders of the same customer, `reacceptance: false`) is none of these: it changes
 * nothing the customer ordered. A put-back (./put-back.ts) restores the order as it was: no yes is asked again and a
 * CHANGE_REQUEST field may go back without a price (a BLOCKED one may not).
 */

export interface ChangeOptions {
  /** B-W2b-303's split (no re-acceptance): nothing of this file applies. */
  readonly split: boolean
  /** A priced change request (POST …/priced-changes): its money. */
  readonly priced: PricedInput | null
  /** A put-back of a turned-down or refused change. */
  readonly putBack: boolean
}

export interface BeforeWrites {
  /** The furthest production stage of a changed line (null: none in production). */
  readonly stage: OrderFreezeStage | null
}

const conflict = (message: string, path = 'body') => new DomainError('conflict', message, [{ path, message }])

/** Before W2a writes the lines (see the file's head). */
export async function beforeAmendmentWrites(tools: CommandTools, order: OrderRow, plan: AmendmentPlan, options: ChangeOptions): Promise<BeforeWrites> {
  if (options.split) return { stage: null }
  if (!options.putBack) {
    const waiting = await pendingChangeYes(tools.tx, order.id)
    if (waiting) throw conflict(`${order.number}'s last change waits for its yes (request of ${businessDate(waiting.requestedAt)}): ask the approver, or take the request back, before another change.`)
  }
  if (options.priced) {
    const issues = pricedInputProblems(options.priced, order.currency)
    if (issues.length > 0) throw new DomainError('validation_failed', issues[0]!.message, issues)
  }
  const frozen = await frozenChangesOf(tools.tx, order, plan.diff)
  const issues = frozenProblems(frozen.changes, options.priced !== null || options.putBack)
  if (issues.length > 0) throw new DomainError('conflict', issues.length === 1 ? issues[0]!.message : `${issues.length} changes are frozen at the stage production reached: ${issues[0]!.message}`, issues)
  const removed = plan.removed.map((lineId) => ({ id: lineId, seq: plan.before.lines.find((line) => line.id === lineId)?.seq ?? 0 }))
  await materialsOfRemovedLines(tools, removed)
  return { stage: frozen.furthest }
}

export interface AmendmentExtras {
  readonly priceDeltaLines: Prisma.InputJsonValue | undefined
  readonly feeAmount: number | null
  readonly depositRequestId: string | null
  readonly reapprovalTaskId: string | null
  readonly yes: 'ASKED' | 'NO_RULE' | 'NOBODY_TO_ASK' | 'NOT_ASKED'
  readonly priced: boolean
}

/** The order's deposit percent and kind (its first deposit request: the version's or the order's own). */
async function orderDepositOf(tools: CommandTools, order: OrderRow): Promise<{ pct: string | null; kind: DepositKind | null }> {
  const first = await tools.tx.depositRequest.findFirst({
    where: { AND: [{ OR: [{ orderId: order.id }, ...(order.quoteVersionId ? [{ quoteVersionId: order.quoteVersionId }] : [])] }, ORDER_DEPOSIT_ONLY], status: { not: 'CANCELLED' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { depositPct: true, kind: true },
  })
  return { pct: first?.depositPct ? first.depositPct.toString() : null, kind: (first?.kind as DepositKind | undefined) ?? null }
}

const tenantOf = (tools: CommandTools): string => {
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : undefined
  if (!tenantId) throw new Error('order changes: a command outside a tenant')
  return tenantId
}
const actorOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The extra deposit of a bigger order, written OPEN on the order (SAL-221); null when none is asked. */
async function extraDepositInCommand(tools: CommandTools, order: OrderRow, input: { readonly growth: number; readonly revision: number; readonly asked: PricedInput['deposit'] }): Promise<string | null> {
  const own = await orderDepositOf(tools, order)
  const plan = extraDepositOf({ growth: input.growth, currency: order.currency, orderPct: own.pct, asked: input.asked })
  if (plan === null) return null
  if ('path' in plan) throw new DomainError('validation_failed', plan.message, [plan])
  const kind = ((input.asked?.kind as DepositKind | undefined) ?? own.kind ?? 'ACCONTO') as DepositKind
  if (!['ACCONTO', 'CAPARRA', PENITENTIAL_KIND].includes(kind)) throw new DomainError('validation_failed', 'A deposit is an acconto, a caparra confirmatoria or a caparra penitenziale.', [{ path: 'body/deposit/kind', message: 'ACCONTO, CAPARRA or CAPARRA_PENITENZIALE.' }])
  let fiscal: { fiscalDocument: 'TD02' | 'NONE'; fiscalRule: string; reason: string }
  if (kind === PENITENTIAL_KIND) {
    // B-W2b-309 (SAL-248): built switched off until the accountant's wording (GATE-ACCOUNTANT).
    if (!(await caparraPenitenzialeOn(tools.tx, tenantOf(tools), order.companyId)).on) throw conflict(PENITENTIAL_OFF_WORDS.en, 'body/deposit/kind')
    fiscal = penitentialFiscal(PENITENTIAL_FISCAL_REASON)
  } else {
    const party = await quotePartyOf(tools.tx, order.partyId, businessDate(tools.now), tools.now)
    fiscal = depositFiscalOf(kind, party?.profile ?? null)
  }
  const dueDate = input.asked?.dueDate ?? addDays(businessDate(tools.now), DEPOSIT_DUE_DAYS)
  if (dueDate < businessDate(tools.now)) throw new DomainError('validation_failed', 'The extra deposit is due today or later.', [{ path: 'body/deposit/dueDate', message: 'Today or later.' }])
  const id = newId()
  await tools.tx.depositRequest.create({
    data: { id, companyId: order.companyId, partyId: order.partyId, orderId: order.id, kind, depositPct: plan.pct, currency: order.currency, amount: plan.amount, dueDate: new Date(`${dueDate}T00:00:00.000Z`), fiscalDocument: fiscal.fiscalDocument, fiscalRule: fiscal.fiscalRule, createdAt: tools.now, updatedAt: tools.now, createdById: actorOf(tools) },
    select: { id: true },
  })
  tools.audit({
    action: 'sales.deposits.request',
    recordType: 'DepositRequest',
    recordId: id,
    companyId: order.companyId,
    after: { orderId: order.id, extraFor: { revision: input.revision, growth: markMoney('price', input.growth), basis: plan.basis }, kind, depositPct: plan.pct, currency: order.currency, amount: markMoney('price', plan.amount), dueDate, fiscalDocument: fiscal.fiscalDocument, fiscalRule: fiscal.fiscalRule, reason: fiscal.reason, status: 'OPEN' },
  })
  tools.emit({ type: 'deposit_request.created_for_order', subject: id, companyId: order.companyId, payload: { depositRequestId: id, orderId: order.id, number: order.number, partyId: order.partyId, stepKind: 'DEPOSIT', fiscalDocument: fiscal.fiscalDocument, dueDate } })
  return id
}

/** Just before the amendment row (see the file's head): what the row names. `after` is the snapshot with the new lines' ids. */
export async function amendmentExtras(
  tools: CommandTools,
  order: OrderRow,
  input: { readonly amendmentId: string; readonly revision: number; readonly reason: string; readonly before: OrderSnapshot; readonly after: OrderSnapshot; readonly stage: OrderFreezeStage | null },
  options: ChangeOptions,
): Promise<AmendmentExtras> {
  const none: AmendmentExtras = { priceDeltaLines: undefined, feeAmount: null, depositRequestId: null, reapprovalTaskId: null, yes: 'NOT_ASKED', priced: false }
  if (options.split) return none
  const diff = amendmentDiff(input.before, input.after)
  let parts: PricedPart[] | null = null
  let feeAmount: number | null = null
  let depositRequestId: string | null = null
  if (options.priced) {
    parts = pricedPartsOf(diff.lines, new Map(Object.entries(options.priced.labels ?? {})))
    feeAmount = feeMinorOf(options.priced.fee, order.currency)
    if (parts.length === 0 && feeAmount === null) throw conflict('A priced change carries its price: a change that moves the net of a line, or a change fee. Send it as a plain amendment otherwise.', 'body/fee')
    if (parts.length > 100) throw conflict('A priced change is priced in at most 100 parts: change fewer lines at once.', 'body/lines')
    depositRequestId = await extraDepositInCommand(tools, order, { growth: diff.grossAfter - diff.grossBefore, revision: input.revision, asked: options.priced.deposit })
  }
  let reapprovalTaskId: string | null = null
  let yes: AmendmentExtras['yes'] = 'NOT_ASKED'
  if (!options.putBack) {
    const change: ChangeFacts = {
      amendmentId: input.amendmentId,
      revision: input.revision,
      reason: input.reason,
      before: input.before,
      after: input.after,
      netAmountBefore: diff.netBefore,
      netAmountAfter: diff.netAfter,
      grossAmountBefore: diff.grossBefore,
      grossAmountAfter: diff.grossAfter,
      priceDeltaLines: parts && parts.length > 0 ? parts : null,
      feeAmount,
      depositRequestId,
      stage: input.stage,
    }
    const asked = await askChangeYes(tools, order, change)
    reapprovalTaskId = asked.taskId
    yes = asked.taskId !== null ? 'ASKED' : asked.held
  }
  return { priceDeltaLines: parts && parts.length > 0 ? (parts as unknown as Prisma.InputJsonValue) : undefined, feeAmount, depositRequestId, reapprovalTaskId, yes, priced: options.priced !== null }
}

/** After the amendment row (see the file's head). */
export async function afterAmendment(tools: CommandTools, order: OrderRow, input: { readonly amendmentId: string; readonly revision: number; readonly changedLineIds: readonly string[]; readonly extras: AmendmentExtras }): Promise<void> {
  if (input.extras.priced) {
    tools.emit({
      type: 'sales_order.change_priced',
      subject: order.id,
      companyId: order.companyId,
      payload: { orderId: order.id, number: order.number, amendmentId: input.amendmentId, revision: input.revision, hasFee: input.extras.feeAmount !== null, depositRequestId: input.extras.depositRequestId, reapprovalTaskId: input.extras.reapprovalTaskId },
    })
  }
  // The customer's materials follow the sizes, when the order keeps them.
  if (input.changedLineIds.length > 0 && (await tools.tx.customerMaterial.count({ where: { orderId: order.id } })) > 0) {
    const lines = (await tools.tx.salesOrderLine.findMany({ where: { id: { in: [...input.changedLineIds] } }, select: { id: true } })).map((row) => row.id)
    if (lines.length > 0) await planInCommand(tools, order, lines)
  }
}
