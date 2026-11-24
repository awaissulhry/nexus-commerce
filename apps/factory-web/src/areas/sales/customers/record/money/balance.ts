import { AGEING_BUCKETS, type AgeingBucket, type AgeingRow } from '../../../../finance/receivables/api'
import { word, type MoneyWord } from '../../../orders/record/money/word'
import type { Loaded } from '../../../../parties/_shared/model'
import type { CustomerMoneyModel } from '../../money/overview'
import { customerTabHref, priceDifferHref, receivablesHref, workOpenOrdersHref } from './doors'
import { figuresOf, standingOf, type CurrencyFigures } from './head'
import { daysFrom, daysLateOf, isReading, orderProblemOf, partReady, paymentTermsOf, READING, type MoneyTabCan, type MoneyTabInput, type OpenItemsRead, type Part } from './model'

/**
 * F-CM-104 (customer page › MONEY tab, 10-design §5.1; 18-lead-settles Z4, Z11, Z24) — section 1, Balance (#balance): the figures in
 * TWO directions, never netted and never added across currencies — "{customer} owes us" (Open to pay · Overdue · Deposits asked · Not
 * invoiced yet) and "We hold or owe {customer}" (On account · To give back), each a door down the page; the open invoices by age (five
 * cells per currency); "What needs you · N", each with its ONE door, most blocking first; two facts. Figures and the ageing only with the
 * price grain (Sales and Read-only read the needs and the facts in words). "Not invoiced yet" is a COUNT that is a door; its amount is
 * only a hint and only for a customer WITH a credit limit (Z4). "Ordered in <year>" is gone (no honest source).
 *
 * The tab's count (Z11): late invoices + late deposit requests; null while read; never "0" (undefined: no chip).
 */

/** Where a figure or a need opens: a section of this tab (when it is drawn), else an address. */
export type BalanceDoor = { readonly kind: 'down'; readonly to: string; readonly label: MoneyWord } | { readonly kind: 'href'; readonly href: string; readonly label: MoneyWord }

export interface BalanceTile {
  readonly key: 'open' | 'overdue' | 'deposits' | 'notInvoiced' | 'onAccount' | 'giveBack'
  readonly label: MoneyWord
  /** An amount in the block's currency (price grain), or words (a count). */
  readonly value: { readonly amount: number } | { readonly words: MoneyWord }
  readonly hint: MoneyWord | null
  /** A section of this tab (`collect`, `on-account`, `give-back`) or an address. */
  readonly door: { readonly down: string } | { readonly href: string }
}

export interface FigureGroup {
  readonly kind: 'owes' | 'holds'
  readonly label: MoneyWord
  readonly tiles: readonly BalanceTile[]
}

export interface BalanceBlock {
  /** Said only when the customer's money is in two or more currencies ("In EUR"). */
  readonly currency: string | null
  /** The block's currency (amounts are said in it). */
  readonly unit: string
  readonly groups: readonly FigureGroup[]
  /** The open invoices by age, five cells (Finance's bucket words); null: no open invoice. */
  readonly ageing: readonly { readonly bucket: AgeingBucket; readonly amount: number; readonly late: boolean }[] | null
}

export interface Need {
  readonly code: 'depositLate' | 'invoicesLate' | 'onHold' | 'overLimit' | 'onAccount' | 'giveBack' | 'shipped' | 'cantInvoice' | 'reminders' | 'priceDiffer'
  readonly tone: 'danger' | 'warning'
  readonly words: MoneyWord
  /** Its ONE door: a section of this tab when drawn (`down`), else `fallback` (an address with this customer chosen), else none. */
  readonly down: string | null
  readonly fallback: BalanceDoor | null
  /** In the amount's currency (a need that says one amount). */
  readonly currency?: string
}

export interface Fact {
  readonly key: 'lastPayment' | 'paymentTerms' | 'notInvoiced'
  readonly label: MoneyWord
  readonly value: MoneyWord
  readonly href?: string
}

export interface BalanceModel {
  readonly reading: boolean
  /** The head's ONE answer: "7 things need you · 3 invoices open · 2 late · …". */
  readonly answer: readonly MoneyWord[]
  /** The figures and the ageing per currency (price grain only; null without it). */
  readonly blocks: readonly BalanceBlock[] | null
  readonly needs: readonly Need[]
  /** "Nothing needs you: nothing is late, nothing waits." (no need). */
  readonly calm: MoneyWord | null
  readonly facts: readonly Fact[]
}

const sumOf = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

