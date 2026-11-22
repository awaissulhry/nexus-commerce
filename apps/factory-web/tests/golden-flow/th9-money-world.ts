import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import type { Flow, PersonKey } from './_harness/flow'
import { byApi, day } from './_harness/ui'

/**
 * F-OM (order MONEY tab, PR T; 15-steps T.2): the world th9-order-page's step 14 "the Money tab" stands on — made through the real API
 * as the person whose act it is (never SQL), each part said in the report as done by the API (`byApi`). Not a stage of its own (no
 * default export; the stage list reads only stage files): th9-order-page imports it. No screen file is touched here.
 *
 * Two orders of Brand Alpha (P1, its terms DEP30: 30 % on the order, the balance before shipping), typed by the Owner (their lines
 * carry prices):
 *   the money order  its deposit paid SHORT by Finance within the company's write-off tolerance (bank charges) — still OPEN, ready
 *                    for step 14's "Accept short…"; its balance step opened if it had no request, and its due day moved by hand
 *                    (MOVE_DUE: the plan reads "Set by hand"); a hand cost line (a commission) and a target margin on its Margin; the
 *                    customer's price typed 20.00 under ours by the Owner (the price check reads Not equal, ready for "Accept the
 *                    difference…")
 *   the undo order   a part payment of its balance recorded by Finance — ready for step 14's undo of a payment
 *
 *   typeMoneyOrder       an order of Brand Alpha typed by the Owner, CONFIRMED, with its deposit and balance steps (asserted)
 *   scheduleOf           the order's money plan as Finance reads it (GET /sales/orders/:id/schedule)
 *   writeOffTolerance    the company's write-off tolerance in force (the Owner reads it; null: none)
 *   payDepositShort      a payment of the deposit less `short`, placed on its request (POST /payments), by Finance
 *   acceptShort          Accept short… by the API (ACCEPT_SHORT, bank charges), for a step that only reads the result
 *   openBalance          the balance step's request (Open for payment, POST …/schedule/:milestoneId/request) when it has none
 *   moveBalanceDue       the balance's due day moved by hand (MOVE_DUE) by Finance
 *   payPartOfBalance     a part payment on the balance's request (POST /payments) by Finance: the payment to undo
 *   undoPartPayment      the undo by the API (POST /payments/:paymentId/undo), for a step that only reads the result
 *   addHandCost          a hand cost line on the order's margin (POST /costing/margins/orders/:id/cost-lines) by Finance
 *   setMarginTarget      the order's target margin (PUT /costing/margins/orders/:id/target) by Finance
 *   typeCustomerPrice    the customer's price of the whole order typed `less` under ours by the Owner (PUT …/brand-prices)
 *   acceptDifference     "Accept the difference…" by the API (POST …/price-check/accept) by Finance, for a step that only reads it
 *   moneyWorld           all of the world above, in that order, once, with the worker settled at the end
 *
 * Every word and number is made up (TH9 money …); no customer's name is in them; nobody of the floor is named.
 */

type Json = Record<string, any>

/** The made-up words of this world. */
export const MONEY_WORDS = Object.freeze({
  moneyRef: 'T-TH9-MONEY-0001',
  undoRef: 'T-TH9-MONEY-0002',
  moveDue: 'Made-up: the customer pays the balance a week later, agreed by mail (TH9 money).',
  acceptShort: 'Made-up: the bank kept its charges on the transfer (TH9 money).',
  undo: 'Made-up: the payment was typed on the wrong order (TH9 money).',
  costLine: 'Made-up: the agent’s commission on this order (TH9 money).',
  target: 'Made-up: this order is held to a higher margin (TH9 money).',
  accept: 'Made-up: the customer’s price agreed by phone (TH9 money).',
})

/** The world's figures (minor units of the order's currency; the target a percent). */
export const MONEY_FIGURES = Object.freeze({
  /** At most this short (bank charges), never beyond the company's tolerance. */
  shortAtMost: 1_500,
  partPayment: 10_000,
  commission: 3_000,
  targetPct: '35',
  /** The customer's price under ours. */
  priceLess: 2_000,
})

export interface MoneyOrder {
  readonly id: string
  readonly number: string
  readonly grossAmount: number
  readonly depositStepId: string
  readonly depositRequestId: string
  readonly balanceStepId: string
}

export interface ShortPayment {
  readonly paymentId: string
  readonly depositRequestId: string
  /** What is left of the deposit (the short part: within the tolerance). */
  readonly short: number
}

export interface PartPayment {
  readonly paymentId: string
  readonly version: number
  readonly depositRequestId: string
  readonly amount: number
}

