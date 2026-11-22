import type { ColDef } from '@nexus/ui/grid'
import type { Locale } from '../../../../lib/i18n/locales'
import { money } from '../../quotes/model'
import type { OrderAbilities } from '../model'
import type { OrderRow, PriceMatch } from '../api'
import type { Phrase } from './sheet/model'

/**
 * F-CP-140 (customer page plan C2d, C3; design 11-money §3.1, §3.5; review F6, G1; the API's B-CP-018) — the ONE column spec of the
 * price check: Our price · Customer's price · Price check · Difference. It drives the Orders sheet (OrdersListView builds the four
 * columns from it, each opt-in in Customise under the group "Price check", none shown by default until the Owner's sheet names its
 * columns), the presets that name them (by these ids) and the file (the export writes the shown columns by id, and the API's
 * `sales.orders` source knows exactly these four ids, each of the price grain).
 *
 * The ids are FIXED (`ourPrice`, `brandPrice`, `priceMatch`, `priceDiff`): the Owner's Google Sheet maps onto them — a rename is one
 * word in orders-sheet.json `col.*`, a new column is one id here + one word + one field of the API's list row.
 *
 * The money wall (Owner O1–O3): without the price grain there is no column at all — no Customise entry, no chip, no export column
 * (priceCheckColumnsFor gives none), and the API leaves the row's fields out anyway (absent, never zero, never "Equal").
 */

export const PRICE_CHECK_IDS = ['ourPrice', 'brandPrice', 'priceMatch', 'priceDiff'] as const
export type PriceCheckId = (typeof PRICE_CHECK_IDS)[number]

export interface PriceCheckColumn {
  readonly id: PriceCheckId
  /** orders-sheet.json: the header and its hint. */
  readonly header: string
  readonly hint: string
  readonly minWidth: number
  readonly flex: number
  /** An amount (right-aligned, in the order's currency). */
  readonly amount: boolean
}

/** The four columns, in the picture's order (ours first, design 11 §3.1). */
export const PRICE_CHECK_COLUMNS: readonly PriceCheckColumn[] = Object.freeze([
  { id: 'ourPrice', header: 'col.ourPrice', hint: 'col.ourPriceHint', minWidth: 104, flex: 0.7, amount: true },
  { id: 'brandPrice', header: 'col.brandPrice', hint: 'col.brandPriceHint', minWidth: 104, flex: 0.7, amount: true },
  { id: 'priceMatch', header: 'col.priceMatch', hint: 'col.priceMatchHint', minWidth: 112, flex: 0.8, amount: false },
  { id: 'priceDiff', header: 'col.priceDiff', hint: 'col.priceDiffHint', minWidth: 100, flex: 0.7, amount: true },
])

/** The Customise group the four sit under (its words: `col.priceMatch` "Price check"). */
export const PRICE_CHECK_GROUP = Object.freeze({ key: 'priceCheck', label: 'col.priceMatch' })

/** The columns a reader gets: the four with the price grain; none without (no column, no Customise entry, no export column). */
export function priceCheckColumnsFor(can: Pick<OrderAbilities, 'price'>): readonly PriceCheckColumn[] {
  return can.price ? PRICE_CHECK_COLUMNS : []
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The sheet's four columns from the spec: opt-in (hidden until Customise or a preset shows them), no header sort (none of them sorts
 * on the server), under the Customise heading "Price check", each its own export id. `s` the orders-sheet words; `cells` each
 * column's cell; `text` its plain words. None without the price grain.
 */
export function priceCheckColDefs(can: Pick<OrderAbilities, 'price'>, s: Translate, cells: Readonly<Record<PriceCheckId, ColDef<OrderRow>['cellRenderer']>>, text: (id: PriceCheckId, row: OrderRow) => string): ColDef<OrderRow>[] {
  return priceCheckColumnsFor(can).map((spec) => ({
    colId: spec.id,
    headerName: s(spec.header),
    headerTooltip: s(spec.hint),
    minWidth: spec.minWidth,
    flex: spec.flex,
    ...(spec.amount ? { type: 'rightAligned' } : {}),
    cellRenderer: cells[spec.id],
    valueGetter: ({ data }: { data?: OrderRow }) => (data ? text(spec.id, data) : ''),
    hide: true,
    sortable: false,
    context: { optIn: true, toolGroup: s(PRICE_CHECK_GROUP.label), toolGroupKey: PRICE_CHECK_GROUP.key },
  }))
}

