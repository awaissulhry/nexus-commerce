/**
 * D2 — the single source of truth for "which bulksheet columns can we write".
 *
 * THE BUG THIS EXISTS TO KILL. `preview.ts` kept its own `*_FIELDS` lists and
 * `apply.ts` kept its own mapping code. They disagreed: preview offered
 * `Campaign name`, `Portfolio ID` and `Ad group name` as editable diffs; apply
 * mapped only status, budget, bidding strategy and default bid.
 *
 * A name-ONLY edit was visible — apply produced an empty patch and recorded
 * SKIPPED. The silent case was a MIXED row: edit budget *and* name, the budget
 * populates the patch, the row reports APPLIED with `_status: ok`, `_baseline`
 * refreshes from the re-read entity, and the rename is gone while the file now
 * asserts it succeeded.
 *
 * Adding the missing mappings would have fixed the instance and left the class:
 * two hand-maintained lists with nothing forcing agreement. So preview now
 * DERIVES its field lists from this map. A column that cannot be applied cannot
 * be previewed, by construction, and the invariant test that enforces it is
 * cheap because there is only one list to check.
 */

import { parseMoney, parseVocabulary } from '@nexus/shared/ads-bulksheet'

/** Which write service a row's entity is applied through. */
export type ApplyTargetKind = 'campaign' | 'adGroup' | 'adTarget' | 'portfolio'

/**
 * One writable column. `apply` mutates the patch and returns an error string to
 * fail the row, or null on success — mirroring how apply.ts already reports.
 */
export interface FieldMapping {
  column: string
  apply: (patch: Record<string, unknown>, raw: string) => string | null
}

const STATE_TO_DB: Record<string, 'ENABLED' | 'PAUSED' | 'ARCHIVED'> = {
  enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED',
}
const STRATEGY_TO_DB: Record<string, 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'> = {
  'Dynamic bids - down only': 'LEGACY_FOR_SALES',
  'Dynamic bids - up and down': 'AUTO_FOR_SALES',
  'Fixed bid': 'MANUAL',
}

/** State is shared by all three entity kinds and behaves identically. */
const stateField: FieldMapping = {
  column: 'State',
  apply: (patch, raw) => {
    const mapped = STATE_TO_DB[raw.trim().toLowerCase()]
    if (!mapped) return `State "${raw}" is not one we can write`
    patch.status = mapped
    return null
  },
}

const money = (label: string, assign: (patch: Record<string, unknown>, v: number) => void): FieldMapping => ({
  column: label,
  apply: (patch, raw) => {
    const m = parseMoney(raw)
    if ('error' in m) return `${label}: ${m.error}`
    assign(patch, m.value)
    return null
  },
})

/** A plain string column. Empty is meaningful for portfolioId (detach). */
const text = (label: string, key: string, opts: { allowEmpty?: boolean } = {}): FieldMapping => ({
  column: label,
  apply: (patch, raw) => {
    const v = raw.trim()
    if (!v && !opts.allowEmpty) return `${label} cannot be blank`
    patch[key] = opts.allowEmpty && !v ? null : v
    return null
  },
})

export const FIELD_MAP: Record<ApplyTargetKind, FieldMapping[]> = {
  campaign: [
    stateField,
    money('Daily budget', (p, v) => { p.dailyBudget = v }),
    // D2 — these three were previewed and never written.
    text('Campaign name', 'name'),
    text('Portfolio ID', 'portfolioId', { allowEmpty: true }),
    {
      column: 'Bidding strategy',
      apply: (patch, raw) => {
        const canonical = parseVocabulary('biddingStrategy', raw)
        const mapped = canonical ? STRATEGY_TO_DB[canonical] : undefined
        if (!mapped) return `Bidding strategy "${raw}" is not one we can write`
        patch.biddingStrategy = mapped
        return null
      },
    },
  ],
  /**
   * AX-IE.2 — portfolios, from Amazon's real sheet.
   *
   * State is deliberately ABSENT. Amazon labels it "State (Informational only)"
   * on its own Portfolios sheet, so it is read-only there; offering it would
   * invite an edit that can never apply. Same for "In Budget".
   */
  portfolio: [
    text('Portfolio name', 'name'),
    money('Budget amount', (p, v) => { p.budgetAmount = v }),
    text('Budget currency code', 'budgetCurrencyCode'),
    text('Budget policy', 'budgetPolicy'),
    text('Budget start date', 'startDate', { allowEmpty: true }),
    text('Budget end date', 'endDate', { allowEmpty: true }),
  ],
  adGroup: [
    stateField,
    text('Ad group name', 'name'),
    money('Ad Group Default Bid', (p, v) => { p.defaultBidCents = Math.round(v * 100) }),
  ],
  adTarget: [
    stateField,
    money('Bid', (p, v) => { p.bidCents = Math.round(v * 100) }),
  ],
}

/** The columns preview may diff, derived so it can never exceed what apply writes. */
export const FIELDS_BY_KIND: Record<ApplyTargetKind, readonly string[]> = {
  portfolio: FIELD_MAP.portfolio.map((f) => f.column),
  campaign: FIELD_MAP.campaign.map((f) => f.column),
  adGroup: FIELD_MAP.adGroup.map((f) => f.column),
  adTarget: FIELD_MAP.adTarget.map((f) => f.column),
}

/**
 * Columns that are editable in the schema but deliberately NOT writable here,
 * with the reason. Kept explicit so "why did my edit do nothing?" has an answer
 * in code rather than in someone's memory.
 *
 * `Keyword text` and `Match type` are immutable on Amazon: changing either means
 * archive + create, which mints a new target id and destroys that target's
 * performance history. That is a real decision with a real cost, so it belongs
 * in the Create work where the consequence can be shown — not silently
 * implemented as if it were an update.
 */
export const NON_WRITABLE_REASONS: Record<string, string> = {
  'Keyword text': 'Immutable on Amazon — changing it means archive + create, which resets the target id and loses its performance history.',
  'Match type': 'Immutable on Amazon — changing it means archive + create, which resets the target id and loses its performance history.',
  'Campaign ID': 'Identity column, not an editable value.',
  'Ad group ID': 'Identity column, not an editable value.',
  'Keyword ID': 'Identity column, not an editable value.',
}

/**
 * Apply every mapped column present in `next` onto a patch.
 * Returns the first error, or null. Columns absent from `next` are untouched.
 */
export function applyFields(
  kind: ApplyTargetKind,
  patch: Record<string, unknown>,
  next: (column: string) => string | null | undefined,
): string | null {
  for (const f of FIELD_MAP[kind]) {
    const raw = next(f.column)
    if (raw == null) continue
    const err = f.apply(patch, raw)
    if (err) return err
  }
  return null
}