export interface MoneyWorld {
  readonly money: MoneyOrder
  readonly undo: MoneyOrder
  readonly tolerance: number
  readonly short: ShortPayment
  readonly balance: { readonly stepId: string; readonly requestId: string; readonly dueDate: string }
  readonly handCostLineId: string
  readonly targetPct: string
  readonly prices: { readonly ourNet: number; readonly brandNet: number }
  readonly partPayment: PartPayment
}

const ref = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const steps = (plan: Json): Json[] => (plan.steps ?? []) as Json[]
const stepOf = (plan: Json, kind: string): Json | undefined => steps(plan).find((step) => step.kind === kind && step.status !== 'CANCELLED')
const requestOf = (plan: Json, id: string): Json | undefined => ((plan.requests ?? []) as Json[]).find((request) => request.id === id)

/** The order's money plan (steps, requests, payments) as `by` reads it (Finance by default: every figure and payment). */
export async function scheduleOf(flow: Flow, orderId: string, by: PersonKey = 'finance'): Promise<Json> {
  const desk = await flow.desk(by)
  return flow.read(desk.page, `/sales/orders/${orderId}/schedule`)
}

/** An order of Brand Alpha typed by the Owner (12 jackets at 100.00, the terms' deposit): CONFIRMED, its deposit and balance steps. */
export async function typeMoneyOrder(flow: Flow, customerRef: string): Promise<MoneyOrder> {
  byApi(`an order of Brand Alpha typed by the Owner (${customerRef}): the deposit and the balance of its terms`)
  const owner = await flow.desk('owner')
  const made = await flow.write(
    owner.page,
    'POST',
    '/sales/orders/manual',
    {
      companyId: flow.companyId,
      partyId: await flow.seedId('party:P1'),
      customerRef,
      promiseDate: day(60),
      // th9's own jacket of P1 (op-fx4: its revision RELEASED, so step 14's "Make work orders" may make one).
      lines: [{ styleId: await flow.seedId('production:style:JKT-02'), colourwayId: await flow.seedId('production:colourway:JKT-02:BLK'), unitPrice: '100', sizes: [{ size: '50', quantity: 6 }, { size: '52', quantity: 6 }] }],
    },
    201,
  )
  const order = made.order as Json
  expect(order.status, `${customerRef} is confirmed (no rule asks a yes of it)`).toBe('CONFIRMED')
  const plan = await scheduleOf(flow, order.id as string)
  const deposit = stepOf(plan, 'DEPOSIT')
  const balance = stepOf(plan, 'BEFORE_SHIPPING')
  expect(deposit?.depositRequestId, `${customerRef}'s deposit step and its request (P1's terms ask 30 % on the order)`).toBeTruthy()
  expect(balance, `${customerRef}'s balance before shipping`).toBeDefined()
  return { id: order.id as string, number: order.number as string, grossAmount: plan.grossAmount as number, depositStepId: deposit!.id as string, depositRequestId: deposit!.depositRequestId as string, balanceStepId: balance!.id as string }
}

/** The company's write-off tolerance in force (minor units; null: none), as the Owner reads it. */
export async function writeOffTolerance(flow: Flow): Promise<number | null> {
  const owner = await flow.desk('owner')
  const read = await flow.read(owner.page, `/payments/write-offs/tolerance?companyId=${flow.companyId}`)
  return (read.inForce?.amount as number | null | undefined) ?? null
}

/** A payment of the deposit less `short`, placed on its request, recorded by Finance (Payments › Record a payment's call). */
export async function payDepositShort(flow: Flow, order: MoneyOrder, short: number): Promise<ShortPayment> {
  byApi(`the deposit of ${order.number} paid ${short} short (bank charges), within the tolerance — step 14 accepts it short`)
  const finance = await flow.desk('finance')
  const request = requestOf(await scheduleOf(flow, order.id), order.depositRequestId)
  expect(request, `${order.number}'s deposit request`).toBeDefined()
  const amount = (request!.amount as number) - (request!.paid as number) - short
  expect(amount, `${order.number}'s deposit is larger than the short part`).toBeGreaterThan(0)
  const answer = await flow.write(finance.page, 'POST', '/payments', { companyId: flow.companyId, partyId: await flow.seedId('party:P1'), amount, receivedOn: day(0), externalRef: ref('T-TH9-PAY-DEP'), allocations: [{ depositRequestId: order.depositRequestId, amount }] }, 201)
  const after = requestOf(await scheduleOf(flow, order.id), order.depositRequestId)!
  expect(after.status, 'a deposit paid short stays OPEN until it is accepted short').toBe('OPEN')
  return { paymentId: answer.payment.id as string, depositRequestId: order.depositRequestId, short }
}

