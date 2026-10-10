'use client'

/**
 * SwitchCell — the on/off cell of `switchColumn` (ads brain page D2, 2026-10-10).
 *
 * It NEVER writes. A flip is handed to the grid's `context.current.onSwitch(row, next, field)`: the page changes its
 * DRAFT, and the page's `EditModeBar` + review dialog save it. While the draft holds a change the cell shows "Not
 * saved". Without a handler (no permission) it draws only the word — the `AllowedCell` precedent
 * (`control-room/CampaignLimitsGrid.tsx`). A switch that cannot move is disabled with its reason as title and
 * `aria-description`.
 *
 * Keyboard: Space and Enter on the focused CELL flip it (AG would otherwise select the row on Space); the column's
 * `suppressKeyboardEvent` keeps AG out of it, and the cell listens on its own `eGridCell`. A click in the cell is
 * flagged for AG (`keepFromGrid`) so it never selects or opens the row.
 */
import { memo, useEffect, useRef } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'

import { Tag } from '../../primitives/Tag'
import { Toggle } from '../../primitives/Toggle'
import { keepFromGrid } from './rowVerbs'

export interface SwitchWords { on: string; off: string }
export const SWITCH_WORDS: SwitchWords = { on: 'On', off: 'Off' }

/** What the page hands the grid as `context` (a ref, so the column definitions never change with the draft). */
export interface SwitchHandlers<T = unknown> {
  onSwitch?: (row: T, next: boolean, field: string) => void
}

export interface SwitchCellParams<T = unknown> {
  field: string
  /** Accessible name of the switch: "Keep JACKET-A under the brain". */
  label: (row: T) => string
  words?: SwitchWords
  /** null = it may move; a sentence = disabled, and why. */
  disabledReason?: (row: T) => string | null
  /** The draft holds a change for this row: "Not saved". */
  pending?: (row: T) => boolean
}

/** A missing value reads as Off: a switch is on only when it is `true`. */
export const switchWord = (value: unknown, words: SwitchWords = SWITCH_WORDS): string => (value === true ? words.on : words.off)

/** `context.current.onSwitch` (the ref the plan asks for); a plain `{ onSwitch }` object is read too. */
export function switchHandlerOf<T>(context: unknown): SwitchHandlers<T>['onSwitch'] {
  if (!context || typeof context !== 'object') return undefined
  const holder = 'current' in context ? (context as { current?: SwitchHandlers<T> | null }).current : (context as SwitchHandlers<T>)
  return typeof holder?.onSwitch === 'function' ? holder.onSwitch : undefined
}

interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
const isFlipKey = (e: KeyLike) => (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') && !e.ctrlKey && !e.metaKey && !e.altKey

/**
 * The column's `suppressKeyboardEvent`: Space and Enter belong to the switch, not to AG (Space would select the row,
 * Enter would try to edit). Arrows, Tab, Escape and every Ctrl/⌘ combination stay AG's. Never while editing.
 */
export function suppressSwitchKeys({ event, editing }: { event: KeyLike; editing?: boolean }): boolean {
  return !editing && isFlipKey(event)
}

/** The cell's own listener flips only for a key pressed ON the cell — the toggle button handles its own keys. */
export function switchKeyFlips(event: KeyLike & { target: unknown; repeat?: boolean }, cell: unknown): boolean {
  return event.target === cell && !event.repeat && isFlipKey(event)
}

type Props<T> = ICellRendererParams<T> & SwitchCellParams<T>

function SwitchCellView<T>(p: Props<T>) {
  const row = p.data
  const handler = switchHandlerOf<T>(p.context)
  const on = p.value === true
  const reason = row && p.disabledReason ? p.disabledReason(row) : null
  const flip = useRef<(() => void) | null>(null)
  flip.current = row && handler && !reason ? () => handler(row, !on, p.field) : null

  useEffect(() => {
    const cell = p.eGridCell
    if (!cell || !handler) return
    const onKey = (e: KeyboardEvent) => {
      if (!flip.current || !switchKeyFlips(e, cell)) return
      e.preventDefault()
      flip.current()
    }
    cell.addEventListener('keydown', onKey)
    return () => cell.removeEventListener('keydown', onKey)
  }, [p.eGridCell, handler])

  if (!row) return null
  const word = switchWord(p.value, p.words)
  if (!handler) return <span className="nds-cell-switch">{word}</span>
  return (
    <span className="nds-cell-switch" onClickCapture={keepFromGrid} title={reason ?? undefined}>
      <Toggle
        size="xs"
        checked={on}
        disabled={!!reason}
        aria-label={p.label(row)}
        aria-description={reason ?? undefined}
        onChange={(next) => handler(row, next, p.field)}
      />
      <span>{word}</span>
      {p.pending?.(row) && <Tag tone="info">Not saved</Tag>}
    </span>
  )
}

export const SwitchCell = memo(SwitchCellView) as typeof SwitchCellView
