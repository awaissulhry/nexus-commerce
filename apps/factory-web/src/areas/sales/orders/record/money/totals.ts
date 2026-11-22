import { SETTLEMENT_GAPS, type Order, type Settlement } from '../../api'
import { askedOutsideGate, depositGate, isShippedInFull, stillToPay, type OrderAbilities } from '../../model' // F-OM-fx5w (N1): + askedOutsideGate, stillToPay
import { isExtraDeposit, liveDepositsOf, openGoodsOf } from './head' // F-OM-fx5w (N9): + openGoodsOf (one open invoice with the head)
import { word, type MoneyWord } from './word'

/**
 * F-OM-102 (order MONEY tab, 10-design §4) — section 1, Totals (#totals): what the order is worth, what came in, what is left and what
 * is still missing before it is settled. Pure: the view draws it.
 *
 *   tiles        Order total · VAT incl. · Invoiced › (#invoices) · Paid › "of which deposits" (#payments) · Still to pay — the price
 *                grain only; Invoiced and Paid need the settlement (invoices.view) or the order's own `money` (B-OM-002); Still to pay
 *                is the server's ONE rule (the order's `money`, else the settlement's `thisOrder`), never the web's gross − deposits;
 *                a figure the reader's answers do not hold is no tile (never a made-up 0, never a bare "—")
 *   answer       "Not settled yet · 2 things left" · "Settled · nothing left" · a cancelled order: "nothing more is owed"
 *   gaps         one row per gap of the order read's settlement (every orders.view reader, words only) with its door: Shipments ›,
 *                Invoices ↓ (invoices.view), Payments ↓ (a paid deposit with no deposit invoice)
 *   adds         How it adds up (price): Order total − never billed − credit notes − paid − written off = still to pay; then freight on
 *                the invoices in no order — rows only when not zero
 *   facts        Deposit (in paid words: the amount PAID, M1-B11) · Payment terms · Margin now › (#margin, the margin grain: the margin
 *                read's now, else the order's) · Cost now (the cost grain)
 *   close        ⋯ Close unsettled… (orders.close: the band's own dialog), held in words until everything has shipped
 */

export type TotalsDoor = 'shipments' | 'invoices' | 'payments'

export interface TotalsTile {
  readonly id: 'total' | 'invoiced' | 'paid' | 'still'
  readonly label: MoneyWord
  readonly amount: number
  readonly hint: MoneyWord | null
  readonly door: Extract<TotalsDoor, 'invoices' | 'payments'> | null
}

export interface TotalsGap {
  readonly code: string
  readonly words: MoneyWord
  /** With the price grain: what is open on it ("FT-2026-00012: € 2,418.00 open"). */
  readonly extra: MoneyWord | null
  readonly door: TotalsDoor | null
}

export interface TotalsAdd {
  readonly words: MoneyWord
  readonly amount: number
  /** "−" before it (taken off), or the sum line. */
  readonly sign: 'plus' | 'minus' | 'sum' | 'aside'
}

export interface TotalsFact {
  readonly label: MoneyWord
  readonly value: MoneyWord
  /** "Margin now ›" lands on #margin. */
  readonly door: 'margin' | null
}

export interface TotalsModel {
  readonly answer: MoneyWord
  readonly settled: boolean
  /** Settled: the one row that says what is done, with its day. */
  readonly settledRow: MoneyWord | null
  readonly gaps: readonly TotalsGap[]
  /** Null without the price grain (no tile at all: the head says the money wall once). */
  readonly tiles: readonly TotalsTile[] | null
  /** How it adds up (price grain, the still-to-pay figure known); null: not drawn. */
  readonly adds: readonly TotalsAdd[] | null
  readonly facts: readonly TotalsFact[]
  /** ⋯ Close unsettled… (orders.close), its held words by state; null: not offered. */
  readonly close: { readonly held: MoneyWord | null } | null
}

const INVOICE_GAPS = new Set(['NOT_INVOICED', 'OVER_INVOICED', 'NO_INVOICE', 'AT_SDI', 'DEPOSIT_NOT_DEDUCTED', 'BALANCE_DUE', 'REFUND_DUE'])

