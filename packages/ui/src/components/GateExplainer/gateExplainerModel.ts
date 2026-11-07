/**
 * GateExplainer's rules (B-W2b-78, design part GateExplainer): one way for every gate to say its answer — the
 * certificate gate, release, a hold's release conditions, labels, tests, the market requirements.
 *
 * - **A check** is met (`pass`), not met (`fail`), not known (`unknown`: a result not in yet, a lookup that failed) or
 *   not needed here (`notNeeded`, never counted).
 * - **The verdict**: any check not met → `held`; else any unknown → `unknown` (held too: a gate never lets through what
 *   it cannot see); else `open`. A gate with no checks listed is `held` ("No checks are listed for this gate"); a gate
 *   whose every check is not needed is `open`.
 * - **The held reason** names every check that holds it, with its value now ("Cr VI result PASS (now: PENDING)"), for a
 *   held button's `heldReason` and for prints. `null` when the gate is open.
 * - **The one line** (compact form): the first blocking check's reason (or its name), "+2 more" when there are more;
 *   open: the one check's reason when there is one, else "All 3 checks met".
 */

export type GateCheckState = 'pass' | 'fail' | 'unknown' | 'notNeeded'
export type GateVerdict = 'open' | 'held' | 'unknown'

export interface GateCheckInput {
  state: GateCheckState
  label: string
  /** The value now, when the check is not met ("PENDING", "missing"). */
  now?: string
  /** The reason in words; a string is used in the one line. */
  reason?: unknown
}

export interface GateSummary<T extends GateCheckInput> {
  /** Checks that count (not `notNeeded`). */
  total: number
  passed: number
  failed: T[]
  unknown: T[]
}

export function gateSummary<T extends GateCheckInput>(checks: readonly T[]): GateSummary<T> {
  const counted = checks.filter((c) => c.state !== 'notNeeded')
  return {
    total: counted.length,
    passed: counted.filter((c) => c.state === 'pass').length,
    failed: counted.filter((c) => c.state === 'fail'),
    unknown: counted.filter((c) => c.state === 'unknown'),
  }
}

export function gateVerdict(checks: readonly GateCheckInput[]): GateVerdict {
  if (checks.length === 0) return 'held'
  const s = gateSummary(checks)
  if (s.failed.length) return 'held'
  if (s.unknown.length) return 'unknown'
  return 'open'
}

export interface GateWords {
  /** A gate with nothing listed (never a free pass). */
  none: string
  /** "2 checks not met: A, B". */
  held: (count: number, names: readonly string[]) => string
  /** "1 check not known yet: A". */
  unknownHeld: (count: number, names: readonly string[]) => string
  /** "now: PENDING". */
  now: (value: string) => string
  /** "All 3 checks met". */
  allMet: (count: number) => string
  /** "+2 more". */
  more: (count: number) => string
}

/** A check's name with its value now: "Cr VI result PASS (now: PENDING)". */
export const gateCheckName = (check: GateCheckInput, words: Pick<GateWords, 'now'>): string => (check.now ? `${check.label} (${words.now(check.now)})` : check.label)

/** Why the gate holds, naming every blocking check; null when it is open. */
export function gateHeldReason(checks: readonly GateCheckInput[], words: GateWords): string | null {
  if (checks.length === 0) return words.none
  const s = gateSummary(checks)
  if (s.failed.length) return words.held(s.failed.length, s.failed.map((c) => gateCheckName(c, words)))
  if (s.unknown.length) return words.unknownHeld(s.unknown.length, s.unknown.map((c) => gateCheckName(c, words)))
  return null
}

/** The compact form's words after the verdict. */
export function gateLine(checks: readonly GateCheckInput[], words: GateWords): string {
  if (checks.length === 0) return words.none
  const s = gateSummary(checks)
  const blocking = s.failed.length ? s.failed : s.unknown
  if (blocking.length) {
    const first = blocking[0]!
    const text = typeof first.reason === 'string' && first.reason.trim() ? first.reason : gateCheckName(first, words)
    return blocking.length > 1 ? `${text} · ${words.more(blocking.length - 1)}` : text
  }
  const counted = checks.filter((c) => c.state !== 'notNeeded')
  const only = counted.length === 1 ? counted[0] : undefined
  if (only && typeof only.reason === 'string' && only.reason.trim()) return only.reason
  return words.allMet(s.total)
}

/** The checks a list of blockers shows: not met first, then not known; met and not needed left out. */
export function gateBlockers<T extends GateCheckInput>(checks: readonly T[]): T[] {
  const s = gateSummary(checks)
  return [...s.failed, ...s.unknown]
}
