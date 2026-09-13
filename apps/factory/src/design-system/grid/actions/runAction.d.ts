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
import { type ActionImpact, type ActionResult, type GridAction } from './registry';
/**
 * What happened. FOUR outcomes, not ok/not-ok.
 *
 * 🔴 `cancelled` and `refused` are different facts and a surface must be able to tell them apart.
 * An operator who said no wants silence; a verb the client REFUSED (a malformed impact, a preflight
 * that could not reach the listings service) has to say so loudly, because from the operator's side
 * both look like "nothing happened" — and one of them means the safety check itself is broken.
 */
export type ActionOutcome<R = ActionResult> = {
    kind: 'ran';
    result: R;
    impact?: ActionImpact;
} | {
    kind: 'cancelled';
} | {
    kind: 'refused';
    problem: string;
    refusal?: ActionImpact['refusal'];
} | {
    kind: 'failed';
    message: string;
};
/** Renders the impact and answers. Returning false must leave the world untouched. */
export type AskToConfirm = (impact: ActionImpact) => boolean | Promise<boolean>;
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
export declare function runAction<T, R extends ActionResult = ActionResult>(action: Omit<GridAction<T>, 'run'> & {
    run: (rows: T[], impact?: ActionImpact) => Promise<R>;
}, rows: T[], ask: AskToConfirm): Promise<ActionOutcome<R>>;
