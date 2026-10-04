/**
 * Amazon sheet gaps (D4=B, D7=A) — the channel sheet's Amazon offer changes that wait for Publish. An offer edit on a
 * live listing is saved in Nexus and sent by Publish; the server marks each such cell with `pendingPublish` (saved value,
 * live value, when, its words — `amazon-offer-cells.ts`). Everything here is counted from those cells, never inferred:
 *
 *   - the toolbar mark ("3 changes wait for Publish") and its "Show these rows" filter (the `withRejectedFilter` pattern);
 *   - the ⋯ items: the same filter (a mark folded into "+N" cannot be pressed) and "Discard saved changes…", confirmed,
 *     which leaves through the sheet writer as resets (the bulk save's reset discards a live listing's saved change);
 *   - a waiting cell's words (its "waits for Publish" mark, Cell details, its reset offer) and the Last publish column's "Edited".
 *
 * Mode / Qty / Buffer never wait: they write at once through the Matrix door. Pure: no React, no AG at runtime.
 */
import type { MenuItemDef } from '@/design-system/components'
import type { SheetWriter } from '@/design-system/grid'
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import { publishFullTime } from '@/design-system/grid/renderers/publishStatus'
import type { SheetStatus } from '@/design-system/grid/toolbars/SheetStatus'
import { SHOW_ALL_ACTION, SHOW_REJECTED_ACTION } from '@/app/products/_publication/dialog/outcome'
import { isCellEditable } from './rows'
import type { AmazonOfferPending, StudioCellValue } from './types'

/** The saved change of one cell waiting for Publish (API `AmazonOfferPending`). */
export type OfferPendingPublish = AmazonOfferPending

/** A sheet row as these rules read it. */
export interface OfferDraftRow { rowId: string; sku?: string | null; values?: Readonly<Record<string, unknown>> }

export const OFFER_DRAFT_COPY = {
  mark: (changes: number) => (changes === 1 ? '1 change waits for Publish' : `${changes} changes wait for Publish`),
  markDetail: (changes: number, destination: string) =>
    `Saved in Nexus. ${changes === 1 ? 'It goes' : 'They go'} to ${destination} when you publish; live prices and stock keep syncing until then.`,
  showRows: (rows: number) => `Show the ${rows === 1 ? 'row' : `${rows} rows`} with changes waiting for Publish`,
  showRowsDetail: 'The rows whose offer changes are saved in Nexus and not published yet',
  discard: 'Discard saved changes…',
  discardDetail: (destination: string) => `The cells show the live values again. Nothing is sent to ${destination}.`,
  discardNone: (reason: string) => `No waiting change can be discarded here. ${reason}`,
  confirmTitle: (changes: number) => (changes === 1 ? 'Discard 1 saved change?' : `Discard ${changes} saved changes?`),
  confirmLead: (changes: number, rows: number, destination: string) =>
    `${changes === 1 ? 'The saved value goes' : 'The saved values go'} and ${rows === 1 ? 'the row shows' : `the ${rows} rows show`} the live values again. Nothing is sent to ${destination}. One save.`,
  heldStay: (held: number, reason: string) => `${held} held ${held === 1 ? 'change stays' : 'changes stay'}: ${reason}`,
  reviewTitle: 'Saved value (before) and the live value it goes back to (after)',
  cellLabel: 'Waits for Publish',
  cellNotSent: 'Saved, not sent',
  cellSaved: 'Saved — sent when you publish',
  cellSavedValue: (value: string) => `Saved value: ${value}`,
  cellLiveValue: (value: string) => `Live until you publish: ${value}`,
  cellWhen: (at: string, by?: string) => `Saved ${at}${by ? ` by ${by}` : ''}`,
  liveChanged: (from: string, to: string) => `Live changed since you saved: ${from} → ${to}. Publish sends your saved value.`,
  reset: (live: string) => `Discard saved change (live: ${live})`,
  resetDetail: (destination: string) => `The saved change goes and the cell shows the live value again. Nothing is sent to ${destination}.`,
} as const

/** The cell's waiting change, or null. */
export function pendingPublishOf(cell: unknown): OfferPendingPublish | null {
  const pending = (cell as { pendingPublish?: unknown } | null | undefined)?.pendingPublish
  return pending && typeof pending === 'object' && typeof (pending as OfferPendingPublish).savedAt === 'string' ? pending as OfferPendingPublish : null
}

