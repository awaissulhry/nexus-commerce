import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { asMoney, markMoney, type Money } from '@nexus/factory-domain/money/marked'
import { depositFiscalOf } from '@nexus/factory-domain/sales/deposits/deposits'
import {
  amountOfPct,
  MONEY_PLAN_REFUSAL_WORDS,
  planByHand,
  PLAN_BY_HAND_ACTION,
  type AcceptShortWhy,
  type MoneyPlanAction,
  type MoneyPlanRefusal,
  type MoneyPlanResult,
  type PlannerFacts,
} from '@nexus/factory-domain/sales/orders/money-plan'
import { ORDERS_MONEY_PLAN, ORDERS_WAIVE } from '@nexus/factory-domain/sales/orders/permissions'
import { MILESTONE_WORDS, remadeSchedule, type MilestoneKind } from '@nexus/factory-domain/sales/orders/schedule'
import type { DepositKind } from '@nexus/factory-domain/sales/quotes/quotes'
import { instalmentsOf, termsNameIn } from '@nexus/factory-domain/sales/terms/terms'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { lockAll } from '../../payments/locks'
import { toleranceOf } from '../../payments/write-offs/sums'
import { shipmentsOfOrderWhere } from '../../shipping/shipments/orders-of'
import { markDepositPaid } from '../deposits/deposits'
import { officeContextOf } from './access'
import { officeOrder } from './moves'
import { followDepositInCommand, getSchedule, handStepIdsOf, profileNow, readMilestones, remakeScheduleInCommand } from './schedule'
import { asDay, dayOf, dayOrNull, lockOrder, readOrder, type OrderRow, type Reader } from './store'

/**
 * B-OM-011 … 016 (order money tab; 13-backend §3): an order's money plan changed BY HAND — ONE route, ONE pure planner
 * (factory-domain sales/orders/money-plan `planByHand`):
 *
 *   POST /sales/orders/:orderId/money-plan           orders.moneyPlan: the act (a discriminated body: `act`, the target's
 *                                                    `version`, a `reason` 3–500), written in ONE command
 *   POST /sales/orders/:orderId/money-plan/preview   the same body, nothing written: before → after (or the refusal in words)
 *
 * The command takes the money locks of the order's OPEN deposit requests FIRST, then the order's row (a payment holds a
 * request's lock and then needs the order: the waive's and the amendment's order), reads the plan under them, checks the version
 * sent, plans, and writes exactly the plan: new requests (the customer's fiscal decision now, `depositFiscalOf`), requests
 * cancelled (plain words, their live deposit pages revoked), moved or PAID by hand (ACCEPT_SHORT, `markDepositPaid`), the steps
 * changed or added, the order's deposit flag and version, the other open steps shared again (REPLACE_DEPOSIT, CHANGE_TERMS:
 * `remakeScheduleInCommand`, hand steps kept). ONE audit row `orders.planByHand` on the order: { act, milestoneIds,
 * depositRequestIds, replacements: [{ from, to }], why? } and the rows before → after (money marked price), the reason in the
 * row's reason; event sales_order.schedule_changed BY_HAND (+ deposit_request.created_for_order per new request). Amount acts
 * need the price grain (403 in words; the contract's money.price inputs are refused for a no-price writer too). CHANGE_TERMS asks
 * a fresh code, and so does ACCEPT_SHORT beyond the company's write-off tolerance (only the Owner: orders.waive). Refusals 409
 * `moneyPlan/<CODE>` in words (EN; the Italian in MONEY_PLAN_REFUSAL_WORDS).
 */

interface Common {
  readonly version: number
  readonly reason: string
}
interface Amounted {
  readonly amount?: number | undefined
  readonly pct?: string | undefined
}
export type MoneyPlanBody = Common &
  (
    | ({ readonly act: 'REPLACE_DEPOSIT'; readonly requestId: string } & Amounted)
    | { readonly act: 'MOVE_DUE'; readonly milestoneId?: string | undefined; readonly requestId?: string | undefined; readonly dueDate: BusinessDate }
    | { readonly act: 'ASK_AGAIN'; readonly milestoneId?: string | undefined; readonly requestId?: string | undefined; readonly dueDate: BusinessDate }
    | ({ readonly act: 'ADD_STEP'; readonly kind: MilestoneKind; readonly dueDate?: BusinessDate | null | undefined; readonly label?: string | null | undefined; readonly from: string } & Amounted)
    | ({ readonly act: 'CHANGE_STEP'; readonly milestoneId: string; readonly restTo?: string | undefined } & Amounted)
    | { readonly act: 'REMOVE_STEP'; readonly milestoneId: string; readonly restTo?: string | undefined }
    | { readonly act: 'RENAME_STEP'; readonly milestoneId: string; readonly label: string | null }
    | { readonly act: 'UNDO_OPEN'; readonly milestoneId: string }
    | { readonly act: 'CHANGE_TERMS'; readonly paymentTermsId: string }
    | { readonly act: 'ACCEPT_SHORT'; readonly requestId: string; readonly why: AcceptShortWhy }
  )