/** Accept short… by the API: the deposit PAID by hand with bank charges (its steps follow at once). */
export async function acceptShort(flow: Flow, order: MoneyOrder): Promise<Json> {
  byApi(`Accept short… on ${order.number}'s deposit (bank charges)`)
  const finance = await flow.desk('finance')
  const request = requestOf(await scheduleOf(flow, order.id), order.depositRequestId)!
  return flow.write(finance.page, 'POST', `/sales/orders/${order.id}/money-plan`, { act: 'ACCEPT_SHORT', requestId: order.depositRequestId, version: request.version, why: 'BANK_CHARGES', reason: MONEY_WORDS.acceptShort })
}

/** The balance step's request: Open for payment by Finance (orders.moneyPlan) when the step has none yet. */
export async function openBalance(flow: Flow, order: MoneyOrder): Promise<{ stepId: string; requestId: string }> {
  const plan = await scheduleOf(flow, order.id)
  const step = steps(plan).find((entry) => entry.id === order.balanceStepId)!
  if (step.depositRequestId) return { stepId: step.id as string, requestId: step.depositRequestId as string }
  byApi(`Open for payment on ${order.number}'s balance step (its request)`)
  const finance = await flow.desk('finance')
  const opened = await flow.write(finance.page, 'POST', `/sales/orders/${order.id}/schedule/${step.id}/request`, { version: step.version, dueDate: step.dueDate ?? day(50) }, 201)
  return { stepId: step.id as string, requestId: opened.depositRequestId as string }
}

/** The balance's due day moved by hand by Finance (MOVE_DUE): the plan reads the step "Set by hand". */
export async function moveBalanceDue(flow: Flow, order: MoneyOrder, dueDate: string = day(52)): Promise<{ stepId: string; dueDate: string }> {
  byApi(`the balance's due day of ${order.number} moved by hand (MOVE_DUE) to ${dueDate}`)
  const finance = await flow.desk('finance')
  const step = steps(await scheduleOf(flow, order.id)).find((entry) => entry.id === order.balanceStepId)!
  // Never the day it has now (a move that changes nothing is refused in words).
  const due = step.dueDate === dueDate ? day(53) : dueDate
  const answer = await flow.write(finance.page, 'POST', `/sales/orders/${order.id}/money-plan`, { act: 'MOVE_DUE', milestoneId: step.id, version: step.version, dueDate: due, reason: MONEY_WORDS.moveDue })
  const moved = steps(answer).find((entry) => entry.id === step.id)
  expect(moved, `${order.number}'s balance step after the move`).toMatchObject({ dueDate: due, byHand: { act: 'MOVE_DUE' } })
  return { stepId: step.id as string, dueDate: due }
}

/** A part payment of the balance's request recorded by Finance: the payment step 14 undoes. */
export async function payPartOfBalance(flow: Flow, order: MoneyOrder, amount: number = MONEY_FIGURES.partPayment): Promise<PartPayment> {
  const { requestId } = await openBalance(flow, order)
  byApi(`a part payment of ${amount} on ${order.number}'s balance — step 14 undoes it`)
  const finance = await flow.desk('finance')
  const answer = await flow.write(finance.page, 'POST', '/payments', { companyId: flow.companyId, partyId: await flow.seedId('party:P1'), amount, receivedOn: day(0), externalRef: ref('T-TH9-PAY-PART'), allocations: [{ depositRequestId: requestId, amount }] }, 201)
  const listed = (requestOf(await scheduleOf(flow, order.id), requestId)?.payments ?? []) as Json[]
  expect(listed.find((entry) => entry.paymentId === answer.payment.id)?.undo, 'the part payment may be undone').toMatchObject({ may: true })
  return { paymentId: answer.payment.id as string, version: answer.payment.version as number, depositRequestId: requestId, amount }
}

/** The undo by the API (Finance): the allocation reversed, the payment voided when it pays nothing else. */
export async function undoPartPayment(flow: Flow, part: PartPayment): Promise<Json> {
  byApi('the undo of the part payment (POST /payments/:paymentId/undo)')
  const finance = await flow.desk('finance')
  return flow.write(finance.page, 'POST', `/payments/${part.paymentId}/undo`, { depositRequestId: part.depositRequestId, version: part.version, reason: MONEY_WORDS.undo })
}