/** A value in a sentence: "none", "On" / "Off", a price to the cent, a whole number as it is, the first item of a list. */
export function offerValueText(value: unknown): string {
  if (Array.isArray(value)) return offerValueText(value[0] ?? null)
  if (value === null || value === undefined || value === '') return 'none'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** The D7 line: the server's words, else built from its two values. */
export function liveChangedLine(pending: OfferPendingPublish): string | null {
  const moved = pending.liveChangedSince
  if (!moved) return null
  return moved.note?.trim() || OFFER_DRAFT_COPY.liveChanged(offerValueText(moved.from), offerValueText(moved.to))
}

/** What a waiting cell's mark and Cell details say: the server's sentence, the D7 line, both values, when. */
export function offerDraftCellWords(pending: OfferPendingPublish, now: number = Date.now()): { label: string; description: string; notSent: boolean } {
  const notSent = pending.sent === false
  const parts = [
    pending.note?.trim() || OFFER_DRAFT_COPY.cellSaved,
    liveChangedLine(pending),
    OFFER_DRAFT_COPY.cellSavedValue(offerValueText(pending.value)),
    OFFER_DRAFT_COPY.cellLiveValue(offerValueText(pending.live)),
    OFFER_DRAFT_COPY.cellWhen(publishFullTime(pending.savedAt, now), pending.savedBy?.trim() || undefined),
  ]
  return {
    label: notSent ? OFFER_DRAFT_COPY.cellNotSent : OFFER_DRAFT_COPY.cellLabel,
    description: parts.filter((part): part is string => !!part).map(part => part.trim().replace(/\.+$/, '')).join('. '),
    notSent,
  }
}

/** The reset a waiting cell offers: back to the live value, which it names. */
export function offerDraftResetLabel(pending: OfferPendingPublish): string {
  return OFFER_DRAFT_COPY.reset(offerValueText(pending.live))
}

const waitingKeys = (row: OfferDraftRow): string[] =>
  Object.entries(row.values ?? {}).flatMap(([key, cell]) => (pendingPublishOf(cell) ? [key] : []))

/** Does this row hold an offer change waiting for Publish? */
export const rowHasOfferDraft = (row: OfferDraftRow): boolean => waitingKeys(row).length > 0

/**
 * The Last publish column's "Edited": a waiting change saved AFTER the row's last publish. One saved before it is not
 * "edited since" — that publish did not carry it (failed, not selected, or still waiting for the channel's answer).
 */
export function offerDraftEditedSince(row: OfferDraftRow, lastPublishAt: string | null | undefined): boolean {
  const last = lastPublishAt ? Date.parse(lastPublishAt) : NaN
  if (Number.isNaN(last)) return false
  return Object.values(row.values ?? {}).some(cell => {
    const pending = pendingPublishOf(cell)
    return !!pending && Date.parse(pending.savedAt) > last
  })
}

export interface OfferDraftCounts {
  /** Rows with a waiting change. */
  rows: number
  /** Cells with a waiting change (each of a sale's three columns is a cell). */
  changes: number
  /** Waiting cells this sheet can discard (the rest are held, `held`). */
  discardable: number
  held: number
  /** The first held cell's reason, in the server's words. */
  heldReason: string | null
}

export function offerDraftCounts(rows: readonly OfferDraftRow[]): OfferDraftCounts {
  const counts: OfferDraftCounts = { rows: 0, changes: 0, discardable: 0, held: 0, heldReason: null }
  for (const row of rows) {
    const keys = waitingKeys(row)
    if (!keys.length) continue
    counts.rows += 1
    counts.changes += keys.length
    for (const key of keys) {
      const cell = row.values?.[key] as StudioCellValue | undefined
      if (isCellEditable(cell)) counts.discardable += 1
      else {
        counts.held += 1
        counts.heldReason ??= cell?.writeBlockedReason?.trim() || 'These cells cannot be changed here.'
      }
    }
  }
  return counts
}

/** One cell "Discard saved changes…" resets. */
export interface OfferDraftTarget<Row> { row: Row; rowId: string; colId: string }

/** What "Discard saved changes…" resets, and the question it asks first (the confirm's table: saved → live). */
export function offerDraftDiscard<Row extends OfferDraftRow>(rows: readonly Row[], input: { destination: string; labelOf: (colId: string) => string }):
  { targets: OfferDraftTarget<Row>[]; impact: ActionImpact | null } {
  const targets: OfferDraftTarget<Row>[] = []
  const review: Array<{ label: string; before: string; after: string }> = []
  for (const row of rows) {
    for (const colId of waitingKeys(row)) {
      const cell = row.values?.[colId] as StudioCellValue | undefined
      const pending = pendingPublishOf(cell)
      if (!pending || !isCellEditable(cell)) continue
      targets.push({ row, rowId: row.rowId, colId })
      review.push({ label: `${row.sku ?? row.rowId} · ${input.labelOf(colId)}`, before: offerValueText(pending.value), after: offerValueText(pending.live) })
    }
  }
  if (!targets.length) return { targets, impact: null }
  const counts = offerDraftCounts(rows)
  const discardRows = new Set(targets.map(t => t.rowId)).size
  return {
    targets,
    impact: {
      level: 'confirm',
      title: OFFER_DRAFT_COPY.confirmTitle(targets.length),
      consequences: [
        OFFER_DRAFT_COPY.confirmLead(targets.length, discardRows, input.destination),
        ...(counts.held ? [OFFER_DRAFT_COPY.heldStay(counts.held, counts.heldReason ?? '')] : []),
      ],
      review: { title: OFFER_DRAFT_COPY.reviewTitle, rows: review },
    },
  }
}

/**
 * Every target leaves as a reset, in ONE operation (one save): the bulk save's reset discards the saved change. Each
 * target is read again on the row the sheet holds NOW (`current`): a change that no longer waits (published, discarded
 * elsewhere) is left alone — a reset there is not a discard (a live price would follow its rule again).
 */
export function discardOfferDrafts<Row extends OfferDraftRow>(writer: Pick<SheetWriter<Row>, 'beginOperation' | 'endOperation' | 'set'>,
  targets: readonly OfferDraftTarget<Row>[], current: (rowId: string) => Row | undefined = () => undefined): number {
  const due = targets.flatMap(t => {
    const row = current(t.rowId) ?? t.row
    return pendingPublishOf(row.values?.[t.colId]) ? [{ ...t, row }] : []
  })
  if (!due.length) return 0
  writer.beginOperation()
  try {
    for (const t of due) writer.set(t.rowId, t.colId, null, { row: t.row, intent: 'reset' })
  } finally {
    writer.endOperation()
  }
  return due.length
}

/**
 * The sheet's whole surface for waiting offer changes: the counts, the filter, the toolbar mark and the ⋯ items. The
 * filter is on only while something waits; the mark is the info tone (a waiting change is not a problem).
 */
export function offerDraftControls<Row extends OfferDraftRow>(rows: readonly Row[], input: {
  filterOn: boolean
  toggle: () => void
  /** "Amazon · IT". */
  destination: string
  labelOf: (colId: string) => string
  /** Ask `impact`, then discard `targets` (`discardOfferDrafts`). */
  discard: (impact: ActionImpact, targets: OfferDraftTarget<Row>[]) => void
}) {
  const count = offerDraftCounts(rows)
  const filterOn = input.filterOn && count.changes > 0
  const mark: SheetStatus | null = count.changes > 0 ? {
    tone: 'info',
    label: OFFER_DRAFT_COPY.mark(count.changes),
    detail: OFFER_DRAFT_COPY.markDetail(count.changes, input.destination),
    onSelect: input.toggle,
    actionLabel: filterOn ? SHOW_ALL_ACTION : SHOW_REJECTED_ACTION,
    selected: filterOn,
  } : null
  const menu: MenuItemDef[] = count.changes > 0 ? [
    { id: 'show-offer-drafts', label: filterOn ? SHOW_ALL_ACTION : OFFER_DRAFT_COPY.showRows(count.rows), description: OFFER_DRAFT_COPY.showRowsDetail, onSelect: input.toggle },
    {
      id: 'discard-offer-drafts', label: OFFER_DRAFT_COPY.discard, disabled: count.discardable === 0,
      description: count.discardable ? OFFER_DRAFT_COPY.discardDetail(input.destination) : OFFER_DRAFT_COPY.discardNone(count.heldReason ?? ''),
      onSelect: () => {
        const plan = offerDraftDiscard(rows, input)
        if (plan.impact) input.discard(plan.impact, plan.targets)
      },
    },
  ] : []
  return { count, filterOn, mark, menu, keep: rowHasOfferDraft as (row: Row) => boolean }
}