/** The acts that move an amount: the price grain only. */
const PRICED_ACTS: readonly MoneyPlanBody['act'][] = ['REPLACE_DEPOSIT', 'ASK_AGAIN', 'ADD_STEP', 'CHANGE_STEP', 'REMOVE_STEP', 'CHANGE_TERMS', 'ACCEPT_SHORT']
export const NO_PRICE_WORDS = 'Shown to people who see prices: someone who sees prices changes the money plan.'

const refused = (code: MoneyPlanRefusal): DomainError => new DomainError('conflict', MONEY_PLAN_REFUSAL_WORDS[code].en, [{ path: `moneyPlan/${code}`, message: MONEY_PLAN_REFUSAL_WORDS[code].en }])
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

const REQUEST_SELECT = { id: true, kind: true, status: true, amount: true, dueDate: true, version: true } as const

/** The plan as the planner reads it: every step, the order's deposit requests with what is paid on each, whether goods left. */
async function plannerFactsOf(db: Reader, order: OrderRow, now: Date) {
  const rows = await readMilestones(db, order.id)
  const requests = await db.depositRequest.findMany({ where: { OR: [{ orderId: order.id }, ...(order.quoteVersionId ? [{ quoteVersionId: order.quoteVersionId }] : [])] }, select: REQUEST_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const placed = requests.length > 0 ? await db.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: requests.map((row) => row.id) } }, _sum: { amount: true } }) : []
  const paidOf = new Map(placed.flatMap((row) => (row.depositRequestId ? [[row.depositRequestId, row._sum.amount ?? 0] as const] : [])))
  const left = await db.shipment.findFirst({ where: { ...shipmentsOfOrderWhere(order.id), shippedAt: { not: null } }, select: { id: true } })
  const facts: PlannerFacts = {
    order: { status: order.status, gross: order.grossAmount, goodsLeft: left !== null, paymentTermsId: order.paymentTermsId },
    steps: rows.map((row) => ({ id: row.id, seq: row.seq, kind: row.kind, status: row.status, amount: row.amount, sharePct: row.sharePct === null ? null : row.sharePct.toFixed(4), dueDate: dayOrNull(row.dueDate), label: row.label, depositRequestId: row.depositRequestId })),
    requests: requests.map((row) => ({ id: row.id, kind: row.kind, status: row.status, amount: row.amount, paid: paidOf.get(row.id) ?? 0, dueDate: dayOf(row.dueDate) })),
    today: businessDate(now),
  }
  return { facts, rows, requests }
}
type PlanRead = Awaited<ReturnType<typeof plannerFactsOf>>

/** The step or request the act names (404 when it is not the order's), and its version (409 when it moved on). */
function checkTarget(body: MoneyPlanBody, read: PlanRead, order: OrderRow): void {
  const step = (id: string | undefined) => {
    const row = id && isUuid(id) ? read.rows.find((entry) => entry.id === id) : undefined
    if (!row) throw new NotFoundError('Payment schedule step not found on this order.')
    return { model: 'SalesOrderMilestone' as const, id: row.id, version: row.version }
  }
  const request = (id: string | undefined) => {
    const row = id && isUuid(id) ? read.requests.find((entry) => entry.id === id) : undefined
    if (!row) throw new NotFoundError('Deposit request not found on this order.')
    return { model: 'DepositRequest' as const, id: row.id, version: row.version }
  }
  let target: { model: 'SalesOrderMilestone' | 'DepositRequest' | 'SalesOrder'; id: string; version: number }
  switch (body.act) {
    case 'REPLACE_DEPOSIT':
    case 'ACCEPT_SHORT':
      target = request(body.requestId)
      break
    case 'MOVE_DUE':
    case 'ASK_AGAIN':
      if ((body.milestoneId === undefined) === (body.requestId === undefined)) throw new ValidationError('Name the step or the deposit request (one of them).', [{ path: 'body/milestoneId', message: 'One of milestoneId and requestId.' }])
      target = body.milestoneId !== undefined ? step(body.milestoneId) : request(body.requestId)
      break
    case 'ADD_STEP':
      target = step(body.from)
      break
    case 'CHANGE_TERMS':
      target = { model: 'SalesOrder', id: order.id, version: order.version }
      break
    default:
      target = step(body.milestoneId)
  }
  if (target.version !== body.version) throw new StaleVersionError(target.model, target.id, target.version, body.version)
}

