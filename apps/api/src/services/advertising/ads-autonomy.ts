/**
 * ADX N2 — the intensity dial.
 *
 * `rule.dryRun` is a binary, and a binary is the reason 21 rules sat stuck asking
 * permission: there was no way to move one a single notch and watch it for a week.
 * Pacvue's governance model has four legs — thresholds, approvals, an intensity dial,
 * and audit — and their own research names the dial as the underrated one, because it
 * is how an operator builds trust incrementally instead of wagering it all at once.
 *
 * Nexus had three of the four. This is the fourth.
 *
 * Deliberately NOT a 0-100 percentage. A percentage implies a continuous knob over
 * something that is actually a small set of distinct behaviours, and it would have to
 * be explained every time it was read. Named levels say what they do. The genuinely
 * continuous ramp — "act, but at most N times today" — already exists as
 * `maxExecutionsPerDay`, and pretending it lives somewhere else would be a second
 * source of truth for the same control.
 */

export type AutonomyLevel = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const

/** What each level means, for the UI and for anyone reading a log line. */
export const AUTONOMY_LABELS: Record<AutonomyLevel, { label: string; hint: string }> = {
  OFF: { label: 'Off', hint: 'Does not evaluate.' },
  OBSERVE: { label: 'Observe', hint: 'Evaluates and records what it would do. No proposal, no write.' },
  PROPOSE: { label: 'Propose', hint: 'Queues a suggestion for your approval. Nothing reaches Amazon until you accept.' },
  AUTO: { label: 'Auto', hint: 'Acts on its own, inside its daily cap and the write gate’s bounds.' },
}

export function isAutonomyLevel(v: unknown): v is AutonomyLevel {
  return typeof v === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(v)
}

/** The rule fields this resolution depends on. */
export interface AutonomyInput {
  enabled: boolean
  dryRun: boolean
  autonomyLevel?: string | null
}

/**
 * Resolve a rule's effective level.
 *
 * `enabled` still gates evaluation — the evaluator's queries filter on it and are
 * untouched by this — so a disabled rule is OFF regardless of what the dial says.
 *
 * When `autonomyLevel` is missing or unrecognised we fall back to the old binary, so a
 * row written by an older deploy, or by a code path that has not learned the column
 * yet, behaves exactly as it did before.
 */
export function resolveAutonomy(rule: AutonomyInput): AutonomyLevel {
  if (!rule.enabled) return 'OFF'
  if (isAutonomyLevel(rule.autonomyLevel) && rule.autonomyLevel !== 'OFF') return rule.autonomyLevel
  return rule.dryRun ? 'PROPOSE' : 'AUTO'
}

/** Whether the level permits a real write. Everything below AUTO is a rehearsal. */
export function levelActs(level: AutonomyLevel): boolean {
  return level === 'AUTO'
}

/**
 * Whether the level should queue a suggestion.
 *
 * OBSERVE deliberately does not. It is the mode for a rule you want running and
 * measured but do not yet want to hear from — without it, the only way to quieten a
 * noisy rule is to switch it off, which also stops the evidence you would need to
 * decide whether to trust it.
 */
export function levelProposes(level: AutonomyLevel): boolean {
  return level === 'PROPOSE'
}

/** One notch up / down, for the UI. Ramping is the whole point; jumping is not. */
export function nextLevel(level: AutonomyLevel): AutonomyLevel {
  const i = AUTONOMY_LEVELS.indexOf(level)
  return AUTONOMY_LEVELS[Math.min(i + 1, AUTONOMY_LEVELS.length - 1)]
}
export function prevLevel(level: AutonomyLevel): AutonomyLevel {
  const i = AUTONOMY_LEVELS.indexOf(level)
  return AUTONOMY_LEVELS[Math.max(i - 1, 0)]
}
