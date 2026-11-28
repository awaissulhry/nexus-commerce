import { actionKeyOf } from '../../../../../lib/change-log/model'
import type { OrderLogAction } from '@nexus/factory-domain/sales/order-log/faces'

/**
 * owb-of6 step 2 (design plan § 5l "What changed": chips All · Asks · Lines · Dates · Design · Status) — which chip a row of the ONE
 * order log belongs to, by its action (the base's allow-list keys, D/sales/order-log/faces). A kind no chip names (people, other)
 * shows under All only. Pure.
 */
export const LOG_CHIPS = ['all', 'asks', 'lines', 'dates', 'design', 'status'] as const
export type LogChip = (typeof LOG_CHIPS)[number]

const CHIP_OF: Readonly<Partial<Record<OrderLogAction, Exclude<LogChip, 'all'>>>> = Object.freeze({
  CHANGE_ACCEPTED: 'asks',
  DRAFT_CHANGED: 'lines',
  LINES_ADDED: 'lines',
  LINE_CHANGED: 'lines',
  LINE_TAKEN_OUT: 'lines',
  PRICES_TAKEN: 'lines',
  PROMISE_MOVED: 'dates',
  DELIVER_TO: 'dates',
  FILE_ADDED: 'design',
  ARTWORK_SHARED: 'design',
  PICTURE_SET: 'design',
  DRAFT_STARTED: 'status',
  SENT: 'status',
  TAKEN_BACK: 'status',
  WITHDRAWN: 'status',
  REFUSED: 'status',
  CONFIRMED: 'status',
  READY: 'status',
  CANCELLED: 'status',
  CLOSED: 'status',
  SHIPPED: 'status',
  AT_OUR_WAREHOUSE: 'status',
  LABEL_RECEIVED: 'status',
  SENT_ON: 'status',
  DELIVERED: 'status',
})

/** The chip of one log row (an audit action or the log's own key); null: All only. */
export const logChipOf = (action: string): Exclude<LogChip, 'all'> | null => CHIP_OF[actionKeyOf(action)] ?? null

/** The rows a chip shows (All: every row). */
export function rowsOfChip<T extends { readonly action: string }>(rows: readonly T[], chip: LogChip): readonly T[] {
  return chip === 'all' ? rows : rows.filter((row) => logChipOf(row.action) === chip)
}

/** Each chip's count over the rows read so far. */
export function logChipCounts(rows: readonly { readonly action: string }[]): Record<LogChip, number> {
  const counts = Object.fromEntries(LOG_CHIPS.map((chip) => [chip, 0])) as Record<LogChip, number>
  counts.all = rows.length
  for (const row of rows) {
    const chip = logChipOf(row.action)
    if (chip) counts[chip] += 1
  }
  return counts
}