/** An amount act's amount: the minor units sent, or the share of the gross sent. */
function amountOf(body: Amounted, gross: number): number {
  if ((body.amount === undefined) === (body.pct === undefined)) throw new ValidationError('Say the amount or the share of the total (one of them).', [{ path: 'body/amount', message: 'One of amount and pct.' }])
  const amount = body.amount ?? amountOfPct(body.pct!, gross)
  if (amount === null) throw new ValidationError('The share of the total is a number above 0 and at most 100.', [{ path: 'body/pct', message: 'Above 0, at most 100.' }])
  return amount
}

/** The terms the act names (CHANGE_TERMS): the company's own or the tenant-wide ones. */
async function termsOf(db: Reader, order: OrderRow, paymentTermsId: string) {
  const terms = isUuid(paymentTermsId) ? await db.paymentTerms.findUnique({ where: { id: paymentTermsId }, select: { id: true, companyId: true, name: true, nameI18n: true, status: true, instalments: true } }) : null
  if (!terms || (terms.companyId !== null && terms.companyId !== order.companyId)) throw new NotFoundError('Payment terms not found.')
  return terms
}
type TermsRow = Awaited<ReturnType<typeof termsOf>>

/** The planner's action of a body; the facts only the API reads (the terms, the tolerance) put in. */
function actionOf(body: MoneyPlanBody, gross: number, extra: { readonly terms: TermsRow | null; readonly tolerance: number | null; readonly override: boolean }): MoneyPlanAction {
  switch (body.act) {
    case 'REPLACE_DEPOSIT':
      return { act: body.act, requestId: body.requestId, amount: amountOf(body, gross) }
    case 'MOVE_DUE':
    case 'ASK_AGAIN':
      return { act: body.act, milestoneId: body.milestoneId, requestId: body.requestId, dueDate: body.dueDate }
    case 'ADD_STEP':
      return { act: body.act, kind: body.kind, amount: amountOf(body, gross), dueDate: body.dueDate ?? null, label: body.label ?? null, from: body.from }
    case 'CHANGE_STEP':
      return { act: body.act, milestoneId: body.milestoneId, amount: amountOf(body, gross), restTo: body.restTo ?? null }
    case 'REMOVE_STEP':
      return { act: body.act, milestoneId: body.milestoneId, restTo: body.restTo ?? null }
    case 'RENAME_STEP':
      return { act: body.act, milestoneId: body.milestoneId, label: body.label }
    case 'UNDO_OPEN':
      return { act: body.act, milestoneId: body.milestoneId }
    case 'CHANGE_TERMS':
      return { act: body.act, paymentTermsId: body.paymentTermsId, termsArchived: extra.terms?.status === 'ARCHIVED' }
    case 'ACCEPT_SHORT':
      return { act: body.act, requestId: body.requestId, why: body.why, tolerance: extra.tolerance, override: extra.override }
  }
}

/** Whether ACCEPT_SHORT goes beyond the company's tolerance (or it has none): only then the Owner's fresh code. */
async function shortBeyondTolerance(db: Reader, order: OrderRow, read: PlanRead, requestId: string): Promise<boolean> {
  const request = read.facts.requests.find((row) => row.id === requestId)
  if (!request || request.paid <= 0 || request.paid >= request.amount) return false
  const tolerance = (await toleranceOf(db, order.companyId)).amount
  return tolerance === null || request.amount - request.paid > tolerance
}

