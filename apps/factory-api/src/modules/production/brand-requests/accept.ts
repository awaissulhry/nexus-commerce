import { DomainError, ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { actorOf } from '../../../core/context'
import {
  CUSTOMER_PAUSE_REASON,
  isProductionAccept,
  pauseDoneWords,
  pausePlan,
  resumeReasonOf,
  SALES_ACCEPT_WORDS,
} from '@nexus/factory-domain/production-brand/accept'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { answerProblems, type OrderRequestKind } from '@nexus/factory-domain/sales/change-requests/rules'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import type { Clock } from '../../../core/time'
import { answerableIn } from '../../sales/change-requests/counter'
import type { OfficeRequestRow } from '../../sales/change-requests/store'
import { lockOrder } from '../../sales/orders/store'
import { GOODS_LINE_KINDS } from '../brand/facts'
import { liftWorkOrderHoldInCommand, placeWorkOrderHoldsInCommand } from '../holds/holds'
import { officeContextOf } from '../work-orders/access'
import { assertAnswers, viewAfter } from './answer'
import { brandRequestWhere, readableRequest } from './read'
// ── B-PR-27b: the rush, the sample round ──
import type { OfficeContext } from '../../../core/context'
import { ACCEPT_DONE_WORDS, joinedWords, NOTHING_TO_RUSH_WORDS, RUSH_FLOOR_ONLY_WORDS, RUSH_REFUSAL_WORDS, RUSH_RIGHT_WORDS, rushMixedWords, rushPlan, sampleCellsOf, sampleInstructionsOf, type RushWorkOrder } from '@nexus/factory-domain/production-brand/accept'
import { WORKORDERS_MANAGE } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CreateRoundBody } from '@nexus/factory-domain/sales/samples/contracts'
import type { SampleKind } from '@nexus/factory-domain/sales/samples/rules'
import { acceptProposals, proposeInCommand, type AcceptProposals } from '../../planning/promise-keep/repromise'
import { agreedDateOf } from '../../sales/change-requests/counter'
import { readCells } from '../../sales/change-requests/store'
import { createRoundInCommand, roundChecks, type RoundChecked } from '../../sales/samples/rounds'
import { databaseRefusal } from '../../sales/samples/store'
import { acceptAskInCommand, type AcceptedUrgency } from '../brand/urgency'
import { lockWorkOrderRow } from '../holds/standing'
import { mayOn } from '../work-orders/access'
import { bumpVersion } from '../work-orders/moves'
import { readWorkOrder, type Reader } from '../work-orders/store'
import { priorityEvent } from '../work-orders/work-orders'
import { newId } from '@nexus/factory-domain/core/ids'
// ── end B-PR-27b ──
// ── B-PR-46a: a customer's batch accepted as one group ──
import { BATCH_ANSWER_WORDS, BATCH_RUSH_FLOOR_ONLY } from '@nexus/factory-domain/production-brand/bulk'
import { acceptRequest } from '../../sales/change-requests/office'
import { answerEach, type BatchItem } from './answer'
import { readableBatch } from './read'
// ── end B-PR-46a ──

