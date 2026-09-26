/**
 * P3 (docs/attributes/PLAN.md §4.1) — a stand-in for `familyHierarchyService` in tests that fake family resolution.
 *
 * Production code resolves many families at once (`resolveEffectiveAttributesMany`). Tests written before it faked
 * only `resolveEffectiveAttributes(id)`; this stand-in builds the batch form from that same fake, one call per family,
 * so each test keeps its own family data.
 */
export function familyServiceMock(resolveEffectiveAttributes: (familyId: string) => unknown) {
  return {
    resolveEffectiveAttributes,
    resolveEffectiveAttributesMany: async (familyIds: readonly string[]) =>
      new Map(await Promise.all([...new Set(familyIds)].map(async id => [id, await resolveEffectiveAttributes(id)] as const))),
  }
}