/** The checks before the command: the right and the grain; the fresh code for the acts that ask it. */
async function admitted(caller: CommandCaller, orderId: string, body: MoneyPlanBody) {
  const order = await officeOrder(caller, orderId, ORDERS_MONEY_PLAN)
  const actor = actorOf(officeContextOf(caller))
  if (PRICED_ACTS.includes(body.act) && !heldGrains(actor).has('price')) throw new ForbiddenError(NO_PRICE_WORDS)
  const reason = body.reason.trim()
  if (reason.length < 3 || reason.length > 500) throw new ValidationError('Say why the money plan changes.', [{ path: 'body/reason', message: 'Say why (3 to 500 characters): it is kept in the history.' }])
  // Beyond the tolerance only the Owner (orders.waive) accepts a short deposit.
  const mayOverride = can(actor, ORDERS_WAIVE, { companyId: order.companyId, partyId: order.partyId })
  return { order, reason, mayOverride }
}

// ---- the preview ----------------------------------------------------------------------------------------------------------------

const figures = (row: { readonly amount: number; readonly dueDate: BusinessDate | null; readonly status: string; readonly label?: string | null }) => ({
  amount: asMoney('price', row.amount),
  dueDate: row.dueDate,
  status: row.status,
  label: row.label ?? null,
})

/** The plan before → after as the dialogs show it: each step and request it touches, and the steps the remake makes. */
async function previewOf(db: Reader, order: OrderRow, read: PlanRead, plan: MoneyPlanResult, terms: TermsRow | null) {
  const stepRows = new Map(read.facts.steps.map((row) => [row.id, row]))
  const requestRows = new Map(read.facts.requests.map((row) => [row.id, row]))
  const steps = plan.steps.map((step) => {
    const before = step.id ? stepRows.get(step.id) : undefined
    return { id: step.id, kind: step.kind, words: step.label ?? MILESTONE_WORDS[step.kind], before: before ? figures(before) : null, after: figures(step) }
  })
  const requests = [
    ...plan.cancelRequests.map((entry) => ({ id: entry.id, before: figures(requestRows.get(entry.id)!), after: figures({ ...requestRows.get(entry.id)!, status: 'CANCELLED' }) })),
    ...plan.moveRequests.map((entry) => ({ id: entry.id, before: figures(requestRows.get(entry.id)!), after: figures({ ...requestRows.get(entry.id)!, dueDate: entry.dueDate }) })),
    ...(plan.payRequest ? [{ id: plan.payRequest, before: figures(requestRows.get(plan.payRequest)!), after: figures({ ...requestRows.get(plan.payRequest)!, status: 'PAID' }) }] : []),
    ...plan.newRequests.map((entry) => ({ id: null, before: null, after: figures({ amount: entry.amount, dueDate: entry.dueDate, status: 'OPEN' }) })),
  ]
  const remade = plan.remake ? await remadePreviewOf(db, order, read, plan, terms) : { cancelled: [], added: [] }
  return { steps, requests, remade, short: asMoney('price', plan.short), needsFreshCode: plan.act === 'CHANGE_TERMS' || plan.overridden }
}

/** REPLACE_DEPOSIT, CHANGE_TERMS: the other open steps as the remake would share them (factory-domain remadeSchedule; hand steps kept). */
async function remadePreviewOf(db: Reader, order: OrderRow, read: PlanRead, plan: MoneyPlanResult, terms: TermsRow | null): Promise<{ cancelled: string[]; added: { kind: MilestoneKind; amount: Money<'price', number>; dueDate: BusinessDate | null }[] }> {
  const hand = await handStepIdsOf(db, order.id)
  const paidOf = new Map(read.facts.requests.map((row) => [row.id, row.paid]))
  const after = read.facts.steps.map((row) => {
    const planned = plan.steps.find((step) => step.id === row.id)
    return planned ? { ...row, status: planned.status, amount: planned.amount, dueDate: planned.dueDate, depositRequestId: planned.request } : row
  })
  const instalmentsFrom = terms ?? (order.paymentTermsId ? await db.paymentTerms.findUnique({ where: { id: order.paymentTermsId }, select: { instalments: true } }) : null)
  const outcome = remadeSchedule(
    after.map((row) => ({ id: row.id, seq: row.seq, kind: row.kind, status: row.status, amount: row.amount, dueDate: row.dueDate, depositRequestId: row.depositRequestId, requestPaid: row.depositRequestId ? (paidOf.get(row.depositRequestId) ?? 0) : 0, byHand: hand.has(row.id) })),
    { gross: order.grossAmount, instalments: instalmentsFrom ? instalmentsOf(instalmentsFrom.instalments) : null, promiseDate: dayOrNull(order.promiseDate) },
  )
  return { cancelled: [...outcome.cancel], added: outcome.insert.map((step) => ({ kind: step.kind, amount: asMoney('price', step.amount), dueDate: step.dueDate })) }
}

