'use client'

/**
 * Sheet publish parity, step 3 (item 2) — the channel sheet's "Last publish" column: what became of each row's last
 * publish to THIS sheet's destination (channel · market · account · listing), in the old flat file's place of a row
 * that turned green or red.
 *
 * Every fact is the server's (`GET …/studio/publication-status`, read by `usePublicationStatus`); nothing here infers
 * a result. The cell and its card are the design system's (`PublishStatusCell`); this module only shapes the read
 * into the cell's contract (`PublishStatusValue`) and names the sheet columns the channel's problems belong to.
 *
 * A SYSTEM column, like the progress column: built here, never by the channel column builder, never a write field.
 * It rides the sheet's `managedBy: 'progress'` marker — the shared column hook (`useSheetColumns`) reads that marker as
 * "a column the sheet builds itself": listed in Customise but not counted, kept by a narrowing filter, shown on a saved
 * layout that predates it. Its Customise group is its own ("Publish").
 */
import type { StudioPublicationStatus, StudioRowLastPublish, StudioRowPublicationStatus } from '@nexus/shared/studio-publication'
import { CREATE_FIELD, PublishStatusCell, cellDetailKeys, publishCellModel, type ColDef, type ICellRendererParams, type PublishIssue, type PublishStatusCellParams, type PublishStatusValue } from '@/design-system/grid'
import { offerDraftEditedSince } from './offerDrafts'

export const PUBLISH_COLUMN = 'publish:scope'
export const PUBLISH_COLUMN_LABEL = 'Last publish'
/** The widest content measured in review (2026-10-02): "Result unknown" + a time + "Edited" = 157 px, plus padding. */
export const PUBLISH_COLUMN_WIDTH = 168
export const PUBLISH_COLUMN_TIP = 'What became of each row’s last publish to this sheet’s channel, market and listing. Hover, click or press Enter on a cell for what was sent, what the channel answered and the fields it refused.'

/** The read as the sheet holds it: the last good answer, and whether the newest attempt failed. */
export interface PublishRead {
  /** `idle` — no destination to read yet (no account, or the listing is still resolving). */
  state: 'idle' | 'loading' | 'ready' | 'error'
  status: StudioPublicationStatus | null
}

/** A row on another listing of the same channel · market: its results live on that listing's view. */
export interface OtherListingValue { otherListing: true; destinationLabel: string }
export type PublishCellValue = PublishStatusValue | OtherListingValue | undefined

/**
 * The row identity this column reads. `isParent` = the family's main row, which also carries the family's total. `values`
 * = the row's cells: an Amazon offer change saved after the last publish makes the cell say "Edited" (D4=B).
 */
export interface PublishRowLike { id: string; aliasId: string | null; listing: { id: string } | null; isParent?: boolean; values?: Readonly<Record<string, unknown>> }

/** A sheet column as the channel tells this sheet about it (`SheetColumn.channels[<scope label>]`). */
export interface PublishColumnFacts {
  key: string
  label: string
  slot?: { index: number } | null
  channels?: Record<string, { key: string; attribute: string } | undefined>
}

export interface SheetColumnRef { key: string; label: string }
export type ColumnLookup = (name: string) => SheetColumnRef | null

/**
 * The sheet column a channel's attribute name belongs to: the channel's own key first (`item_name`, `aspect_Brand`),
 * then its top-level attribute (`closure` for `closure__type`), then a column's own key; exact before case-insensitive.
 * A list attribute shown as slot columns lands on its FIRST slot. An attribute with no column here is `null` —
 * the card then names it but offers no "Go to field".
 */
export function publishColumnLookup(columns: readonly PublishColumnFacts[], scopeLabel: string): ColumnLookup {
  const exact = new Map<string, SheetColumnRef>()
  const loose = new Map<string, SheetColumnRef>()
  const add = (name: string | undefined, ref: SheetColumnRef) => {
    if (!name) return
    if (!exact.has(name)) exact.set(name, ref)
    const lower = name.toLowerCase()
    if (!loose.has(lower)) loose.set(lower, ref)
  }
  // Slot 1 before slot 2 … so a list attribute lands on its first slot whatever order the server sent.
  const ordered = [...columns].sort((a, b) => (a.slot?.index ?? 0) - (b.slot?.index ?? 0))
  for (const pass of ['key', 'attribute', 'column'] as const) {
    for (const column of ordered) {
      const ref = { key: column.key, label: column.label }
      const facts = column.channels?.[scopeLabel]
      if (pass === 'key') add(facts?.key, ref)
      else if (pass === 'attribute') add(facts?.attribute, ref)
      else add(column.key, ref)
    }
  }
  const find = (name: string) => exact.get(name) ?? loose.get(name.toLowerCase()) ?? null
  return name => find(name) ?? (fieldBase(name) !== name ? find(fieldBase(name)) : null)
}