/** What the Price check cell draws: a DS Tag (neutral = Equal, danger = Not equal with how many lines) or plain words (no customer price yet). */
export type PriceMatchCellModel =
  | { readonly state: 'EQUAL'; readonly tone: 'neutral'; readonly words: Phrase }
  | { readonly state: 'NOT_EQUAL'; readonly tone: 'danger'; readonly words: Phrase; readonly lines: Phrase | null }
  /** Review G1: the DS Tag has no plain tone, so "— No customer price yet" is plain text in the cell, never a Tag, never "Equal". */
  | { readonly state: 'NO_BRAND_PRICE'; readonly words: Phrase }
  /** F-OM-305 (B-OM-020): a "Not equal" accepted by hand — an info Tag "Not equal" and "Accepted by hand" under it (the server's filter leaves it out). */
  | { readonly state: 'ACCEPTED'; readonly tone: 'info'; readonly words: Phrase; readonly accepted: Phrase; readonly lines: Phrase | null }

/** The Price check cell of a row; null: the row carries no check (a reader without the price grain, an older answer). */
export function priceMatchCellOf(row: Pick<OrderRow, 'priceMatch' | 'priceNotEqualLines' | 'priceAccepted'>): PriceMatchCellModel | null {
  const match: PriceMatch | undefined = row.priceMatch
  if (match === 'EQUAL') return { state: 'EQUAL', tone: 'neutral', words: { key: 'priceCheck.EQUAL' } }
  if (match === 'NOT_EQUAL') {
    const count = row.priceNotEqualLines ?? 0
    const lines = count > 0 ? { key: 'priceCheck.lines', params: { count } } : null
    // F-OM-305: one rule with the server (factory-domain sales/brand-prices/accept acceptanceInForce): accepted is not an alarm.
    if (row.priceAccepted === true) return { state: 'ACCEPTED', tone: 'info', words: { key: 'priceCheck.NOT_EQUAL' }, accepted: { key: 'moneyTab.price.tag.accepted' }, lines }
    return { state: 'NOT_EQUAL', tone: 'danger', words: { key: 'priceCheck.NOT_EQUAL' }, lines }
  }
  if (match === 'NO_BRAND_PRICE') return { state: 'NO_BRAND_PRICE', words: { key: 'priceCheck.NO_BRAND_PRICE' } }
  return null
}

/** The Difference of a row: our price − the customer's, its sign in words (+ we ask more, − we ask less, 0 the same); null: unknown. */
export function priceDiffOf(row: Pick<OrderRow, 'priceDiff'>): { readonly sign: 'more' | 'less' | 'same'; readonly minor: number; readonly words: Phrase | null } | null {
  const diff = row.priceDiff
  if (diff === null || diff === undefined) return null
  if (diff > 0) return { sign: 'more', minor: diff, words: { key: 'priceCheck.more' } }
  if (diff < 0) return { sign: 'less', minor: -diff, words: { key: 'priceCheck.less' } }
  return { sign: 'same', minor: 0, words: null }
}

/** A difference as the cell writes it: "+€60.00", "−€10.00" (a true minus sign), "€0.00"; "—" when it is not known. */
export function signedMoney(diff: ReturnType<typeof priceDiffOf>, currency: string, locale: Locale): string {
  if (!diff) return '—'
  const amount = money(diff.minor, currency, locale)
  return diff.sign === 'more' ? `+${amount}` : diff.sign === 'less' ? `−${amount}` : amount
}

/** Each column's words for a row (the cell's plain text: the phone card, a copy, a screen reader). */
export function priceCheckText(id: PriceCheckId, row: OrderRow, t: Translate, locale: Locale): string {
  if (id === 'ourPrice') return row.netAmount === undefined ? '' : money(row.netAmount, row.currency, locale)
  if (id === 'brandPrice') return row.brandPrice === undefined ? '' : money(row.brandPrice, row.currency, locale)
  if (id === 'priceDiff') {
    if (row.priceDiff === undefined) return ''
    const diff = priceDiffOf(row)
    return diff?.words ? `${signedMoney(diff, row.currency, locale)} ${t(diff.words.key)}` : signedMoney(diff, row.currency, locale)
  }
  const cell = priceMatchCellOf(row)
  if (!cell) return ''
  const words = t(cell.words.key, cell.words.params)
  // F-OM-305: "Not equal · Accepted by hand · 1 line".
  if (cell.state === 'ACCEPTED') return [words, t(cell.accepted.key), ...(cell.lines ? [t(cell.lines.key, cell.lines.params)] : [])].join(' · ')
  return cell.state === 'NOT_EQUAL' && cell.lines ? `${words} · ${t(cell.lines.key, cell.lines.params)}` : words
}
