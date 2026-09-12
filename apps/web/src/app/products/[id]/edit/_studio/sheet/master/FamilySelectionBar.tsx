'use client'

/**
 * PES.2 / F2 — the SELECTION surface for family verbs.
 *
 * Unlink and reparent act on the rows the operator picked, so they belong here rather than on the
 * family bar — and the split is not cosmetic: `actionsFor` filters by scope, so a context verb
 * physically cannot appear on this bar and a selection verb cannot appear on that one. That is the
 * registry doing the work a convention would otherwise have to.
 *
 * The bar itself is the DS `BulkActionBar` (checked before hand-rolling, per the standing rule); it
 * already renders nothing at zero selection, which is the behaviour a selection bar needs.
 *
 * 🔴 A disabled verb is KEPT with its reason. On this bar that matters more than most, because the
 * reasons are all things the operator can fix — "select one at a time", "only a variation can be
 * unlinked", "unlinking needs the channels.sync permission". A bar that hid them would leave an
 * operator with an empty strip and no idea what selection would fill it.
 */
import { memo, useMemo } from 'react'

import { actionLabel, actionsFor, isRunnable, SELECTION, type ActionResult, type GridAction } from '@/design-system/grid/actions/registry'
import { useActionPress } from '@/design-system/grid/actions/useActionPress'
import { BulkActionBar } from '@/design-system/patterns/BulkActionBar'
import { Button, InfoTip } from '@/design-system/primitives'

import type { StudioRow } from './types'

export interface FamilySelectionBarProps {
  rows: StudioRow[]
  actions: readonly GridAction<StudioRow>[]
  onClear?: () => void
  onDone?: (result: ActionResult) => void
}

export const FamilySelectionBar = memo(function FamilySelectionBar({ rows, actions, onClear, onDone }: FamilySelectionBarProps) {
  const { press, busy, problem, confirmElement } = useActionPress<StudioRow>(onDone)
  const offered = useMemo(() => actionsFor(actions, SELECTION, rows), [actions, rows])

  if (rows.length === 0) return null

  // The DS bar prints `count + noun` verbatim, so the noun carries the plural. "1 rows selected"
  // was on screen before this.
  const noun = rows.length === 1 ? 'row selected' : 'rows selected'

  return (
    <BulkActionBar count={rows.length} noun={noun} onClear={onClear}>
      {problem && <span className="nds-cell-stock-out" role="alert">{problem}</span>}
      {offered.map(({ action, availability }) => {
        const runnable = isRunnable(availability)
        const button = (
          <Button
            size="sm"
            variant={action.danger ? 'danger' : 'secondary'}
            disabled={!runnable || busy !== null}
            onClick={() => void press(action, rows)}
          >
            {actionLabel(action, rows)}
          </Button>
        )
        // The reason is the whole point of keeping a disabled verb on screen.
        return availability.kind === 'disabled'
          ? <InfoTip key={action.id} tip={availability.reason}>{button}</InfoTip>
          : <span key={action.id}>{button}</span>
      })}
      {confirmElement}
    </BulkActionBar>
  )
})
