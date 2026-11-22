import { MONEY_PLAN_ACTS } from '@nexus/factory-domain/sales/orders/money-plan' // the hand acts (B-OM-004)
import { DEPOSIT_KINDS, type ByHand, type ChainInvoice, type DepositRequest, type Milestone, type MilestoneKind, type Order, type PlanPayment, type PlanRequest, type Schedule, type Settlement } from '../../api'
import { depositInvoicesOf, isFinal, stillToPay, type OrderAbilities, type Tone } from '../../model'
import { rowAnchor } from '../dock/discuss'
import { stepVerbs, type StepAbilities } from '../schedule/model'
import { isExtraDeposit } from './head'
import { word, type MoneyWord } from './word'

/**
 * F-OM-103 (order MONEY tab, 10-design §5; 18-lead-settles L8) — section 2, Payments (#payments; #deposit and #schedule land here):
 * the ONE payment plan, read. Six sections became five: the deposit cards and the payment schedule are this one list. Pure.
 *
 *   rows      one per step of the schedule (its seq), and one per live request no step names — a priced change's EXTRA deposit, right
 *             after the deposit (L8: a row by request, no step). Each: title (kind · share) · pill · amount (+ what is left) · due ·
 *             notes (production waits for this deposit; holds the shipment; paid with the invoice) · "Set by hand" (the plan read's
 *             audit, B-OM-004) · ONE next act · the rest in its ⋯
 *   unfold    a row with a request: its steps (Asked → Page sent → Paid → TD02 → SDI) and its payments (the plan read; payments.view)
 *   earlier   the replaced or removed steps and requests, kept ("Earlier steps (N)")
 *   answer    "Still open € 8,686.40 · overdue € 0.00 · next: the extra deposit, due 25 Nov" · words without the price grain
 *
 * The acts are today's (Record a payment, Send the page, Open for payment, Invoice this step, Waive…, Record payment… on the goods'
 * invoice in Finance): HIDDEN without their right, held with words only by the order's or the row's state (goods left; money placed
 * on it); none on a closed or cancelled order. The gate words follow the release's own rule (model.ts depositGate).
 */

export type PlanRowKind = MilestoneKind | 'EXTRA'
export type PlanActId = 'record' | 'send' | 'open' | 'invoiceStep' | 'waive' | 'payInvoice'

export interface PlanAct {
  readonly id: PlanActId
  readonly label: MoneyWord
  /** Held by the state, in words (never for a missing right: then the act is not here). */
  readonly held: MoneyWord | null
  /** Open for payment of a step with no day: its window asks one. */
  readonly needsDay?: boolean
}

export interface PlanRow {
  /** The row's element id: the request's anchor when it has one (the dock's "Show on the page"), else the step's. */
  readonly anchor: string
  /** The step's anchor too, when the row is a step with a request. */
  readonly alias: string | null
  readonly kind: PlanRowKind
  readonly title: MoneyWord
  /** A deposit that is not an acconto: its kind (caparra confirmatoria, caparra penitenziale). */
  readonly sub: MoneyWord | null
  readonly step: Milestone | null
  readonly request: DepositRequest | null
  /** Its payments (the plan read, payments.view); null: the read does not name them (the request's paid sum only). */
  readonly payments: readonly PlanPayment[] | null
  readonly pill: { readonly word: MoneyWord; readonly tone: Tone }
  /** Price grain only. */
  readonly amount: number | null
  readonly left: number | null
  readonly due: MoneyWord
  readonly dueSub: MoneyWord | null
  readonly notes: readonly { readonly word: MoneyWord; readonly tone: 'warning' | 'neutral' }[]
  /** "Set by hand": the newest hand change that names it (who, when; the reason with the price grain). */
  readonly byHand: { readonly word: MoneyWord; readonly reason: string | null } | null
  readonly fromChange: { readonly amendmentId: string; readonly revision: number } | null
  /** The ONE next act on the row; the others are in `more` (its ⋯). */
  readonly act: PlanAct | null
  readonly more: readonly PlanAct[]
  /** An on-delivery / on-invoice step's goods invoice (its number opens it; Record payment… in Finance picks it). */
  readonly invoice: { readonly id: string; readonly number: string } | null
  readonly unfolds: boolean
  /** Open while it waits; folded when paid. */
  readonly openAtFirst: boolean
  readonly done: boolean
  /** Discuss (an office note: money is never discussed in a reply, F-SA-266). */
  readonly discuss: { readonly part: MoneyWord; readonly target: { readonly kind: 'DepositRequest'; readonly id: string } | null }
}

