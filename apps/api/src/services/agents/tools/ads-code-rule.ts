/**
 * THE OWNER'S CODE RULE — which Amazon ads requests a person approves only with their fresh authenticator code (the
 * preview's `stepUp`, checked by `stepUpApproval` in `execute`).
 *
 * NOW (Owner, 2026-10-12, "B"): NONE. Every line below is off: a person's normal approval sends every ads request, and
 * the bulk approve takes them too. The table stays as the switch: one line set back to `true` asks the code again for
 * that door, on the card and in the run. What still asks the code is elsewhere: signing in, connecting Claude, and a
 * change set to "confirm in Claude".
 *
 * Until 2026-10-12 ("Code rule: A", 2026-10-07) only the BIG DOORS asked it:
 *
 *   a new structure going live   create-ad-group startLive, set-ad-group op start, set-campaign-live-writes on (the
 *                                allowlist), restore-campaign of a campaign born at the floor (with the allowlist, the
 *                                builders' go-live), apply-ads-playbook start
 *   new product ads              add-product-ads
 *   the strategy raised          set-ads-strategy (a raise), set-ads-playbook (what adds spend), an apply-ads-playbook
 *                                phase switch that raises
 *   someone else's pause lifted  enable-ads with includePeoplesPauses (a person, Seller Central, an unknown writer, a
 *                                rule now off), set-ads-brain op leave resuming the brain's own pauses (the brain going off)
 *   the brain let loose          (lead decision on batch 2's review, 2026-10-08) set-ads-brain op set-value RAISING a
 *                                product's portfolio cap limit (portfolioCapLimitCents: a larger monthly cap may then be
 *                                written, the only hard limit Amazon enforces), and set-brain-kill-switch op end (the brain
 *                                writes that lever again). Lowering the limit, or setting a kill, stays a normal approval.
 *
 * ONE BRAIN AB-16 (D1 = B, Owner 2026-10-08) — one exception to "a new structure going live": a campaign the ads brain
 * built for an enrolled product (its own approved build, brain/structure-golive.ts), going live INSIDE its caps (its first
 * budget, the single-keyword campaigns, the money brake), at any of the three go-live doors (set-campaign-live-writes on,
 * restore-campaign of a campaign born at the floor, apply-ads-playbook start). `goLiveDoor` picks the line: the brain's
 * when every campaign at the door is inside, else the door's own (the code, as before).
 *
 * Every other request that can add spend is DAY-TO-DAY: it lists itself in the preview's `raises`, says so in its effect
 * (no silent raise), the card warns where it goes past the business's own limits (`reach.pastOwnLimits`, where a write
 * is judged by the gate), and a person's normal approval sends it. Its limits still judge a run by the business's rule.
 * "Never by rule" rules are separate and unchanged (a person's hourly plan without allowPeoplesPlans, a person's pause,
 * a copy to another market, a bid handed back to auto-bid, …).
 *
 * Every door's tool asks `needsCode(door)` when it builds its preview's `stepUp`, and its `execute` checks the code from
 * the FRESH dry run's `stepUp` (`codeGate`, or the tool's own gate reading it): a line flipped here changes both the card
 * and the run. The table test (ads-code-rule.vitest.test.ts) pins every line, and each door's own test flips its line
 * (`__codeRuleTest`) to prove the tool follows. What the table does NOT decide: a door's "never by rule" (each tool's
 * withinLimits and execute keep it, code or not).
 */
import { stepUpApproval, stepUpOf } from '../step-up-approval.js'
import type { ToolContext } from '../tool-types.js'

