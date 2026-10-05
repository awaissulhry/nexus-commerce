'use client'

/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P8 — the channel sheet's **Status** column, THE one
 * control for "is it on this market" (simplify, Owner 2026-10-04): the selling state of each listing on this
 * destination (Active · Inactive · Ended — Ended only on eBay and Shopify; Mixed on a main product whose variations
 * differ), and the state a row WAITS to reach until Publish ("Inactive · now Active").
 *
 * A SYSTEM column like "Last publish" (`publishColumn.tsx`): built here, never by the channel column builder, never a
 * write field of the sheet's writer. It rides `managedBy: 'progress'` (listed in Customise, not counted, kept by a
 * narrowing filter) and sits in the "Publish" group right after "Last publish". Not pinned.
 *
 * The cell and the editor are the design system's (`SellingStatusCell`, `SelectPanelEditor` + `statusEditorOptions`):
 * only the targets the row can reach are offered, refused ones stay in the list, held, with the server's reason; the
 * FBA warning is the option's note. A change is STAGED, not saved here: `onInput` hands it to the sheet's operation
 * fence (`PublishActionFence`), which sends one write per column and value when the edit, fill or paste ends. The
 * column's `valueSetter` never writes the row — the value lives in `usePublishActions` — so AG reports no change and
 * the sheet's own writer and undo never see these cells. Delete / Backspace on a cell resets it to "no change" (the
 * sheet's key handler; AG's own clear is kept off with `suppressKeyboardEvent`).
 *
 * New listings (Owner 2026-10-04): a row not on the channel yet (`cell.create` — a Draft, or a family member with no
 * listing here, whose cell has a `new:` id) is never locked: it shows what Publish creates it as — Active, Inactive — or
 * Not listed (Publish leaves it out), with a small "new" mark; a choice made on the row waits with a clock, one taken
 * from the main product or the default has none. Its editor offers Active · Inactive · Not listed with what each does
 * and the channel's refusals (eBay Inactive needs the out-of-stock option; "checked when sending" when not read yet).
 * The first choice on a row with no listing starts the family's drafts on this sheet's account (the server's
 * `started`). "Not listed" pastes.
 *
 * Delete and relist (simplify, Owner 2026-10-04): a row Nexus deleted from the channel is such a row: it reads **Not
 * listed** with "deleted 4 Oct" beside it (the tooltip: "Deleted on Amazon · IT on 4 Oct. To list it again, set Status
 * to Active and Publish."), its default is Not listed, and Active or Inactive lists it again on the next Publish; after
 * the relist it reads Active by itself.
 */
import { parseSendMode, parseStatusTarget, type PublishActionCell } from '@nexus/shared/publish-actions'
import { deletedOn, type StatusTarget } from '@nexus/shared/listing-actions'
import {
  SelectPanelEditor, SellingStatusCell, composeCellTooltip, newListingEditorOptions, roundTripClassRules, saveNote, sellingStatusModel, statusEditorOptions,
  SELLING_STATE_WORD, STATUS_TARGET_WORD,
  type CellSaveTracker, type ColDef, type SellingStatusValue, type SelectPanelOption,
} from '@/design-system/grid'
import { isClearKey } from '../sheetReset'
import type { PublishCellInput } from '../usePublishActions'

export const STATUS_COLUMN = 'publish:status'
export const STATUS_COLUMN_LABEL = 'Status'
/** "[clock Inactive] now Not listed" / "[Not listed] deleted 24 Oct" — the widest content, plus padding. */
export const STATUS_COLUMN_WIDTH = 200
export const STATUS_COLUMN_TIP = 'Is it on this channel and market: Active, Inactive, or Ended (eBay, Shopify). Change it here (Enter on a cell, or Action ▾ for the ticked rows); Publish sends the change. A row not on the channel ("new", or deleted) chooses what Publish does: Active or Inactive creates it, Not listed leaves it out. A choice a channel cannot take is held, with the reason.'

export const ENDED_NEEDS_DELETE = 'Your role cannot end or delete listings.'
export const STATUS_READ_FAILED = 'The selling state could not be read. Reload the sheet to try again.'
export const STATUS_NOT_LISTED = 'Not on this channel and market yet. Publish creates it.'

/** The column as a member of the sheet's column model (Customise, saved views). Never a write field. */
export function statusSheetColumn<T>(): T {
  return {
    key: STATUS_COLUMN, writeField: '', label: STATUS_COLUMN_LABEL, group: 'Publish', groupKey: 'publish', kind: 'text',
    storage: 'column', scope: 'global', requiredBy: [], editable: false, formulaWritable: false, width: STATUS_COLUMN_WIDTH,
    defaultVisible: true, managedBy: 'progress', helpText: STATUS_COLUMN_TIP,
  } as unknown as T
}

export interface PublishCellReadState {
  /** The first read has answered (or failed). Before it, the cell shows a skeleton — never a guessed state. */
  loaded: boolean
  /** The read failed and nothing was ever read. */
  failed: boolean
  /** The viewer may not change it at all (plain English), or null. */
  lockedReason: string | null
}

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

/** One Status cell's facts from the row's stored (and optimistic) values. */
export function statusCellValue(cell: PublishActionCell | null | undefined, read: PublishCellReadState): SellingStatusValue | undefined {
  if (!read.loaded) return undefined
  if (!cell) return read.failed ? { state: 'unknown', lockedReason: STATUS_READ_FAILED } : { state: 'not_listed', reason: STATUS_NOT_LISTED }
  // A row not on the channel (new, or deleted by Nexus): what Publish creates it as (or that it leaves it out), never
  // locked by its state.
  if (cell.create) return { state: cell.state, create: newListingFacts({ ...cell, create: cell.create }), lockedReason: read.lockedReason,
    waiting: cell.status.target && cell.create.source === 'own' ? { target: cell.status.target, setAt: cell.status.setAt, setByName: cell.status.setByName } : null }
  const outgrown = cell.status.target && cell.status.noLongerApplies
    ? `The waiting change to ${STATUS_TARGET_WORD[cell.status.target]} no longer applies: ${sentence(cell.status.noLongerApplies)} Publish skips it`
    : null
  return {
    state: cell.state,
    reason: [cell.stateReason, outgrown].filter(Boolean).map(s => sentence(s!)).join(' ') || null,
    waiting: cell.status.target ? { target: cell.status.target, setAt: cell.status.setAt, setByName: cell.status.setByName } : null,
    lockedReason: read.lockedReason,
  }
}

/**
 * A removed row's mark facts: when ("4 Oct"), and whether Nexus UNLINKED it (Item ID control, 2026-10-05) rather than
 * deleted it — an unlinked row reads "unlinked 5 Oct" and is never listed as new (the listing may still be live there).
 */
export const removedFacts = (deleted: PublishActionCell['deleted']) =>
  deleted ? { on: deletedOn(deleted.at), ...(deleted.unlinked ? { unlinked: true } : {}) } : null

/** A new row's Status facts for the cell: its choice, the sentence, and the check Publish makes again (eBay). */
export function newListingFacts(cell: PublishActionCell & { create: NonNullable<PublishActionCell['create']> }): NonNullable<SellingStatusValue['create']> {
  const option = cell.statusOptions.find(o => o.target === cell.create.target)
  const outgrown = cell.status.target && cell.status.noLongerApplies ? `This choice no longer applies: ${sentence(cell.status.noLongerApplies)}` : null
  const note = [outgrown, option?.checkedAtSend ?? null].filter(Boolean).join(' ') || null
  return { target: cell.create.target, source: cell.create.source, sentence: cell.create.sentence, note,
    deleted: removedFacts(cell.deleted) }
}

/** The Status the editor opens on: a new row's choice, the waiting target, else the live state's own target (none for Draft, Mixed …). */
export function currentStatusTarget(cell: PublishActionCell | null | undefined): StatusTarget | null {
  if (!cell) return null
  if (cell.create) return cell.create.target
  if (cell.status.target) return cell.status.target
  return cell.state === 'active' ? 'active' : cell.state === 'paused' ? 'inactive' : cell.state === 'ended' ? 'ended' : null
}

/** The editor's options: the server's choices; Ended held without `products.delete` (the server refuses it too). */
export function statusEditorChoices(cell: PublishActionCell, canDelete: boolean): SelectPanelOption[] {
  // A new row: Active · Inactive · Not listed, each with what Publish does; the current choice says where it comes from.
  if (cell.create) return newListingEditorOptions(cell.statusOptions, { ...cell.create, deleted: removedFacts(cell.deleted) },
    cell.create.source === 'own' ? cell.status : null)
  const choices = cell.statusOptions.map(option => option.target === 'ended' && option.offered && option.action && !canDelete
    ? { ...option, offered: false, reason: ENDED_NEEDS_DELETE } : option)
  return statusEditorOptions(choices, cell.state, cell.status.target ? { target: cell.status.target, setAt: cell.status.setAt, setByName: cell.status.setByName } : null)
}

const capital = (text: string) => { const t = text.trim(); return t ? `${t[0].toUpperCase()}${t.slice(1)}` : t }
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'

/**
 * What a Status cell received — from its editor ('inactive'), a paste ("Pause", "paused", "End"), a fill (another
 * Status cell's value) or Delete (null: no change) — as a change, or the reason it is not one.
 */
export function parseStatusInput(raw: unknown): PublishCellInput {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return { change: { column: 'status', target: null } }
  if (isObject(raw)) {
    if (typeof raw.state === 'string') {
      // Filled from a Status cell: its waiting target, else the state it shows.
      const value = raw as unknown as SellingStatusValue
      // From a new row: its choice (Active, Inactive, Not listed).
      const target = value.create?.target ?? value.waiting?.target ?? (value.state === 'active' ? 'active' : value.state === 'paused' ? 'inactive' : value.state === 'ended' ? 'ended' : null)
      return target ? { change: { column: 'status', target } } : { refused: `${SELLING_STATE_WORD[value.state] ?? 'This'} is not a Status you can set. Choose Active, Inactive or Ended` }
    }
    if (typeof raw.mode === 'string') return { refused: 'An Action is not a Status: use the Action column' }
    return { refused: 'Not a Status. Choose Active, Inactive or Ended' }
  }
  const text = String(raw)
  const target = parseStatusTarget(text)
  if (target) return { change: { column: 'status', target } }
  if (parseSendMode(text)) return { refused: `${capital(text)} is an Action: use the Action column` }
  return { refused: `"${text.trim()}" is not a Status. Choose Active, Inactive or Ended` }
}

/** The cell's text for copy, export and search: the waiting target, else the live state. */
export function statusCellText(value: SellingStatusValue | undefined): string {
  if (!value) return ''
  if (value.create) return STATUS_TARGET_WORD[value.create.target]
  return value.waiting ? STATUS_TARGET_WORD[value.waiting.target] : SELLING_STATE_WORD[value.state] ?? ''
}

export const samePublishCellValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export interface PublishColumnInput<Row> {
  /** Read when a cell asks — through refs, so a new read repaints cells without rebuilding the column. */
  cell: (row: Row) => PublishActionCell | null
  read: () => PublishCellReadState
  /** The cell received a value (editor, fill, paste): stage it in the sheet's operation fence. */
  onInput: (row: Row, input: PublishCellInput) => void
  /** May the viewer end or delete listings (`products.delete`)? */
  canDelete: () => boolean
  /** The column's own save marks (saving, refused with the reason). */
  tracker: CellSaveTracker
  rowIdOf: (row: Row) => string
}

export function statusColumn<Row>(input: PublishColumnInput<Row>): ColDef<Row> {
  const valueOf = (row: Row) => statusCellValue(input.cell(row), input.read())
  return {
    colId: STATUS_COLUMN,
    headerName: STATUS_COLUMN_LABEL,
    headerTooltip: STATUS_COLUMN_TIP,
    width: STATUS_COLUMN_WIDTH,
    minWidth: 160,
    sortable: false,
    cellClass: 'nds-ag-cell',
    cellClassRules: roundTripClassRules<Row>(input.tracker, input.rowIdOf),
    valueGetter: p => (p.data ? valueOf(p.data) : undefined),
    equals: samePublishCellValue,
    valueFormatter: p => statusCellText(p.value as SellingStatusValue | undefined),
    // Never writes the row: the value is staged and sent by the sheet (see the file header).
    valueSetter: p => { if (p.data) input.onInput(p.data, parseStatusInput(p.newValue)); return false },
    editable: p => !!p.data && sellingStatusModel(valueOf(p.data)).editable,
    cellEditor: SelectPanelEditor,
    cellEditorPopup: true,
    cellEditorPopupPosition: 'under',
    // The cell's value is an object: the editor opens on the target it stands for.
    cellEditorParams: (p: { data?: Row }) => {
      const cell = p.data ? input.cell(p.data) : null
      return { value: currentStatusTarget(cell), options: cell ? statusEditorChoices(cell, input.canDelete()) : [] }
    },
    cellRenderer: SellingStatusCell,
    tooltipValueGetter: p => composeCellTooltip(
      saveNote(p.data ? input.tracker.get(input.rowIdOf(p.data), STATUS_COLUMN) : undefined),
      sellingStatusModel(p.value as SellingStatusValue | undefined).tooltip,
    ),
    // Delete / Backspace reset the cell through the sheet (one write), never AG's clear.
    suppressKeyboardEvent: p => isClearKey(p.event, p.editing),
  }
}