/** A hand cost line on the order's margin, by Finance (costing.ledger.manage + the cost grain): its id. */
export async function addHandCost(flow: Flow, orderId: string, amount: number = MONEY_FIGURES.commission, kind: 'FREIGHT_ESTIMATE' | 'COMMISSION' | 'BANK_CHARGES' | 'OTHER' = 'COMMISSION'): Promise<string> {
  byApi(`a hand cost line (${kind}, ${amount}) on the order's margin`)
  const finance = await flow.desk('finance')
  const answer = await flow.write(finance.page, 'POST', `/costing/margins/orders/${orderId}/cost-lines`, { kind, amount, reason: MONEY_WORDS.costLine })
  const line = ((answer.handLines ?? []) as Json[]).find((entry) => entry.kind === kind && entry.amount === amount)
  expect(line, 'the hand cost line, counted').toBeDefined()
  return line!.id as string
}

/** The order's own target margin, by Finance (+ the margin grain): the flag is judged on it. */
export async function setMarginTarget(flow: Flow, orderId: string, targetPct: string = MONEY_FIGURES.targetPct): Promise<string> {
  byApi(`the order's target margin set to ${targetPct} %`)
  const finance = await flow.desk('finance')
  const answer = await flow.write(finance.page, 'PUT', `/costing/margins/orders/${orderId}/target`, { targetPct, reason: MONEY_WORDS.target })
  expect(answer.targetPct, 'the target set').toBe(targetPct)
  return answer.targetPct as string
}

/** The customer's price of the whole order typed `less` under ours by the Owner (orders.manage + price): the check reads Not equal. */
export async function typeCustomerPrice(flow: Flow, orderId: string, less: number = MONEY_FIGURES.priceLess): Promise<{ ourNet: number; brandNet: number }> {
  byApi(`the customer's price typed ${less} under ours (the price check reads Not equal) — step 14 accepts the difference`)
  const owner = await flow.desk('owner')
  const check = await flow.read(owner.page, `/sales/orders/${orderId}/price-check`)
  const ourNet = check.total.ourPrice as number
  const row = check.total.row as Json | null
  const typed = await flow.write(owner.page, 'PUT', `/sales/orders/${orderId}/brand-prices`, { rows: [{ lineId: null, netAmount: ourNet - less, source: 'CUSTOMER_PO', ...(row ? { version: row.version } : {}) }] })
  expect(typed.total, 'the customer’s price under ours').toMatchObject({ priceMatch: 'NOT_EQUAL', brandPrice: ourNet - less })
  expect(typed.accepted ?? null, 'no difference accepted yet').toBeNull()
  return { ourNet, brandNet: ourNet - less }
}

/** "Accept the difference…" by the API (Finance: orders.moneyPlan + price), with the nets as read. */
export async function acceptDifference(flow: Flow, orderId: string, nets: { readonly ourNet: number; readonly brandNet: number }): Promise<Json> {
  byApi('Accept the difference… (POST /sales/orders/:id/price-check/accept)')
  const finance = await flow.desk('finance')
  return flow.write(finance.page, 'POST', `/sales/orders/${orderId}/price-check/accept`, { ...nets, reason: MONEY_WORDS.accept })
}

/**
 * The whole world of step 14, in order: the money order (its deposit paid short within the tolerance, its balance's due day moved by
 * hand, a hand cost line and a target on its margin, the customer's price under ours) and the undo order (a part payment of its
 * balance); the worker settled at the end. The acts step 14 does on the screen — Accept short…, the undo, Accept the difference… —
 * are left to it (their API forms above are for a step that only reads). Call it once, inside a `flow.step` of the stage.
 */
export async function moneyWorld(flow: Flow): Promise<MoneyWorld> {
  const tolerance = await writeOffTolerance(flow)
  expect(tolerance, 'a write-off tolerance in force (the seeds set one): a deposit may be accepted short within it').not.toBeNull()
  expect(tolerance!, 'a tolerance of at least 0.01').toBeGreaterThan(0)
  const money = await typeMoneyOrder(flow, MONEY_WORDS.moneyRef)
  const short = await payDepositShort(flow, money, Math.min(tolerance!, MONEY_FIGURES.shortAtMost))
  const { requestId } = await openBalance(flow, money)
  const moved = await moveBalanceDue(flow, money)
  const handCostLineId = await addHandCost(flow, money.id)
  const targetPct = await setMarginTarget(flow, money.id)
  const prices = await typeCustomerPrice(flow, money.id)
  const undo = await typeMoneyOrder(flow, MONEY_WORDS.undoRef)
  const partPayment = await payPartOfBalance(flow, undo)
  await flow.settle()
  return { money, undo, tolerance: tolerance!, short, balance: { stepId: moved.stepId, requestId, dueDate: moved.dueDate }, handCostLineId, targetPct, prices, partPayment }
}