/** The order's gaps in its read's order, each once (an unknown code is "Something else is missing"). */
export function gapCodesOf(order: Pick<Order, 'settlement'>): string[] {
  const seen: string[] = []
  for (const gap of order.settlement.missing) {
    const code = (SETTLEMENT_GAPS as readonly string[]).includes(gap.code) ? gap.code : 'OTHER'
    if (!seen.includes(code)) seen.push(code)
  }
  return seen
}

/** Where a gap is answered: what has not shipped on Shipments, a deposit's invoice on Payments, the rest on Invoices (invoices.view). */
export function gapDoorOf(code: string, can: Pick<OrderAbilities, 'viewInvoices'>): TotalsDoor | null {
  if (code === 'NOT_SHIPPED') return 'shipments'
  if (code === 'DEPOSIT_NOT_INVOICED') return 'payments'
  if (INVOICE_GAPS.has(code)) return can.viewInvoices ? 'invoices' : null
  return null
}

/**
 * The order's still to pay by the server's ONE rule (the order's money, else the settlement's thisOrder); null: not known here. Never
 * the settlement's invoice-wide balance (0 before the first invoice: a made-up figure for this order) and never gross − deposits.
 */
export function stillToPayOf(order: Pick<Order, 'money'>, settlement: Settlement | null): number | null {
  return order.money?.stillToPay ?? settlement?.thisOrder?.stillToPay ?? null
}

