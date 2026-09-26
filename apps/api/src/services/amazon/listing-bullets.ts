/**
 * CHMAP M7 (B4) — an Amazon listing's bullet points as plain text, for the Amazon → eBay pre-fill. The old read looked
 * only at top-level `bullet_points` / `bulletPoints`, which Nexus does not write, so bullets were never copied. Read
 * order: those old keys (unchanged where they exist), then Amazon's stored `attributes.bullet_point` values, then the
 * listing's own bullets.
 */
export function amazonListingBullets(listing: { platformAttributes?: unknown; bulletPointsOverride?: readonly string[] | null }): string[] {
  const text = (values: unknown): string[] => (Array.isArray(values) ? values : [])
    .map(v => (typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { value?: unknown }).value : undefined))
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  const attrs = (listing.platformAttributes && typeof listing.platformAttributes === 'object' ? listing.platformAttributes : {}) as Record<string, unknown>
  const legacy = attrs.bullet_points ?? attrs.bulletPoints
  if (Array.isArray(legacy) && legacy.length) return legacy as string[]
  const stored = text((attrs.attributes as Record<string, unknown> | undefined)?.bullet_point)
  return stored.length ? stored : text(listing.bulletPointsOverride)
}
