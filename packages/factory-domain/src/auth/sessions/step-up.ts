/**
 * Step-up for risky office actions in depth (B-W2b-404; PLT-063; GDPR art. 32), pure: every try with a code is a
 * StepUpAttempt (append-only, B-W2b-373) and each code works once; repeated wrong codes lock step-up for a while.
 *
 *   SUCCESS      the code was right and unused: the session may do risky actions for 5 minutes; the row keeps a keyed
 *                hash of the code (never the code), unique per person, so the same code can never count twice
 *   WRONG_CODE   the code was wrong (or not a code)
 *   REUSED_CODE  the code was right but already used (its time step was claimed)
 *   LOCKED       a try while step-up was locked: no code is checked
 *
 * THE LOCK (the database keeps the same rule, so a slip of the API cannot unlock it): step-up is locked when the person
 * has at least `maxFailures` WRONG_CODE or REUSED_CODE tries after their last SUCCESS and within the last `lockMinutes`;
 * it lasts until the oldest of the latest `maxFailures` such tries plus `lockMinutes`. LOCKED tries do not count. The
 * lock touches only step-up: the person stays signed in and does everything that asks no fresh code. Wrong step-up
 * codes no longer count towards the account's sign-in lockout (W0 did): a wrong code on a live session locks the risky
 * actions, never the sign-in. The lock ends by itself; nobody can lift it earlier (the rows are append-only).
 */

export const STEP_UP_RESULTS = ['SUCCESS', 'WRONG_CODE', 'REUSED_CODE', 'LOCKED'] as const
export type StepUpResult = (typeof STEP_UP_RESULTS)[number]

export interface StepUpTry {
  readonly at: Date
  readonly result: StepUpResult
}

export interface StepUpLockRules {
  readonly maxFailures: number
  readonly lockMinutes: number
}

const counts = (result: StepUpResult): boolean => result === 'WRONG_CODE' || result === 'REUSED_CODE'

/**
 * Until when step-up is locked for a try at `at`, given the person's earlier tries (any order; tries after `at` are
 * ignored); null when it is not locked.
 */
export function stepUpLockedUntil(tries: readonly StepUpTry[], at: Date, rules: StepUpLockRules): Date | null {
  const time = at.getTime()
  const windowStart = time - rules.lockMinutes * 60_000
  const earlier = tries.filter((entry) => entry.at.getTime() <= time)
  const lastSuccess = Math.max(-Infinity, ...earlier.filter((entry) => entry.result === 'SUCCESS').map((entry) => entry.at.getTime()))
  const failures = earlier
    .filter((entry) => counts(entry.result) && entry.at.getTime() > windowStart && entry.at.getTime() > lastSuccess)
    .map((entry) => entry.at.getTime())
    .sort((a, b) => b - a)
  const reached = failures[rules.maxFailures - 1]
  return reached === undefined ? null : new Date(reached + rules.lockMinutes * 60_000)
}

/** How many wrong codes in a row from now lock step-up (the last of them locks it; 0 while locked). */
export function failuresLeft(tries: readonly StepUpTry[], at: Date, rules: StepUpLockRules): number {
  if (stepUpLockedUntil(tries, at, rules) !== null) return 0
  for (let more = 1; more < rules.maxFailures; more += 1) {
    const extra = Array.from({ length: more }, () => ({ at, result: 'WRONG_CODE' as const }))
    if (stepUpLockedUntil([...tries, ...extra], at, rules) !== null) return more
  }
  return rules.maxFailures
}

/** The codes of a refused step-up (path `code/<code>` or `stepUp/<code>`); the web says its own words. */
export const STEP_UP_REFUSALS = Object.freeze({
  noTwoFactor: 'Set up two-factor first: a step-up needs a code from the authenticator app.',
  accountLocked: 'Too many wrong attempts on this account. Wait a few minutes, then try again.',
  locked: 'Too many wrong codes in a row: step-up is locked for a while. Everything else keeps working.',
  wrong: 'The code is wrong.',
  reused: 'This code was already used. Wait for the next one.',
})
export type StepUpRefusal = keyof typeof STEP_UP_REFUSALS
