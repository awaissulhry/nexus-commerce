/**
 * P2 — resolve an Amazon issue's `attributeNames` to the editor's columns, so a
 * feed error can point at the exact cell(s). Pure + manifest-driven: a compound
 * attribute (e.g. `bullet_point`, `purchasable_offer`) expands to every matching
 * grid column; an unmapped attribute degrades gracefully to its raw name.
 */
import type { FeedIssueColumn } from '../feed-report-types.js'

export interface ManifestColumnLite { id: string; label: string }

export function resolveIssueColumns(
  attributeNames: string[],
  manifestColumns: ManifestColumnLite[],
): FeedIssueColumn[] {
  const out: FeedIssueColumn[] = []
  const seen = new Set<string>()
  const push = (id: string, label: string) => { if (!seen.has(id)) { seen.add(id); out.push({ id, label }) } }

  for (const raw of attributeNames) {
    const attr = String(raw ?? '').trim()
    if (!attr) continue

    // 1) exact column id
    const direct = manifestColumns.find((c) => c.id === attr)
    if (direct) { push(direct.id, direct.label); continue }

    // 2) expanded/numbered/compound columns: `bullet_point` → bullet_point_1..5,
    //    `purchasable_offer` → purchasable_offer__our_price, etc.
    const expanded = manifestColumns.filter(
      (c) => c.id.startsWith(`${attr}_`) || c.id.startsWith(`${attr}__`),
    )
    if (expanded.length) { for (const c of expanded) push(c.id, c.label); continue }

    // 3) graceful fallback — surface the raw attribute name so nothing is lost
    push(attr, attr)
  }
  return out
}
