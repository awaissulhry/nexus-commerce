import { chooseRules } from '@nexus/factory-domain/approvals/rules'
import { InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { amendmentDiff, nextRevision, type AmendLineInput, type OrderSnapshot } from '@nexus/factory-domain/sales/amendments/amendments'
import { STAGE_WORDS } from '@nexus/factory-domain/sales/order-changes/freeze'
import {
  CHANGE_YES_WORDS,
  changeYesStateOf,
  CUSTOMER_DECISION_WORDS,
  customerDecisionOf,
  DEPOSIT_KIND_WORDS,
  extraDepositOf,
  feeMinorOf,
  PENITENTIAL_KIND,
  PENITENTIAL_OFF_WORDS,
  pricedInputProblems,
  pricedPartsOf,
  SALES_ORDER_CHANGE_FIELDS,
  type PricedInput,
  type PricedPart,
} from '@nexus/factory-domain/sales/order-changes/priced'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { isIssueList } from '@nexus/factory-domain/sales/quotes/quotes'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { withdrawPending } from '../../../platform/approvals/engine'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { caparraPenitenzialeOn, ORDER_DEPOSIT_ONLY } from '../deposits/deposits'
import { officeContextOf } from '../orders/access'
import { amendInCommand, diffView, planAmendment, type AmendBody } from '../orders/amend'
import { officeOrder, recordAfter } from '../orders/moves'
import { readOrder, readOrderFacts, type OrderRow, type Reader } from '../orders/store'
import { frozenChangesOf } from './freeze'
import { AMENDMENT_CHANGE_COLUMNS, changeFactsFor, changeFactsOf, pendingChangeYes } from './yes'
import { frozenProblems } from '@nexus/factory-domain/sales/order-changes/freeze'

/**
 * Priced change requests after the start, their extra deposit, the new yes and the put-back (B-W2b-309; SAL-219, SAL-221,
 * SAL-190; design order.changes.priced "Priced change requests": Change · Extra cost and price · Customer decision;
 * order.changes.list "Customer re-acceptance: not needed / waiting / accepted").
 *
 *   POST /sales/orders/:orderId/priced-changes/preview   orders.manage: the change as it would be written (W2a's diff), its
 *                                                        parts and fee, the extra deposit, whether a yes would be asked, the
 *                                                        freeze rules' problems — nothing written
 *   POST /sales/orders/:orderId/priced-changes           orders.manage: ONE command — W2a's amendment carrying its price
 *                                                        (./apply.ts): parts, fee, extra deposit, the new yes; the customer
 *                                                        must accept it again (reacceptanceNeeded: B-W2b-184's REVISED_ORDER
 *                                                        link on the amendment, which now shows the parts, the fee and the
 *                                                        deposit)
 *   GET  /sales/orders/:orderId/changes                  orders.view: every change newest first — what changed, its price
 *                                                        (the price grain), the extra deposit, the yes and the customer's
 *                                                        decision in words, and whether it may be put back
 *   POST /sales/orders/:orderId/changes/:amendmentId/put-back
 *                                                        orders.manage: the order written back as it was before that change
 *                                                        (its latest), when the yes was refused or the customer refused it:
 *                                                        a new amendment (no yes asked, no re-acceptance), its extra deposit
 *                                                        cancelled while nothing is paid on it
 *   GET  /sales/deposit-kinds?companyId=                 orders.view: the deposit kinds with their words and whether the
 *                                                        company asks each now (the caparra penitenziale: off until the
 *                                                        accountant's wording, GATE-ACCOUNTANT)
 */

export interface PricedBody extends AmendBody, PricedInput {}

const pricedOf = (body: PricedBody): PricedInput => ({ labels: body.labels, fee: body.fee, deposit: body.deposit })
const amendOf = (body: PricedBody): AmendBody => ({ version: body.version, reason: body.reason, customerRef: body.customerRef, requestedDate: body.requestedDate, lines: body.lines })

const partView = (part: PricedPart) => ({ label: part.label, orderLineId: part.orderLineId ?? null, amount: asMoney('price', part.amount) })

/** POST /sales/orders/:orderId/priced-changes/preview */
export async function previewPricedChange(caller: CommandCaller, orderId: string, body: PricedBody) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const now = serverClock.now()
  const priced = pricedOf(body)
  return caller.withClient(async (client) => {
    const facts = await readOrderFacts(client, order)
    // W2a's review asks no reason yet (the dialog's stand-in, as B-W2a-50's preview).
    const plan = await planAmendment(client, order, order.status, facts, { ...amendOf(body), reason: body.reason?.trim() || 'Review before applying.' }, now)
    const revision = nextRevision((await client.salesOrderAmendment.findMany({ where: { orderId: order.id }, select: { revision: true } })).map((row) => row.revision))
    const empty = { revision, version: order.version, diff: null, parts: asMoney('price', [] as ReturnType<typeof partView>[]), feeAmount: asMoney('price', null), changeAmount: asMoney('price', null), deposit: asMoney('price', null), yes: null, stage: null }
    if (isIssueList(plan)) {
      if (plan.length === 1 && plan[0]!.path === 'body') throw new InvalidStateError(plan[0]!.message)
      return { ok: false, problems: plan, ...empty }
    }
    const problems: Issue[] = [...pricedInputProblems(priced, order.currency)]
    const waiting = await pendingChangeYes(client, order.id)
    if (waiting) problems.push({ path: 'body', message: `${order.number}'s last change waits for its yes (request of ${businessDate(waiting.requestedAt)}): ask the approver, or take the request back, before another change.` })
    const frozen = await frozenChangesOf(client, order, plan.diff)
    problems.push(...frozenProblems(frozen.changes, true))
    const parts = pricedPartsOf(plan.diff.lines, new Map(Object.entries(priced.labels ?? {})))
    const feeAmount = problems.some((issue) => issue.path === 'body/fee') ? null : feeMinorOf(priced.fee, order.currency)
    if (parts.length === 0 && feeAmount === null) problems.push({ path: 'body/fee', message: 'A priced change carries its price: a change that moves the net of a line, or a change fee. Send it as a plain amendment otherwise.' })
    const own = await client.depositRequest.findFirst({ where: { AND: [{ OR: [{ orderId: order.id }, ...(order.quoteVersionId ? [{ quoteVersionId: order.quoteVersionId }] : [])] }, ORDER_DEPOSIT_ONLY], status: { not: 'CANCELLED' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { depositPct: true, kind: true } })
    const growth = plan.diff.grossAfter - plan.diff.grossBefore
    let deposit: { amount: number; pct: string; basis: string; kind: string; growth: number } | null = null
    if (!problems.some((issue) => issue.path.startsWith('body/deposit'))) {
      const extra = extraDepositOf({ growth, currency: order.currency, orderPct: own?.depositPct ? own.depositPct.toString() : null, asked: priced.deposit })
      if (extra && 'path' in extra) problems.push(extra)
      else if (extra) {
        const kind = priced.deposit?.kind ?? own?.kind ?? 'ACCONTO'
        if (kind === PENITENTIAL_KIND && !(await caparraPenitenzialeOn(client, context.tenantId, order.companyId)).on) problems.push({ path: 'body/deposit/kind', message: PENITENTIAL_OFF_WORDS.en })
        deposit = { amount: extra.amount, pct: extra.pct, basis: extra.basis, kind, growth }
      }
    }
    // Whether a yes would be asked (the same rules and facts the command tests).
    const rules = await client.approvalRule.findMany({ where: { kind: 'SALES_ORDER_CHANGE', active: true, OR: [{ companyId: null }, { companyId: order.companyId }] }, select: { id: true, companyId: true, sequence: true, createdAt: true, active: true, effectiveFrom: true, condition: true, approverRoleId: true, approverUserId: true } })
    let yes: 'WOULD_ASK' | 'NO_RULE' | 'NOBODY_TO_ASK' = 'NO_RULE'
    if (rules.length > 0) {
      const change = { amendmentId: '00000000-0000-4000-8000-000000000000', revision, reason: body.reason ?? '', before: plan.before, after: plan.after, netAmountBefore: plan.diff.netBefore, netAmountAfter: plan.diff.netAfter, grossAmountBefore: plan.diff.grossBefore, grossAmountAfter: plan.diff.grossAfter, priceDeltaLines: parts.length > 0 ? parts : null, feeAmount, depositRequestId: null, stage: frozen.furthest }
      const choice = chooseRules(rules, { companyId: order.companyId, facts: await changeFactsFor(client, order, change), askers: [context.actorId] }, SALES_ORDER_CHANGE_FIELDS, now)
      yes = choice.matched.length === 0 ? 'NO_RULE' : choice.deciding === null ? 'NOBODY_TO_ASK' : 'WOULD_ASK'
    }
    return {
      ok: problems.length === 0,
      problems,
      revision,
      version: order.version,
      diff: diffView(plan.diff),
      parts: asMoney('price', parts.map(partView)),
      feeAmount: asMoney('price', feeAmount),
      /** The net change of the lines plus the fee (what the customer is asked, before VAT). */
      changeAmount: asMoney('price', plan.diff.netAfter - plan.diff.netBefore + (feeAmount ?? 0)),
      deposit: asMoney('price', deposit ? { amount: asMoney('price', deposit.amount), pct: deposit.pct, basis: deposit.basis, kind: deposit.kind, growthAmount: asMoney('price', deposit.growth) } : null),
      yes,
      stage: frozen.furthest ? { stage: frozen.furthest, words: STAGE_WORDS[frozen.furthest] } : null,
    }
  })
}

/** POST /sales/orders/:orderId/priced-changes */
export async function applyPricedChange(caller: CommandCaller, orderId: string, body: PricedBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const { result } = await command(caller, { name: 'orders.pricedChange', idempotencyKey, input: { orderId, ...body } }, (tools) => amendInCommand(tools, context.tenantId, order, amendOf(body), { priced: pricedOf(body) }))
  const change = await caller.withClient(async (client) => (await changesOf(client, (await readOrder(client, order.id))!, context)).find((entry) => entry.id === result.amendmentId)!)
  return { order: await recordAfter(caller, order.id), change }
}

// ---- the order's changes ----------------------------------------------------------------------------------------------------

async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

/** What may be put back: the latest change, when its yes was refused or the customer refused it. */
function putBackWhy(latest: boolean, yesStatus: string | null, customerStatus: string | null, order: Pick<OrderRow, 'status'>): string | null {
  if (!latest) return 'Only the latest change is put back.'
  if (!['CONFIRMED', 'IN_PRODUCTION', 'READY'].includes(order.status)) return `The order is ${order.status.toLowerCase()}: its lines no longer change.`
  if (yesStatus !== 'REJECTED' && customerStatus !== 'REFUSED') return 'A change is put back when its yes was refused or the customer refused it.'
  return null
}

async function changesOf(db: Reader, order: OrderRow, context: ReturnType<typeof officeContextOf>) {
  const rows = await db.salesOrderAmendment.findMany({ where: { orderId: order.id }, orderBy: { revision: 'desc' }, select: AMENDMENT_CHANGE_COLUMNS })
  if (rows.length === 0) return []
  const tasks = await db.approvalTask.findMany({ where: { kind: 'SALES_ORDER_CHANGE', recordType: 'SalesOrder', recordId: order.id }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true, requestedAt: true, decidedAt: true, rejectReason: true } })
  const requests = await db.approvalRequest.findMany({ where: { recordType: 'SalesOrderAmendment', recordId: { in: rows.map((row) => row.id) }, kind: 'REVISED_ORDER' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, recordId: true, status: true, answeredAt: true } })
  const deposits = await db.depositRequest.findMany({ where: { id: { in: rows.flatMap((row) => (row.depositRequestId ? [row.depositRequestId] : [])) } }, select: { id: true, kind: true, amount: true, status: true, dueDate: true, depositPct: true } })
  const names = await namesOf(db, rows.map((row) => row.createdById))
  const mayManage = can(actorOf(context), ORDERS_MANAGE, { companyId: order.companyId, partyId: order.partyId })
  return rows.map((row, index) => {
    const next = index > 0 ? rows[index - 1]! : null
    // The yes of this change: the request it names, else the newest asked while it was the latest.
    const task = (row.reapprovalTaskId ? tasks.find((entry) => entry.id === row.reapprovalTaskId) : undefined) ?? tasks.find((entry) => entry.requestedAt >= row.createdAt && (next === null || entry.requestedAt < next.createdAt))
    const newer = task ? tasks.find((entry) => entry.requestedAt > task.requestedAt && entry.requestedAt >= row.createdAt && (next === null || entry.requestedAt < next.createdAt)) : undefined
    const yesTask = newer ?? task
    const request = requests.find((entry) => entry.recordId === row.id)
    const yesState = changeYesStateOf(yesTask?.status ?? null)
    const decision = customerDecisionOf(row.reacceptanceNeeded, request?.status ?? null)
    const deposit = deposits.find((entry) => entry.id === row.depositRequestId)
    const facts = changeFactsOf(row)
    const diff = amendmentDiff(facts.before, facts.after)
    const why = putBackWhy(index === 0, yesTask?.status ?? null, request?.status ?? null, order)
    return {
      id: row.id,
      revision: row.revision,
      reason: row.reason,
      createdAt: toUtcIso(row.createdAt),
      createdBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
      /** A priced change request (parts or a fee). */
      priced: facts.priceDeltaLines !== null || facts.feeAmount !== null,
      diff: diffView(diff),
      parts: asMoney('price', (facts.priceDeltaLines ?? []).map(partView)),
      feeAmount: asMoney('price', facts.feeAmount),
      changeAmount: asMoney('price', diff.netAfter - diff.netBefore + (facts.feeAmount ?? 0)),
      deposit: deposit ? { id: deposit.id, kind: deposit.kind, kindWords: DEPOSIT_KIND_WORDS[deposit.kind as keyof typeof DEPOSIT_KIND_WORDS], amount: asMoney('price', deposit.amount), pct: deposit.depositPct ? new Dec(deposit.depositPct.toString()).toFixed(4) : null, status: deposit.status, dueDate: businessDate(deposit.dueDate) } : null,
      yes: { state: yesState, words: CHANGE_YES_WORDS[yesState], taskId: yesTask?.id ?? null, reason: yesTask?.status === 'REJECTED' ? yesTask.rejectReason : null },
      customer: { decision, words: CUSTOMER_DECISION_WORDS[decision], requestId: request?.id ?? null, answeredAt: request?.answeredAt ? toUtcIso(request.answeredAt) : null },
      putBack: { may: why === null && mayManage, why },
    }
  })
}

/** GET /sales/orders/:orderId/changes */
export async function listOrderChanges(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_VIEW)
  return caller.withClient(async (client) => {
    const waiting = await pendingChangeYes(client, order.id)
    return { orderId: order.id, number: order.number, waitingForYes: waiting ? { taskId: waiting.id, since: toUtcIso(waiting.requestedAt) } : null, reapprovalNeededAt: order.reapprovalNeededAt ? toUtcIso(order.reapprovalNeededAt) : null, changes: await changesOf(client, order, context) }
  })
}

