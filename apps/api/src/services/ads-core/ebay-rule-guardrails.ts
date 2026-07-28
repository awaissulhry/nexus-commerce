/**
 * D7 — make `EbayAdsRule.guardrails` mean what its name says.
 *
 * The field was stored, versioned, round-tripped and editable in the rule
 * editor, and **never read during evaluation**. A repo-wide search for a
 * property access on it returned only unrelated `team-guardrails` hits.
 *
 * The rules DO have real guardrails — break-even clamp, per-entity cooldown,
 * spend ceiling, per-campaign policy — but those are hard-coded. So this field
 * was not merely unused: it implied operator control that did not exist.
 *
 * WHAT THE LIVE DATA SAID. Auditing the six existing rules before choosing a
 * fix: every non-empty value is `{ note: "…" }` — free text, no constraints,
 * and all six rules are disabled. So "wire it as constraints" would have
 * enforced nothing, and "rename it to notes" would have thrown away the hook
 * Phase 5's blast-radius caps need.
 *
 * Hence both, explicitly: `note` stays a documented free-text key, and the
 * typed keys below are genuinely read. The name becomes true, existing rows
 * keep working unchanged, and there is somewhere for a cap to live.
 */

export interface RuleGuardrails {
  /** Free text. Documented, ignored by the engine — this is what rules hold today. */
  note?: string
  /** Hard cap on how many candidates one run may act on. The blast-radius lever. */
  maxActionsPerRun?: number
  /** Skip entities with fewer clicks in the trigger window — statistical floor. */
  minClicks?: number
  /** Skip entities below this spend in the trigger window. */
  minSpendCents?: number
  /** Clamp any single bid/rate move to ±this percent of the current value. */
  maxBidChangePct?: number
}

/** Keys the engine actually enforces. `note` is deliberately absent. */
export const ENFORCED_GUARDRAIL_KEYS = [
  'maxActionsPerRun', 'minClicks', 'minSpendCents', 'maxBidChangePct',
] as const

const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0

/**
 * Parse and validate. Returns the typed shape plus any errors, so
 * `validateRuleBody` can refuse a rule whose guardrails would silently not
 * apply — which is the failure mode being fixed, in miniature.
 */
export function parseGuardrails(raw: unknown): { value: RuleGuardrails; errors: string[] } {
  const errors: string[] = []
  const value: RuleGuardrails = {}
  if (raw == null) return { value, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { value, errors: ['guardrails: must be an object'] }
  }
  const o = raw as Record<string, unknown>

  if (o.note !== undefined) {
    if (typeof o.note !== 'string') errors.push('guardrails.note: must be a string')
    else value.note = o.note
  }
  if (o.maxActionsPerRun !== undefined) {
    if (!isPosInt(o.maxActionsPerRun)) errors.push('guardrails.maxActionsPerRun: positive integer')
    else value.maxActionsPerRun = o.maxActionsPerRun
  }
  if (o.minClicks !== undefined) {
    if (!isNonNegInt(o.minClicks)) errors.push('guardrails.minClicks: integer ≥ 0')
    else value.minClicks = o.minClicks
  }
  if (o.minSpendCents !== undefined) {
    if (!isNonNegInt(o.minSpendCents)) errors.push('guardrails.minSpendCents: integer ≥ 0')
    else value.minSpendCents = o.minSpendCents
  }
  if (o.maxBidChangePct !== undefined) {
    const v = o.maxBidChangePct
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100) {
      errors.push('guardrails.maxBidChangePct: number in (0, 100]')
    } else value.maxBidChangePct = v
  }

  // An unknown key is almost always a typo for one of the enforced ones, and a
  // typo here fails open — the guardrail silently does nothing, which is the
  // exact class of bug this module exists to close.
  const known = new Set<string>(['note', ...ENFORCED_GUARDRAIL_KEYS])
  for (const k of Object.keys(o)) {
    if (!known.has(k)) errors.push(`guardrails.${k}: unknown key (known: ${[...known].join(', ')})`)
  }
  return { value, errors }
}

/** True when the guardrails would actually constrain anything. */
export function hasEnforceableGuardrails(g: RuleGuardrails): boolean {
  return ENFORCED_GUARDRAIL_KEYS.some((k) => g[k] !== undefined)
}

/** Apply the statistical floors. Returns true when the entity may be acted on. */
export function passesGuardrailFloors(
  g: RuleGuardrails,
  stats: { clicks?: number | null; spendCents?: number | null },
): boolean {
  if (g.minClicks != null && (stats.clicks ?? 0) < g.minClicks) return false
  if (g.minSpendCents != null && (stats.spendCents ?? 0) < g.minSpendCents) return false
  return true
}

/** Clamp a proposed value to ±maxBidChangePct of the current one. */
export function clampByGuardrail(g: RuleGuardrails, current: number, proposed: number): number {
  if (g.maxBidChangePct == null || current <= 0) return proposed
  const delta = current * (g.maxBidChangePct / 100)
  return Math.max(current - delta, Math.min(current + delta, proposed))
}

/** Trim a candidate list to maxActionsPerRun. Returns the kept slice and how many were held back. */
export function capActions<T>(g: RuleGuardrails, candidates: T[]): { kept: T[]; withheld: number } {
  if (g.maxActionsPerRun == null || candidates.length <= g.maxActionsPerRun) {
    return { kept: candidates, withheld: 0 }
  }
  return { kept: candidates.slice(0, g.maxActionsPerRun), withheld: candidates.length - g.maxActionsPerRun }
}