/**
 * B-PR-27a — accepting a customer's production ask does the work (production plan §3 "Brand asks, we decide", "Who answers /
 * sets", "Legacy mixed work order: accept is held ('answer by hand')"; 08-backend §4.2 "Accept does"; lead pick L4; the Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."; rules factory-domain production-brand/accept):
 *
 *   POST /production/brand-requests/:requestId/accept {version, answer?}
 *     who     the request read through the brand wall (./read: orders.view or workorders.view over its company AND customer, else
 *             "Change request not found."), then the kind's permission over the order (HOLD, RESUME production.brand.manage),
 *             else 403 in words; a Sales kind (change, cancel, ship what is ready) → 409 `request/SALES_ASK`
 *     what    an OPEN request, or a COUNTERED one the customer said yes to (sales/change-requests/counter answerableIn: it is
 *             carried out with the counter), at the version read; ONE command — the request (FOR UPDATE), the order's row (FOR
 *             UPDATE), then the work orders by id (production/holds: each one's issue lock, gate lock, row) —
 *             HOLD    a BRAND hold (the customer's pause, its HOLD ask named; the reason CUSTOMER_PAUSE, never the office's
 *                     note) on each open work order of the order (placeWorkOrderHoldsInCommand); held in words, nothing written,
 *                     when the office answers it by hand (409 `request/<NO_WORK|MIXED|SHARED>`)
 *             RESUME  the order's ACTIVE BRAND holds lifted (liftWorkOrderHoldInCommand: a work order still held by another hold
 *                     stays held under it)
 *             then the request ACCEPTED with our words, audit rows on the request and the order, order_change_request.answered
 *             (ACCEPTED); production/holds emits work_order_hold.placed | lifted and workorder.status_changed
 *     wall    the work orders are those of the order's own goods lines only: a mixed one (another customer's pieces too) is never
 *             held, and nothing here reads or writes another customer's row; the answer names the order's own work orders only
 *
 * B-PR-27b (production plan §3 "Brand-slot rule", "Who answers / sets"; 08-backend §4.2; R-40, R-64) — the same route, {version,
 * answer?, rushFloor?}:
 *   RUSH          (production.brand.manage) "Accept as urgent": the order marked Urgent by us, last in the customer's OWN Urgent
 *                 list (production/brand/urgency acceptAskInCommand: it may pass the quota — "agreed with us" —, planning's
 *                 brand-slot pass moves it only among that customer's own places; refused in words while we locked it, its
 *                 urgency is off, it has no production state or left production), and the date it asked (our counter's when the
 *                 customer agreed one) proposed to sales as the re-promise of each open size promised later
 *                 (planning/promise-keep acceptProposals + proposeInCommand; a line left out says why). `rushFloor: true` ("Accept
 *                 and rush the floor"): the same, plus the planner's own rush lever on each open work order of the order
 *                 (WorkOrder.rush, workorder.priority_changed; workorders.manage over each, else 403 in words; nothing to rush: 409
 *                 `request/NOTHING_TO_RUSH`; a mixed work order left alone, in words). Never the office's priority, level or
 *                 backlog rank: a jump ahead of other customers stays the planner's level or hand rank
 *   SAMPLE_ROUND  (sales.samples.manage) a sample round of the kind asked, for the customer, of the line's style in its colourway
 *                 (sales/samples roundChecks + createRoundInCommand: a size set one piece per size ordered, the others one piece of
 *                 the base size), named on the request (sampleRoundId); sample_round.requested
 * Lock order: the request, the order's row, the customer's urgency lock, the work orders by id, each line's promise lock.
 */

/** One work order of the order, as the accept writes it back. */
export interface AcceptedWorkOrder {
  readonly id: string
  readonly number: string
  readonly status: WorkOrderStatus
  /** HOLD: it went ON_HOLD now (false: on hold already, the pause stands beside the other hold). RESUME: it left ON_HOLD now. */
  readonly changed: boolean
}

/** The accept's answer as the contract sends it (fix-pr-4: its lists are the response's own arrays, not read-only ones). */
export interface AcceptDone {
  readonly kind: OrderRequestKind
  /** HOLD: the work orders paused now. */
  readonly paused: AcceptedWorkOrder[]
  /** RESUME: the work orders whose pause was lifted now. */
  readonly resumed: AcceptedWorkOrder[]
  // B-PR-27b
  /** RUSH: the order's urgency in the customer's own list after the accept. */
  readonly urgency: AcceptedUrgency | null
  /** RUSH with rushFloor: the work orders rushed now (changed), or rushed already. */
  readonly rushed: AcceptedWorkOrder[]
  /** RUSH with rushFloor: the mixed work orders left alone (rush them by hand). */
  readonly rushSkipped: Words | null
  /** RUSH: the new date proposed to sales per line, and the lines not proposed with why. */
  readonly repromise: { readonly proposals: { readonly id: string; readonly orderLineId: string; readonly seq: number; readonly sizes: { readonly size: string | null; readonly from: string | null; readonly to: string }[] }[]; readonly skipped: AcceptProposals['skipped'][number][] } | null
  /** SAMPLE_ROUND: the round it made. */
  readonly sampleRound: { readonly id: string; readonly number: string; readonly kind: string } | null
  /** What was done, in the office's words. */
  readonly words: Words
}

