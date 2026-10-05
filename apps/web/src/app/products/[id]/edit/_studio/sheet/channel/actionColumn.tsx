'use client'

/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P8 — the channel sheet's **Action** column (how Publish
 * sends each row: Partial update, the quiet default · Full update · Delete) and the selection bar's **Action ▾** button,
 * which fills either column for the ticked rows.
 *
 * Same contract as the Status column (`statusColumn.tsx`): a system column after Status, the design system's cell and
 * editor (`PublishActionCell`, `SelectPanelEditor` + `sendModeEditorOptions`: Send · Partial update, Full update ·
 * Remove · Delete, refused values held with the reason), every change staged in the sheet's operation fence and sent
 * as one write per column and value. Delete / Backspace resets a cell to Partial update. Pasting a Status word
 * ("pause") here is refused: "Pause is a Status: use the Status column".
 *
 * A row not on the channel (simplify, Owner 2026-10-04: never sent, no listing here, or deleted by Nexus — `cell.create`)
 * reads **Full update**: a create always sends the whole listing. Never locked: its editor opens on Full update and
 * lists Partial update and Delete HELD with the server's reasons ("A new listing is always sent whole.", "Nothing to
 * delete yet. To leave it out, set Status to Not listed.", "Already deleted on Amazon · IT. …"). Full update pasted,
 * filled or chosen there stores nothing; Delete / Backspace leaves it as it is. With Status Not listed, Full update is
 * drawn quiet (Publish leaves it out). Whether such a row goes out is its Status's choice, never the Action's.
 *
 * Nothing in this file sends anything to a channel: Publish does, after its review.
 */
import { ChevronDown } from 'lucide-react'
import { parseSendMode, parseStatusTarget, type PublishActionCell, type PublishActionChange } from '@nexus/shared/publish-actions'
import {
  PublishActionCell as PublishActionCellRenderer, SelectPanelEditor, composeCellTooltip, publishActionModel, roundTripClassRules, saveNote,
  sendModeEditorOptions, SEND_MODE_WORD,
  type ColDef, type PublishActionValue, type SelectPanelOption,
} from '@/design-system/grid'
import { Menu, type MenuItemDef } from '@/design-system/components'
import { isClearKey } from '../sheetReset'
import { SKIP_CELL, type PublishCellInput } from '../usePublishActions'
import { samePublishCellValue, type PublishCellReadState, type PublishColumnInput } from './statusColumn'
import type { ActionMenuEntry } from './channelActions'

export const ACTION_COLUMN = 'publish:action'
export const ACTION_COLUMN_LABEL = 'Action'
/** "[clock Partial update]" plus the lock glyph — the widest content, plus padding. */
export const ACTION_COLUMN_WIDTH = 170
export const ACTION_COLUMN_TIP = 'What Publish sends for each row: Partial update (the default: only the fields you changed), Full update (every field Nexus manages again) or Delete (removes the listing from the channel). A row not on the channel reads Full update: a new listing is always sent whole, and its Status says whether Publish creates it. A choice a channel cannot take is held, with the reason. Nothing is sent until you press Publish.'

export const DELETE_NEEDS_DELETE = 'Your role cannot end or delete listings.'
export const ACTION_NOT_LISTED = 'Not on this channel and market yet: Publish creates it with every field.'

export function actionSheetColumn<T>(): T {
  return {
    key: ACTION_COLUMN, writeField: '', label: ACTION_COLUMN_LABEL, group: 'Publish', groupKey: 'publish', kind: 'text',
    storage: 'column', scope: 'global', requiredBy: [], editable: false, formulaWritable: false, width: ACTION_COLUMN_WIDTH,
    defaultVisible: true, managedBy: 'progress', helpText: ACTION_COLUMN_TIP,
  } as unknown as T
}

/**
 * Partial update's own note on this row, when Publish sends none of its fields (D5, D13): the server's warning on the
 * Partial update option (a product already on Shopify, Etsy), or null.
 */