// ---- put back -----------------------------------------------------------------------------------------------------------------

/** The amendment body that writes the order back as the snapshot before a change: kept lines by id, gone ones again. */
export function putBackBody(before: OrderSnapshot, linesNow: ReadonlySet<string>, version: number, reason: string): AmendBody {
  const lines: AmendLineInput[] = before.lines
    .filter((line) => line.kind !== 'FEE' && line.closedShortQuantity === null)
    .map((line) => {
      const sizes = line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: size.unitPrice }))
      return linesNow.has(line.id)
        ? { id: line.id, sizes, unitPrice: line.unitPrice, description: line.description, note: line.note }
        : { styleId: line.styleId, colourwayId: line.colourwayId, sizes, unitPrice: line.unitPrice, description: line.description, note: line.note }
    })
  // A line closed short since stays as it is (kept by id, never in the grid).
  for (const line of before.lines) if (line.closedShortQuantity !== null && linesNow.has(line.id)) lines.push({ id: line.id })
  return { version, reason, customerRef: before.header.customerRef, requestedDate: before.header.requestedDate, lines }
}

/** POST /sales/orders/:orderId/changes/:amendmentId/put-back */
export async function putBackChange(caller: CommandCaller, orderId: string, amendmentId: string, body: { readonly version: number; readonly reason?: string | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const { result } = await command(caller, { name: 'orders.putBackChange', idempotencyKey, input: { orderId, amendmentId, ...body } }, async (tools) => {
    const { tx } = tools
    // amendInCommand takes the locks in their order (lines, deposit requests, then the order at this version).
    const fresh = (await readOrder(tx, order.id))!
    const all = await changesOf(tx, fresh, context)
    const target = all.find((entry) => entry.id === amendmentId)
    if (!target) throw new NotFoundError('Change not found.')
    if (!target.putBack.may) throw new InvalidStateError(target.putBack.why ?? 'You may not put this change back.')
    const row = await tx.salesOrderAmendment.findUniqueOrThrow({ where: { id: amendmentId }, select: AMENDMENT_CHANGE_COLUMNS })
    const before = row.before as unknown as OrderSnapshot
    const linesNow = new Set((await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id))
    const reason = (body.reason?.trim() || `Put back as before revision ${row.revision}: ${target.yes.state === 'TURNED_DOWN' ? 'its yes was refused' : 'the customer refused it'}.`).slice(0, 500)
    const amend = putBackBody(before, linesNow, body.version, reason)
    // The yes still waiting on the change (the customer refused first) is taken back: the change goes away.
    if (target.yes.state === 'WAITING' && target.yes.taskId) {
      await withdrawPending(tools, { kind: 'SALES_ORDER_CHANGE', recordId: order.id, byId: context.actorId, words: reason })
    }
    const { amendmentId: putBackId } = await amendInCommand(tools, context.tenantId, fresh, amend, { putBack: true })
    // Its extra deposit, while nothing is paid on it.
    let depositCancelled = false
    if (row.depositRequestId) {
      const { count } = await tx.depositRequest.updateMany({ where: { id: row.depositRequestId, status: 'OPEN', allocations: { none: {} } }, data: { status: 'CANCELLED', statusNote: `${fresh.number}: change of revision ${row.revision} put back`, updatedAt: tools.now, version: { increment: 1 } } })
      depositCancelled = count === 1
      if (depositCancelled) tools.audit({ action: 'orders.cancelDeposit', recordType: 'DepositRequest', recordId: row.depositRequestId, companyId: fresh.companyId, before: { status: 'OPEN' }, after: { status: 'CANCELLED', orderId: fresh.id, putBackOf: row.revision }, reason })
    }
    // The order no longer waits for the customer to accept a change that is gone — unless it waited before that change: an
    // earlier change the customer had to accept and had not accepted by then (W2a's flag is one for every change).
    const after = await tx.salesOrderAmendment.findUniqueOrThrow({ where: { id: putBackId }, select: { netAmountAfter: true, revision: true } })
    const earlier = await tx.salesOrderAmendment.findFirst({ where: { orderId: fresh.id, revision: { lt: row.revision }, reacceptanceNeeded: true }, orderBy: { revision: 'desc' }, select: { id: true } })
    const acceptedBefore = earlier ? await tx.approvalRequest.findFirst({ where: { recordType: 'SalesOrderAmendment', recordId: earlier.id, kind: 'REVISED_ORDER', status: { in: ['APPROVED', 'APPROVED_WITH_CHANGES'] }, answeredAt: { lt: row.createdAt } }, select: { id: true } }) : null
    const waitedBefore = earlier !== null && acceptedBefore === null
    let cleared = false
    if (!waitedBefore && after.netAmountAfter === row.netAmountBefore) {
      const { count } = await tx.salesOrder.updateMany({ where: { id: fresh.id, reapprovalNeededAt: { not: null } }, data: { reapprovalNeededAt: null, updatedAt: tools.now, version: { increment: 1 } } })
      cleared = count === 1
    }
    tools.audit({ action: 'orders.putBackChange', recordType: 'SalesOrder', recordId: fresh.id, companyId: fresh.companyId, after: { amendmentId, revision: row.revision, putBackAmendmentId: putBackId, putBackRevision: after.revision, depositCancelled, reacceptanceCleared: cleared }, reason })
    return { amendmentId: putBackId, depositCancelled }
  })
  const change = await caller.withClient(async (client) => (await changesOf(client, (await readOrder(client, order.id))!, context)).find((entry) => entry.id === result.amendmentId)!)
  return { order: await recordAfter(caller, order.id), change, depositCancelled: result.depositCancelled }
}

// ---- deposit kinds ---------------------------------------------------------------------------------------------------------

/** GET /sales/deposit-kinds?companyId= */
export async function depositKinds(caller: CommandCaller, query: { readonly companyId: string }) {
  const context = officeContextOf(caller)
  if (!can(actorOf(context), ORDERS_VIEW, { companyId: query.companyId })) throw new NotFoundError('Company not found.')
  const switchState = await caller.withClient((client) => caparraPenitenzialeOn(client, context.tenantId, query.companyId))
  return {
    companyId: query.companyId,
    kinds: (['ACCONTO', 'CAPARRA', PENITENTIAL_KIND] as const).map((kind) => ({
      kind,
      words: DEPOSIT_KIND_WORDS[kind],
      available: kind === PENITENTIAL_KIND ? switchState.on : true,
      why: kind === PENITENTIAL_KIND && !switchState.on ? PENITENTIAL_OFF_WORDS : null,
    })),
    caparraPenitenziale: { on: switchState.on, source: switchState.source },
  }
}
