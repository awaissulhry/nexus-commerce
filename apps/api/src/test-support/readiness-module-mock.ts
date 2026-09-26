/**
 * P2 (docs/attributes/PLAN.md §4.7) — a stand-in for `services/pim/readiness-index.service.js` in tests that isolate
 * the bulk writer from the readiness rebuild.
 *
 * `applyProductBulkEdits` calls `produceReadinessForProducts(ids, scope)` (one query for every touched family). Tests
 * written before it mocked only `produceReadiness(id, scope?)` and assert on those calls. This stand-in keeps them
 * meaningful: the batch function calls the test's `produceReadiness` once per product, with the same arguments the old
 * per-product loop passed (no scope argument at all when there is no scope).
 */
export function readinessModuleMock(produceReadiness: (...args: unknown[]) => unknown, extra: Record<string, unknown> = {}) {
  return {
    produceReadiness,
    produceReadinessForProducts: async (productIds: string[], scope?: unknown) => {
      for (const id of productIds) await (scope ? produceReadiness(id, scope) : produceReadiness(id))
      return { inline: productIds.length, pending: 0 }
    },
    ...extra,
  }
}