export const actionPartialNote = (cell: PublishActionCell) => cell.sendOptions.find(option => option.mode === 'partial')?.warning?.trim() || null

/** One Action cell's facts. A row with no listing here is locked: Publish creates it (a Partial update does that). */
export function actionCellValue(cell: PublishActionCell | null | undefined, read: PublishCellReadState): PublishActionValue | undefined {
  if (!read.loaded) return undefined
  if (!cell) return { mode: 'partial', lockedReason: read.failed ? 'The publish action could not be read. Reload the sheet to try again.' : ACTION_NOT_LISTED }
  // A row not on the channel: Full update, sent whole (quiet when its Status leaves it out).
  if (cell.create) return { mode: cell.send.mode === 'delete' ? 'delete' : 'full', newRow: true, leftOut: cell.create.target === 'not_listed',
    deleted: !!cell.deleted, ...(cell.deleted?.unlinked ? { unlinked: true } : {}), setAt: cell.send.setAt, setByName: cell.send.setByName, lockedReason: read.lockedReason }
  const partialNote = actionPartialNote(cell)
  return { mode: cell.send.mode, setAt: cell.send.setAt, setByName: cell.send.setByName, lockedReason: read.lockedReason, ...(partialNote ? { partialNote } : {}) }
}

/** The value the Action editor opens on: the stored mode (a row not on the channel: Full update). */
export const actionEditorValue = (cell: PublishActionCell | null | undefined) => cell?.send.mode ?? 'partial'

export function actionEditorChoices(cell: PublishActionCell, canDelete: boolean): SelectPanelOption[] {
  const choices = cell.sendOptions.map(option => option.mode === 'delete' && option.offered && !canDelete ? { ...option, offered: false, reason: DELETE_NEEDS_DELETE } : option)
  // A row not on the channel: Full update (sent whole), the rest held with the server's reasons. Nothing waits.
  if (cell.create) return sendModeEditorOptions(choices, null, Date.now(), true)
  const by = { mode: cell.send.mode, setAt: cell.send.setAt, setByName: cell.send.setByName }
  return sendModeEditorOptions(choices, cell.send.mode !== 'partial' ? by : null)
}

const capital = (text: string) => { const t = text.trim(); return t ? `${t[0].toUpperCase()}${t.slice(1)}` : t }

/**
 * What an Action cell received — editor, paste, fill (another Action cell's value) or Delete (null: Partial update).
 * `target` is the row's own cell: a row not on the channel reads Full update whatever it receives — an empty value and
 * Full update leave it as it is (Partial update and Delete are refused there by the server, with the reason).
 */
export function parseSendInput(raw: unknown, target?: PublishActionCell | null): PublishCellInput {
  const newRow = !!target?.create
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return newRow ? SKIP_CELL : { change: { column: 'send', mode: 'partial' } }
  if (raw && typeof raw === 'object') {
    const value = raw as Record<string, unknown>
    if (typeof value.mode === 'string' && value.mode in SEND_MODE_WORD) {
      const mode = value.mode as PublishActionValue['mode']
      // Filled onto a row not on the channel from another cell: Full update is what it reads already.
      if (newRow && mode === 'full') return SKIP_CELL
      // Filled FROM a row not on the channel (its Full update is no value someone set): nothing to copy.
      if (value.newRow === true) return SKIP_CELL
      return { change: { column: 'send', mode } }
    }
    if (typeof value.state === 'string') return { refused: 'A Status is not an Action: use the Status column' }
    return { refused: 'Not an Action. Choose Partial update, Full update or Delete' }
  }
  const text = String(raw)
  const mode = parseSendMode(text)
  if (mode === 'full' && newRow) return SKIP_CELL
  if (mode) return { change: { column: 'send', mode } }
  if (parseStatusTarget(text)) return { refused: `${capital(text)} is a Status: use the Status column` }
  return { refused: `"${text.trim()}" is not an Action. Choose Partial update, Full update or Delete` }
}