export const CODE_RULE = {
  // ── The big doors of code rule A — off since 2026-10-12 (Owner, "B"): a normal approval ──
  'create-ad-group: startLive': false,
  'set-ad-group: op start': false,
  'add-product-ads': false,
  'set-campaign-live-writes: on': false,
  'restore-campaign: born at the floor': false,
  'apply-ads-playbook: start': false,
  'apply-ads-playbook: a phase switch that raises': false,
  'set-ads-playbook: adds spend': false,
  'set-ads-strategy: a raise': false,
  'enable-ads: includePeoplesPauses': false,
  // BID BRAIN BB-6 — a campaign under the bid brain: a new bid writer going live.
  'set-bid-brain-enrollment: live': false,
  // ONE BRAIN — set-ads-brain: a lever of a product's brain to AUTO (or a campaign under the bid brain), whichever op does it.
  'set-ads-brain: a lever to AUTO': false,
  // Batch 2 fix — set-ads-brain op leave lifting the brain's own pauses: an automation's pause lifted (the brain going off).
  'set-ads-brain: leave lifts the brain\'s pauses': false,
  // Batch 2 review fix (lead decision) — a raise of a product's portfolio cap limit: a larger monthly cap may be written.
  'set-ads-brain: a portfolio cap limit raised': false,
  // Batch 2 review fix (lead decision) — ending a kill switch: the brain writes that lever again.
  'set-brain-kill-switch: end': false,
  // ── Day-to-day: listed in raises, warned, a normal approval ──
  // ONE BRAIN AB-16 (D1 = B) — a brain-built campaign of an enrolled product going live inside its caps (goLiveDoor).
  'brain structure go-live: inside an enrolled product, inside caps': false,
  'set-hourly-bid-plan': false,
  'set-portfolio': false,
  'set-campaign-settings': false,
  'add-ad-targets: at a bid': false,
  'retire-negatives': false,
  'harvest-search-term': false,
  'set-monthly-ad-budget': false,
  'set-budget-schedule': false,
  'set-budget-pool': false,
  'restore-budget-baselines': false,
  'assign-ad-rules: a rule at Auto': false,
  'set-coverage-set': false,
  'run-ad-engine-now': false,
} as const satisfies Record<string, boolean>

export type CodeDoor = keyof typeof CODE_RULE

/** Tests only: a line of the table flipped for one test (`__codeRuleTest`); empty in production. */
const flipped = new Map<CodeDoor, boolean>()

/** Does a raise through this door need the approver's authenticator code? */
export function needsCode(door: CodeDoor): boolean {
  return flipped.get(door) ?? CODE_RULE[door]
}

/** Tests only — flip one line of the table (from what it reads now), to prove a tool follows it; `reset` puts the table back. */
export const __codeRuleTest = {
  flip(door: CodeDoor, value = !needsCode(door)) { flipped.set(door, value) },
  reset() { flipped.clear() },
}

/** What a preview says (`noCode`) when it can add spend and approving it needs no code. */
export const DAY_TO_DAY_NO_CODE = 'It can add spend (listed in raises), as a day-to-day change: a person\'s approval sends it, with '
  + 'no authenticator code (no ads request asks for the code). Where it goes past the business\'s own limits, the card warns.'

/** AB-16 (D1 = B) — the brain's go-live line. */
export const BRAIN_GO_LIVE: CodeDoor = 'brain structure go-live: inside an enrolled product, inside caps'

/**
 * AB-16 (D1 = B) — the door a go-live is judged by: the brain's line when every campaign at the door is a campaign the ads
 * brain built and it goes live inside its caps (brain/structure-golive.ts structureGoLive), else the door's own line.
 */
export function goLiveDoor(own: CodeDoor, brain: { inside: boolean } | null | undefined): CodeDoor {
  return brain?.inside ? BRAIN_GO_LIVE : own
}

/** What a preview says (`noCode`) when it adds no spend. */
export const ADDS_NO_SPEND = 'It adds no spend: it needs no authenticator code.'

/**
 * The sentence an effect ends with when it adds spend: plainly, whatever the code decision (no silent raise). `coded`:
 * approving it needs the approver's code; else a person's approval sends it. Empty when nothing raises.
 */
export function addsSpendWords(raises: readonly string[], coded: boolean, shown = 3): string {
  if (!raises.length) return ''
  const list = `${raises.slice(0, shown).join('; ')}${raises.length > shown ? `; and ${raises.length - shown} more` : ''}`
  return coded
    ? ` It ADDS SPEND (${list}): the approver's authenticator code is needed.`
    : ` It ADDS SPEND (${list}): a day-to-day change — a person's approval sends it, with no authenticator code.`
}

/**
 * The ONE gate in `execute` of a door that may need the code: it reads the stepUp of the fresh dry run (which the tool's
 * code helper decided). A person's approval runs it only with the approver's fresh code; a run the business's rule
 * decided runs inside the tool's limits (withinLimits judged it). A preview without a stepUp passes.
 */
export async function codeGate(ctx: Pick<ToolContext, 'approvalId' | 'can' | 'decidedVia'>, preview: unknown): Promise<{ byRule: boolean; at: Date | null } | { refusal: string }> {
  const stepUp = stepUpOf(preview)
  if (!stepUp) return { byRule: false, at: null }
  if (ctx.decidedVia === 'auto') return { byRule: true, at: null }
  const coded = await stepUpApproval(ctx)
  if ('refusal' in coded) {
    return { refusal: coded.refusal.replace('it raises, and a raise runs', `it ${stepUp.what}, and that runs`).replace('it raises, and', `it ${stepUp.what}, and`).replace('which a raise needs', 'which that needs') }
  }
  return { byRule: false, at: coded.at }
}