/** POST /sales/orders/:orderId/money-plan/preview: the act planned on the plan as it is now, nothing written. */
export async function previewMoneyPlan(caller: CommandCaller, orderId: string, body: MoneyPlanBody) {
  const { order, mayOverride } = await admitted(caller, orderId, body)
  return caller.withClient(async (db) => {
    const fresh = (await readOrder(db, order.id))!
    const read = await plannerFactsOf(db, fresh, serverClock.now())
    checkTarget(body, read, fresh)
    const terms = body.act === 'CHANGE_TERMS' ? await termsOf(db, fresh, body.paymentTermsId) : null
    const tolerance = body.act === 'ACCEPT_SHORT' ? (await toleranceOf(db, fresh.companyId)).amount : null
    const outcome = planByHand(read.facts, actionOf(body, fresh.grossAmount, { terms, tolerance, override: mayOverride }))
    if (!outcome.ok) return { act: body.act, refusal: { code: outcome.refusal, words: MONEY_PLAN_REFUSAL_WORDS[outcome.refusal] }, preview: null }
    return { act: body.act, refusal: null, preview: await previewOf(db, fresh, read, outcome.plan, terms) }
  })
}

// ---- the command ----------------------------------------------------------------------------------------------------------------

/** The live deposit pages of a request cancelled by hand are revoked (any address: the request is gone). */
async function revokeLinksOf(tools: CommandTools, requestId: string, companyId: string): Promise<void> {
  const links = await tools.tx.oneOffLink.findMany({ where: { recordType: 'DepositRequest', recordId: requestId, purpose: 'DEPOSIT_INFO' }, select: { id: true, revokedAt: true, expiresAt: true, uses: true, maxUses: true } })
  for (const link of links.filter((entry) => linkState(entry, tools.now) === 'LIVE')) {
    await tools.tx.oneOffLink.updateMany({ where: { id: link.id, revokedAt: null }, data: { revokedAt: tools.now, revokedById: actorIdOf(tools) ?? SYSTEM_ACTOR_ID } })
    tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: link.id, companyId, after: { revokedAt: toUtcIso(tools.now) }, reason: 'The deposit request was replaced or removed by hand.' })
  }
}

