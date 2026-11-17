import { productionLimits } from '../../../../sales/customers/portal/demo'
import type { WorkOrder } from '../../../_shared/api'
import type { AskedApproval, CustomerIssue, CustomerIssues, CustomerRequest, CustomerUrgency, UrgencyOrder } from './api'
import { cardCustomersOf, type CustomerBlock, type CustomerCardModel } from './model'

/**
 * F-PR-05b — made-up data for the Customer card's design cases and tests: the work order's one customer (the record fixtures' made-up
 * "Moto Demo S.r.l."), another made-up order of the same customer that is NOT on this work order (it must never show), invented
 * people (Bea Esempio, Alex Demo, Anna Cliente). No real business data, no money.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
const words = (en: string, it: string) => ({ en, it })

/** The reader's clock in the cases (29 Oct 2026, 13:00 UTC): a request asked at 09:00 waits on us 4 h. */
export const CARD_NOW = Date.UTC(2026, 9, 29, 13)
/** An order of the same customer that is not on this work order: its rows are dropped (PW-07). */
export const OTHER_ORDER = { id: uid('5151', 77), number: 'SO-DEMO-0077' }

export function request(workOrder: WorkOrder, over: Partial<CustomerRequest> = {}): CustomerRequest {
  const order = workOrder.orders[0]!
  return {
    id: uid('5252', 1),
    orderId: order.id,
    orderNumber: order.number,
    customerRef: order.customerRef,
    kind: 'RUSH',
    kindWords: words('Make it urgent', 'Rendilo urgente'),
    status: 'OPEN',
    askedAt: at(29, 9),
    answer: null,
    answeredAt: null,
    party: { id: order.partyId, code: 'ALPHA', name: order.partyName },
    askedBy: 'Anna Cliente',
    answeredBy: null,
    waitingOn: 'US',
    standing: words('Waits on us', 'Tocca a noi'),
    batch: null,
    version: 1,
    ...over,
  }
}

export function requestsOf(workOrder: WorkOrder): CustomerRequest[] {
  return [
    request(workOrder),
    request(workOrder, { id: uid('5252', 2), kind: 'CHANGE', kindWords: words('Change', 'Modifica'), status: 'REFUSED', askedAt: at(24, 10), answer: 'The leather is already cut for these sizes.', answeredAt: at(25, 11), waitingOn: null, standing: words('Refused', 'Rifiutata'), answeredBy: 'Bea Esempio' }),
    // Another order of the same customer: never on this card.
    request(workOrder, { id: uid('5252', 3), orderId: OTHER_ORDER.id, orderNumber: OTHER_ORDER.number, customerRef: null }),
  ]
}

export function approvalsOf(workOrder: WorkOrder): AskedApproval[] {
  const order = workOrder.orders[0]!
  return [
    { id: uid('5353', 1), kind: 'SAMPLE', record: { type: 'SalesOrder', id: order.id, words: words(`${order.number} · PP sample`, `${order.number} · campione di preproduzione`) }, party: { id: order.partyId, name: order.partyName }, question: 'Please approve the PP sample.', dueAt: at(31, 16), status: 'OPEN', answer: null, createdAt: at(27, 9) },
    { id: uid('5353', 2), kind: 'COLOUR', record: { type: 'SalesOrder', id: order.id, words: words(`${order.number} · red`, `${order.number} · rosso`) }, party: { id: order.partyId, name: order.partyName }, question: 'The red swatch.', dueAt: at(26, 16), status: 'APPROVED', answer: { at: at(25, 15), via: 'PORTAL', words: null }, createdAt: at(22, 9) },
  ]
}

export function urgencyOrder(workOrder: WorkOrder, over: Partial<UrgencyOrder> = {}): UrgencyOrder {
  const order = workOrder.orders[0]!
  return {
    id: order.id,
    number: order.number,
    customerRef: order.customerRef,
    status: 'IN_PRODUCTION',
    orderDate: '2026-10-01',
    urgency: 'URGENT',
    counted: true,
    urgentRank: 2,
    setBy: 'BRAND',
    setAt: at(26, 10),
    setByPerson: { id: uid('5454', 1), name: 'Anna Cliente' },
    locked: false,
    lockReason: null,
    lockedAt: null,
    lockedBy: null,
    words: words('Urgent · 2 of 3', 'Urgente · 2 su 3'),
    ...over,
  }
}

