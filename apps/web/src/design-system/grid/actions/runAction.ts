/**
 * GDS — the one place a verb actually RUNS.
 *
 * `registry.ts` says what a verb IS; this says what happens when someone presses it. The two are
 * separate files because the sequence is where the dangerous mistakes live, and it must not be
 * re-typed per surface: the drawer, the family bar, the row menu and the selection bar all run the
 * same nine rules, and the moment there are two copies one of them softens a `type-to-confirm` into
 * a click on exactly one surface. That is not hypothetical — `validateImpact` exists because a
 * five-live-listing delete can become a one-click delete, and it only protects the surfaces that
 * remember to call it.
 *
 * So the SEQUENCE lives here and the LOOK lives in each surface: `ask` receives the impact and
 * renders it however that surface renders things, and answers yes or no. Nothing else is delegated.
 *
 * Pure and React-free, so all nine rules are tested rather than trusted.
 */

import { validateImpact, type ActionImpact, type ActionResult, type GridAction } from './registry'

/**
 * What happened. FOUR outcomes, not ok/not-ok.
 *
 * 🔴 `cancelled` and `refused` are different facts and a surface must be able to tell them apart.
 * An operator who said no wants silence; a verb the client REFUSED (a malformed impact, a preflight
 * that could not reach the listings service) has to say so loudly, because from the operator's side
 * both look like "nothing happened" — and one of them means the safety check itself is broken.
 */
export type ActionOutcome<R = ActionResult> =
  | { kind: 'ran'; result: R; impact?: ActionImpact }
  | { kind: 'cancelled' }
  | { kind: 'refused'; problem: string }
  | { kind: 'failed'; message: string }

/** Renders the impact and answers. Returning false must leave the world untouched. */
export type AskToConfirm = (impact: ActionImpact) => boolean | Promise<boolean>

/**
 * Run a verb, honouring every rule the registry declares.
 *
 * 1. A verb with a preflight NEVER runs until it resolves — the confirm is written from what the
 *    server said, not from what the client guessed.
 * 2. A preflight that throws is a failure, not a reason to proceed. The verb does not run.
 * 3. `validateImpact` problems REFUSE the verb outright. Never softened into a plainer confirm.
 * 4. `impact.unavailable` refuses too: the preflight failed, so the verb would run on a guess.
 * 5. `level: 'none'` runs without asking — the preflight looked and found nothing worth stopping for.
 * 6. `ask` saying no means nothing happened. `run` is not called.
 * 7. `run` receives the impact its OWN preflight produced (ruling #118), so it applies the snapshot
 *    the operator approved rather than re-fetching a possibly different one.
 * 8. A verb with no preflight runs with no impact at all — `undefined`, not an invented empty one.
 * 9. A throwing `run` reports the server's own words, never a rewrite.
 */
export async function runAction<T, R extends ActionResult = ActionResult>(
  // `Omit`, not an intersection: intersecting two `run` signatures makes TS resolve the call to
  // the first one and quietly narrow the result back to `ActionResult`, losing whatever the lane
  // actually returned. This way a lane's richer result survives to its own surface.
  action: Omit<GridAction<T>, 'run'> & { run: (rows: T[], impact?: ActionImpact) => Promise<R> },
  rows: T[],
  ask: AskToConfirm,
): Promise<ActionOutcome<R>> {
  let impact: ActionImpact | undefined

  if (action.preflight) {
    try {
      impact = await action.preflight(rows) // rule 1
    } catch (err) {
      return { kind: 'failed', message: messageOf(err) } // rule 2
    }

    if (impact.cancelled) return { kind: 'cancelled' }
    const problems = validateImpact(impact)
    if (problems.length > 0) {
      return { kind: 'refused', problem: problems.join('; ') } // rule 3
    }
    if (impact.unavailable) {
      return { kind: 'refused', problem: impact.unavailable } // rule 4
    }

    if (impact.level !== 'none') {
      // rule 5
      let said: boolean
      try {
        said = await ask(impact)
      } catch (err) {
        // A confirm that BLEW UP is not a yes. Treated as a refusal rather than a cancel, because
        // the operator never got to answer and the surface needs to say something broke.
        return { kind: 'refused', problem: messageOf(err) }
      }
      if (!said) return { kind: 'cancelled' } // rule 6
    }
  }

  try {
    const result = await action.run(rows, impact) // rules 7 + 8
    return { kind: 'ran', result, impact }
  } catch (err) {
    return { kind: 'failed', message: messageOf(err) } // rule 9
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