export interface AcceptBody {
  readonly version: number
  /** Our words to the customer (optional on an accept). */
  readonly answer?: string | null | undefined
  /** B-PR-27b, RUSH only: "Accept and rush the floor" (true) or "Accept as urgent" (false, left out). */
  readonly rushFloor?: boolean | undefined
}

const none27b = (): Pick<AcceptDone, 'urgency' | 'rushed' | 'rushSkipped' | 'repromise' | 'sampleRound'> => ({ urgency: null, rushed: [], rushSkipped: null, repromise: null, sampleRound: null })

const blank = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The order's work orders (cells of its goods lines; never a repair), in id order, with what the accept needs of each. */
async function orderWorkOrders(tx: Reader, orderId: string): Promise<RushWorkOrder[]> {
  const lines = await tx.salesOrderLine.findMany({ where: { orderId }, select: { id: true, kind: true } })
  const own = new Set(lines.filter((line) => (GOODS_LINE_KINDS as readonly string[]).includes(line.kind)).map((line) => line.id))
  if (own.size === 0) return []
  const cells = await tx.workOrderSize.findMany({ where: { salesOrderLineId: { in: [...own] }, workOrder: { kind: { not: 'REPAIR' } } }, select: { workOrderId: true } })
  const ids = [...new Set(cells.map((cell) => cell.workOrderId))].sort()
  if (ids.length === 0) return []
  const rows = await tx.workOrder.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, status: true, partyId: true, rush: true /* B-PR-27b */ } })
  // Every cell of those work orders: one of another order's line (or of no order) makes the work order shared.
  const all = await tx.workOrderSize.findMany({ where: { workOrderId: { in: ids } }, select: { workOrderId: true, salesOrderLineId: true } })
  const shared = new Set(all.filter((cell) => cell.salesOrderLineId === null || !own.has(cell.salesOrderLineId)).map((cell) => cell.workOrderId))
  const paused = new Set((await tx.workOrderHold.findMany({ where: { workOrderId: { in: ids }, kind: 'BRAND', status: 'ACTIVE' }, select: { workOrderId: true } })).map((hold) => hold.workOrderId))
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    return row ? [{ id, number: row.number, status: row.status as WorkOrderStatus, partyId: row.partyId, otherOrders: shared.has(id), paused: paused.has(id), rush: row.rush }] : []
  })
}

/** HOLD: a BRAND hold on each open work order of the order (or the reason it is answered by hand, nothing written). */
async function pauseInCommand(tools: CommandTools, row: OfficeRequestRow): Promise<AcceptDone> {
  const plan = pausePlan(await orderWorkOrders(tools.tx, row.orderId))
  if (!plan.ok) throw new DomainError('invalid_state', plan.words.en, [{ path: `request/${plan.code}`, message: plan.words.en }])
  const placed = plan.hold.length === 0 ? [] : await placeWorkOrderHoldsInCommand(tools, { workOrderIds: plan.hold, kind: 'BRAND', reasonCode: CUSTOMER_PAUSE_REASON.code, requestId: row.id })
  const paused = placed.map((entry) => ({ id: entry.workOrder.id, number: entry.workOrder.number, status: entry.workOrder.status, changed: entry.held }))
  return { kind: 'HOLD', paused, resumed: [], ...none27b(), words: pauseDoneWords('HOLD', paused.map((entry) => entry.number)) }
}

