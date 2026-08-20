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
    const field = String(c.field ?? c.metric ?? '?')
    const op = String(c.operator ?? c.op ?? '?')
    const raw = c.value ?? c.threshold
    const known = FIELDS[field]
    const sym = OPS[op] ?? op
    // Unmapped: keep the path and the raw value. Better an ugly truth than a missing condition.
    if (!known) return `${field} ${sym} ${String(raw)}`
    return `${known.label} ${sym} ${readValue(raw, known.unit)}`
  }).join(' and ')
}