export function totalsOf(input: { readonly order: Order; readonly settlement: Settlement | null; readonly can: OrderAbilities; readonly marginNow?: string | null; readonly today: string }): TotalsModel {
  const { order, settlement, can } = input
  const price = can.price
  const cancelled = order.status === 'CANCELLED'
  const settled = order.settlement.settled
  const codes = gapCodesOf(order)
  // F-OM-fx5w: the head's own open invoice (openGoodsOf), so the head and What is left name the same one.
  const firstOpen = price ? openGoodsOf(settlement, true) : null
  const gaps: TotalsGap[] = cancelled || settled
    ? []
    : codes.map((code) => ({
        code,
        words: word(`settlement.${code}`),
        extra: code === 'BALANCE_DUE' && firstOpen && firstOpen.amount !== null ? word('moneyTab.totals.openOn', { params: { number: firstOpen.number }, money: { amount: firstOpen.amount } }) : null,
        door: gapDoorOf(code, can),
      }))
  const answer = cancelled
    ? word('moneyTab.totals.cancelled')
    : settled
      ? order.closedAt
        ? word('moneyTab.totals.settledOn', { instants: { date: order.closedAt } })
        : word('moneyTab.totals.settled')
      : word('moneyTab.totals.left', { params: { count: gaps.length } })
  const settledRow = settled && !cancelled ? word('moneyTab.totals.settledRow') : null

  // ---- the tiles (price grain): the server's figures only ----
  // F-OM-fx3 (B-OM-029, W-05): a cancelled order owes 0 (M1-B9), even on an older answer that still says otherwise.
  const owed = stillToPayOf(order, settlement)
  const still = cancelled && owed !== null ? 0 : owed
  const mine = settlement?.thisOrder
  // This order's share only (F-OP-118): the settlement's invoice-wide figures are never this order's.
  const paid = order.money?.paid ?? mine?.paid ?? null
  const deposits = order.money?.depositsPaid ?? mine?.depositsPaid ?? null
  const invoiced = mine?.invoicedShare ?? null
  const credited = order.money?.credited ?? (settlement ? (settlement.creditedAmount ?? null) : null)
  const depositInvoiced = (settlement?.depositInvoices ?? []).filter((invoice) => invoice.status !== 'DRAFT').reduce((sum, invoice) => sum + (invoice.gross ?? 0), 0)
  // B-OM-001: this order's share of the small differences written off on its invoices (no longer owed).
  const writtenOff = order.money?.writtenOff ?? mine?.writtenOff ?? 0
  const next = nextDueOf(order)
  let tiles: TotalsTile[] | null = null
  if (price && order.grossAmount !== undefined) {
    tiles = [
      { id: 'total', label: word('moneyTab.totals.tile.total'), amount: order.grossAmount, hint: order.netAmount !== undefined && order.vatAmount !== undefined ? word('moneyTab.totals.hint.netVat', { money: { net: order.netAmount, vat: order.vatAmount } }) : null, door: null },
    ]
    if (invoiced !== null) {
      const hint = invoiced === 0 && depositInvoiced === 0 ? word('moneyTab.totals.hint.nothingYet') : depositInvoiced > 0 ? word('moneyTab.totals.hint.goodsOnly', { money: { amount: depositInvoiced } }) : (credited ?? 0) > 0 ? word('moneyTab.totals.hint.afterCredit', { money: { amount: credited ?? 0 } }) : null
      tiles.push({ id: 'invoiced', label: word('moneyTab.totals.tile.invoiced'), amount: invoiced, hint, door: can.viewInvoices ? 'invoices' : null })
    }
    if (paid !== null) tiles.push({ id: 'paid', label: word('moneyTab.totals.tile.paid'), amount: paid, hint: paid === 0 ? word('moneyTab.totals.hint.nothingReceived') : (deposits ?? 0) > 0 ? word('moneyTab.totals.hint.ofWhichDeposits', { money: { amount: deposits ?? 0 } }) : null, door: 'payments' })
    if (still !== null) {
      const hint = cancelled
        ? word('moneyTab.totals.hint.cancelled')
        : still === 0 && writtenOff > 0
          ? word('moneyTab.totals.hint.writtenOff', { money: { amount: writtenOff } })
          : still > 0 && next
            ? next.what
              ? word('moneyTab.totals.hint.next', { words: { what: next.what }, days: { date: next.day } })
              : word('moneyTab.totals.hint.due', { days: { date: next.day } })
            : null
      tiles.push({ id: 'still', label: word('moneyTab.totals.tile.still'), amount: still, hint, door: null })
    }
  }

  // ---- How it adds up (price grain, still to pay known): rows only when not zero; F-OM-fx3 (W-05): none for a cancelled order ----
  let adds: TotalsAdd[] | null = null
  if (price && still !== null && order.grossAmount !== undefined && !cancelled) {
    const neverBilled = order.money?.neverBilled ?? 0
    const freight = (settlement?.invoices ?? []).reduce((sum, invoice) => sum + (invoice.freight ?? 0), 0)
    adds = [
      { words: word('moneyTab.totals.adds.total'), amount: order.grossAmount, sign: 'plus' },
      ...(neverBilled > 0 ? [{ words: word('moneyTab.totals.adds.neverBilled'), amount: neverBilled, sign: 'minus' as const }] : []),
      ...((credited ?? 0) > 0 ? [{ words: word('moneyTab.totals.adds.credited'), amount: credited ?? 0, sign: 'minus' as const }] : []),
      ...(paid !== null ? [{ words: word('moneyTab.totals.adds.paid'), amount: paid, sign: 'minus' as const }] : []),
      ...(writtenOff > 0 ? [{ words: word('moneyTab.totals.adds.writtenOff'), amount: writtenOff, sign: 'minus' as const }] : []),
      { words: word('moneyTab.totals.adds.still'), amount: still, sign: 'sum' },
      ...(freight > 0 ? [{ words: word('moneyTab.totals.adds.freight'), amount: freight, sign: 'aside' as const }] : []),
    ]
  }

  // ---- the facts ----
  const facts: TotalsFact[] = [
    { label: word('summary.deposit'), value: depositWordsOf(order, price), door: null },
    { label: word('newOrder.terms'), value: order.paymentTerms ? word('moneyTab.totals.fact.terms', { params: { terms: order.paymentTerms } }) : word('moneyTab.totals.fact.noTerms'), door: null },
  ]
  if (can.margin) {
    const now = input.marginNow ?? order.marginPct ?? null
    facts.push({ label: word('moneyTab.totals.fact.marginNow'), value: now === null ? word('summary.marginUnknown') : word('moneyTab.totals.fact.marginValue', { pcts: { pct: now } }), door: 'margin' })
  }
  if (can.cost) facts.push({ label: word('moneyTab.totals.fact.costNow'), value: order.costAmount === null || order.costAmount === undefined ? word('summary.costIncomplete') : word('moneyTab.totals.fact.cost', { money: { amount: order.costAmount } }), door: null })

  // ---- ⋯ Close unsettled… (orders.close; the band's dialog): only while it is not settled, held by state in words ----
  const close = can.close && !settled && !cancelled
    ? { held: order.status === 'CLOSED' ? word('moneyTab.totals.closeHeld.closed') : !isShippedInFull(order) ? word('moneyTab.totals.closeHeld.notShipped') : null }
    : null

  return { answer, settled: settled && !cancelled, settledRow, gaps, tiles, adds, facts, close }
}