export interface EarlierRow {
  readonly key: string
  readonly title: MoneyWord
  readonly amount: number | null
  readonly words: MoneyWord
  readonly byHand: { readonly word: MoneyWord; readonly reason: string | null } | null
}

export interface PlanModel {
  readonly rows: readonly PlanRow[]
  readonly earlier: readonly EarlierRow[]
  /** The head's answer, its parts said one after the other (" · "). */
  readonly answer: readonly MoneyWord[]
  /** A closed or cancelled order: no act on any row. */
  readonly final: boolean
}


const ADVANCE: readonly PlanRowKind[] = ['DEPOSIT', 'EXTRA', 'BEFORE_SHIPPING']
const ON_GOODS: readonly PlanRowKind[] = ['ON_INVOICE', 'ON_DELIVERY']
const isGoods = (invoice: { readonly docType: string; readonly status: string }) => invoice.docType !== 'TD02' && invoice.docType !== 'TD04' && invoice.status !== 'DRAFT'

/** "Due day set by hand · Bea Esempio, 18 Nov" (+ the reason); null: nothing by hand. */
export function byHandOf(hand: ByHand | null | undefined): PlanRow['byHand'] {
  if (!hand) return null
  // The domain's hand acts (B-OM-011 … 016); an act a newer server names is "Set by hand".
  const what = word(`moneyTab.plan.byHand.what.${(MONEY_PLAN_ACTS as readonly string[]).includes(hand.act) ? hand.act : 'OTHER'}`)
  return { word: hand.by ? word('moneyTab.plan.byHand.who', { words: { what }, params: { by: hand.by }, instants: { date: hand.at } }) : word('moneyTab.plan.byHand.when', { words: { what }, instants: { date: hand.at } }), reason: hand.reason ?? null }
}

function titleOf(kind: PlanRowKind, share: string | null, options: { readonly ofChange?: boolean; readonly label?: string | null } = {}): MoneyWord {
  const what = options.label ? word('moneyTab.plan.label', { params: { label: options.label } }) : word(`moneyTab.plan.kind.${kind}`)
  if (!share) return what
  return word('moneyTab.plan.title', { words: { kind: what, share: word(options.ofChange ? 'moneyTab.plan.shareOfChange' : 'moneyTab.plan.share', { pcts: { share } }) } })
}

/** The row's kind for a request no step names: the balance's own request, an extra deposit (L8), else the deposit itself. */
function requestKindOf(order: Order, request: DepositRequest, schedule: Schedule): PlanRowKind {
  if (request.stepKind === 'BEFORE_SHIPPING') return 'BEFORE_SHIPPING'
  return isExtraDeposit(order, request, schedule) ? 'EXTRA' : 'DEPOSIT'
}