/** RESUME: every ACTIVE BRAND hold of the order's HOLD asks lifted, work order by work order in id order. */
async function resumeInCommand(tools: CommandTools, row: OfficeRequestRow): Promise<AcceptDone> {
  const { tx } = tools
  const pauses = await tx.orderChangeRequest.findMany({ where: { orderId: row.orderId, kind: 'HOLD' }, select: { id: true } })
  const holds = pauses.length === 0 ? [] : await tx.workOrderHold.findMany({ where: { requestId: { in: pauses.map((pause) => pause.id) }, kind: 'BRAND', status: 'ACTIVE' }, select: { id: true, workOrderId: true } })
  const order = await tx.salesOrder.findUnique({ where: { id: row.orderId }, select: { number: true } })
  const reason = resumeReasonOf(order?.number ?? '')
  const resumed: AcceptedWorkOrder[] = []
  for (const hold of [...holds].sort((a, b) => (a.workOrderId < b.workOrderId ? -1 : a.workOrderId > b.workOrderId ? 1 : a.id < b.id ? -1 : 1))) {
    const lifted = await liftWorkOrderHoldInCommand(tools, { workOrderId: hold.workOrderId, holdId: hold.id, reason })
    const workOrder = (await tx.workOrder.findUnique({ where: { id: hold.workOrderId }, select: { number: true, status: true } }))!
    resumed.push({ id: hold.workOrderId, number: workOrder.number, status: workOrder.status as WorkOrderStatus, changed: lifted.lifted })
  }
  return { kind: 'RESUME', paused: [], resumed, ...none27b(), words: pauseDoneWords('RESUME', resumed.map((entry) => entry.number)) }
}

// ── B-PR-27b: "Urgent – asked" and another sample round ─────────────────────────────────────────────────────────────────────────

/** What the accept read before its command (the reads that check, as every command of this codebase does them). */
interface AcceptReads {
  /** RUSH: the date the customer asked (our counter's when it agreed one), and the re-promise it proposes. */
  readonly proposals: AcceptProposals | null
  /** SAMPLE_ROUND: the round's body and its checks. */
  readonly round: { readonly body: CreateRoundBody; readonly checked: RoundChecked } | null
}

/** "Accept and rush the floor" before the command: something to rush, and the person may rush each work order (else refused). */
async function rushChecks(caller: CommandCaller, context: OfficeContext, orderId: string): Promise<void> {
  const workOrders = await caller.withClient((client) => orderWorkOrders(client, orderId))
  const plan = rushPlan(workOrders)
  if (plan.rush.length + plan.already.length === 0) throw new DomainError('invalid_state', NOTHING_TO_RUSH_WORDS.en, [{ path: 'request/NOTHING_TO_RUSH', message: NOTHING_TO_RUSH_WORDS.en }])
  const rows = plan.rush.length === 0 ? [] : await caller.withClient((client) => client.workOrder.findMany({ where: { id: { in: [...plan.rush] } }, select: { companyId: true, siteId: true, partyId: true } }))
  if (rows.some((row) => !mayOn(context, WORKORDERS_MANAGE, row))) throw new ForbiddenError(RUSH_RIGHT_WORDS.en)
}

/** SAMPLE_ROUND before the command: the round of the kind asked, of the request's line, checked as a new round (sales/samples). */
async function sampleChecks(caller: CommandCaller, row: OfficeRequestRow): Promise<{ body: CreateRoundBody; checked: RoundChecked }> {
  const facts = await caller.withClient(async (client) => {
    const cell = ((await readCells(client, [row.id])).get(row.id) ?? [])[0]
    const line = cell ? await client.salesOrderLine.findUnique({ where: { id: cell.orderLineId }, select: { id: true, seq: true, styleId: true, colourwayId: true, baseSize: true, sizes: { select: { size: true, quantity: true } } } }) : null
    const style = line ? await client.style.findUnique({ where: { id: line.styleId }, select: { baseSize: true, sizes: true } }) : null
    const order = await client.salesOrder.findUnique({ where: { id: row.orderId }, select: { number: true, companyId: true } })
    return { line, style, order }
  })
  if (!facts.line || !facts.style || !facts.order || !row.sampleKind) throw new DomainError('invalid_state', 'The sample round asked names no line of the order any more: refuse it with words.', [{ path: 'request/NO_LINE', message: 'The line is gone.' }])
  const cells = sampleCellsOf(row.sampleKind, facts.line, facts.style)
  const body: CreateRoundBody = {
    styleId: facts.line.styleId,
    companyId: facts.order.companyId,
    kind: row.sampleKind as SampleKind,
    partyId: row.partyId,
    cells,
    instructions: sampleInstructionsOf(facts.order.number, facts.line.seq, row.reason),
  } as CreateRoundBody
  return { body, checked: await roundChecks(caller, body) }
}

