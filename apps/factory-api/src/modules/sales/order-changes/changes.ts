import { InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { amendmentDiff, amountMoves, nextRevision, totalGoesUp, type AmendLineInput, type OrderSnapshot } from '@nexus/factory-domain/sales/amendments/amendments' // B-OL-005: + amountMoves, totalGoesUp
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
import { amendInCommand, diffView, planAmendment, plannedGap, type AmendBody } from '../orders/amend'
// B-OP-013 (order page plan N2): the preview says what each work order will do, read as the command reads it.
import { workOrderPreviewOf } from '../orders/work-order-plan'
import { officeOrder, recordAfter } from '../orders/moves'
import { readOrder, readOrderFacts, type OrderRow, type Reader } from '../orders/store'
import { frozenChangesOf } from './freeze'
import { AMENDMENT_CHANGE_COLUMNS, changeFactsOf, pendingChangeYes } from './yes'
import { frozenProblems } from '@nexus/factory-domain/sales/order-changes/freeze'
// B-SA-041: a put-back makes the change's waiting work-order changes stale.
import { staleChangesInCommand } from '../../production/work-order-changes/decide'
// B-OP-012 (order page plan N2, D1): the work orders follow a priced change and a put-back in their command where the person may.
import { withAutoApply } from '../../production/work-order-changes/auto'
// B-OC-010 / B-OC-011 / B-OC-012 (order changes tab R6a, R6b, R8): each change linked, the customer's answer, the server's reasons.
import { PARTNERS_APPROVALS_VIEW } from '@nexus/factory-domain/approvals-out/permissions'
import { STATUS_NAMES, type Words } from '@nexus/factory-domain/sales/change-requests/rules'
import type { SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { putBackReasonWords, serverReasonOf } from '@nexus/factory-domain/sales/amendments/reasons'

/**
 * Priced change requests after the start, their extra deposit, the new yes and the put-back (B-W2b-309; SAL-219, SAL-221,
 * SAL-190; design order.changes.priced "Priced change requests": Change · Extra cost and price · Customer decision;
 * order.changes.list "Customer re-acceptance: not needed / waiting / accepted").
 *
 *   POST /sales/orders/:orderId/priced-changes/preview   orders.manage: the change as it would be written (W2a's diff), its
 *                                                        parts and fee, the extra deposit, that it applies at once (B-OP-010:
 *                                                        no yes is asked), the freeze rules' problems — nothing written
 *   POST /sales/orders/:orderId/priced-changes           orders.manage: ONE command — W2a's amendment carrying its price
 *                                                        (./apply.ts): parts, fee, extra deposit (B-OP-010: no yes); the customer
 *                                                        accepts it again when asked (B-OL-005: `askCustomer`, else when the
 *                                                        total goes up or a fee is charged; reacceptanceNeeded: B-W2b-184's
 *                                                        REVISED_ORDER link on the amendment, which shows the parts, the fee and
 *                                                        the deposit)
 *   GET  /sales/orders/:orderId/changes                  orders.view: every change newest first — what changed, its price
 *                                                        (the price grain), the extra deposit, the yes and the customer's
 *                                                        decision in words, and whether it may be put back
 *   POST /sales/orders/:orderId/changes/:amendmentId/put-back
 *                                                        orders.manage: the order written back as it was before that change
 *                                                        (its latest), when the yes was refused or the customer refused it
 *                                                        (B-OC-013: or its ask expired unanswered):
 *                                                        a new amendment (no yes asked, no re-acceptance), its extra deposit
 *                                                        cancelled while nothing is paid on it
 *   GET  /sales/deposit-kinds?companyId=                 orders.view: the deposit kinds with their words and whether the
 *                                                        company asks each now (the caparra penitenziale: off until the
 *                                                        accountant's wording, GATE-ACCOUNTANT)
 */

export interface PricedBody extends AmendBody, PricedInput {}

const pricedOf = (body: PricedBody): PricedInput => ({ labels: body.labels, fee: body.fee, deposit: body.deposit })
const amendOf = (body: PricedBody): AmendBody => ({ version: body.version, reason: body.reason, customerRef: body.customerRef, requestedDate: body.requestedDate, lines: body.lines, /* B-SA-042 */ extraOutcome: body.extraOutcome, /* B-OL-005 */ askCustomer: body.askCustomer })

const partView = (part: PricedPart) => ({ label: part.label, orderLineId: part.orderLineId ?? null, amount: asMoney('price', part.amount) })

/** POST /sales/orders/:orderId/priced-changes/preview */
export async function previewPricedChange(caller: CommandCaller, orderId: string, body: PricedBody) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const now = serverClock.now()
  const priced = pricedOf(body)
  return caller.withClient(async (client) => {
    const facts = await readOrderFacts(client, order)
    // B-OL-004 (order lines plan D2): a reason is optional, so the review needs no stand-in for it any more.
    // B-OP-014: the office's own change closes short a line it leaves out that work orders make (as its apply does).
    const plan = await planAmendment(client, order, order.status, facts, amendOf(body), now, { closeLeftOut: true })
    const revision = nextRevision((await client.salesOrderAmendment.findMany({ where: { orderId: order.id }, select: { revision: true } })).map((row) => row.revision))
    const empty = { revision, version: order.version, diff: null, parts: asMoney('price', [] as ReturnType<typeof partView>[]), feeAmount: asMoney('price', null), changeAmount: asMoney('price', null), deposit: asMoney('price', null), yes: null, stage: null, /* B-OP-013 */ workOrders: null, /* B-OL-005 */ amountChanges: false, totalUp: asMoney('price', false) }
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
    // B-OL-016 (order lines plan O8; 18 F25): no part and no fee is fine — a priced change of nothing is "no charge".
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
    // B-OP-013: the extra pieces and what each work order will do (in the same click or waiting, and why); Apply stays held until
    // the extra pieces' outcome is chosen (the command refuses it otherwise).
    const workOrders = await workOrderPreviewOf(client, context, order, await plannedGap(client, context.tenantId, order, plan, facts.lines), { requireOutcome: true, outcomeChosen: Boolean(body.extraOutcome) })
    return {
      ok: problems.length === 0 && !workOrders.needsOutcome,
      problems,
      revision,
      version: order.version,
      diff: diffView(plan.diff),
      parts: asMoney('price', parts.map(partView)),
      feeAmount: asMoney('price', feeAmount),
      /** The net change of the lines plus the fee (what the customer is asked, before VAT). */
      changeAmount: asMoney('price', plan.diff.netAfter - plan.diff.netBefore + (feeAmount ?? 0)),
      deposit: asMoney('price', deposit ? { amount: asMoney('price', deposit.amount), pct: deposit.pct, basis: deposit.basis, kind: deposit.kind, growthAmount: asMoney('price', deposit.growth) } : null),
      // B-OP-010 (order page plan N2, decision D2): an office change applies at once — "Applies at once — no approval".
      yes: 'APPLIES_AT_ONCE' as const,
      stage: frozen.furthest ? { stage: frozen.furthest, words: STAGE_WORDS[frozen.furthest] } : null,
      workOrders,
      // B-OL-005 (order lines plan D3; 18 F10): the amount moves (every writer); what the customer pays goes up (the price grain).
      amountChanges: amountMoves({ netBefore: plan.diff.netBefore, netAfter: plan.diff.netAfter, feeAmount }),
      totalUp: asMoney('price', totalGoesUp({ netBefore: plan.diff.netBefore, netAfter: plan.diff.netAfter, feeAmount })),
    }
  })
}

/** POST /sales/orders/:orderId/priced-changes */
export async function applyPricedChange(caller: CommandCaller, orderId: string, body: PricedBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  // The command's result is plain JSON (a replay answers from its receipt): the amendment's id, never amendInCommand's `before` Map.
  const { result } = await withAutoApply((autoApply) =>
    command(caller, { name: 'orders.pricedChange', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
      const done = await amendInCommand(tools, context.tenantId, order, amendOf(body), { priced: pricedOf(body), autoApply, /* B-OP-014 */ closeLeftOut: true })
      return { amendmentId: done.amendmentId, workOrders: done.workOrders }
    }),
  )
  const change = await caller.withClient(async (client) => (await changesOf(client, (await readOrder(client, order.id))!, context)).find((entry) => entry.id === result.amendmentId)!)
  return { order: await recordAfter(caller, order.id), change, /* B-OP-012 */ workOrders: result.workOrders }
}

// ---- the order's changes ----------------------------------------------------------------------------------------------------

async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

// ── B-OC-010 (order changes tab R6a; 13-backend §4): why a change is not restored as before, in the office's words (EN + IT) ──
export const PUT_BACK_WHY = Object.freeze({
  notLatest: { en: 'Only the latest change can be restored as before.', it: "Si può ripristinare com'era solo l'ultima modifica." },
  // B-OC-013 (Owner D5): + the customer's silence (its ask expired).
  noRefusal: { en: 'A change is restored as before when its yes was refused, or the customer refused it or did not answer in time.', it: "Una modifica si ripristina com'era quando il suo sì è stato rifiutato, o il cliente l'ha rifiutata o non ha risposto in tempo." },
} as const satisfies Record<string, Words>)

/** "The order is partly shipped: its lines no longer change." (the order's status in the change requests' own words). */
export function putBackStatusWhy(status: string): Words {
  const name = STATUS_NAMES[status as SalesOrderStatus] ?? { en: status.toLowerCase(), it: status.toLowerCase() }
  return { en: `The order is ${name.en}: its lines no longer change.`, it: `L'ordine è ${name.it}: le sue righe non cambiano più.` }
}

/** The order's states in which a change may be restored as before (its lines still change). */
const PUT_BACK_STATES: readonly string[] = ['CONFIRMED', 'IN_PRODUCTION', 'READY']

/**
 * B-OC-010: a reason to restore it — our yes refused, or the customer's no to it (its NEWEST ask: one asked again and open, or
 * answered, wins). B-OC-013 (order changes tab R9; Owner D5 2026-11-22): or that newest ask EXPIRED — silence is not a yes, and
 * without this there is no way back (our undo, never a yes for the customer). Pure.
 */
export const putBackCause = (yesStatus: string | null, customerStatus: string | null): boolean => yesStatus === 'REJECTED' || customerStatus === 'REFUSED' || /* B-OC-013 */ customerStatus === 'EXPIRED'

/** What may be put back: the latest change, when its yes was refused or the customer refused it (B-OC-010: in words, EN + IT). */
function putBackWhy(latest: boolean, yesStatus: string | null, customerStatus: string | null, order: Pick<OrderRow, 'status'>): Words | null {
  if (!latest) return PUT_BACK_WHY.notLatest
  if (!PUT_BACK_STATES.includes(order.status)) return putBackStatusWhy(order.status)
  if (!putBackCause(yesStatus, customerStatus)) return PUT_BACK_WHY.noRefusal
  return null
}

/** B-OC-011: how the customer answered a request — by its one-use link or in its portal (null: not answered). */
const answeredViaOf = (request: { readonly answeredViaLinkId: string | null; readonly answeredByUserId: string | null }): 'LINK' | 'PORTAL' | null =>
  request.answeredViaLinkId ? 'LINK' : request.answeredByUserId ? 'PORTAL' : null

/** B-OC-010: each put-back of the order (its `orders.putBackChange` audit rows): the change put back and the one that did it. */
function putBacksOf(rows: readonly { readonly after: unknown }[]): { restores: Map<string, number>; restoredBy: Map<string, number> } {
  const restores = new Map<string, number>()
  const restoredBy = new Map<string, number>()
  for (const row of rows) {
    const after = (row.after ?? {}) as Record<string, unknown>
    const { amendmentId, revision, putBackAmendmentId, putBackRevision } = after
    if (typeof putBackAmendmentId === 'string' && typeof revision === 'number') restores.set(putBackAmendmentId, revision)
    if (typeof amendmentId === 'string' && typeof putBackRevision === 'number') restoredBy.set(amendmentId, putBackRevision)
  }
  return { restores, restoredBy }
}
// ── end B-OC-010 ──

async function changesOf(db: Reader, order: OrderRow, context: ReturnType<typeof officeContextOf>) {
  const rows = await db.salesOrderAmendment.findMany({ where: { orderId: order.id }, orderBy: { revision: 'desc' }, select: AMENDMENT_CHANGE_COLUMNS })
  if (rows.length === 0) return []
  const tasks = await db.approvalTask.findMany({ where: { kind: 'SALES_ORDER_CHANGE', recordType: 'SalesOrder', recordId: order.id }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true, requestedAt: true, decidedAt: true, rejectReason: true, /* B-OC-010 */ decidedById: true } })
  // B-OC-011: + how the customer answered (its typed name, its words, by link or in its portal).
  const requests = await db.approvalRequest.findMany({ where: { recordType: 'SalesOrderAmendment', recordId: { in: rows.map((row) => row.id) }, kind: 'REVISED_ORDER' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, recordId: true, status: true, answeredAt: true, typedName: true, answer: true, answeredViaLinkId: true, answeredByUserId: true } })
  const deposits = await db.depositRequest.findMany({ where: { id: { in: rows.flatMap((row) => (row.depositRequestId ? [row.depositRequestId] : [])) } }, select: { id: true, kind: true, amount: true, status: true, dueDate: true, depositPct: true } })
  // ── B-OC-010: the customer's request each change carried out, and the put-backs (each names the change it restored) ──
  const carried = new Map((await db.orderChangeRequest.findMany({ where: { orderId: order.id, amendmentId: { in: rows.map((row) => row.id) } }, select: { id: true, amendmentId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).flatMap((request) => (request.amendmentId ? [[request.amendmentId, request.id] as const] : [])))
  const putBacks = putBacksOf(await db.auditLog.findMany({ where: { recordType: 'SalesOrder', recordId: order.id, action: 'orders.putBackChange' }, select: { after: true } }))
  // ── end B-OC-010 ──
  const names = await namesOf(db, [...rows.map((row) => row.createdById), /* B-OC-010 */ ...tasks.map((task) => task.decidedById)])
  const mayManage = can(actorOf(context), ORDERS_MANAGE, { companyId: order.companyId, partyId: order.partyId })
  // B-OC-011: the customer's own words only with the approvals list's right (partners.approvals.view over its company and customer).
  const seesWords = can(actorOf(context), PARTNERS_APPROVALS_VIEW, { companyId: order.companyId, partyId: order.partyId })
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
      /** B-OC-012: which server words the reason is (AUTOMATIC · REQUEST · PUT_BACK); null: typed by a person. */
      reasonCode: serverReasonOf(row.reason),
      // ── B-OC-010: the customer's request it carried out; the revision it restored, and the one that restored it ──
      changeRequestId: carried.get(row.id) ?? null,
      restores: putBacks.restores.get(row.id) ?? null,
      restoredBy: putBacks.restoredBy.get(row.id) ?? null,
      // ── end B-OC-010 ──
      createdAt: toUtcIso(row.createdAt),
      createdBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
      /** A priced change request (parts or a fee). */
      priced: facts.priceDeltaLines !== null || facts.feeAmount !== null,
      diff: diffView(diff),
      parts: asMoney('price', (facts.priceDeltaLines ?? []).map(partView)),
      feeAmount: asMoney('price', facts.feeAmount),
      changeAmount: asMoney('price', diff.netAfter - diff.netBefore + (facts.feeAmount ?? 0)),
      deposit: deposit ? { id: deposit.id, kind: deposit.kind, kindWords: DEPOSIT_KIND_WORDS[deposit.kind as keyof typeof DEPOSIT_KIND_WORDS], amount: asMoney('price', deposit.amount), pct: deposit.depositPct ? new Dec(deposit.depositPct.toString()).toFixed(4) : null, status: deposit.status, dueDate: businessDate(deposit.dueDate) } : null,
      // B-OC-010: + when and by whom (an office person) our yes was decided.
      yes: { state: yesState, words: CHANGE_YES_WORDS[yesState], taskId: yesTask?.id ?? null, reason: yesTask?.status === 'REJECTED' ? yesTask.rejectReason : null, decidedAt: yesTask?.decidedAt ? toUtcIso(yesTask.decidedAt) : null, decidedBy: yesTask?.decidedById ? (names.get(yesTask.decidedById) ?? null) : null },
      customer: {
        decision,
        words: CUSTOMER_DECISION_WORDS[decision],
        requestId: request?.id ?? null,
        answeredAt: request?.answeredAt ? toUtcIso(request.answeredAt) : null,
        // ── B-OC-011 (R6b): the name the customer typed, how it answered, its own words (with partners.approvals.view) ──
        by: request?.typedName ?? null,
        via: request ? answeredViaOf(request) : null,
        answer: seesWords ? (request?.answer ?? null) : null,
        // ── end B-OC-011 ──
      },
      // B-OC-010: `offered` — the latest change with a reason to restore it, to a reader who may (orders.manage); `why` in words.
      putBack: { offered: index === 0 && putBackCause(yesTask?.status ?? null, request?.status ?? null) && mayManage, may: why === null && mayManage, why },
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
  const { result } = await withAutoApply((autoApply) => command(caller, { name: 'orders.putBackChange', idempotencyKey, input: { orderId, amendmentId, ...body } }, async (tools) => {
    const { tx } = tools
    // amendInCommand takes the locks in their order (lines, deposit requests, then the order at this version).
    const fresh = (await readOrder(tx, order.id))!
    const all = await changesOf(tx, fresh, context)
    const target = all.find((entry) => entry.id === amendmentId)
    if (!target) throw new NotFoundError('Change not found.')
    if (!target.putBack.may) throw new InvalidStateError(target.putBack.why?.en ?? 'You may not put this change back.')
    const row = await tx.salesOrderAmendment.findUniqueOrThrow({ where: { id: amendmentId }, select: AMENDMENT_CHANGE_COLUMNS })
    const before = row.before as unknown as OrderSnapshot
    const linesNow = new Set((await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id))
    // B-OC-012: the default words are the domain's template (serverReasonOf reads them back as PUT_BACK).
    // B-OC-013: after the customer's silence (its ask expired), "…: the customer did not answer in time."
    const cause = target.yes.state === 'TURNED_DOWN' ? 'YES_REFUSED' : target.customer.decision === 'EXPIRED' ? 'CUSTOMER_SILENT' : 'CUSTOMER_REFUSED'
    const reason = (body.reason?.trim() || putBackReasonWords(row.revision, cause)).slice(0, 500)
    const amend = putBackBody(before, linesNow, body.version, reason)
    // The yes still waiting on the change (the customer refused first) is taken back: the change goes away.
    if (target.yes.state === 'WAITING' && target.yes.taskId) {
      await withdrawPending(tools, { kind: 'SALES_ORDER_CHANGE', recordId: order.id, byId: context.actorId, words: reason })
    }
    // B-SA-041: the work-order changes the change proposed and nobody applied yet are no longer needed (STALE): it is put back.
    await staleChangesInCommand(tools, { amendmentId })
    // B-OP-014: the lines that change closed short (left out while work orders made them) are reopened by its put-back, as Reopen
    // lines reopens them — the order is as it was before it.
    const closedByIt = (row.after as unknown as OrderSnapshot).lines.filter((line) => line.closedShortQuantity !== null && before.lines.some((was) => was.id === line.id && was.closedShortQuantity === null)).map((line) => line.id)
    const { amendmentId: putBackId, workOrders } = await amendInCommand(tools, context.tenantId, fresh, amend, { putBack: true, autoApply, reopen: closedByIt })
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
    return { amendmentId: putBackId, depositCancelled, workOrders }
  }))
  const change = await caller.withClient(async (client) => (await changesOf(client, (await readOrder(client, order.id))!, context)).find((entry) => entry.id === result.amendmentId)!)
  return { order: await recordAfter(caller, order.id), change, depositCancelled: result.depositCancelled, /* B-OP-012 */ workOrders: result.workOrders }
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