export function planOf(input: {
  readonly order: Order
  readonly schedule: Schedule
  readonly settlement: Settlement | null
  readonly can: OrderAbilities
  /** The schedule's verbs' rights (orders.manage: open a step; invoices.manage: invoice a step; orders.waive: waive); null: none. */
  readonly stepCan: StepAbilities | null
  readonly today: string
  /** The order's still to pay by the server's one rule (Totals' figure), when the plan read has no `stillOpen` yet. */
  readonly stillToPay: number | null
}): PlanModel {
  const { order, schedule, settlement, can, stepCan, today } = input
  const price = can.price
  const final = isFinal(order)
  const live = (id: string | null) => (id ? (order.chain.depositRequests.find((request) => request.id === id && request.status !== 'CANCELLED') ?? null) : null)
  const planRequest = (id: string): PlanRequest | null => schedule.requests?.find((entry) => entry.id === id) ?? null
  // The goods invoice an on-delivery / on-invoice step is paid with: the first one still open (price), else the first issued.
  const openGoods = price ? (settlement?.invoices.find((invoice) => isGoods(invoice) && !!invoice.number && (invoice.openShare ?? invoice.openAmount ?? 0) > 0) ?? null) : null
  const goods: Pick<ChainInvoice, 'id' | 'number'> | null = openGoods ? { id: openGoods.id, number: openGoods.number } : (order.chain.invoices.find((invoice) => isGoods(invoice) && !!invoice.number) ?? null)

  const rowOf = (kind: PlanRowKind, step: Milestone | null, request: DepositRequest | null): PlanRow => {
    const plan = request ? planRequest(request.id) : null
    const status = step?.status ?? request?.status ?? 'OPEN'
    const covered = step && ON_GOODS.includes(kind) ? (step.coveredByInvoices ?? 0) : 0
    const amount = price ? (step?.amount ?? request?.amount ?? null) : null
    const coveredFull = !!step && ON_GOODS.includes(kind) && (step.settledBy === 'INVOICES' || (amount !== null && amount > 0 && covered >= amount))
    const open = status === 'OPEN' && !coveredFull
    const placed = request ? (request.paidAmount ?? plan?.paid ?? 0) : (step?.paidSoFar ?? 0)
    const part = open && (placed > 0 || covered > 0)
    const day = step?.dueDate ?? request?.dueDate ?? null
    const overdue = open && ADVANCE.includes(kind) && !!day && day < today
    const left = !part ? null : request ? stillToPay(request) : amount !== null ? Math.max(0, amount - Math.max(placed, covered)) : null
    const done = !open
    const pill = status === 'WAIVED'
      ? { word: word('moneyTab.plan.pill.WAIVED'), tone: 'neutral' as const }
      : !open
        ? { word: word('moneyTab.plan.pill.PAID'), tone: 'success' as const }
        : overdue
          ? { word: word('moneyTab.plan.pill.OVERDUE'), tone: 'danger' as const }
          : part
            ? { word: word('moneyTab.plan.pill.PART'), tone: 'warning' as const }
            : kind === 'DEPOSIT' && !request && order.depositRequired
              ? { word: word('moneyTab.plan.pill.NOT_ASKED'), tone: 'warning' as const }
              : { word: word('moneyTab.plan.pill.OPEN'), tone: kind === 'DEPOSIT' || kind === 'EXTRA' ? ('warning' as const) : ('neutral' as const) }

    // ---- due: a paid step's day is an instant (paidAt), an open step's a business day (dueDate): never mixed ----
    const paidAt = step?.paidAt ?? request?.paidAt ?? null
    const due = status === 'WAIVED'
      ? word('moneyTab.plan.due.waived')
      : coveredFull
        ? word('moneyTab.plan.due.paidWithInvoices')
        : !open
          ? paidAt
            ? word('moneyTab.plan.due.paidOn', { instants: { date: paidAt } })
            : word('moneyTab.plan.due.paid')
          : kind === 'ON_INVOICE'
            ? word('moneyTab.plan.due.asInvoice')
            : kind === 'ON_DELIVERY'
              ? word('moneyTab.plan.due.onDelivery')
              : day
                ? word(overdue ? 'moneyTab.plan.due.overdueSince' : 'moneyTab.plan.due.on', { days: { date: day } })
                : kind === 'BEFORE_SHIPPING'
                  ? word('moneyTab.plan.due.beforeGoodsLeave')
                  : word('schedule.when.DEPOSIT')
    const invoice = ON_GOODS.includes(kind) && goods?.number ? { id: goods.id, number: goods.number } : null
    const dueSub = invoice && open ? word('moneyTab.plan.due.withInvoice', { params: { number: invoice.number } }) : null

    // ---- notes ----
    const notes: { word: MoneyWord; tone: 'warning' | 'neutral' }[] = []
    if (open && !final) {
      if (kind === 'DEPOSIT' && order.depositRequired) notes.push({ word: word(request ? 'moneyTab.plan.note.productionWaits' : 'held.depositMissing'), tone: 'warning' })
      if (kind === 'EXTRA') notes.push({ word: word('moneyTab.plan.note.extraWaits'), tone: 'warning' })
      if (kind === 'BEFORE_SHIPPING') notes.push({ word: word('moneyTab.plan.note.holdsShipment'), tone: 'neutral' })
      if (ON_GOODS.includes(kind)) notes.push({ word: word('moneyTab.plan.note.paidWithInvoice'), tone: 'neutral' })
    }

    // ---- the acts: today's, hidden without their right, held only by state; none on a closed or cancelled order ----
    const acts: PlanAct[] = []
    if (!final) {
      if (request && request.status === 'OPEN') {
        if (can.recordPayment && price) acts.push({ id: 'record', label: word('moneyTab.plan.act.record'), held: null })
        if (can.recordPayment) acts.push({ id: 'send', label: word(request.link ? 'moneyTab.plan.act.sendAgain' : 'moneyTab.plan.act.send'), held: null })
      }
      if (step && stepCan?.manageOrders) {
        const opening = stepVerbs(step, order, stepCan).find((verb) => verb.kind === 'open')
        if (opening && opening.kind === 'open') acts.push({ id: 'open', label: word('schedule.verbs.open'), held: opening.held ? word(opening.held.key, { params: opening.held.params }) : null, needsDay: opening.needsDay })
      }
      // P0-B4 (M4-B4): "Invoice this step" only while a paid part waits for its deposit invoice (TD02 rule) and none was made yet.
      const paidSomething = !!request && (request.status === 'PAID' || (request.paidAmount ?? 0) > 0)
      if (step && request && (step.kind === 'DEPOSIT' || step.kind === 'BEFORE_SHIPPING') && stepCan?.manageInvoices && request.fiscalDocument === 'TD02' && paidSomething && depositInvoicesOf(request, order.chain.invoices).length === 0) {
        acts.push({ id: 'invoiceStep', label: word('schedule.verbs.invoice'), held: null })
      }
      if (open && invoice && openGoods && can.recordPayment) acts.push({ id: 'payInvoice', label: word('moneyTab.plan.act.payInvoice'), held: null })
      // Waive… (the owner, a fresh code): shown ONCE per row (P0-B6); money placed on it holds it (M4-B5).
      if (stepCan?.waive && open && ADVANCE.includes(kind)) acts.push({ id: 'waive', label: word('moneyTab.plan.act.waive'), held: placed > 0 ? word('schedule.verbs.held.partPaid') : null })
    }
    // The ONE next act, one rule for every request (the deposit and an extra one alike): Send the page while it was never sent and
    // nothing is paid on it, else Record a payment; a step without a request: Open for payment, or Record payment… on its invoice.
    const sendFirst = !!request && request.status === 'OPEN' && !request.link && placed === 0
    const firstOf: readonly PlanActId[] = sendFirst ? ['send', 'record'] : ['record', 'open', 'payInvoice', 'send']
    const act = firstOf.map((id) => acts.find((entry) => entry.id === id)).find((entry) => !!entry) ?? null
    const fromChange = plan?.fromChange ?? null
    const renamed = step?.byHand?.act === 'RENAME_STEP' ? step.label : null
    const share = step?.sharePct ?? (kind === 'EXTRA' || !step ? (request?.depositPct ?? null) : null)
    return {
      anchor: request ? rowAnchor('DepositRequest', request.id) : rowAnchor('Step', step!.id),
      alias: request && step ? rowAnchor('Step', step.id) : null,
      kind,
      title: titleOf(kind, share, { ofChange: kind === 'EXTRA' && !!fromChange, label: renamed }),
      sub: request && request.kind !== 'ACCONTO' && (DEPOSIT_KINDS as readonly string[]).includes(request.kind) ? word(`depositKind.${request.kind}`) : null,
      step,
      request,
      payments: plan?.payments ?? null,
      pill,
      amount,
      left,
      due,
      dueSub,
      notes,
      byHand: byHandOf(step?.byHand ?? plan?.byHand),
      fromChange,
      act,
      more: acts.filter((entry) => entry !== act),
      invoice,
      unfolds: !!request,
      openAtFirst: !!request && request.status === 'OPEN',
      done,
      discuss: request ? { part: word('discuss.deposit'), target: { kind: 'DepositRequest', id: request.id } } : { part: word('discuss.step', { params: { seq: step!.seq } }), target: null },
    }
  }

  // ---- the rows: the steps in their order; the requests no step names right after the deposit (L8) ----
  const steps = [...schedule.steps].sort((a, b) => a.seq - b.seq)
  const named = new Set([...schedule.steps, ...schedule.cancelled].flatMap((step) => (step.depositRequestId ? [step.depositRequestId] : [])))
  const stepRows = steps.map((step) => rowOf(step.kind, step, live(step.depositRequestId)))
  const requestRows = order.chain.depositRequests.filter((request) => request.status !== 'CANCELLED' && !named.has(request.id)).map((request) => rowOf(requestKindOf(order, request, schedule), null, request))
  const afterDeposit = stepRows.reduce((at, row, index) => (row.kind === 'DEPOSIT' ? index + 1 : at), 0)
  const rows = [...stepRows.slice(0, afterDeposit), ...requestRows, ...stepRows.slice(afterDeposit)]

  // ---- earlier: the replaced or removed steps, and the requests no step names that were cancelled (kept, never deleted) ----
  const earlier: EarlierRow[] = [
    ...schedule.cancelled.map((step) => ({ key: step.id, title: titleOf(step.kind, step.sharePct), amount: price ? (step.amount ?? null) : null, words: word('moneyTab.plan.earlier.step'), byHand: byHandOf(step.byHand) })),
    ...order.chain.depositRequests
      .filter((request) => request.status === 'CANCELLED' && !named.has(request.id))
      .map((request) => {
        const plan = planRequest(request.id)
        return { key: request.id, title: titleOf(request.stepKind === 'BEFORE_SHIPPING' ? 'BEFORE_SHIPPING' : 'DEPOSIT', request.depositPct), amount: price ? (request.amount ?? null) : null, words: word(plan?.replacedBy ? 'moneyTab.plan.earlier.replaced' : 'moneyTab.plan.earlier.cancelled'), byHand: byHandOf(plan?.byHand) }
      }),
  ]

  return { rows, earlier, answer: answerOf(rows, schedule, input.stillToPay, price, final), final }
}

