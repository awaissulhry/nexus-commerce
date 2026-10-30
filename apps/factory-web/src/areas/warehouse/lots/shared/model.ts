import type { LedgerRow, Uom } from '../../../_shared/stock/api'
import { decimalValue } from '../../../_shared/stock/model'

/**
 * Rules the Hides (SCR-200) and Lots & traceability (SCR-201) pages share, pure: a part's read state, the running balance
 * of a record's moves, a hide's area balance in parts that add up (or say they do not), and the words catalogue they
 * speak (`warehouse-lots`, beside the shared `stock`).
 */

export const LOTS_NAMESPACES = ['stock', 'lists', 'records', 'warehouse-lots'] as const

/** A part a screen reads: loading, there, failed (its words, a key of `stock`), gone, or not this person's. */
export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }
export const LOADING = { status: 'loading' } as const
export const ready = <T>(value: T): Loaded<T> => ({ status: 'ready', value })

/** A part of a record read beside it: its value, or why it is missing (both null: still loading). */
export interface Part<T> {
  value: T | null
  problem: string | null
}
export const PART_LOADING: Part<never> = Object.freeze({ value: null, problem: null })
export const part = <T>(value: T): Part<T> => ({ value, problem: null })

/**
 * The balance after each move of one stock key, newest first: the first row's balance is `closing` (the balance now),
 * each next one is the previous less that move's delta. Without a closing (more than one key) there is none.
 */
export function runningBalances(rows: readonly Pick<LedgerRow, 'id' | 'delta'>[], closing: string | null): Map<string, number> {
  const balances = new Map<string, number>()
  if (closing === null) return balances
  let balance = decimalValue(closing) ?? 0
  for (const row of rows) {
    balances.set(row.id, round(balance))
    balance -= decimalValue(row.delta) ?? 0
  }
  return balances
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000

export interface AreaParts {
  readonly measured: number
  readonly cut: number
  readonly remnant: number
  readonly onHand: number
  /** Measured less what cuts used and what is in stock: at the work order, not cut yet. */
  readonly elsewhere: number
  /** The parts add up to the measured area (they always should; otherwise the page says so). */
  readonly addsUp: boolean
  readonly uom: Uom
}

/**
 * A hide's area in parts (design hd-area, AreaBalanceBar): what cuts used (pieces and waste), what is in stock now (a
 * remnant set aside counts there once it is back), and the rest — issued to a work order, not cut yet. Never below 0.
 */
export function areaParts(area: { measured: string; cut: string; remnant: string; onHand: string; uom: Uom }): AreaParts {
  const measured = decimalValue(area.measured) ?? 0
  const cut = decimalValue(area.cut) ?? 0
  const remnant = decimalValue(area.remnant) ?? 0
  const onHand = decimalValue(area.onHand) ?? 0
  const rest = round(measured - cut - onHand)
  return { measured, cut, remnant, onHand, elsewhere: Math.max(0, rest), addsUp: rest >= -0.0001, uom: area.uom }
}

/** A part's share of the whole, in whole percent (the bar's widths and its words). */
export const share = (value: number, whole: number): number => (whole <= 0 ? 0 : Math.round((value / whole) * 100))

/** The address of a record page with its tab (company-free paths get the caller's prefix). */
export const tabHref = (base: string, tab: string, first: string): string => (tab === first ? base : `${base}?tab=${tab}`)