/**
 * A publish journal's field name without its language suffix: Amazon names a text field per market and language,
 * `item_name:["<marketplace id>","it_IT"]` (`amazonContentField`); the sheet's column is the attribute itself.
 */
export const fieldBase = (name: string): string => name.replace(/:\[.*\]$/, '')

/**
 * The server's status row for a sheet row: by the row's listing on this destination, else — a row with no listing
 * here, such as a draft not yet made — by its product, when exactly one status row names that product.
 */
export function statusRowFor(row: PublishRowLike, rows: readonly StudioRowPublicationStatus[]): StudioRowPublicationStatus | null {
  if (row.listing) {
    const byListing = rows.find(r => r.listingId === row.listing!.id)
    if (byListing) return byListing
  }
  const byProduct = rows.filter(r => r.productId === row.id)
  return byProduct.length === 1 ? byProduct[0] : null
}

/** The channel's issues for this row, each with the sheet column it belongs to when the sheet has one. */
export function publishIssues(last: StudioRowLastPublish, lookup: ColumnLookup): PublishIssue[] {
  return last.issues.map(issue => {
    const column = issue.attributeNames.map(lookup).find((ref): ref is SheetColumnRef => ref !== null) ?? null
    return {
      code: issue.code || null,
      severity: issue.severity,
      message: issue.message,
      fieldLabel: column?.label ?? (issue.attributeNames[0] || null),
      columnKey: column?.key ?? null,
    }
  })
}

/** The fields a publish carried, in the sheet's own words where it has them. `$create` stays: the card says it. */
export function sentFieldLabels(fields: readonly string[], lookup: ColumnLookup): string[] {
  if (fields.includes(CREATE_FIELD)) return [CREATE_FIELD]
  return [...new Set(fields.map(field => lookup(field)?.label ?? fieldBase(field)))]
}

/**
 * The word a ROW shows: its own result when the channel gave one, else the publication's. A row Amazon accepted
 * inside a publish that partly failed reads "Accepted", not "Partly failed" — each row tells its own truth, as the old
 * flat file's rows did. The publication's word stays on the toolbar mark and in the history.
 */
export function rowStatus(last: Pick<StudioRowLastPublish, 'status' | 'outcome'>): string {
  return last.outcome === 'ACCEPTED' || last.outcome === 'VERIFIED' || last.outcome === 'FAILED' ? last.outcome : last.status
}

/** A row its publish failed for — by its own result, else (no per-row result) the publication's. */
const rowFailed = (last: Pick<StudioRowLastPublish, 'status' | 'outcome'>) =>
  last.outcome === 'FAILED' || (last.outcome == null && last.status === 'FAILED')

/**
 * How the family fared in one publish on this destination: the rows that publish carried, and how many of them failed.
 * The read covers the destination's listing only, so this is the family as this sheet's listing sent it.
 */
export function familyCounts(rows: readonly StudioRowPublicationStatus[], publicationId: string): { total: number; failed: number } {
  let total = 0
  let failed = 0
  for (const r of rows) {
    if (r.last?.publicationId !== publicationId) continue
    total += 1
    if (rowFailed(r.last)) failed += 1
  }
  return { total, failed }
}

/**
 * One row's cell value. `undefined` = the first read has not answered (the cell shows a skeleton, never a dash that
 * would claim "never published"). A row that belongs to a different listing than the one read is said so.
 *
 * The family's MAIN row (review 2026-10-02) shows the publication's word and the family's total — "2 of 11 failed" —
 * not its own "Accepted": a collapsed family must not hide the sizes that failed under it. Its own result stays in the
 * card ("This row: Accepted").
 */
export function rowPublishValue(row: PublishRowLike, read: PublishRead, lookup: ColumnLookup, destinationLabel: string): PublishCellValue {
  const status = read.status
  if (!status) {
    if (read.state === 'idle') return { destinationLabel, last: null }
    if (read.state === 'error') return { destinationLabel, last: null, readError: 'Publish results could not be read.' }
    return undefined
  }
  if ((row.aliasId ?? '') !== status.destination.aliasKey) return { otherListing: true, destinationLabel }
  const found = statusRowFor(row, status.rows)
  const last = found?.last ?? null
  if (!last) return { destinationLabel, last: null }
  // A row inside a publication still on its way carries that publication as its last: its status IS the in-flight
  // one, so the card's "a newer publish is in progress" note (for a row whose last is OLDER) is never needed here.
  const family = row.isParent ? familyCounts(status.rows, last.publicationId) : null
  return {
    destinationLabel,
    ...(family && family.total > 1 ? { family } : {}),
    ...(offerDraftEditedSince({ rowId: row.id, values: row.values }, last.at) ? { editedSince: true } : {}),
    last: {
      publicationId: last.publicationId,
      status: family && family.total > 1 ? last.status : rowStatus(last),
      outcome: last.outcome,
      at: last.at,
      userName: last.userName,
      message: last.message,
      reference: last.reference,
      sentFields: sentFieldLabels(last.sentFields, lookup),
      issues: publishIssues(last, lookup),
    },
  }
}