/** The open orders not invoiced in full (the orders summary of the OPEN orders: invoiced None + Part), or null when not read. */
export function notInvoicedOf(input: MoneyTabInput): number | null {
  const figures = input.summary?.value?.all ?? null
  return figures ? figures.invoiced.NONE.count + figures.invoiced.PART.count : null
}

function tilesOf(figures: CurrencyFigures, input: MoneyTabInput, first: boolean, prefix: string): FigureGroup[] {
  const owes: BalanceTile[] = []
  const holds: BalanceTile[] = []
  const name = input.party.name
  if (figures.openInvoices > 0 && figures.open !== null)
    owes.push({ key: 'open', label: word('tab.openToPay'), value: { amount: figures.open }, hint: word('cell.invoices', { params: { count: figures.openInvoices } }), door: { down: 'collect' } })
  if (figures.oldestDays > 0 && figures.late !== null) {
    const oldest = word('cm.balance.oldest', { words: { days: word('cm.days', { params: { count: figures.oldestDays } }) } })
    const hint = figures.lateInvoices !== null && figures.lateInvoices > 0 ? word('cm.dot', { words: { first: word('cell.invoices', { params: { count: figures.lateInvoices } }), second: oldest } }) : oldest
    owes.push({ key: 'overdue', label: word('money.overdue'), value: { amount: figures.late }, hint, door: { down: 'collect' } })
  }
  if (figures.requests > 0 && figures.deposits !== null) {
    const hint = figures.requestsLate > 0 ? word('cm.dot', { words: { first: word('cm.balance.requests', { params: { count: figures.requests } }), second: word('cm.answer.lateOfThem', { params: { count: figures.requestsLate } }) } }) : word('cm.balance.requestsOpen', { params: { count: figures.requests } })
    owes.push({ key: 'deposits', label: word('cm.balance.depositsAsked'), value: { amount: figures.deposits }, hint, door: { down: 'collect' } })
  }
  // A COUNT that is a door (Z4): once, in the first block (the summary is not per currency). Its amount only with a credit limit (cm-w3).
  const notInvoiced = first ? notInvoicedOf(input) : null
  if (notInvoiced !== null && notInvoiced > 0)
    owes.push({ key: 'notInvoiced', label: word('cm.balance.notInvoiced'), value: { words: word('cm.balance.orders', { params: { count: notInvoiced } }) }, hint: word('cm.balance.notInvoicedHint'), door: { href: workOpenOrdersHref(prefix, input.party.id) } })
  if (figures.onAccount && figures.onAccountAmount !== null)
    holds.push({ key: 'onAccount', label: word('cm.balance.onAccount'), value: { amount: figures.onAccountAmount }, hint: word('cm.balance.onAccountHint'), door: { down: 'on-account' } })
  if (figures.toGiveBack > 0 && figures.giveBack !== null)
    holds.push({ key: 'giveBack', label: word('cm.balance.giveBack'), value: { amount: figures.giveBack }, hint: word('cm.answer.refundsWords', { params: { count: figures.toGiveBack } }), door: { down: 'give-back' } })
  return [
    ...(owes.length > 0 ? [{ kind: 'owes' as const, label: word('cm.balance.owesUs', { params: { customer: name } }), tiles: owes }] : []),
    ...(holds.length > 0 ? [{ kind: 'holds' as const, label: word('cm.balance.weHold', { params: { customer: name } }), tiles: holds }] : []),
  ]
}

