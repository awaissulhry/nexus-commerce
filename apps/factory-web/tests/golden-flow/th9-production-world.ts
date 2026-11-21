import { expect } from '@playwright/test'
import type { Desk, Flow, PersonKey } from './_harness/flow'
import { byApi, day } from './_harness/ui'

/**
 * F-PT (order production tab, PR T): the world th9-order-page's step 12 "the Production tab" stands on — made through the real API as
 * the person whose act it is (never SQL), each part said in the report as done by the API (`byApi`). Not a stage of its own (no
 * default export; the stage list reads only stage files): th9-order-page imports it.
 *
 *   setProductionSupervisor  the order's production supervisor (POST /production/orders/supervisor): the production manager, by herself
 *   placeProductionHold      a plain production hold on one of the order's own work orders (POST /production/work-orders/:id/holds),
 *                            by the planner, with a made-up note — the one step 12 lifts from Problems & holds
 *   askForAnUpdate           "Ask for an update" as the tab sends it: an office note on the order with askSupervisor + needsAnswer
 *                            (POST /production/notes), by Sales — its issue and its task, given to the supervisor
 *   supervisorReplies        the supervisor's reply to that very note in the order's thread (POST /threads/SalesOrder/:id/notes with
 *                            replyToMessageId), then the worker settles: the reply answers the ask (C1, B-PT-015)
 *   movePromiseTwice         the promise moved twice by Sales (PUT /sales/orders/:id/promise): the whole order, then one line
 *   askState                 the ask as the tab reads it (GET /production/issues?salesOrderId=&status=ALL): status, answered at, who
 *                            asked, the reply, its batch — what step 12 asserts beside the screen
 *   productionWorld          all of the above in that order, once, with the worker settled at the end
 *
 * Every word is made up (TH9 …); nobody of the floor is named; nothing priced is touched.
 */

type Json = Record<string, any>

/** The made-up words of this world. */
// No customer's name in them: the note's check holds a text that names another customer (R-47).
export const WORLD_WORDS = Object.freeze({
  holdNote: 'Made-up: the lining roll is short, TH9 production world.',
  ask: 'Made-up: where is this order now? What is cut, sewn and packed? Any problem? Is the date safe? (TH9)',
  reply: 'Made-up: cutting is done, sewing is on the line, nothing is stuck and the date holds. (TH9)',
  orderMove: 'Made-up: the lining arrives a week late (TH9).',
  lineMove: 'Made-up: this line waits for its zip (TH9).',
})

/** A production reason of the tenant's PRODUCTION_HOLD list (the standard reasons). */
const HOLD_REASON = 'MATERIAL_MISSING'
/** Work orders a plain hold may still stop. */
const HOLDABLE = ['DRAFT', 'RELEASED', 'IN_PROGRESS']

export interface PlacedHold {
  readonly holdId: string
  readonly workOrderId: string
  readonly workOrderNumber: string
}

export interface RaisedAsk {
  /** The note in the order's thread the ask was raised with (the supervisor replies to it). */
  readonly messageId: string
  readonly issueId: string
  readonly taskId: string
  /** The task went to the order's supervisor (false: nobody may be given it yet). */
  readonly assigned: boolean
}

export interface PromiseMoves {
  readonly order: { readonly from: string | null; readonly to: string }
  readonly line: { readonly lineId: string; readonly to: string }
}

export interface AskState {
  readonly status: string
  readonly answeredAt: string | null
  readonly askedBy: { readonly id: string; readonly name: string } | null
  readonly reply: { readonly at: string; readonly messageId: string; readonly by: { readonly id: string; readonly name: string } | null; readonly excerpt: string } | null
  readonly batch: { readonly id: string; readonly issues: number; readonly orders: readonly { readonly id: string; readonly number: string }[]; readonly more: number } | null
  readonly messageId: string | null
}

export interface ProductionWorld {
  readonly supervisor: { readonly id: string; readonly key: PersonKey }
  readonly hold: PlacedHold
  readonly ask: RaisedAsk
  readonly reply: { readonly messageId: string }
  readonly promise: PromiseMoves
}

/** The order's production supervisor: `by` (the production manager by default) names herself (production.brand.manage). */
export async function setProductionSupervisor(flow: Flow, orderId: string, by: PersonKey = 'manager'): Promise<{ id: string; key: PersonKey; desk: Desk }> {
  byApi('the order’s production supervisor (the People card’s Assign supervisor… is not this step’s screen)')
  const desk = await flow.desk(by)
  await flow.write(desk.page, 'POST', '/production/orders/supervisor', { orderIds: [orderId], supervisorId: desk.person.id })
  return { id: desk.person.id, key: by, desk }
}

/** A plain production hold on the first of the order's own live work orders `by` may hold (the planner by default). */
export async function placeProductionHold(flow: Flow, orderId: string, by: PersonKey = 'planner'): Promise<PlacedHold> {
  byApi('a production hold placed on one of the order’s work orders (step 12 lifts it from Problems & holds)')
  const desk = await flow.desk(by)
  const read = await flow.read(desk.page, `/sales/orders/${orderId}/production?parts=work`)
  const rows = ((read.work?.workOrders ?? []) as Json[]).filter((row) => !row.sharedWithOtherCustomers && !row.held && row.rights?.hold === true && HOLDABLE.includes(row.status as string))
  expect(rows.length, `a work order of ${orderId} that ${by} may hold`).toBeGreaterThan(0)
  const target = rows[0]!
  const placed = await flow.write(desk.page, 'POST', `/production/work-orders/${target.id}/holds`, { reasonCode: HOLD_REASON, note: WORLD_WORDS.holdNote, version: target.version }, 201)
  return { holdId: placed.hold.id as string, workOrderId: target.id as string, workOrderNumber: target.number as string }
}

