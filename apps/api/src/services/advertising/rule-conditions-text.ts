/**
 * D2b-fix (2026-08-20) — one human reading of a rule's conditions, in a module with NO imports.
 *
 * 🔴 Why it lives alone. It began as an export from `budget-grid.service.ts`, pulled into the
 * assignment route with a dynamic `await import()`. On prod that threw **"Cannot access
 * 'conditionsTextOf' before initialization"** — a temporal-dead-zone error: the import resolved to
 * a module still part-way through evaluation via a circular chain, so the `const` was in its TDZ
 * even though the request ran long after boot. The endpoint 500'd and the modal, which could not
 * tell a failed load from an empty one, told the operator "No budget rule exists yet" while six
 * existed.
 *
 * A pure formatter with zero dependencies cannot take part in a cycle, so both callers now import
 * it statically and neither can be caught by that again. Duplicating the function into the route
 * would also have worked and was rejected: two formatters drift the first time an operator
 * compares the modal with the Budget tab.
 */
export const conditionsTextOf = (conditions: unknown): string => {
  const list = (Array.isArray(conditions) ? conditions : []) as Array<Record<string, unknown>>
  if (!list.length) return 'No conditions — matches every context'
  return list.map((c) => {
    const field = String(c.field ?? c.metric ?? '?')
    const op = String(c.operator ?? c.op ?? '?')
    const value = c.value ?? c.threshold
    const sym = op === 'gte' ? '≥' : op === 'lte' ? '≤' : op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'eq' ? '=' : op
    return `${field} ${sym} ${String(value)}`
  }).join(' AND ')
}