/** The needs, most blocking first: each its ONE door (a section of this tab, else Finance or Terms with this customer chosen). */
export function needsOf(input: MoneyTabInput, figures: readonly CurrencyFigures[], prefix: string): Need[] {
  const price = input.can.price
  const out: Need[] = []
  const finance: BalanceDoor = { kind: 'href', href: receivablesHref(prefix, input.party.id), label: word('cm.door.finance') }
  // 1 a late deposit (open items): the oldest first, with its order.
  const lateRequests = input.can.payments
    ? (input.openItems?.value?.items ?? []).filter((item) => item.target === 'DEPOSIT_REQUEST' && daysLateOf(item.dueDate, input.today) > 0).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
    : []
  const oldestLate = lateRequests[0]
  if (oldestLate?.dueDate)
    out.push({ code: 'depositLate', tone: 'danger', words: word('cm.needs.depositLate', { params: { count: lateRequests.length, order: oldestLate.orderNumber ?? '' }, days: { date: oldestLate.dueDate } }), down: 'collect', fallback: null })
  // 2 late invoices (the ageing; the count from S7 or the open items).
  const oldest = Math.max(0, ...figures.map((entry) => entry.oldestDays))
  if (oldest > 0) {
    const counts = figures.map((entry) => entry.lateInvoices)
    const count = counts.every((value) => value !== null) ? sumOf(counts as number[]) : null
    const days = word('cm.days', { params: { count: oldest } })
    out.push({ code: 'invoicesLate', tone: 'danger', words: count !== null && count > 0 ? word('cm.needs.invoicesLate', { params: { count }, words: { days } }) : word('cm.needs.invoicesLateSome', { words: { days } }), down: 'collect', fallback: null })
  }
  // 3 on hold · 4 over the credit limit (the glance).
  const standing = standingOf(input)
  if (standing?.holdReason)
    out.push({
      code: 'onHold',
      tone: 'danger',
      words: standing.holdSince ? word('cm.needs.onHoldSince', { instants: { date: standing.holdSince }, words: { reason: word(`sales-customers-depth:reason.${standing.holdReason}`) } }) : word('cm.needs.onHold', { words: { reason: word(`sales-customers-depth:reason.${standing.holdReason}`) } }),
      down: 'credit',
      fallback: { kind: 'href', href: customerTabHref(prefix, input.party.id, 'terms', 'party-hold'), label: word('cm.door.terms') },
    })
  if (standing?.over)
    out.push({ code: 'overLimit', tone: 'danger', words: standing.overBy !== null ? word('cm.needs.overBy', { money: { amount: standing.overBy } }) : word('cm.needs.over'), down: 'credit', fallback: finance, ...(standing.currency ? { currency: standing.currency } : {}) })
  // 5 money on account placed on nothing (open items' credit balance).
  for (const entry of figures)
    if (input.can.payments && entry.onAccount)
      out.push({ code: 'onAccount', tone: 'warning', words: price && entry.onAccountAmount !== null ? word('cm.needs.onAccount', { money: { amount: entry.onAccountAmount } }) : word('cm.needs.onAccountWords'), down: 'on-account', fallback: finance, currency: entry.currency })
  // 6 refunds to make, credit notes with money left to refund.
  const refunds = input.can.payments ? (input.refunds?.value ?? null) : null
  if (refunds && (refunds.refundsDue.length > 0 || refunds.creditNotesToRefund.length > 0)) {
    const due = refunds.refundsDue.filter((refund) => refund.status === 'DUE')
    const firstDay = due.map((refund) => refund.dueDate).filter((day): day is string => !!day).sort()[0] ?? null
    const made = due.length > 0 ? (firstDay ? word('cm.needs.refundsBy', { params: { count: due.length }, days: { date: firstDay } }) : word('cm.needs.refunds', { params: { count: due.length } })) : null
    const notes = refunds.creditNotesToRefund.length > 0 ? word('cm.needs.notes', { params: { count: refunds.creditNotesToRefund.length } }) : null
    const said = made && notes ? word('cm.dot', { words: { first: made, second: notes } }) : (made ?? notes)!
    out.push({ code: 'giveBack', tone: 'warning', words: said, down: 'give-back', fallback: finance })
  }
  // 7 shipped, not invoiced (invoices.view).
  const shipped = input.can.invoices ? (input.shipped?.value ?? null) : null
  // M-11 (cm-fx4): an "invoice by" day already past is said as past ("… 13 days ago") and is danger.
  const pastBy = shipped?.invoiceBy ? daysFrom(shipped.invoiceBy, input.today) : 0
  if (shipped && shipped.shipments > 0)
    out.push({ code: 'shipped', tone: pastBy > 0 ? 'danger' : 'warning', words: shipped.invoiceBy ? (pastBy > 0 ? word('cm.needs.shippedByPast', { params: { count: shipped.shipments }, days: { date: shipped.invoiceBy }, words: { ago: word('cm.daysAgo', { params: { count: pastBy } }) } }) : word('cm.needs.shippedBy', { params: { count: shipped.shipments }, days: { date: shipped.invoiceBy } })) : word('cm.needs.shipped', { params: { count: shipped.shipments } }), down: 'invoices', fallback: { kind: 'href', href: `${prefix}/finance/invoices`, label: word('cm.door.finance') } /* W1.5: every count a door — Finance › Invoices until the section is drawn (cm-w2) */ })
  // 8 can't be invoiced yet (Z32): the party read's own block — the Overview strip's source, no read of its own; its home is Terms.
  if (input.party.invoiceBlocked) {
    const why = (input.party.blocking ?? [])[0]
    out.push({ code: 'cantInvoice', tone: 'danger', words: why ? word('cm.needs.cantInvoice', { words: { why: word(`parties:warning.${why}`) } }) : word('parties:list.cannotInvoice'), down: null, fallback: { kind: 'href', href: customerTabHref(prefix, input.party.id, 'terms', 'party-identity'), label: word('cm.door.terms') } })
  }
  // 9 reminders that wait for a yes (prepared, not held by a stop or a rule).
  const waiting = input.can.receivables ? (input.reminders?.value ?? []).filter((reminder) => reminder.status === 'PREPARED' && reminder.held.length === 0).length : 0
  if (waiting > 0) out.push({ code: 'reminders', tone: 'warning', words: word('cm.needs.reminders', { params: { count: waiting } }), down: 'statement', fallback: finance })
  // 10 prices differ (the price grain): the Price check section (cm-w3); until then today's line and door (Work › Not equal).
  if (price && input.can.orders && input.priceDiffer !== null && input.priceDiffer > 0)
    out.push({ code: 'priceDiffer', tone: 'warning', words: word('cm.needs.priceDiffer', { params: { count: input.priceDiffer } }), down: 'price-check', fallback: { kind: 'href', href: priceDifferHref(prefix, input.party.id), label: word('parties:customers.work.priceDiffer', { params: { count: input.priceDiffer } }) } }) // F-CM-303 (Z31): ↓ Price check
  return out
}