/** The head's answer: still open · overdue · next (price), else the next step in words; nothing open; everything paid (the view
 * says its first word with a capital). */
function answerOf(rows: readonly PlanRow[], schedule: Schedule, stillToPay: number | null, price: boolean, final: boolean): MoneyWord[] {
  const tail = final ? [word('moneyTab.plan.answer.final')] : []
  if (rows.length === 0) return [word('moneyTab.plan.answer.none'), ...tail]
  const next = rows.find((row) => !row.done) ?? null
  if (!next) return [word('moneyTab.plan.answer.allPaid'), ...tail]
  const what = word(`moneyTab.plan.next.${next.kind}`)
  const day = next.step?.dueDate ?? next.request?.dueDate ?? null
  const still = schedule.stillOpen ?? stillToPay
  if (price && still !== null) {
    return [
      word('moneyTab.plan.answer.stillOpen', { money: { amount: still } }),
      ...(schedule.overdue !== undefined ? [word('moneyTab.plan.answer.overdue', { money: { amount: schedule.overdue } })] : []),
      day ? word('moneyTab.plan.answer.nextDue', { words: { what }, days: { date: day } }) : word('moneyTab.plan.answer.next', { words: { what } }),
      ...tail,
    ]
  }
  return [day ? word('moneyTab.plan.answer.nextDue', { words: { what }, days: { date: day } }) : word('moneyTab.plan.answer.next', { words: { what } }), ...tail]
}