/**
 * RUSH inside the command: the order marked Urgent by us in the customer's own list (production/brand/urgency acceptAskInCommand,
 * under the customer's lock); "rush the floor": then the planner's rush lever on each open work order of the order (its row FOR
 * UPDATE, by id; workorder.priority_changed), a mixed one left alone in words; then the date asked proposed to sales
 * (planning/promise-keep proposeInCommand, line by line). Never the office's priority, level or backlog rank.
 */
async function rushInCommand(tools: CommandTools, context: OfficeContext, row: OfficeRequestRow, input: { readonly rushFloor: boolean; readonly proposals: AcceptProposals }): Promise<AcceptDone> {
  const { tx } = tools
  const urgency = await acceptAskInCommand(tools, { partyId: row.partyId, companyId: row.companyId, orderId: row.orderId, actorId: context.actorId }, RUSH_REFUSAL_WORDS)
  const rushed: AcceptedWorkOrder[] = []
  let rushSkipped: Words | null = null
  if (input.rushFloor) {
    const plan = rushPlan(await orderWorkOrders(tx, row.orderId))
    if (plan.rush.length + plan.already.length === 0) throw new DomainError('invalid_state', NOTHING_TO_RUSH_WORDS.en, [{ path: 'request/NOTHING_TO_RUSH', message: NOTHING_TO_RUSH_WORDS.en }])
    for (const id of [...plan.rush, ...plan.already].sort()) {
      await lockWorkOrderRow(tx, id)
      const current = (await readWorkOrder(tx, id))!
      if (current.status === 'COMPLETED' || current.status === 'CLOSED' || current.status === 'CANCELLED') continue
      if (current.rush) {
        rushed.push({ id, number: current.number, status: current.status as WorkOrderStatus, changed: false })
        continue
      }
      if (!mayOn(context, WORKORDERS_MANAGE, current)) throw new ForbiddenError(RUSH_RIGHT_WORDS.en)
      await bumpVersion(tx, id, undefined)
      await tx.workOrder.update({ where: { id }, data: { rush: true }, select: { id: true } })
      tools.audit({ action: 'workorders.rushForCustomer', recordType: 'WorkOrder', recordId: id, companyId: current.companyId, siteId: current.siteId, before: { rush: false }, after: { rush: true, requestId: row.id }, reason: `The customer's "Urgent – asked" accepted with a rush of the floor.` })
      priorityEvent(tools, current, { priority: current.priority, rush: true })
      rushed.push({ id, number: current.number, status: current.status as WorkOrderStatus, changed: true })
    }
    if (plan.mixed.length > 0) rushSkipped = rushMixedWords(plan.mixed)
  }
  const proposals: NonNullable<AcceptDone['repromise']>['proposals'][number][] = []
  for (const checked of input.proposals.checked) {
    const made = await proposeInCommand(tools, checked)
    proposals.push({ id: made.proposalId, orderLineId: checked.line.id, seq: checked.line.seq, sizes: made.sizes.map((size) => ({ size: size.size, from: size.from, to: size.to })) })
  }
  const words = joinedWords([
    ACCEPT_DONE_WORDS.urgent(urgency.urgentRank, urgency.already),
    ...(input.rushFloor ? [ACCEPT_DONE_WORDS.rushed(rushed.filter((entry) => entry.changed).map((entry) => entry.number))] : []),
    ...(rushSkipped ? [rushSkipped] : []),
    ACCEPT_DONE_WORDS.repromised(proposals.length),
  ])
  return { kind: 'RUSH', paused: [], resumed: [], urgency, rushed, rushSkipped, repromise: { proposals, skipped: [...input.proposals.skipped] }, sampleRound: null, words }
}

