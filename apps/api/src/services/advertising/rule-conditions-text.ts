/**
 * One human reading of a rule's conditions, in a module with NO imports.
 *
 * 🔴 Why it lives alone. It began as an export from `budget-grid.service.ts`, pulled into the
 * assignment route with a dynamic `await import()`. On prod that threw **"Cannot access
 * 'conditionsTextOf' before initialization"** — a temporal-dead-zone error: the import resolved to
 * a module still part-way through evaluation via a circular chain, so the `const` was in its TDZ
 * even though the request ran long after boot. A pure formatter with zero dependencies cannot take
 * part in a cycle, so both callers import it statically.
 *
 * ── D2d (2026-08-20) — it printed DATABASE PATHS at operators ───────────────────────────────────
 * 🔴 Operator: *"the ui is still too bad"*. Measured on prod, this is what the assignment modal
 * and the Budget tab were showing a human:
 *
 *     campaign.acos ≤ 0.2 AND adTarget.spendCents ≥ 5000
 *
 * Two separate failures in one string. The FIELD is a database path — `campaign.acos`, and worse
 * `adTarget.spendCents`, which names a table. And the VALUE is in storage units — `0.2` for twenty
 * percent, `5000` for fifty euros. An operator reading that has to know both the schema and the
 * encoding to learn that the rule fires under a 20% ACoS. It now reads:
 *
 *     ACoS ≤ 20% and target spend ≥ €50
 *
 * The same law as "operators don't read Italian, so the UI is English": they do not read field
 * paths either. An unmapped field falls back to its raw path rather than being hidden — a
 * condition nobody can name is still a condition the rule evaluates, and dropping it would make
 * the rule look looser than it is.
 */

/** field path → how a human says it, and how its stored value should be read back. */
const FIELDS: Record<string, { label: string; unit: 'fraction' | 'cents' | 'multiple' | 'raw' }> = {
  'campaign.acos': { label: 'ACoS', unit: 'fraction' },
  'campaign.roas': { label: 'ROAS', unit: 'multiple' },
  'campaign.budgetUtilization': { label: 'Budget used', unit: 'fraction' },
  'campaign.spendCents': { label: 'Spend', unit: 'cents' },
  'campaign.salesCents': { label: 'Sales', unit: 'cents' },
  'campaign.clicks': { label: 'Clicks', unit: 'raw' },
  'campaign.impressions': { label: 'Impressions', unit: 'raw' },
  'campaign.orders': { label: 'Orders', unit: 'raw' },
  'campaign.ctr': { label: 'CTR', unit: 'fraction' },
  'campaign.cvr': { label: 'CVR', unit: 'fraction' },
  'adTarget.acos': { label: 'Target ACoS', unit: 'fraction' },
  'adTarget.spendCents': { label: 'Target spend', unit: 'cents' },
  'adTarget.salesCents': { label: 'Target sales', unit: 'cents' },
  'adTarget.clicks': { label: 'Target clicks', unit: 'raw' },
  'adTarget.orders': { label: 'Target orders', unit: 'raw' },
  'adTarget.cvr': { label: 'Target CVR', unit: 'fraction' },
  'adTarget.ctr': { label: 'Target CTR', unit: 'fraction' },
}

const OPS: Record<string, string> = { gte: '≥', lte: '≤', gt: '>', lt: '<', eq: '=', neq: '≠' }

/**
 * SG (2026-08-21) — rules have TWO stored shapes, and this formatter read only one. A
 * builder-authored rule nests its leaves one level down — `[{ match, lookback, exclude,
 * conditions: [{ metric, op, value }] }]` — so the group object hit the leaf path and the
 * Suggestions queue printed **"? ? undefined"** at the operator. Builder leaves carry the
 * builder's own metric vocabulary with values already in DISPLAY units (ACOS "30" is 30%,
 * Spend "50" is €50 — unlike the engine shape's storage units above). Vocabulary mirrors
 * `PerformanceCriteria.tsx`'s PC_METRIC_UNIT; kept inline because this module must stay
 * dependency-free (see the TDZ note at the top).
 */
const BUILDER_UNITS: Record<string, 'eur' | 'pct' | ''> = {
  Sales: 'eur', Spend: 'eur', CPC: 'eur', 'Current Bid': 'eur',
  ACOS: 'pct', CTR: 'pct', CVR: 'pct', 'Budget Utilization': 'pct',
  'Share of Voice': 'pct', 'Campaign Concentration': 'pct',
}
const BUILDER_LABELS: Record<string, string> = { ACOS: 'ACoS' }

function builderLeafText(metric: string, sym: string, raw: unknown): string {
  const label = BUILDER_LABELS[metric] ?? metric
  const n = Number(raw)
  if (!Number.isFinite(n)) return `${label} ${sym} ${String(raw)}`
  const unit = BUILDER_UNITS[metric] ?? ''
  return unit === 'eur' ? `${label} ${sym} €${n}` : unit === 'pct' ? `${label} ${sym} ${n}%` : `${label} ${sym} ${n}`
}

/** Storage units read back the way they are written on screen everywhere else in this product. */
function readValue(raw: unknown, unit: 'fraction' | 'cents' | 'multiple' | 'raw'): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return String(raw)
  switch (unit) {
    // 0.4 → 40%. `toFixed` then strip a trailing ".0" so 40% does not read "40.0%".
    case 'fraction': return `${Number((n * 100).toFixed(2))}%`
    case 'cents': return `€${(n / 100).toFixed(2).replace(/\.00$/, '')}`
    case 'multiple': return `${n}×`
    default: return String(n)
  }
}

export const conditionsTextOf = (conditions: unknown): string => {
  const list = (Array.isArray(conditions) ? conditions : []) as Array<Record<string, unknown>>
  if (!list.length) return 'No conditions — matches every context'
  return list.map((c) => {
    // Builder-nested group: recurse into its leaves; 'any' groups join with "or".
    if (Array.isArray(c.conditions)) {
      const inner = conditionsTextOf(c.conditions)
      return c.match === 'any' && (c.conditions as unknown[]).length > 1
        ? `(${inner.replace(/ and /g, ' or ')})` : inner
    }
    const op = String(c.operator ?? c.op ?? '?')
    const sym = OPS[op] ?? op
    const raw = c.value ?? c.threshold
    const field = String(c.field ?? c.metric ?? '?')
    const known = FIELDS[field]
    if (known) return `${known.label} ${sym} ${readValue(raw, known.unit)}`
    // A builder leaf names its metric in the builder's vocabulary, value in display units.
    if (c.metric != null && c.field == null) return builderLeafText(String(c.metric), sym, raw)
    // Unmapped: keep the path and the raw value. Better an ugly truth than a missing condition.
    return `${field} ${sym} ${String(raw)}`
  }).join(' and ')
}
