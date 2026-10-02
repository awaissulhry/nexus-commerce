/**
 * MCP full control 07 — "stale refused": an approved change runs only while the world is still the one its preview
 * showed. A change tool's `execute` re-runs its own dry run and compares the fields that make the decision with the
 * preview the person approved (`ctx.approvedPreview`, C1); any difference refuses the run with what moved, and nothing
 * changes. The approval gate's own check (MATERIAL_PREVIEW_FIELDS) reads the same fields.
 */

/** One text per value whatever the order of its keys (a stored preview comes back from jsonb with its keys re-ordered). */
function canonical(value: unknown): string | undefined {
  const plain = JSON.stringify(value)
  if (plain === undefined) return undefined
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(plain)))
}

/** The fields of `fields` whose value differs between the approved preview and the fresh one. */
export function movedSince(approved: unknown, fresh: unknown, fields: readonly string[]): string[] {
  const a = (approved ?? {}) as Record<string, unknown>
  const f = (fresh ?? {}) as Record<string, unknown>
  return fields.filter((field) => canonical(a[field]) !== canonical(f[field]))
}

/** The refusal of a run whose approval no longer describes the world, or null when nothing moved (or nothing was approved). */
export function staleRefusal(approved: unknown, fresh: unknown, fields: readonly string[], what: string): string | null {
  if (approved === undefined || approved === null) return null
  const moved = movedSince(approved, fresh, fields)
  return moved.length
    ? `Not changed: ${what} changed since you approved it (${moved.join(', ')}). Ask again to see it as it is now.`
    : null
}