/** SAMPLE_ROUND inside the command: the round of the kind asked (sales/samples createRoundInCommand), named on the request. */
async function sampleInCommand(tools: CommandTools, round: NonNullable<AcceptReads['round']>): Promise<AcceptDone> {
  const made = await createRoundInCommand(tools, round.checked, round.body, newId())
  return { kind: 'SAMPLE_ROUND', paused: [], resumed: [], ...none27b(), sampleRound: { id: made.id, number: made.number, kind: round.body.kind }, words: ACCEPT_DONE_WORDS.sampleRound(made.number) }
}
// ── end B-PR-27b ──

/** POST /production/brand-requests/:requestId/accept — accepting a production ask carries it out (ONE command). */
export async function acceptBrandRequest(caller: CommandCaller, requestId: string, body: AcceptBody, idempotencyKey: string | undefined, clock: Clock) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!brandRequestWhere(actor)) throw new ForbiddenError()
  const found = await caller.withClient((client) => readableRequest(client, actor, requestId))
  const kind = found.kind as OrderRequestKind
  if (!isProductionAccept(kind)) throw new DomainError('invalid_state', SALES_ACCEPT_WORDS.en, [{ path: 'request/SALES_ASK', message: SALES_ACCEPT_WORDS.en }])
  assertAnswers(actor, found)
  const problems = answerProblems('ACCEPTED', body.answer)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  // B-PR-27b: "rush the floor" names only an "Urgent – asked".
  if (body.rushFloor !== undefined && kind !== 'RUSH') throw new ValidationError(RUSH_FLOOR_ONLY_WORDS.en, [{ path: 'body/rushFloor', message: RUSH_FLOOR_ONLY_WORDS.en }])
  const answer = blank(body.answer)
  // B-PR-27b: the reads that check before the command (a rush of the floor, the re-promise, the sample round).
  if (kind === 'RUSH' && body.rushFloor === true) await rushChecks(caller, context, found.orderId)
  const reads: AcceptReads = {
    proposals: kind === 'RUSH' ? await caller.withClient((client) => acceptProposals(client, context, { orderId: found.orderId, date: agreedDateOf(found), now: clock.now() })) : null,
    round: kind === 'SAMPLE_ROUND' ? await sampleChecks(caller, found) : null,
  }
  const { result } = await runCommand(
    caller,
    { name: 'production.acceptCustomerRequest', idempotencyKey, input: { requestId, ...body } },
    async (tools) => {
      const { tx, now } = tools
      // The request first (FOR UPDATE: the customer's withdrawal and another answer wait), then the order's row, then its work.
      const { row } = await answerableIn(tools, requestId, body.version, 'ACCEPTED')
      await lockOrder(tx, row.orderId)
      let done: AcceptDone
      switch (kind) {
        case 'HOLD':
          done = await pauseInCommand(tools, row)
          break
        case 'RESUME':
          done = await resumeInCommand(tools, row)
          break
        // ── B-PR-27b ──
        case 'RUSH':
          done = await rushInCommand(tools, context, row, { rushFloor: body.rushFloor === true, proposals: reads.proposals! })
          break
        case 'SAMPLE_ROUND':
          done = await sampleInCommand(tools, reads.round!)
          break
        // ── end B-PR-27b ──
        default:
          throw new DomainError('invalid_state', SALES_ACCEPT_WORDS.en, [{ path: 'request/SALES_ASK', message: SALES_ACCEPT_WORDS.en }])
      }
      // B-PR-27b: an accepted sample round ask names the round it made (once).
      const sampleRoundId = done.sampleRound?.id ?? null
      await tx.orderChangeRequest.update({ where: { id: requestId }, data: { status: 'ACCEPTED', answer, answeredAt: now, answeredById: context.actorId, updatedAt: now, version: { increment: 1 }, ...(sampleRoundId ? { sampleRoundId } : {}) }, select: { id: true } })
      const workOrders = {
        paused: done.paused.map((entry) => entry.id),
        resumed: done.resumed.map((entry) => entry.id),
        // B-PR-27b
        ...(kind === 'RUSH' ? { urgentRank: done.urgency?.urgentRank ?? null, rushFloor: body.rushFloor === true, rushed: done.rushed.map((entry) => entry.id), proposals: done.repromise?.proposals.map((entry) => entry.id) ?? [] } : {}),
        ...(sampleRoundId ? { sampleRoundId } : {}),
      }
      tools.audit({ action: 'production.acceptCustomerRequest', recordType: 'OrderChangeRequest', recordId: requestId, companyId: row.companyId, before: { status: row.status }, after: { status: 'ACCEPTED', answer, kind, ...workOrders, ...(row.status === 'COUNTERED' ? { withCounter: row.counterApprovalId } : {}) } })
      tools.audit({ action: 'orders.changeRequestAccepted', recordType: 'SalesOrder', recordId: row.orderId, companyId: row.companyId, after: { requestId, kind, amendmentId: null, orderCancelled: false, ...workOrders } })
      tools.emit({ type: 'order_change_request.answered', subject: requestId, companyId: row.companyId, payload: { requestId, orderId: row.orderId, partyId: row.partyId, kind, answer: 'ACCEPTED', amendmentId: null, orderCancelled: false } })
      return done
    },
    { ...COMMAND_SETTINGS, clock },
  ).catch((error: unknown) => (kind === 'SAMPLE_ROUND' ? databaseRefusal(error) : Promise.reject(error)))
  return { request: await viewAfter(caller, requestId), done: result }
}