/** The next request that asks money, and its day: the open deposit (or extra deposit) first, then the balance before shipping's. */
function nextDueOf(order: Order): { readonly what: MoneyWord | null; readonly day: string } | null {
  const gate = depositGate(order)
  if (gate.state === 'WAITING' && gate.request) return { what: word(isExtraDeposit(order, gate.request, null) ? 'moneyTab.plan.next.EXTRA' : 'moneyTab.plan.next.DEPOSIT'), day: gate.request.dueDate }
  // F-OM-fx5w (N1): no deposit needed, an extra deposit asked all the same: the next money asked.
  const asked = gate.state === 'NOT_NEEDED' ? askedOutsideGate(order) : null
  if (asked) return { what: word('moneyTab.plan.next.EXTRA'), day: asked.dueDate }
  const balance = order.chain.depositRequests.find((request) => request.status === 'OPEN' && request.stepKind === 'BEFORE_SHIPPING') ?? null
  if (balance) return { what: word('moneyTab.plan.next.BEFORE_SHIPPING'), day: balance.dueDate }
  return null
}

/**
 * The deposit in words (M1-B11: a paid deposit says the amount PAID): "€ 3,660.00 paid 29 Oct · extra € 43.92 open"; no price: words.
 * F-OM-fx5w (N1): an order that needs no deposit with an extra one open: "Not needed · extra € 43.92 open, due 23 Nov".
 */
export function depositWordsOf(order: Order, price: boolean): MoneyWord {
  const gate = depositGate(order)
  const request = gate.request
  if (gate.state === 'NOT_NEEDED') {
    // F-OM-fx5w (N1): never "Not needed" alone while an extra deposit is open (the head names it; production does not wait for it).
    const asked = askedOutsideGate(order)
    if (!asked) return word('summary.depositNotNeeded')
    const left = stillToPay(asked)
    return price && asked.amount !== undefined ? word('moneyTab.totals.fact.notNeededExtra', { money: { amount: left ?? asked.amount }, days: { date: asked.dueDate } }) : word('moneyTab.totals.fact.notNeededExtraWords', { days: { date: asked.dueDate } })
  }
  if (gate.state === 'MISSING' || !request) return word('summary.depositMissing')
  if (gate.state === 'WAIVED') return word('summary.depositWaived')
  const paidOne = liveDepositsOf(order).find((entry) => entry.status === 'PAID') ?? null
  if (gate.state === 'PAID') {
    if (!price || request.paidAmount === undefined) return word('deposit.PAID')
    return request.paidAt ? word('moneyTab.totals.fact.depositPaidOn', { money: { amount: request.paidAmount }, instants: { date: request.paidAt } }) : word('moneyTab.totals.fact.depositPaid', { money: { amount: request.paidAmount } })
  }
  // Waiting: an extra deposit beside a paid one, a part payment, or the deposit open.
  if (paidOne && paidOne.id !== request.id) {
    if (!price || request.amount === undefined || paidOne.paidAmount === undefined) return word('moneyTab.totals.fact.paidExtraWords')
    return word('moneyTab.totals.fact.paidExtra', { money: { paid: paidOne.paidAmount, extra: Math.max(0, request.amount - (request.paidAmount ?? 0)) } })
  }
  if ((request.paidAmount ?? 0) > 0) return price && request.amount !== undefined && request.paidAmount !== undefined ? word('moneyTab.totals.fact.partPaid', { money: { paid: request.paidAmount, amount: request.amount } }) : word('moneyTab.totals.fact.partPaidWords')
  return price && request.amount !== undefined ? word('moneyTab.totals.fact.depositDue', { money: { amount: request.amount }, days: { date: request.dueDate } }) : word('moneyTab.totals.fact.depositDueWords', { days: { date: request.dueDate } })
}
