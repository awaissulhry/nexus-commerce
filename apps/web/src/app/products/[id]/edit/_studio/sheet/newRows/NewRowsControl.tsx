'use client'

/**
 * Add rows — the control in the product sheet footer's START slot (`GridSheetStatus start`, bottom left): "Rows to add"
 * (1–50) and "Add rows". The Shared scope adds variations, so "Add rows" is a button; a channel scope adds variations or
 * listings (aliases), so it is a menu: "Variations" / "Listing (alias)". At phone width the count leaves the 36 px
 * footer (`GRID_SHEET_STATUS_WIDE`) and only the button shows.
 *
 * A kind that cannot be added now says why: the menu item's second line, or — on the single button — a HELD button
 * (`aria-disabled`, still focusable) whose reason is its description, its hover tip and, when pressed, said at once.
 */
import { useId } from 'react'
import { Button, InfoTip, NumberStepper } from '@/design-system/primitives'
import { Menu, type MenuItemDef } from '@/design-system/components'
import { GRID_SHEET_STATUS_WIDE } from '@/design-system/grid'
import { NEW_ROWS_WORDS, ROWS_TO_ADD_MAX, ROWS_TO_ADD_MIN, type NewRowKind } from './newRows'

export interface NewRowsControlProps {
  kinds: readonly NewRowKind[]
  /** Why a kind cannot be added now (no parent, no account, no permission), or null. */
  unavailable?: Partial<Record<NewRowKind, string | null>>
  count: number
  onCount: (next: number) => void
  onAdd: (kind: NewRowKind) => void
  /** The single button was pressed while held: say the reason. */
  onHeld: (reason: string) => void
}

const kindLabel = (kind: NewRowKind) => (kind === 'alias' ? NEW_ROWS_WORDS.alias : NEW_ROWS_WORDS.variations)
const kindNote = (kind: NewRowKind) => (kind === 'alias' ? NEW_ROWS_WORDS.aliasNote : NEW_ROWS_WORDS.variationsNote)

/** The channel scope's menu: one item per kind, each with what it creates — or why it cannot now — under its name. */
export function newRowsMenuItems(kinds: readonly NewRowKind[], unavailable: Partial<Record<NewRowKind, string | null>>, onAdd: (kind: NewRowKind) => void): MenuItemDef[] {
  return kinds.map((kind) => {
    const held = unavailable[kind] ?? null
    return { id: `add-rows-${kind}`, label: kindLabel(kind), description: held ?? kindNote(kind), disabled: !!held, onSelect: () => onAdd(kind) }
  })
}

/** "Add rows: 5 empty rows" — the action's name says how many it adds (the visible words come first). */
export const addRowsName = (count: number) => `${NEW_ROWS_WORDS.addRows}: ${count} empty ${count === 1 ? 'row' : 'rows'}`

export function NewRowsControl({ kinds, unavailable = {}, count, onCount, onAdd, onHeld }: NewRowsControlProps) {
  const labelId = useId()
  if (kinds.length === 0) return null
  const stepper = (
    <span className={GRID_SHEET_STATUS_WIDE}>
      <span id={labelId}>{NEW_ROWS_WORDS.rowsToAdd}</span>
      <NumberStepper size="sm" value={count} min={ROWS_TO_ADD_MIN} max={ROWS_TO_ADD_MAX} onChange={onCount}
        aria-labelledby={labelId} decrementLabel="One row fewer" incrementLabel="One row more" />
    </span>
  )
  if (kinds.length > 1) {
    return <>
      {stepper}
      <Menu label={`${NEW_ROWS_WORDS.addRows} ▾`} items={newRowsMenuItems(kinds, unavailable, onAdd)}
        triggerProps={{ className: 'nds-btn sm', 'aria-label': addRowsName(count) }} />
    </>
  }
  const kind = kinds[0]
  const held = unavailable[kind] ?? null
  const button = (
    <Button size="sm" aria-label={addRowsName(count)} aria-disabled={held ? true : undefined} aria-description={held ?? undefined}
      onClick={() => (held ? onHeld(held) : onAdd(kind))}>
      {NEW_ROWS_WORDS.addRows}
    </Button>
  )
  return <>{stepper}{held ? <InfoTip tip={held}>{button}</InfoTip> : button}</>
}