/** The section's model (pure). `prefix`: `/w/<company>` — every door names this customer. */
export function balanceOf(input: MoneyTabInput, prefix: string): BalanceModel {
  const reading = isReading(input.ageing) || isReading(input.openItems)
  const figures = figuresOf(input)
  const needs = reading ? [] : needsOf(input, figures, prefix)
  const counts: MoneyWord[] = []
  const open = sumOf(figures.map((entry) => entry.openInvoices))
  // M-9 (cm-fx4): what is late is said for what it is — invoices late beside the invoices, deposits late beside the deposits.
  const lateInvoices = sumOf(figures.map((entry) => entry.lateInvoices ?? 0))
  const lateRequests = sumOf(figures.map((entry) => entry.requestsLate))
  const asked = sumOf(figures.map((entry) => entry.requests))
  const back = sumOf(figures.map((entry) => entry.toGiveBack))
  if (open > 0) counts.push(word('finance-receivables:tiles.invoices', { params: { count: open } }))
  if (lateInvoices > 0) counts.push(word('cm.answer.invoicesLate', { params: { count: lateInvoices } }))
  if (asked > 0) counts.push(word('cm.answer.depositsWords', { params: { count: asked } }))
  if (lateRequests > 0) counts.push(word('cm.answer.depositsLate', { params: { count: lateRequests } }))
  if (figures.some((entry) => entry.onAccount)) counts.push(word('cm.answer.onAccountWords'))
  if (back > 0) counts.push(word('cm.answer.refundsWords', { params: { count: back } }))
  const ordered = input.summary?.value?.all.orders.count ?? null
  const head = needs.length > 0 ? word('cm.balance.needs', { params: { count: needs.length } }) : word('cm.balance.nothingNeeds')
  const answer = reading ? [word('cm.balance.reading')] : [head, ...(counts.length > 0 ? counts : [ordered === 0 ? word('cm.balance.noOrder') : word('cm.balance.nothingOpen')])]
  const blocks = input.can.price
    ? figures
        .map((entry, index): BalanceBlock => ({
          currency: figures.length > 1 ? entry.currency : null,
          unit: entry.currency,
          groups: tilesOf(entry, input, index === 0, prefix),
          ageing: entry.openInvoices > 0 && entry.buckets ? AGEING_BUCKETS.map((bucket) => ({ bucket, amount: entry.buckets![bucket], late: bucket !== 'NOT_DUE' })) : null,
        }))
        .filter((block) => block.groups.length > 0 || block.ageing !== null)
    : null
  // A customer with orders not invoiced and nothing open: the count alone (its own block).
  const notInvoiced = notInvoicedOf(input)
  const withCount = blocks && blocks.length === 0 && notInvoiced !== null && notInvoiced > 0 ? [{ currency: null, unit: input.party.currency ?? 'EUR', groups: tilesOf({ ...NO_FIGURES, currency: input.party.currency ?? 'EUR' }, input, true, prefix), ageing: null }] : blocks
  const facts: Fact[] = []
  const last = lastPaymentOf(input.ageing?.value ?? null)
  if (input.can.receivables && last) facts.push({ key: 'lastPayment', label: word('finance-receivables:col.lastPayment'), value: word('cm.day', { days: { date: last } }) })
  // M-2 (cm-fx4): the payment terms from the ONE helper Credit & terms uses — said once its read has answered (never one text, then another).
  if (!(input.terms && isReading(input.terms))) {
    const terms = paymentTermsOf(input.terms?.value ?? null, input.party)
    facts.push({ key: 'paymentTerms', label: word('tab.paymentTerms'), value: terms ? word('cm.text', { params: { text: terms } }) : word('cm.balance.noTerms') })
  }
  if (!input.can.price && notInvoiced !== null && notInvoiced > 0)
    facts.push({ key: 'notInvoiced', label: word('cm.balance.notInvoiced'), value: word('cm.balance.ordersDoor', { params: { count: notInvoiced } }), href: workOpenOrdersHref(prefix, input.party.id) })
  return {
    reading,
    answer,
    blocks: withCount,
    needs,
    calm: reading || needs.length > 0 ? null : ordered === 0 ? word('cm.balance.calmNew', { params: { customer: input.party.name } }) : word('cm.balance.calm'),
    facts,
  }
}

