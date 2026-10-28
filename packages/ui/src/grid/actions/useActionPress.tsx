'use client'

/**
 * GDS — pressing a verb, once, for every surface.
 *
 * `runAction` owns the SEQUENCE and `ActionConfirm` owns the ASKING; this is the small amount of
 * React between them — busy state, what to say about each outcome, and where the dialog mounts.
 * It exists because the family bar, the selection bar, the row menu and the drawer would otherwise
 * each write the same twenty lines, and the interesting line is the one that is easy to get wrong:
 *
 * 🔴 `ran` with `ok: false` is NOT a failure to run. `POST /pim/attach-to-parent` runs one
 *    transaction per child and answers `{ attached, errors[] }` — "17 of 20, and here is why the
 *    other three did not" is a successful RUN reporting a partial result. A surface that treated
 *    ok:false as an error would say the verb failed when most of it worked; one that treated it as
 *    success would swallow the three failures entirely. Both are wrong, so neither is left to a
 *    surface to decide.
 *
 * 🔴 `cancelled` says nothing at all — the operator knows what they just did. `refused` says a lot,
 *    because from their side it looks identical to a cancel while actually meaning the safety check
 *    could not run.
 */

import { useCallback, useMemo, useState } from 'react'

import { useActionConfirm } from './ActionConfirm'
import { runAction } from './runAction'
import { actionLabel } from './registry'
import type { ActionResult, GridAction } from './registry'

export interface ActionPressApi<T> {
  /** Run a verb against these rows. Empty for a context verb. */
  press: (action: GridAction<T>, rows: T[]) => Promise<void>
  /** The id of the verb in flight, so a surface can disable the rest of them. */
  busy: string | null
  /** What to tell the operator, or null. Already phrased; render it verbatim. */
  problem: string | null
  clearProblem: () => void
  /** Mount once inside the surface. */
  confirmElement: React.ReactNode
}

export function useActionPress<T>(onDone?: (result: ActionResult) => void): ActionPressApi<T> {
  const confirm = useActionConfirm()
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const press = useCallback(
    async (action: GridAction<T>, rows: T[]) => {
      setProblem(null)
      setBusy(action.id)
      // Resolved ONCE, against the rows this press is acting on, so all three messages below name
      // the verb the same way the surface that was clicked did (#363).
      const label = actionLabel(action, rows)
      try {
        const outcome = await runAction(action, rows, confirm.ask)
        switch (outcome.kind) {
          case 'refused':
            setProblem(`${label} was refused: ${outcome.problem}`)
            break
          case 'failed':
            setProblem(`${label} failed: ${outcome.message}`)
            break
          case 'ran':
            // The server's own words on a partial result — never rewritten into "done".
            if (!outcome.result.ok) setProblem(outcome.result.message ?? `${label} did not fully succeed`)
            onDone?.(outcome.result)
            break
          case 'cancelled':
            break
        }
      } finally {
        setBusy(null)
      }
    },
    [confirm.ask, onDone],
  )

  const clearProblem = useCallback(() => setProblem(null), [])

  // Memoised so the returned object is stable while nothing has changed. It used to be a fresh
  // literal every render, which quietly punished the correct usage: a host that memoised
  // `getContextMenuItems` on this api would recompute it every render anyway, and an unstable
  // that memo would then recompute on every render — a memo in name only. 🔴 The earlier version of
  // this comment blamed an AG column-model rebuild; AG.1 measured that false for callbacks on 36.1
  // (a new `getContextMenuItems` identity fires 0 column events, versus 1/1/1 for `columnDefs`), so
  // the banked trap applies to column DEFS and I over-generalised it. The fix stands on its real
  // reason: **a hook whose result cannot be used as a dependency makes every consumer's memo a
  // lie**, and that is true whatever AG does downstream.
  return useMemo(
    () => ({ press, busy, problem, clearProblem, confirmElement: confirm.element }),
    [press, busy, problem, clearProblem, confirm.element],
  )
}
