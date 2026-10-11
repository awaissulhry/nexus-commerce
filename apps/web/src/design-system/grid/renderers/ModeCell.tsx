'use client'

/**
 * ModeCell — the cell of `modeColumn` (bid page DS lane, 2026-10-10): a 4-step picker (Off · Watch · Ask me · Auto by
 * default) that only changes a DRAFT.
 *
 * At rest: a small meter (one bar per step above Off), the set step's word, and — only when something holds the row
 * lower than it is set — a held mark whose name says what acts and why ("Acts as Ask me: held by the account dial").
 * While the page's draft holds a change: "Not saved". A picker the row cannot use is LOCKED, never disabled: the lock's
 * name is the reason, and Space or Enter on the cell put the focus on it, which shows and announces the reason.
 *
 * Picking: Enter (AG) or Space (this cell) on the focused cell, a click on the cell or its chevron, opens the DS list in
 * AG's popup (`SelectPanelEditor`): arrows move, Enter picks, Escape closes without a change. A step the row cannot take
 * is held in the list with its reason under it. The column's `valueSetter` hands the pick to the grid's
 * `context.current.onMode(row, next, field)` and stores nothing — the page's `EditModeBar` and review dialog save it.
 * Without a handler (no permission) the cell only shows. Space never reaches AG, so it never ticks the row.
 */
import { memo, useEffect, useRef } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'
import { ArrowDownToLine } from 'lucide-react'

import { Tag } from '../../primitives/Tag'
import { Tooltip } from '../../primitives/Tooltip'
import { LockGlyph } from './cells'
import { SelectChevron, openCellEditor } from '../editors/SelectCellEditor'
import { keepFromGrid } from './rowVerbs'
import { modeBars, modeCellKey, modeHeldSentence, modeWord, readMode, type ModeCellValue, type ModeStep } from './modeModel'

/** What the page hands the grid as `context` (a ref, so the column definitions never change with the draft). */
export interface ModeHandlers<T = unknown> {
  onMode?: (row: T, next: string, field: string) => void
}

/** `context.current.onMode` (the ref the switch column also reads); a plain `{ onMode }` object is read too. */
export function modeHandlerOf<T>(context: unknown): ModeHandlers<T>['onMode'] {
  if (!context || typeof context !== 'object') return undefined
  const holder = 'current' in context ? (context as { current?: ModeHandlers<T> | null }).current : (context as ModeHandlers<T>)
  return typeof holder?.onMode === 'function' ? holder.onMode : undefined
}

export interface ModeCellParams<T = unknown> {
  field: string
  steps: readonly ModeStep[]
  /** The row's mode: the set step, or `{ set, acts, heldBy }`. */
  read: (row: T) => ModeCellValue
  /** null = it may change; a sentence = locked, and why. */
  lockReason?: (row: T) => string | null
  /** The draft holds a change for this row: "Not saved". */
  pending?: (row: T) => boolean
}

type Props<T> = ICellRendererParams<T> & ModeCellParams<T>

function ModeCellView<T>(p: Props<T>) {
  const row = p.data
  const handler = modeHandlerOf<T>(p.context)
  const lock = row && p.lockReason ? p.lockReason(row) : null
  const editable = !!(row && handler && !lock)
  const lockRef = useRef<HTMLSpanElement>(null)
  const act = useRef<{ open: () => void; editable: boolean; locked: boolean }>({ open: () => {}, editable: false, locked: false })
  act.current = {
    open: openCellEditor(p.api, p.node, p.column?.getColId() ?? p.field),
    editable,
    locked: !!(row && handler && lock),
  }

  useEffect(() => {
    const cell = p.eGridCell
    if (!cell) return
    const onKey = (e: KeyboardEvent) => {
      const what = modeCellKey(e, cell, act.current.locked)
      if (what === 'open' && act.current.editable) { e.preventDefault(); act.current.open() }
      else if (what === 'explain') { e.preventDefault(); lockRef.current?.focus() }
    }
    cell.addEventListener('keydown', onKey)
    return () => cell.removeEventListener('keydown', onKey)
  }, [p.eGridCell])

  if (!row) return null
  const reading = readMode(p.read(row))
  const word = modeWord(p.steps, reading.set)
  const held = modeHeldSentence(p.steps, reading)
  const bars = modeBars(p.steps, reading)
  const onClick = editable ? act.current.open : lock && handler ? () => lockRef.current?.focus() : undefined

  return (
    <span className={editable ? 'nds-cell-mode' : 'nds-cell-mode is-readonly'} onClickCapture={onClick ? keepFromGrid : undefined} onClick={onClick}>
      <span className="nds-cell-mode-meter" aria-hidden>
        {bars.map((bar, i) => <span key={i} className={`is-${bar}`} style={{ height: `${Math.round(((i + 2) / (bars.length + 1)) * 100)}%` }} />)}
      </span>
      <span className="nds-cell-mode-word">{word || '—'}</span>
      {held && (
        <Tooltip label={held} portal>
          <span className="nds-cell-mode-held" role="img" aria-label={held}><ArrowDownToLine size={12} strokeWidth={2.25} aria-hidden /></span>
        </Tooltip>
      )}
      {lock && handler && (
        <Tooltip label={lock} portal>
          <span ref={lockRef} className="nds-cell-mode-lock" tabIndex={-1}><LockGlyph reason={lock} /></span>
        </Tooltip>
      )}
      {/* Polish round 2 (S10): the step word never shrinks ("W.. Not saved" at 1440). Where the cell is too narrow for
          the tag, a dot named "Not saved" takes its place (a container query in grid.css). */}
      {p.pending?.(row) && (
        <span className="nds-cell-mode-draft">
          <Tag tone="info">Not saved</Tag>
          <Tooltip label="Not saved" portal><span className="nds-cell-mode-dot" role="img" aria-label="Not saved" /></Tooltip>
        </span>
      )}
      {editable && <SelectChevron />}
    </span>
  )
}

export const ModeCell = memo(ModeCellView) as typeof ModeCellView