export function urgencyOf(workOrder: WorkOrder, orders: readonly UrgencyOrder[], over: { readonly on?: boolean; readonly mayOverride?: boolean } = {}): CustomerUrgency {
  const order = workOrder.orders[0]!
  return {
    asOf: at(29, 13),
    customer: { id: order.partyId, code: 'ALPHA', name: order.partyName },
    urgency: { on: over.on ?? true, max: 3, dormant: over.on === false ? words('2 urgent marks are kept but not used while this is off', '2 segni urgenti sono tenuti ma non usati finché è spento') : null },
    companies: [
      {
        company: { id: workOrder.companyId, code: 'DEMO', name: 'Demo Manifattura' },
        use: { used: 2, max: 3, agreed: 0, left: 1, over: false, words: words('2 of 3 urgent used', '2 urgenti su 3') },
        mayOverride: over.mayOverride ?? true,
        orders: [...orders, urgencyOrder(workOrder, { id: OTHER_ORDER.id, number: OTHER_ORDER.number, customerRef: null, urgentRank: 1 })],
      },
    ],
  }
}

export function issue(workOrder: WorkOrder, over: Partial<CustomerIssue> = {}): CustomerIssue {
  const order = workOrder.orders[0]!
  return {
    id: uid('5555', 1),
    source: 'BRAND',
    sourceWords: words('Reported by the customer', 'Segnalato dal cliente'),
    status: 'OPEN',
    statusWords: words('Waiting for an answer', 'In attesa di risposta'),
    note: null,
    noteWords: null,
    record: { type: 'SalesOrder', id: order.id, label: order.number },
    salesOrder: { id: order.id, number: order.number },
    customer: { id: order.partyId, name: order.partyName },
    raisedAt: at(16, 9, 30),
    dueOn: '2026-10-19',
    answeredAt: null,
    escalation: null,
    task: { id: uid('5656', 1), status: 'OPEN', assignee: 'SOMEONE_ELSE' },
    mine: false,
    batch: null,
    excerpt: 'The zips on the last delivery were the wrong colour.',
    ...over,
  }
}

export function issuesOf(workOrder: WorkOrder, own: readonly CustomerIssue[]): CustomerIssues {
  return {
    asOf: at(29, 13),
    // Another order of the same customer: never on this card.
    issues: [...own, issue(workOrder, { id: uid('5555', 9), record: { type: 'SalesOrder', id: OTHER_ORDER.id, label: OTHER_ORDER.number }, salesOrder: OTHER_ORDER })],
    more: false,
  }
}

const ready = <T,>(value: T) => ({ value, problem: null })

/** The card with every part read (overrides per part). */
export function cardModel(workOrder: WorkOrder, over: Partial<CustomerBlock> = {}, model: Partial<Omit<CustomerCardModel, 'blocks'>> = {}): CustomerCardModel {
  const customer = cardCustomersOf(workOrder)[0]!
  return {
    blocks: [
      {
        customer,
        requests: ready(requestsOf(workOrder)),
        approvals: ready(approvalsOf(workOrder)),
        urgency: ready(urgencyOf(workOrder, [urgencyOrder(workOrder)])),
        issues: ready(issuesOf(workOrder, [issue(workOrder, { note: 'NO_REPLY_YET', noteWords: words('No reply sent yet', 'Nessuna risposta ancora inviata') })])),
        limits: ready(productionLimits({ level: 'PROGRESS', urgency: { on: true, max: 3, now: 2, dormant: null, overQuota: null } })),
        ...over,
      },
    ],
    dialog: null,
    busy: false,
    problem: null,
    outcome: null,
    now: CARD_NOW,
    ...model,
  }
}
