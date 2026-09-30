/**
 * PES.1 — parsing PES.5's readiness response.
 *
 * Extracted from the hook so the risky part is testable without a browser or a live API. It is
 * risky because it is the one place a wire value becomes a percentage on a chip, and the failure
 * mode is silent: a coerced `null`, a numeric string, or a `NaN` that renders as `0%` states "we
 * checked and everything required is missing" about a scope nobody scored.
 */

import { SCOPE_READINESS_STATES } from '@/design-system/grid/renderers/readiness'
import { getBackendUrl } from '@/lib/backend-url'
import type { ReadinessMatrixEntry, ScopeReadiness } from './types'

/** The four states the scope vocabulary allows. Anything else is a contract change, not a value. */
const SCOPE_STATES = new Set<string>(SCOPE_READINESS_STATES)

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
      ...(Array.isArray(s.languages) ? { languages: s.languages.filter((entry): entry is NonNullable<ScopeReadiness['languages']>[number] => !!entry && typeof entry.language === 'string' && SCOPE_STATES.has(entry.state) && (entry.pct === null || typeof entry.pct === 'number' && Number.isFinite(entry.pct))) } : {}),
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

/** The matrix uses the same percentage/state parser as the scope chips. */
export function parseReadinessMatrix(json: unknown): ReadinessMatrixEntry[] {
  const rows = (json as { matrix?: unknown } | null)?.matrix
  if (!Array.isArray(rows)) return []
  return rows.flatMap(raw => {
    if (!raw || typeof raw !== 'object' || typeof raw.coordinateKey !== 'string' || typeof raw.language !== 'string' || typeof raw.label !== 'string') return []
    if (!['channel', 'market', 'accountId', 'aliasId'].every(key => raw[key] === null || typeof raw[key] === 'string')) return []
    const score = parseReadinessResponse({ scopes: [{ ...raw, id: 'entry' }] }).entry
    // A-45 — `kind` survives only as a string, `requiredEmpty` only as a literal `true`: a flag that arrives as
    // "yes" or 1 is a contract change, and reading it as true would name a field "empty" that nobody measured.
    const missing = Array.isArray(raw.missing) ? raw.missing
      .filter((m: Record<string, unknown>) => m && ['productId','field','label','reason'].every(key => typeof m[key] === 'string'))
      .map((m: Record<string, unknown>) => ({ productId: m.productId as string, field: m.field as string, label: m.label as string, reason: m.reason as string,
        ...(typeof m.kind === 'string' ? { kind: m.kind } : {}), ...(m.requiredEmpty === true ? { requiredEmpty: true as const } : {}) })) : []
    /**
     * LX.FIN (R-LX-22) — the per-product verdicts, parsed with the SAME strictness as the chip above and
     * for the same reason: these become a CELL in every row of the master sheet's per-coordinate readiness
     * column, and a coerced value there states a measurement nobody took. An entry whose state is not in
     * the scope vocabulary, or whose `pct` is not a finite number or `null`, is DROPPED — and a dropped
     * entry reads as `Not computed`, which is the truth about it.
     */
    const byProduct: NonNullable<ReadinessMatrixEntry['byProduct']> = {}
    const rawByProduct = raw.byProduct
    if (rawByProduct && typeof rawByProduct === 'object' && !Array.isArray(rawByProduct)) {
      for (const [productId, value] of Object.entries(rawByProduct as Record<string, unknown>)) {
        if (!productId || !value || typeof value !== 'object') continue
        const v = value as Record<string, unknown>
        if (typeof v.state !== 'string' || !SCOPE_STATES.has(v.state)) continue
        const pct = typeof v.pct === 'number' && Number.isFinite(v.pct) ? v.pct : null
        // A-45 — the product's own required counts only when BOTH are finite numbers (a half-count would put a
        // number on the card nobody measured), and its age only as a string.
        const req = v.required as { filled?: unknown; total?: unknown } | undefined
        const required = req && typeof req.filled === 'number' && Number.isFinite(req.filled) && typeof req.total === 'number' && Number.isFinite(req.total)
          ? { filled: req.filled, total: req.total } : undefined
        // Progress columns (2026-09-26) — the optional side, with the same strictness: a half-count is dropped, and a
        // dropped or absent side is left OUT and reads as NOT RECORDED, never as "nothing optional is empty".
        const opt = v.optional as { filled?: unknown; total?: unknown } | null | undefined
        const optional = opt && typeof opt.filled === 'number' && Number.isFinite(opt.filled) && typeof opt.total === 'number' && Number.isFinite(opt.total)
          ? { filled: opt.filled, total: opt.total } : null
        byProduct[productId] = { pct, state: v.state as ScopeReadiness['state'], ...(typeof v.note === 'string' ? { note: v.note } : {}),
          ...(required ? { required } : {}), ...(optional ? { optional } : {}), ...(typeof v.computedAt === 'string' ? { computedAt: v.computedAt } : {}) }
      }
    }
    const optionalMissing = Array.isArray(raw.optionalMissing) ? raw.optionalMissing
      .filter((m: Record<string, unknown>) => m && ['productId', 'field', 'label'].every(key => typeof m[key] === 'string'))
      .map((m: Record<string, unknown>) => ({ productId: m.productId as string, field: m.field as string, label: m.label as string })) : []
    return [{ ...score, coordinateKey: raw.coordinateKey, channel: raw.channel, market: raw.market, accountId: raw.accountId, aliasId: raw.aliasId,
      language: raw.language, label: raw.label, missing, optionalMissing, byProduct, computedAt: typeof raw.computedAt === 'string' ? raw.computedAt : null }]
  })
}