const NO_FIGURES: CurrencyFigures = { currency: '', openInvoices: 0, open: null, late: null, lateInvoices: 0, oldestDays: 0, buckets: null, requests: 0, deposits: null, requestsLate: 0, lateSince: null, onAccount: false, onAccountAmount: null, toGiveBack: 0, giveBack: null }

/** The last payment's day: the newest of the ageing rows' (it exists while something is open; cm-w2 adds the payments read). */
export function lastPaymentOf(rows: readonly AgeingRow[] | null): string | null {
  return (rows ?? []).reduce<string | null>((newest, row) => (row.lastPaymentOn && (newest === null || row.lastPaymentOn > newest) ? row.lastPaymentOn : newest), null)
}

// ---- the page-level reads as Parts, and the tab's count ----------------------------------------------------------------

/** The page's money reads (useCustomerMoney) as the tab's Parts: null without the right, the problem as an `orders` key. */
export function pagePartsOf(money: CustomerMoneyModel | null): { readonly ageing: Part<readonly AgeingRow[]> | null; readonly ageingElsewhere: Part<readonly AgeingRow[]> | null; readonly openItems: Part<OpenItemsRead> | null } {
  const fromLoaded = (loaded: Loaded<AgeingRow> | undefined): Part<readonly AgeingRow[]> => (!loaded ? READING : loaded.problem ? { value: null, problem: orderProblemOf(loaded.problem) } : loaded.items ? partReady(loaded.items) : READING)
  if (!money) return { ageing: null, ageingElsewhere: null, openItems: null }
  const items = money.openItems ?? null
  return {
    ageing: money.can.receivables ? fromLoaded(money.ageing) : null,
    ageingElsewhere: money.can.receivables && money.ageingElsewhere ? fromLoaded(money.ageingElsewhere) : null,
    openItems: money.can.payments && items ? (items.problem ? { value: null, problem: orderProblemOf(items.problem) } : items) : null,
  }
}

/**
 * The tab's count (Z11): late invoices (the ageing's S7 count, else the open items' due days) + late deposit requests (open items).
 * null while read · undefined when nothing is late or nothing can be counted (never a "0" chip).
 */
export function moneyBadgeOf(input: { readonly can: Pick<MoneyTabCan, 'receivables' | 'payments' | 'price'>; readonly today: string; readonly ageing: Part<readonly AgeingRow[]> | null; readonly openItems: Part<OpenItemsRead> | null; readonly currency: string | null }): number | null | undefined {
  if (isReading(input.ageing) || isReading(input.openItems)) return null
  const figures = figuresOf({
    party: { id: '', name: '', currency: input.currency, paymentTerms: null },
    company: null,
    companies: 1,
    can: { ...BADGE_CAN, receivables: input.can.receivables, payments: input.can.payments, price: input.can.price },
    today: input.today,
    ageing: input.ageing,
    ageingElsewhere: null,
    openItems: input.openItems,
    refunds: null,
    stops: null,
    reminders: null,
    summary: null,
    shipped: null,
    glance: null,
    openOrders: null,
    priceDiffer: null,
  })
  const count = sumOf(figures.map((entry) => (entry.lateInvoices ?? 0) + entry.requestsLate))
  return count > 0 ? count : undefined
}

const BADGE_CAN: MoneyTabCan = { price: false, margin: false, receivables: false, payments: false, paymentsRecord: false, paymentsRefund: false, paymentsVoid: false, invoices: false, invoicesManage: false, invoicesIssue: false, orders: false, moneyPlan: false, waive: false, credit: false, creditLimits: false, remindersManage: false, statementsSend: false, hold: false, door: { recordPayment: false, price: false, moneyPlan: false, waive: false }, costing: false, cost: false }