/** "Ask for an update" as the tab sends it: an office note on the order, the supervisor asked, needing an answer (`by`: Sales). */
export async function askForAnUpdate(flow: Flow, orderId: string, by: PersonKey = 'sales'): Promise<RaisedAsk> {
  byApi('Ask for an update sent as the tab sends it (POST /production/notes, askSupervisor + needsAnswer)')
  const desk = await flow.desk(by)
  const answer = await flow.write(desk.page, 'POST', '/production/notes', { records: [{ type: 'SalesOrder', id: orderId }], body: WORLD_WORDS.ask, askSupervisor: true, needsAnswer: true })
  const written = ((answer.written ?? []) as Json[]).find((entry) => entry.type === 'SalesOrder' && entry.id === orderId)
  expect(written, 'the note written on the order').toBeDefined()
  expect(written!.issueId, 'the ask raised an issue (Needs an answer)').toBeTruthy()
  const task = ((answer.issues?.tasks ?? []) as Json[]).find((entry) => entry.type === 'SalesOrder' && entry.id === orderId)
  expect(task, 'the ask’s task on the order').toBeDefined()
  return { messageId: written!.messageId as string, issueId: written!.issueId as string, taskId: task!.taskId as string, assigned: task!.assigned === true }
}

/** The supervisor (`by`) replies to the ask's own note in the order's thread; the worker settles (C1: the reply answers the ask). */
export async function supervisorReplies(flow: Flow, orderId: string, ask: Pick<RaisedAsk, 'messageId'>, by: PersonKey = 'manager'): Promise<{ messageId: string }> {
  byApi('the supervisor’s reply in the thread (POST /threads/SalesOrder/:id/notes, replyToMessageId: the ask’s note)')
  const desk = await flow.desk(by)
  const answer = await flow.write(desk.page, 'POST', `/threads/SalesOrder/${orderId}/notes`, { body: WORLD_WORDS.reply, replyToMessageId: ask.messageId }, 201)
  await flow.settle()
  return { messageId: answer.message.id as string }
}

/** The order's promise moved by Sales (`by`): the whole order a week on, then its first goods line a week after that. */
export async function movePromiseTwice(flow: Flow, orderId: string, by: PersonKey = 'sales'): Promise<PromiseMoves> {
  byApi('two moves of the promise (the whole order, then one line) before step 12 reads their history')
  const desk = await flow.desk(by)
  const order = (await flow.read(desk.page, `/sales/orders/${orderId}`)).order as Json
  const from = (order.promiseDate as string | null) ?? null
  // A day from today on, never the promise it has now.
  const whole = [day(70), day(71)].find((candidate) => candidate !== from)!
  const moved = (await flow.write(desk.page, 'PUT', `/sales/orders/${orderId}/promise`, { version: order.version, promiseDate: whole, reason: WORLD_WORDS.orderMove })).order as Json
  const line = ((moved.lines ?? []) as Json[]).find((entry) => entry.kind === 'SIZE_GRID' || entry.kind === 'MADE_TO_MEASURE')
  expect(line, `a goods line of ${orderId}`).toBeDefined()
  const lineDay = day(77)
  await flow.write(desk.page, 'PUT', `/sales/orders/${orderId}/promise`, { version: moved.version, promiseDate: lineDay, reason: WORLD_WORDS.lineMove, lineIds: [line!.id] })
  return { order: { from, to: whole }, line: { lineId: line!.id as string, to: lineDay } }
}

/** The ask as the Production tab reads it (the issues list of ONE order, every state), read by `by` (Sales by default). */
export async function askState(flow: Flow, orderId: string, issueId: string, by: PersonKey = 'sales'): Promise<AskState> {
  const desk = await flow.desk(by)
  const list = await flow.read(desk.page, `/production/issues?salesOrderId=${orderId}&status=ALL&limit=50`)
  const row = ((list.issues ?? []) as Json[]).find((issue) => issue.id === issueId)
  expect(row, `the ask ${issueId} on ${orderId}`).toBeDefined()
  return { status: row!.status as string, answeredAt: (row!.answeredAt as string | null) ?? null, askedBy: row!.askedBy ?? null, reply: row!.reply ?? null, batch: row!.batch ?? null, messageId: (row!.messageId as string | null) ?? null }
}

/**
 * The whole world of step 12 on one order, in order: its supervisor, a production hold, the ask and the supervisor's reply (answered:
 * C1), the promise moved twice; the worker settled at the end. Call it once, inside a `flow.step` of the stage.
 */
export async function productionWorld(flow: Flow, orderId: string): Promise<ProductionWorld> {
  const supervisor = await setProductionSupervisor(flow, orderId)
  const hold = await placeProductionHold(flow, orderId)
  const ask = await askForAnUpdate(flow, orderId)
  expect(ask.assigned, 'the ask’s task went to the order’s supervisor').toBe(true)
  const reply = await supervisorReplies(flow, orderId, ask, supervisor.key)
  await expect.poll(async () => (await askState(flow, orderId, ask.issueId)).status, { timeout: 60_000, message: 'the supervisor’s reply answers the ask (C1)' }).toBe('ANSWERED')
  const promise = await movePromiseTwice(flow, orderId)
  await flow.settle()
  return { supervisor: { id: supervisor.id, key: supervisor.key }, hold, ask, reply, promise }
}