/**
 * P2 (2026-09-30, I4-9) — merge a readiness read of ONE coordinate (`?only=coordinate`, asked after a save) into the
 * family-wide answer the scope menu shows. Only that channel's chip and that coordinate's matrix entries are taken from
 * the new answer: whatever else it carries (a partial Shared chip, another channel, or — before the API honours
 * `only` — the whole family again) leaves the rest of the menu exactly as it was read.
 */
export function mergeCoordinateReadiness<T extends { byScope: Readonly<Record<string, ScopeReadiness>>; matrix: ReadinessMatrixEntry[] }>(
  previous: T, json: unknown, coordinate: { channel: string; market: string; accountId?: string | null },
): T {
  const scopes = parseReadinessResponse(json)
  const mine = (entry: ReadinessMatrixEntry) => entry.channel === coordinate.channel && entry.market === coordinate.market &&
    (coordinate.accountId == null || entry.accountId === coordinate.accountId)
  const fresh = parseReadinessMatrix(json).filter(mine)
  const replaced = new Set(fresh.map((entry) => `${entry.coordinateKey}\u0000${entry.language}`))
  return {
    ...previous,
    byScope: scopes[coordinate.channel] ? { ...previous.byScope, [coordinate.channel]: scopes[coordinate.channel] } : previous.byScope,
    matrix: fresh.length ? [...previous.matrix.filter((entry) => !replaced.has(`${entry.coordinateKey}\u0000${entry.language}`)), ...fresh] : previous.matrix,
  }
}

/** The readiness read. `only: 'coordinate'` asks for the one channel coordinate a save moved (P2, I4-9). */
export function readinessUrl(productId: string, q: { market: string; locale?: string | null; channel?: string; listingId?: string; accountId?: string; only?: 'coordinate' }): string {
  const params = new URLSearchParams({ market: q.market })
  if (q.locale) params.set('locale', q.locale)
  if (q.channel) params.set('channel', q.channel)
  if (q.listingId) params.set('listingId', q.listingId)
  if (q.accountId) params.set('accountId', q.accountId)
  if (q.only) params.set('only', q.only)
  return `${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/readiness?${params}`
}
