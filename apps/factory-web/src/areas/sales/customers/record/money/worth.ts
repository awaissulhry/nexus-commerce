import type { Margins } from '../../../../finance/margins/api'
import type { OrderRow } from '../../../orders/api'
import { word, type MoneyWord } from '../../../orders/record/money/word'
import { customerHref, orderMoneyHref, priceDifferHref } from './doors'
import { isFailed, isReading, type MoneyTabInput, type Part } from './model'
import { readProblem } from '../../../orders/model' // cm-fx2: the orders catalogue's own key of a failed read (its rule, never a literal here)

/**
 * F-CM-303 (customer page › MONEY tab, cm-w3 W3.3; 10-design §5.7, §5.8; 18-lead-settles L13, L14, D1) — sections 7 and 8.
 *
 *   Price check (#price-check; orders.view + the price grain — left out otherwise): the answer from the page's own counts ("Prices differ
 *                 on N orders ›" — Work › Not equal, today's door — "N orders have no customer price yet"); one row per ORDER whose
 *                 prices differ (the first 10): the order (a door to its own Price check), the lines that differ, our amount, the
 *                 customer's, the difference; "Accepted by hand" when accepted. A price is typed, changed or accepted on the order.
 *   Margin & cost (#margin; costing.view + the margin grain — left out otherwise): read when the section is reached, never on a burst
 *                 (it computes every order of the customer): Value · Estimated cost (the cost grain) · Margin %, the orders below the
 *                 floor (a door to Finance › Margins with this customer and the floor chosen), Open in Finance › Margins ›, and one
 *                 honest sentence: never a supplier's total here (D1).
 */

export interface PriceRow {
  readonly id: string
  readonly anchor: string
  readonly number: string
  readonly href: string
  readonly lines: number | null
  readonly ours: number | null
  readonly theirs: number | null
  readonly diff: number | null
  readonly accepted: boolean
  readonly currency: string
}

export interface PriceCheckModel {
  readonly reading: boolean
  readonly problem: string | null
  /** "Prices differ on N orders ›" (its door: Work › Not equal); null: none differ. */
  readonly differ: { readonly count: number; readonly href: string } | null
  /** "N orders have no customer price yet" (its door: Work's open orders). */
  readonly missing: { readonly count: number; readonly href: string } | null
  readonly rows: readonly PriceRow[]
  /** "= No order differs" when the counts say nothing differs. */
  readonly calm: MoneyWord | null
}

/** Price check (pure). Left out (null) without orders.view and the price grain. */
export function priceCheckOf(input: MoneyTabInput, rows: Part<readonly OrderRow[]> | null, prefix: string): PriceCheckModel | null {
  if (!input.can.orders || !input.can.price) return null
  const differ = input.priceDiffer !== null && input.priceDiffer > 0 ? { count: input.priceDiffer, href: priceDifferHref(prefix, input.party.id) } : null
  const missing = typeof input.priceMissing === 'number' && input.priceMissing > 0 ? { count: input.priceMissing, href: `${customerHref(prefix, input.party.id)}?tab=work&rows=all&priceMatch=NO_BRAND_PRICE` } : null
  const read = differ ? rows : null
  const list: PriceRow[] = (read?.value ?? []).map((order) => ({
    id: order.id,
    anchor: `cm-Price-${order.id}`,
    number: order.number,
    href: orderMoneyHref(prefix, order.id, 'price-check'),
    lines: typeof order.priceNotEqualLines === 'number' ? order.priceNotEqualLines : null,
    ours: typeof order.netAmount === 'number' ? order.netAmount : null,
    theirs: typeof order.brandPrice === 'number' ? order.brandPrice : null,
    diff: typeof order.priceDiff === 'number' ? order.priceDiff : null,
    accepted: order.priceAccepted === true,
    currency: order.currency,
  }))
  return {
    reading: !!differ && isReading(read),
    problem: differ && isFailed(read) ? read!.problem : null,
    differ,
    missing,
    rows: list,
    calm: !differ && !missing && input.priceDiffer === 0 ? word('cm.price.calm') : null,
  }
}

export interface MarginModel {
  readonly reading: boolean
  readonly problem: string | null
  readonly answer: readonly MoneyWord[]
  /** Value · Estimated cost (the cost grain) · Margin % — in one currency; null: two currencies (one honest line instead). */
  readonly tiles: { readonly value: number; readonly cost: number | null; readonly pct: string | null; readonly currency: string; readonly danger: boolean } | null
  readonly below: { readonly count: number; readonly href: string } | null
  readonly financeHref: string
  readonly twoCurrencies: boolean
}

/** Margin & cost (pure). Left out (null) without costing.view and the margin grain. */
export function marginOf(input: MoneyTabInput, read: Part<Margins> | null, prefix: string): MarginModel | null {
  if (!input.can.margin || !input.can.costing || !read) return null
  const party = encodeURIComponent(input.party.id)
  const financeHref = `${prefix}/finance/margins?party=${party}`
  if (isReading(read)) return { reading: true, problem: null, answer: [word('cm.margin.reading')], tiles: null, below: null, financeHref, twoCurrencies: false }
  const value = read.value
  if (isFailed(read) || !value) return { reading: false, problem: read.problem ?? readProblem(null), answer: [], tiles: null, below: null, financeHref, twoCurrencies: false }
  // The read names THIS customer (`partyId`): its group is its own; a second currency leaves the one figure out (never added).
  const group = value.byCustomer[0] ?? null
  const currency = value.tiles.currency
  const floor = value.rows.find((row) => row.floor)?.floor?.pct ?? null
  const belowCount = typeof value.tiles.belowFloor === 'number' ? value.tiles.belowFloor : 0
  const pct = group?.marginPct ?? null
  const danger = pct !== null && floor !== null && Number(pct) < Number(floor)
  const answer: MoneyWord[] = []
  if (pct !== null) answer.push(word('cm.margin.now', { pcts: { pct }, params: { count: group?.orders ?? value.tiles.orders } }))
  if (belowCount > 0) answer.push(floor ? word('cm.margin.belowFloor', { params: { count: belowCount }, pcts: { floor } }) : word('cm.margin.below', { params: { count: belowCount } }))
  if (value.tiles.orders === 0) answer.push(word('cm.none.margin'))
  return {
    reading: false,
    problem: null,
    answer,
    tiles: group && currency && typeof group.value === 'number' ? { value: group.value, cost: input.can.cost && typeof group.estimateCost === 'number' ? group.estimateCost : null, pct, currency, danger } : null,
    below: belowCount > 0 ? { count: belowCount, href: `${financeHref}&floor=below` } : null,
    financeHref,
    twoCurrencies: !!group && !currency,
  }
}
