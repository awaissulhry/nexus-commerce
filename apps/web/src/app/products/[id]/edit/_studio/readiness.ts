/**
 * PES.1 — parsing PES.5's readiness response.
 *
 * Extracted from the hook so the risky part is testable without a browser or a live API. It is
 * risky because it is the one place a wire value becomes a percentage on a chip, and the failure
 * mode is silent: a coerced `null`, a numeric string, or a `NaN` that renders as `0%` states "we
 * checked and everything required is missing" about a scope nobody scored.
 */

import type { ScopeReadiness } from './types'

/** The four states the scope vocabulary allows. Anything else is a contract change, not a value. */
const SCOPE_STATES = new Set(['ready', 'warn', 'blocked', 'absent'])

/**
 * `{ scopes: [...] }` → `{ [scopeId]: ScopeReadiness }`.
 *
 * Deliberately strict in one direction only: a row it cannot understand is DROPPED (the chip then
 * renders its own `absent` with "not scored in this response"), never guessed at. Nothing here can
 * invent a percentage.
 */
export function parseReadinessResponse(json: unknown): Record<string, ScopeReadiness> {
  const out: Record<string, ScopeReadiness> = {}
  // Read as `unknown`, not as the declared response type: this runs against a wire, and typing the
  // input as the shape we HOPE for is what makes a defensive parser stop being one.
  const scopes = (json as { scopes?: unknown } | null)?.scopes
  if (!Array.isArray(scopes)) return out

  for (const raw of scopes as unknown[]) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as Record<string, unknown>
    if (typeof s.id !== 'string' || !s.id) continue

    // 🔴 Only a real, finite number is a percentage. `"92"`, `null`, `undefined` and `NaN` are all
    // "not scored" — coercing any of them is how a chip starts lying with a number.
    const pct = typeof s.pct === 'number' && Number.isFinite(s.pct) ? s.pct : null

    const state =
      typeof s.state === 'string' && SCOPE_STATES.has(s.state)
        ? (s.state as ScopeReadiness['state'])
        : 'absent'

    const req = s.required as { filled?: unknown; total?: unknown } | undefined
    const required =
      req && typeof req.filled === 'number' && typeof req.total === 'number'
        ? { filled: req.filled, total: req.total }
        : undefined

    out[s.id] = {
      pct,
      state,
      required,
      // Same strictness as `pct`: only a real finite number counts. `0` is meaningful here — it is
      // the "no rules configured" discriminator — so it must survive, exactly as a measured 0% does.
      mappingRules:
        typeof s.mappingRules === 'number' && Number.isFinite(s.mappingRules) ? s.mappingRules : null,
      // 🔴 Verbatim. The server's sentence names BOTH the coordinate and the product type and
      // carries two variables; re-templating it here would produce a second, drifting wording for
      // the same refusal (PES.5 §11 rule 1).
      note: typeof s.note === 'string' ? s.note : undefined,
    }
  }
  return out
}