/** Inside the command: the plan written (see the file's head). Answers the steps and requests it touched. */
async function applyInCommand(tools: CommandTools, order: OrderRow, read: PlanRead, plan: MoneyPlanResult, body: MoneyPlanBody, reason: string, terms: TermsRow | null) {
  const { tx, now } = tools
  const actorId = actorIdOf(tools)
  const made = new Map<string, string>()
  const resolve = (ref: string | null): string | null => (ref === null ? null : (made.get(ref) ?? ref))
  const requestRows = new Map(read.requests.map((row) => [row.id, row]))
  // 1. The requests made, with the customer's fiscal decision now.
  const profile = plan.newRequests.length > 0 ? await profileNow(tx, order.partyId, now) : null
  for (const planned of plan.newRequests) {
    const id = newId()
    const fiscal = depositFiscalOf(planned.kind as DepositKind, profile)
    await tx.depositRequest.create({
      data: { id, companyId: order.companyId, partyId: order.partyId, orderId: order.id, kind: planned.kind as DepositKind, depositPct: planned.sharePct, currency: order.currency, amount: planned.amount, dueDate: asDay(planned.dueDate), fiscalDocument: fiscal.fiscalDocument, fiscalRule: fiscal.fiscalRule, createdAt: now, updatedAt: now, createdById: actorId },
      select: { id: true },
    })
    tools.audit({ action: 'sales.deposits.request', recordType: 'DepositRequest', recordId: id, companyId: order.companyId, after: { orderId: order.id, stepKind: planned.stepKind, kind: planned.kind, depositPct: planned.sharePct, currency: order.currency, amount: markMoney('price', planned.amount), dueDate: planned.dueDate, fiscalDocument: fiscal.fiscalDocument, fiscalRule: fiscal.fiscalRule, status: 'OPEN', byHand: plan.act }, reason })
    tools.emit({ type: 'deposit_request.created_for_order', subject: id, companyId: order.companyId, payload: { depositRequestId: id, orderId: order.id, number: order.number, partyId: order.partyId, stepKind: planned.stepKind, fiscalDocument: fiscal.fiscalDocument, dueDate: planned.dueDate } })
    made.set(planned.ref, id)
  }
  // 2. The requests cancelled (their live pages revoked), moved, or PAID by hand.
  for (const cancel of plan.cancelRequests) {
    const { count } = await tx.depositRequest.updateMany({ where: { id: cancel.id, status: 'OPEN' }, data: { status: 'CANCELLED', statusNote: cancel.note, updatedAt: now, version: { increment: 1 } } })
    if (count !== 1) throw new ConflictError('A deposit request of the order changed meanwhile: read the plan again.')
    tools.audit({ action: 'orders.cancelDeposit', recordType: 'DepositRequest', recordId: cancel.id, companyId: order.companyId, before: { status: 'OPEN' }, after: { status: 'CANCELLED', orderId: order.id, byHand: plan.act }, reason })
    await revokeLinksOf(tools, cancel.id, order.companyId)
  }
  for (const move of plan.moveRequests) {
    await tx.depositRequest.update({ where: { id: move.id }, data: { dueDate: asDay(move.dueDate), updatedAt: now, version: { increment: 1 } }, select: { id: true } })
  }
  // ── B-OM-016 (S2.4): ACCEPT_SHORT — the request PAID by hand ──
  if (plan.payRequest !== null) {
    await markDepositPaid(tools, { id: plan.payRequest, companyId: order.companyId, partyId: order.partyId, orderId: order.id }, { acceptedShort: { short: markMoney('price', plan.short), why: body.act === 'ACCEPT_SHORT' ? body.why : null, overridden: plan.overridden } })
    // Its steps follow at once (the worker's handler on payment.deposit_paid finds them PAID).
    await followDepositInCommand(tools, plan.payRequest)
  }
  // ── end B-OM-016 ──
  // 3. The steps changed or added.
  const stepIds: string[] = []
  for (const step of plan.steps) {
    const data = { amount: step.amount, sharePct: step.sharePct, dueDate: step.dueDate === null ? null : asDay(step.dueDate), label: step.label, depositRequestId: resolve(step.request), status: step.status, statusNote: step.statusNote }
    if (step.id === null) {
      const id = newId()
      await tx.salesOrderMilestone.create({ data: { id, companyId: order.companyId, orderId: order.id, partyId: order.partyId, seq: step.seq, kind: step.kind, ...data, createdAt: now, updatedAt: now, createdById: actorId }, select: { id: true } })
      stepIds.push(id)
    } else {
      await tx.salesOrderMilestone.update({ where: { id: step.id }, data: { ...data, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      stepIds.push(step.id)
    }
  }
  // 4. The order: its deposit flag, its terms (CHANGE_TERMS), its version.
  const depositRequired = plan.depositRequired !== null && plan.depositRequired !== order.depositRequired ? plan.depositRequired : null
  await tx.salesOrder.update({
    where: { id: order.id },
    data: { updatedAt: now, version: { increment: 1 }, ...(depositRequired !== null ? { depositRequired } : {}), ...(terms ? { paymentTermsId: terms.id, paymentTerms: termsNameIn(terms, order.language) } : {}) },
    select: { id: true },
  })
  // 5. The other open steps shared again (hand steps kept): the deposit replaced, the terms changed.
  const remade = plan.remake
    ? await remakeScheduleInCommand(tools, { ...order, paymentTermsId: terms?.id ?? order.paymentTermsId }, order.grossAmount, null, {
        note: plan.act === 'CHANGE_TERMS' ? 'Payment terms changed by hand: the schedule was made again.' : 'The deposit was changed by hand: the schedule was made again.',
      })
    : null
  // 6. ONE audit row of the hand change (the read's "Set by hand"), and the event.
  const depositRequestIds = [...new Set([...plan.cancelRequests.map((entry) => entry.id), ...made.values(), ...plan.moveRequests.map((entry) => entry.id), ...(plan.payRequest ? [plan.payRequest] : [])])]
  const beforeSteps = plan.steps.flatMap((step) => {
    const row = step.id ? read.facts.steps.find((entry) => entry.id === step.id) : undefined
    return row ? [{ milestoneId: row.id, kind: row.kind, status: row.status, amount: row.amount, dueDate: row.dueDate, label: row.label, depositRequestId: row.depositRequestId }] : []
  })
  const beforeRequests = depositRequestIds.flatMap((id) => {
    const row = requestRows.get(id)
    return row ? [{ depositRequestId: row.id, status: row.status, amount: row.amount, dueDate: dayOf(row.dueDate) }] : []
  })
  tools.audit({
    action: PLAN_BY_HAND_ACTION,
    recordType: 'SalesOrder',
    recordId: order.id,
    companyId: order.companyId,
    before: { steps: markMoney('price', beforeSteps), requests: markMoney('price', beforeRequests), depositRequired: order.depositRequired, ...(terms ? { paymentTermsId: order.paymentTermsId, paymentTerms: order.paymentTerms } : {}) },
    after: {
      act: plan.act,
      milestoneIds: stepIds,
      depositRequestIds,
      replacements: plan.replacements.map((pair) => ({ from: pair.from, to: resolve(pair.to) })),
      ...(body.act === 'ACCEPT_SHORT' ? { why: body.why } : {}),
      steps: markMoney('price', plan.steps.map((step, index) => ({ milestoneId: stepIds[index], kind: step.kind, status: step.status, amount: step.amount, dueDate: step.dueDate, label: step.label, depositRequestId: resolve(step.request) }))),
      requests: markMoney('price', [...plan.newRequests.map((entry) => ({ depositRequestId: made.get(entry.ref), status: 'OPEN', amount: entry.amount, dueDate: entry.dueDate })), ...plan.moveRequests.map((entry) => ({ depositRequestId: entry.id, dueDate: entry.dueDate }))]),
      ...(depositRequired !== null ? { depositRequired } : {}),
      ...(terms ? { paymentTermsId: terms.id, paymentTerms: termsNameIn(terms, order.language) } : {}),
      ...(plan.short !== null ? { short: markMoney('price', plan.short), overridden: plan.overridden } : {}),
      ...(remade ? { remade: { cancelled: remade.cancelled, inserted: remade.inserted } } : {}),
    },
    reason,
  })
  tools.emit({ type: 'sales_order.schedule_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'BY_HAND', milestoneIds: stepIds, partyId: order.partyId } })
  return { milestoneIds: stepIds, depositRequestIds }
}

/** POST /sales/orders/:orderId/money-plan: one hand act, written. Answers the plan read and what changed. */
export async function applyMoneyPlan(caller: CommandCaller, orderId: string, body: MoneyPlanBody, stepUp: () => void | Promise<void>, idempotencyKey?: string) {
  const { order, reason, mayOverride } = await admitted(caller, orderId, body)
  // The fresh code before the command: changing the terms always; accepting short beyond the tolerance (the Owner only).
  let override = false
  if (body.act === 'CHANGE_TERMS') await stepUp()
  if (body.act === 'ACCEPT_SHORT' && mayOverride) {
    const beyond = await caller.withClient(async (db) => shortBeyondTolerance(db, order, await plannerFactsOf(db, order, serverClock.now()), body.requestId))
    if (beyond) {
      await stepUp()
      override = true
    }
  }
  const { result } = await command(caller, { name: 'orders.moneyPlan', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx } = tools
    // The money locks of the order's open requests FIRST, then the order's row (the waive's and the amendment's order).
    const open = await tx.depositRequest.findMany({ where: { OR: [{ orderId: order.id }, ...(order.quoteVersionId ? [{ quoteVersionId: order.quoteVersionId }] : [])], status: 'OPEN' }, select: { id: true } })
    await lockAll(tx, tools.context, 'deposit', open.map((row) => row.id))
    await lockOrder(tx, order.id)
    const fresh = (await readOrder(tx, order.id))!
    const read = await plannerFactsOf(tx, fresh, tools.now)
    checkTarget(body, read, fresh)
    const terms = body.act === 'CHANGE_TERMS' ? await termsOf(tx, fresh, body.paymentTermsId) : null
    const tolerance = body.act === 'ACCEPT_SHORT' ? (await toleranceOf(tx, fresh.companyId)).amount : null
    const outcome = planByHand(read.facts, actionOf(body, fresh.grossAmount, { terms, tolerance, override }))
    if (!outcome.ok) throw refused(outcome.refusal)
    return applyInCommand(tools, fresh, read, outcome.plan, body, reason, terms)
  })
  return { ...(await getSchedule(caller, order.id)), changed: { act: body.act, milestoneIds: result.milestoneIds, depositRequestIds: result.depositRequestIds } }
}