/**
 * A row the channel rejected in the destination's LATEST publish: its own result failed, or the whole publication
 * failed and no per-row result says otherwise. What the toolbar's "N rejected" filter shows.
 */
export function isRejectedRow(row: PublishRowLike, status: StudioPublicationStatus | null): boolean {
  const latest = status?.latest
  if (!status || !latest || (latest.status !== 'FAILED' && latest.status !== 'PARTIAL')) return false
  if ((row.aliasId ?? '') !== status.destination.aliasKey) return false
  const last = statusRowFor(row, status.rows)?.last
  if (!last || last.publicationId !== latest.publicationId) return false
  return rowFailed(last)
}

/** How many rows of the latest publish the channel rejected — what the filter will show. */
export function rejectedRowCount(rows: readonly PublishRowLike[], status: StudioPublicationStatus | null): number {
  return rows.reduce((n, row) => n + (isRejectedRow(row, status) ? 1 : 0), 0)
}

/** The cell's text for copy, export and search: "Verified · 1 Oct". */
export function publishCellText(value: PublishCellValue, now: number = Date.now()): string {
  if (!value || 'otherListing' in value) return ''
  const model = publishCellModel(value, now)
  if (model.state !== 'status') return ''
  return model.shortTime ? `${model.meta.label} · ${model.shortTime}` : model.meta.label
}

/** Two values that draw the same cell — a re-read of unchanged facts must not repaint the column. */
export function samePublishValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * A row on another listing: the read covers one listing (the one chosen in the listing menu). Saying "never
 * published" here would be false, so the cell says where its results are instead.
 */
function OtherListingCell(p: ICellRendererParams) {
  const value = p.value as OtherListingValue | undefined
  const where = value ? ` on ${value.destinationLabel}` : ''
  const hint = `This row is on another listing${where}. Choose that listing in the listing menu to see its publish results.`
  return (
    <span className="nds-publish-cell is-other" title={hint}>
      <span aria-hidden="true">Other listing</span>
      <span className="nds-vh">{`Last publish: ${hint}`}</span>
    </span>
  )
}

/** The column as a member of the sheet's column model (Customise, saved views). Never a write field. */
export function publishSheetColumn<T>(): T {
  return {
    key: PUBLISH_COLUMN, writeField: '', label: PUBLISH_COLUMN_LABEL, group: 'Publish', groupKey: 'publish', kind: 'text',
    storage: 'column', scope: 'global', requiredBy: [], editable: false, formulaWritable: false, width: PUBLISH_COLUMN_WIDTH,
    defaultVisible: true, managedBy: 'progress', helpText: PUBLISH_COLUMN_TIP,
  } as unknown as T
}

export function publishColumn<Row>(input: {
  /** Read when a cell asks — through a ref, so a new read refreshes cells without rebuilding the column. */
  value: (row: Row) => PublishCellValue
  cell: PublishStatusCellParams
}): ColDef<Row> {
  return {
    colId: PUBLISH_COLUMN,
    headerName: PUBLISH_COLUMN_LABEL,
    headerTooltip: PUBLISH_COLUMN_TIP,
    width: PUBLISH_COLUMN_WIDTH,
    minWidth: PUBLISH_COLUMN_WIDTH,
    // Not pinned, not locked: it scrolls with the sheet; the header menu pins, moves or hides it like any column.
    sortable: false,
    editable: false,
    cellClass: 'nds-ag-cell nds-cell-is-locked',
    valueGetter: p => (p.data ? input.value(p.data) : undefined),
    equals: samePublishValue,
    valueFormatter: p => (p.data ? publishCellText(p.value as PublishCellValue) : ''),
    // Enter / Space on the cell opens the card; Esc in the card returns here.
    suppressKeyboardEvent: cellDetailKeys,
    cellRendererSelector: p => (p.value && typeof p.value === 'object' && 'otherListing' in p.value
      ? { component: OtherListingCell }
      : { component: PublishStatusCell, params: input.cell }),
  }
}