// ── B-PR-46a: a customer's batch accepted as one group (Home › Approvals "Accept all") ─────────────────────────────────────────

export interface BatchAcceptBody {
  readonly items: readonly BatchItem[]
  /** Our words to the customer, the same on every request (optional on an accept). */
  readonly answer?: string | null | undefined
  /** A batch of "Urgent – asked" only: "Accept and rush the floor" (true) or "Accept as urgent" (false, left out). */
  readonly rushFloor?: boolean | undefined
}

/**
 * POST /production/brand-requests/batches/:batchId/accept — every request named accepted through ITS kind's own accept, one by
 * one, each its own command and key (./answer.ts answerEach): a pause, a resume, an "Urgent – asked" (as urgent, or with a rush of
 * the floor) or another sample round here (acceptBrandRequest), a cancel, a change or ship what is ready through Sales' accept
 * (sales/change-requests acceptRequest). Each is re-checked at the version the office read; one refused is that row's result.
 */
export async function acceptBatch(caller: CommandCaller, batchId: string, body: BatchAcceptBody, idempotencyKey: string | undefined, clock: Clock) {
  const actor = actorOf(officeContextOf(caller))
  if (!brandRequestWhere(actor)) throw new ForbiddenError()
  const rows = await caller.withClient((client) => readableBatch(client, actor, batchId))
  // One kind per batch (the database keeps it so).
  const kind = rows[0]!.kind as OrderRequestKind
  if (body.rushFloor !== undefined && kind !== 'RUSH') throw new ValidationError(BATCH_RUSH_FLOOR_ONLY, [{ path: 'body/rushFloor', message: BATCH_RUSH_FLOOR_ONLY }])
  const problems = answerProblems('ACCEPTED', body.answer)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return answerEach(caller, { batchId, rows, items: body.items, keyName: 'batch-accept' }, idempotencyKey, async (row, version, key) => {
    if (isProductionAccept(row.kind as OrderRequestKind)) {
      const accepted = await acceptBrandRequest(caller, row.id, { version, answer: body.answer, ...(body.rushFloor !== undefined ? { rushFloor: body.rushFloor } : {}) }, key, clock)
      return accepted.done.words
    }
    await acceptRequest(caller, row.id, { version, answer: body.answer }, key, clock)
    return BATCH_ANSWER_WORDS.ACCEPTED
  })
}
// ── end B-PR-46a ──