export function actionCellText(value: PublishActionValue | undefined): string {
  if (!value) return ''
  return SEND_MODE_WORD[value.newRow && value.mode !== 'delete' ? 'full' : value.mode] ?? ''
}

export function actionColumn<Row>(input: PublishColumnInput<Row>): ColDef<Row> {
  const valueOf = (row: Row) => actionCellValue(input.cell(row), input.read())
  return {
    colId: ACTION_COLUMN,
    headerName: ACTION_COLUMN_LABEL,
    headerTooltip: ACTION_COLUMN_TIP,
    width: ACTION_COLUMN_WIDTH,
    minWidth: 130,
    sortable: false,
    cellClass: 'nds-ag-cell',
    cellClassRules: roundTripClassRules<Row>(input.tracker, input.rowIdOf),
    valueGetter: p => (p.data ? valueOf(p.data) : undefined),
    equals: samePublishCellValue,
    valueFormatter: p => actionCellText(p.value as PublishActionValue | undefined),
    valueSetter: p => { if (p.data) input.onInput(p.data, parseSendInput(p.newValue, input.cell(p.data))); return false },
    editable: p => !!p.data && publishActionModel(valueOf(p.data)).editable,
    cellEditor: SelectPanelEditor,
    cellEditorPopup: true,
    cellEditorPopupPosition: 'under',
    cellEditorParams: (p: { data?: Row }) => {
      const cell = p.data ? input.cell(p.data) : null
      return { value: actionEditorValue(cell), options: cell ? actionEditorChoices(cell, input.canDelete()) : [] }
    },
    cellRenderer: PublishActionCellRenderer,
    tooltipValueGetter: p => {
      const cell = p.data ? input.cell(p.data) : null
      return composeCellTooltip(
        saveNote(p.data ? input.tracker.get(input.rowIdOf(p.data), ACTION_COLUMN) : undefined),
        publishActionModel(p.value as PublishActionValue | undefined).tooltip,
        cell?.send.mode !== 'partial' && cell?.send.setAt && cell?.send.noLongerApplies ? `No longer applies: ${cell.send.noLongerApplies} Publish skips it.` : null,
      )
    },
    suppressKeyboardEvent: p => isClearKey(p.event, p.editing),
  }
}

// ── The selection bar's Action ▾ ─────────────────────────────────────────────────────────────────

export interface PublishActionMenuProps {
  /** `actionMenuEntries` (channelActions.ts): what each item does to the ticked rows, counted. */
  entries: readonly ActionMenuEntry[]
  selected: number
  onChoose: (change: PublishActionChange) => void
  disabled?: boolean
}

/**
 * "Action ▾": Status (Active, Inactive, Ended, Not listed) · Send as (Partial update, Full update, Delete), each with how many of the
 * ticked rows allow it ("Inactive — 18 of 21") and, when some do not, why. Choosing one only FILLS the cells.
 */
export function PublishActionMenu({ entries, selected, onChoose, disabled }: PublishActionMenuProps) {
  const items: MenuItemDef[] = []
  let group: string | null = null
  for (const entry of entries) {
    if (entry.group !== group) {
      group = entry.group
      items.push({ id: `heading:${group}`, heading: true, label: group })
    }
    items.push({
      id: entry.id, label: entry.label, description: entry.note ?? undefined, disabled: entry.disabled,
      tone: entry.danger && !entry.disabled ? 'danger' : undefined,
      onSelect: entry.disabled ? undefined : () => onChoose(entry.change),
    })
  }
  return (
    <Menu
      label={<>Action <ChevronDown size={11} aria-hidden /></>}
      items={items}
      triggerProps={{
        className: 'nds-btn sm',
        disabled,
        'aria-label': `Action for the ${selected === 1 ? 'ticked row' : `${selected.toLocaleString('en')} ticked rows`}: set Status or how Publish sends them`,
        title: 'Fill the Status or Action of the ticked rows. Nothing is sent until you press Publish.',
      }}
    />
  )
}
