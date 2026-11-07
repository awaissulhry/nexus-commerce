import type { Words } from './status'

/**
 * Production progress for the customer (B-W2b-175, SAL-076; Owner answer C1: "a switch per customer, off by default,
 * showing counts per line and size"; design portal.customer.orders › Status & progress "Production progress": "Per line:
 * Cut · Sewn · Inspected · Packed as bars with counts ('Sewn 32 of 40'); expand a line: progress per size", "Counts
 * refresh live from floor scans, batched to at most once a minute"). Pure: the API reads the counts in the tenant's scope
 * (the floor's records are the office's) only while the customer's PortalSettings.progressShared is on, and never a
 * person: every figure is a sum over the work orders that make the line.
 *
 *   CUT        garments in the work orders' ACTIVE whole-garment bundles (production/scans WIP `bundled`)
 *   SEWN       garments past the sewing operation by the floor's scans (WIP `sewn`; null: the site does not scan there)
 *   INSPECTED  garments quality released, less the releases taken back
 *   PACKED     garments on the order's shipments that were packed, shipped or delivered
 *
 * A garment at a later stage went through the earlier ones, so each stage shows at least what a later one shows (a work
 * order cut in part bundles has no whole-garment bundle: its CUT comes from the later stages). Each count stops at what
 * was ordered of that size (a work order may cut a spare). A made-to-measure unit counts as one size-less piece of its
 * line.
 */

export const PROGRESS_STAGES = ['CUT', 'SEWN', 'INSPECTED', 'PACKED'] as const
export type ProgressStage = (typeof PROGRESS_STAGES)[number]

export const PROGRESS_STAGE_WORDS: Readonly<Record<ProgressStage, Words>> = Object.freeze({
  CUT: { it: 'Tagliati', en: 'Cut' },
  SEWN: { it: 'Cuciti', en: 'Sewn' },
  INSPECTED: { it: 'Controllati', en: 'Inspected' },
  PACKED: { it: 'Imballati', en: 'Packed' },
})

/** How often the counts are read again at most (the API keeps them this long). */
export const PROGRESS_REFRESH_SECONDS = 60

/** Garments of one line and size at each stage, as read (null: no figure for that stage). */
export interface StageCount {
  readonly lineId: string
  /** null: a made-to-measure unit. */
  readonly size: string | null
  readonly cut: number | null
  readonly sewn: number | null
  readonly inspected: number | null
  readonly packed: number | null
}

export interface ProgressLineFacts {
  readonly id: string
  readonly seq: number
  readonly quantity: number
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
}

export interface StageFigures {
  readonly ordered: number
  readonly cut: number | null
  readonly sewn: number | null
  readonly inspected: number | null
  readonly packed: number | null
}

export interface ProgressLineView extends StageFigures {
  readonly lineId: string
  readonly seq: number
  readonly sizes: readonly ({ readonly size: string | null } & StageFigures)[]
}

export interface ProgressView {
  readonly lines: readonly ProgressLineView[]
  /** The whole order. */
  readonly whole: StageFigures
  /** The order's progress in whole percent: the mean of the stages that have a figure, each as a share of what was ordered. */
  readonly percent: number | null
}

const sumOf = (values: readonly (number | null)[]): number | null => (values.every((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0))

/** A later stage implies the earlier ones; nothing above what was ordered. */
function settle(ordered: number, raw: Omit<StageFigures, 'ordered'>): StageFigures {
  const cap = (value: number | null): number | null => (value === null ? null : Math.max(0, Math.min(ordered, value)))
  const packed = cap(raw.packed)
  const inspected = cap(atLeast(raw.inspected, [packed]))
  const sewn = cap(atLeast(raw.sewn, [inspected, packed]))
  const cut = cap(atLeast(raw.cut, [sewn, inspected, packed]))
  return { ordered, cut, sewn, inspected, packed }
}

function atLeast(own: number | null, later: readonly (number | null)[]): number | null {
  const known = later.filter((value): value is number => value !== null && value > 0)
  if (known.length === 0) return own
  return Math.max(own ?? 0, ...known)
}

/** The progress of an order's lines from the counts read per line and size. */
export function progressOf(lines: readonly ProgressLineFacts[], counts: readonly StageCount[]): ProgressView {
  const views = [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line): ProgressLineView => {
      const sized = line.sizes.length > 0
      const entries: { size: string | null; ordered: number }[] = sized ? line.sizes.map((entry) => ({ size: entry.size, ordered: entry.quantity })) : [{ size: null, ordered: line.quantity }]
      const sizes = entries.map((entry) => {
        const mine = counts.filter((count) => count.lineId === line.id && (sized ? count.size === entry.size : true))
        return {
          size: entry.size,
          ...settle(entry.ordered, {
            cut: sumOf(mine.map((count) => count.cut)),
            sewn: sumOf(mine.map((count) => count.sewn)),
            inspected: sumOf(mine.map((count) => count.inspected)),
            packed: sumOf(mine.map((count) => count.packed)),
          }),
        }
      })
      return { lineId: line.id, seq: line.seq, ...totalOf(sizes), sizes }
    })
  const whole = totalOf(views)
  return { lines: views, whole, percent: percentOf(whole) }
}

function totalOf(rows: readonly StageFigures[]): StageFigures {
  return {
    ordered: rows.reduce((sum, row) => sum + row.ordered, 0),
    cut: sumOf(rows.map((row) => row.cut)),
    sewn: sumOf(rows.map((row) => row.sewn)),
    inspected: sumOf(rows.map((row) => row.inspected)),
    packed: sumOf(rows.map((row) => row.packed)),
  }
}

/** Whole percent: the mean share of the stages with a figure (null: nothing ordered or no figure at all). */
export function percentOf(figures: StageFigures): number | null {
  const known = [figures.cut, figures.sewn, figures.inspected, figures.packed].filter((value): value is number => value !== null)
  if (figures.ordered <= 0 || known.length === 0) return null
  return Math.round((known.reduce((sum, value) => sum + value / figures.ordered, 0) / known.length) * 100)
}
