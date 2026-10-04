'use client'

/**
 * PES.2 / F2 — the SELECTION surface for family verbs.
 *
 * Unlink and reparent act on the rows the operator picked, so they belong here rather than on the
 * family bar — and the split is not cosmetic: `actionsFor` filters by scope, so a context verb
 * physically cannot appear on this bar and a selection verb cannot appear on that one. That is the
 * registry doing the work a convention would otherwise have to.
 *
 * Since 2026-09-26 there is no bottom bar at all: every host (the sheet, the Variants tab's family and channel
 * views) shows these verbs in its TOOLBAR while rows are selected (`SheetToolbar selectionActions`), and the
 * `BulkActionBar` wrapper that used to hold them is gone.
 *
 * 🔴 A disabled verb is KEPT with its reason. On this bar that matters more than most, because the
 * reasons are all things the operator can fix — "select one at a time", "only a variation can be
 * unlinked", "unlinking needs the channels.sync permission". A bar that hid them would leave an
 * operator with an empty strip and no idea what selection would fill it.
 */
import { memo, useMemo, type ReactNode } from 'react'

import { actionLabel, actionsFor, isRunnable, SELECTION, type ActionResult, type GridAction } from '@/design-system/grid/actions/registry'
import { useActionPress } from '@/design-system/grid/actions/useActionPress'
import { Button, InfoTip } from '@/design-system/primitives'

import type { StudioRow } from './types'

export interface FamilySelectionBarProps {
  rows: StudioRow[]
  actions: readonly GridAction<StudioRow>[]
  onClear?: () => void
  onDone?: (result: ActionResult) => void
  /**
   * Build shape v2, P9 (Owner 2026-10-04) — what follows the family verbs on the same bar: the shared scope's
   * **Action ▾** sits right after "Delete child…", the last selection verb.
   */
  children?: ReactNode
}

/**
 * SHEET-VIEWS (Owner, 2026-09-26: the selection bar "looks very odd … the action buttons don't look
 * great"). The VERBS, in one place: the sheet shows them in its toolbar while rows are selected (the
 * products grid's `GridSelectionActions` shape), and so do both Variants views (Owner, 2026-09-26: "go with your
 * recommendation") — same buttons, same reasons, same confirm, so the hosts cannot drift.
 *
 * A destructive verb is drawn `danger` only when it can RUN. A disabled danger button rendered as a
 * pale pink block (measured on master·IT with two variations selected: "Delete child…" in a washed-out
 * red fill) — it read as a broken control, not an unavailable one. Unavailable, it is a plain disabled
 * button like its neighbours; its label and its reason (the InfoTip) still say what it is.
 */
export const FamilySelectionVerbs = memo(function FamilySelectionVerbs({ rows, actions, onDone, children }: Omit<FamilySelectionBarProps, 'onClear'>) {
  const { press, busy, problem, confirmElement } = useActionPress<StudioRow>(onDone)
  const offered = useMemo(() => actionsFor(actions, SELECTION, rows), [actions, rows])
  if (rows.length === 0) return null
  return (
    <>
      {problem && <span className="nds-cell-stock-out" role="alert">{problem}</span>}
      {offered.map(({ action, availability }) => {
        const runnable = isRunnable(availability)
        const button = (
          <Button
            size="sm"
            variant={action.danger && runnable ? 'danger' : 'secondary'}
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
      {children}
      {confirmElement}
    </>
  )
})
