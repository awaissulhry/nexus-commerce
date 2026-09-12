'use client'

/**
 * PES.4.9 — the drawer's ADAPTER for the grid action registry.
 *
 * The drawer is the fourth surface a verb appears on (row menu, `⋯` column, selection bar, here),
 * and ruling #110's strongest finding is that it must never be the surface where a verb is BORN.
 * So this file contains no verb: the lane owning the data declares them, and this renders those
 * declarations.
 *
 * ## It also contains no SEQUENCE any more (ruling #124)
 *
 * This used to hand-write preflight → validateImpact → confirm → run. It was correct, and that was
 * the problem: `validateImpact` only protects a surface that remembers to call it, so a second
 * copy is precisely where a `type-to-confirm` softens into a plain click on one surface and nobody
 * notices, because that surface still looks right. `useActionPress` (which wraps `runAction`) is
 * the one implementation, mutation-tested in the design system. A drawer that re-derived it would
 * be trading a tested guarantee for an untested lookalike.
 *
 * Two behaviours inherited rather than re-derived, both of which this file previously got wrong:
 *
 * - **The outcome is four-valued.** `cancelled` (the operator said no) and `refused` (the client
 *   would not run it — a malformed impact, a preflight that could not reach the service) look
 *   identical from the operator's side, and one of them means the safety check itself is broken.
 *   `press` reports `problem` only for the second.
 * - **`ok: false` from `run` is NOT a failed run.** "17 of 20 attached, here is why three did not"
 *   is a SUCCESSFUL run reporting partial success. This file used to render that as an error,
 *   which claims the verb failed when most of it worked.
 *
 * The confirmation is the design system's too (`ActionConfirm`), so the dangerous verb and the
 * gentle one ask in the same voice. It portals a `Modal` at `--nds-z-overlay`, which is why the
 * dock's narrow-viewport fallback sits at rail level rather than the modal layer — see
 * `.nds-drawer-dock` in components.css.
 */

import { ROW, actionLabel, actionsFor, isRunnable, type GridAction } from '@/design-system/grid/actions/registry'
import { useActionPress } from '@/design-system/grid/actions/useActionPress'
import type { ActionResult } from '@/design-system/grid/actions/registry'
import { Button } from '@/design-system/primitives/Button'
import styles from './drawer.module.css'

export interface RecordActionsProps<T> {
  /** Declared by the lane that owns the data. This component adds none. */
  actions: readonly GridAction<T>[]
  row: T
  /** Told what the verb did, so the host can refetch what it owns. */
  onDone?: (result: ActionResult) => void
}

export function RecordActions<T>({ actions, row, onDone }: RecordActionsProps<T>) {
  const { press, busy, problem, confirmElement } = useActionPress<T>(onDone)

  // Scope is filtered by the registry, not here: a drawer shows one record, so it asks for ROW and
  // physically cannot be handed a selection or family verb.
  const offered = actionsFor(actions, ROW, [row])
  if (offered.length === 0) return null

  return (
    <>
      <div className={styles.actionRow}>
        {offered.map(({ action, availability }) => (
          <Button
            key={action.id}
            size="xs"
            variant={action.danger ? 'danger-outline' : 'secondary'}
            // A disabled verb is KEPT with its reason: one that vanishes teaches nothing, one that
            // explains itself teaches why.
            disabled={!isRunnable(availability) || busy != null}
            title={availability.kind === 'disabled' ? availability.reason : undefined}
            onClick={() => void press(action, [row])}
          >
            {/* `actionLabel`, never `action.label`: the registry made labels callable
                (`string | ((rows) => string)`) so a verb can count its rows, and reading the field
                directly renders a callable one as "(rows) => …". One resolver, theirs. */}
            {busy === action.id ? `${actionLabel(action, [row])}…` : actionLabel(action, [row])}
          </Button>
        ))}
      </div>

      {/* Already phrased by the substrate — rendered verbatim, never re-worded into something
          friendlier that loses which of the four outcomes happened. */}
      {problem && (
        <div className={`${styles.note} ${styles.noteError}`}>
          <span>{problem}</span>
        </div>
      )}

      {confirmElement}
    </>
  )
}
