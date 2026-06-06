/**
 * M3 — Exact-mirror computation (pure).
 *
 * Given the image slots Nexus has FILLED for one ASIN plus the full
 * schema-discovered taxonomy, compute what to send Amazon so its image set
 * matches Nexus EXACTLY:
 *   - `slots`       — the filled images, COMPACTED to contiguous PT/PS indices
 *                     (in the operator's order) so Amazon renders them in the
 *                     same order with no gaps.
 *   - `deleteSlots` — every WRITABLE taxonomy slot Nexus does NOT fill (so the
 *                     count matches), minus MAIN (Amazon-required, never deleted).
 *   - `skip`        — true when Nexus has no MAIN for the ASIN. CRITICAL SAFETY:
 *                     an ASIN with no MAIN is skipped entirely (never wiped) —
 *                     so a product that hasn't been set up in Nexus is left
 *                     untouched on Amazon rather than cleared.
 */

export interface FilledSlot {
  slot: string
  url: string
}

export interface TaxonomySlotLite {
  slot: string
  kind: 'MAIN' | 'OTHER' | 'SWATCH' | 'SAFETY' | 'NAMED'
  writable: boolean
}

export interface ExactMirrorResult {
  slots: FilledSlot[]
  deleteSlots: string[]
  skip: boolean
}

/** Trailing numeric index of a slot code (PT03 → 3, PS02 → 2); 0 otherwise. */
function slotIndex(slot: string): number {
  const m = slot.match(/(\d+)$/)
  return m ? Number(m[1]) : 0
}

type Family = 'MAIN' | 'PT' | 'PS' | 'SWCH' | 'OTHER'

function familyOf(slot: string, taxonomy: TaxonomySlotLite[]): Family {
  if (slot === 'MAIN') return 'MAIN'
  if (slot === 'SWCH') return 'SWCH'
  const t = taxonomy.find((s) => s.slot === slot)
  if (t?.kind === 'SAFETY' || /^PS\d+$/i.test(slot)) return 'PS'
  if (t?.kind === 'OTHER' || /^PT\d+$/i.test(slot)) return 'PT'
  if (t?.kind === 'SWATCH') return 'SWCH'
  if (t?.kind === 'MAIN') return 'MAIN'
  return 'OTHER'
}

/**
 * Re-pack filled slots so PT and PS families occupy contiguous indices
 * (PT01, PT02… / PS01, PS02…) in the operator's order — eliminating gaps so
 * Amazon's display order matches Nexus exactly. MAIN/SWCH keep their codes.
 */
export function compactSlots(filled: FilledSlot[], taxonomy: TaxonomySlotLite[]): FilledSlot[] {
  const byFamily = (f: Family) => filled.filter((s) => familyOf(s.slot, taxonomy) === f)
  const ordered = (f: Family) => byFamily(f).slice().sort((a, b) => slotIndex(a.slot) - slotIndex(b.slot))

  const out: FilledSlot[] = []
  for (const m of byFamily('MAIN')) out.push({ slot: 'MAIN', url: m.url })
  ordered('PT').forEach((s, i) => out.push({ slot: `PT${String(i + 1).padStart(2, '0')}`, url: s.url }))
  ordered('PS').forEach((s, i) => out.push({ slot: `PS${String(i + 1).padStart(2, '0')}`, url: s.url }))
  for (const s of byFamily('SWCH')) out.push({ slot: 'SWCH', url: s.url })
  for (const s of byFamily('OTHER')) out.push({ slot: s.slot, url: s.url }) // rare; keep as-is
  return out
}

/**
 * Compute the exact-mirror feed plan for one ASIN. Pure.
 */
export function computeExactMirror(filled: FilledSlot[], taxonomy: TaxonomySlotLite[]): ExactMirrorResult {
  const hasMain = filled.some((s) => s.slot === 'MAIN')
  if (!hasMain) {
    // SAFETY: never wipe an ASIN Nexus hasn't set up (no MAIN).
    return { slots: [], deleteSlots: [], skip: true }
  }
  const slots = compactSlots(filled, taxonomy)
  const filledCodes = new Set(slots.map((s) => s.slot))
  const deleteSlots = taxonomy
    .filter((t) => t.writable && t.slot !== 'MAIN' && !filledCodes.has(t.slot))
    .map((t) => t.slot)
  return { slots, deleteSlots, skip: false }
}
