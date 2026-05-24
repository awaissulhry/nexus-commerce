// EC.9 — Category-specific health gates.
//
// Some eBay categories require additional aspects beyond what eBay's
// own schema endpoint marks as "required" — these are the soft gates
// operators care about for SEO / compliance / buyer expectation.
// Examples:
//   • Helmets — buyers + EU regulators want ECE certification visible
//   • Jackets — protection level + CE certification drive search rank
//   • Boots / gloves — CE certification is the search filter buyers use
//
// Match by name substring (case-insensitive) against category name OR
// category path. Each rule names one or more aspect labels (any of
// which satisfy the gate — eBay localises aspect names per
// marketplace so we accept several spellings).

export interface CategoryGate {
  /** Human-readable rule name surfaced in the health rail. */
  label: string
  /** Substring match against categoryName OR categoryPath, case-
   *  insensitive. The first matching rule applies. */
  matches: string[]
  /** Aspect names that satisfy the gate (any one is enough). Localised
   *  variants belong here so an IT operator's "Marca" satisfies the
   *  same gate as an UK operator's "Brand". Matched case-insensitive
   *  against aspect keys in platformAttributes.itemSpecifics. */
  needsAnyOf: string[]
  /** Points awarded toward the health score (max 10 across all gates).
   *  Higher = more important. */
  weight: number
}

export const CATEGORY_GATES: CategoryGate[] = [
  // ── Motorcycle helmets ──────────────────────────────────────────
  {
    label: 'ECE certification (helmet)',
    matches: ['helmet', 'casco'],
    needsAnyOf: ['ECE Approval', 'ECE Rating', 'Certification', 'Omologazione', 'Certificazione'],
    weight: 5,
  },
  {
    label: 'Helmet type',
    matches: ['helmet', 'casco'],
    needsAnyOf: ['Helmet Type', 'Style', 'Tipologia', 'Tipo'],
    weight: 3,
  },
  {
    label: 'Riding style',
    matches: ['helmet', 'casco'],
    needsAnyOf: ['Riding Style', 'Style', 'Stile'],
    weight: 2,
  },

  // ── Motorcycle jackets ──────────────────────────────────────────
  {
    label: 'CE protection (jacket)',
    matches: ['jacket', 'giacca', 'giubbotto'],
    needsAnyOf: ['Protection', 'CE Rating', 'Certification', 'Protezione', 'Certificazione'],
    weight: 5,
  },
  {
    label: 'Outer material',
    matches: ['jacket', 'giacca', 'giubbotto'],
    needsAnyOf: ['Material', 'Outer Material', 'Materiale'],
    weight: 3,
  },
  {
    label: 'Season / weather',
    matches: ['jacket', 'giacca', 'giubbotto'],
    needsAnyOf: ['Season', 'Weather', 'Stagione'],
    weight: 2,
  },

  // ── Gloves ──────────────────────────────────────────────────────
  {
    label: 'CE certification (gloves)',
    matches: ['glove', 'guanto', 'guanti'],
    needsAnyOf: ['Certification', 'CE Rating', 'Certificazione'],
    weight: 5,
  },
  {
    label: 'Glove type',
    matches: ['glove', 'guanto', 'guanti'],
    needsAnyOf: ['Type', 'Style', 'Tipo'],
    weight: 3,
  },

  // ── Boots ───────────────────────────────────────────────────────
  {
    label: 'CE certification (boots)',
    matches: ['boot', 'stivali', 'stivale'],
    needsAnyOf: ['Certification', 'CE Rating', 'Certificazione'],
    weight: 5,
  },
  {
    label: 'Waterproofing',
    matches: ['boot', 'stivali', 'stivale'],
    needsAnyOf: ['Waterproof', 'Water Resistance', 'Impermeabile'],
    weight: 3,
  },

  // ── General apparel fallback ────────────────────────────────────
  {
    label: 'Size chart present',
    matches: ['apparel', 'clothing', 'wear', 'abbigliamento'],
    needsAnyOf: ['Size Type', 'Size', 'Taglia'],
    weight: 2,
  },
]

/** Resolve the gates that apply to a given category (matched by name
 *  + path). Returns at most `cap` gates so the rail doesn't get
 *  swamped on a multi-rule category like "Motorcycle Helmets". */
export function applicableGates(
  categoryName: string | null,
  categoryPath: string | null,
  cap = 4,
): CategoryGate[] {
  const haystack = [(categoryName ?? '').toLowerCase(), (categoryPath ?? '').toLowerCase()].join(' ')
  if (!haystack.trim()) return []
  const matched: CategoryGate[] = []
  const seen = new Set<string>()
  for (const gate of CATEGORY_GATES) {
    if (seen.has(gate.label)) continue
    for (const m of gate.matches) {
      if (haystack.includes(m.toLowerCase())) {
        matched.push(gate)
        seen.add(gate.label)
        break
      }
    }
    if (matched.length >= cap) break
  }
  return matched
}

/** True when itemSpecifics has a non-empty value for ANY of the
 *  candidate aspect names (case-insensitive). */
export function gateSatisfied(
  itemSpecifics: Record<string, unknown>,
  needsAnyOf: string[],
): boolean {
  const lowered: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(itemSpecifics)) {
    lowered[k.toLowerCase()] = v
  }
  // Aspect keys are stored as "aspect_<name with underscores>" in
  // platformAttributes; aspect labels are "Brand (Marca)" etc.
  // Normalise both sides to bare lowered words for the match.
  function normalise(s: string): string {
    return s.toLowerCase().replace(/^aspect_/, '').replace(/_/g, ' ').trim()
  }
  const normalisedKeys = Object.keys(lowered).map(normalise)
  for (const candidate of needsAnyOf) {
    const c = normalise(candidate)
    for (const k of normalisedKeys) {
      // Match either as substring OR contained-in-key (e.g. "Brand
      // (Marca)" → key "brand (marca)" satisfies candidate "brand").
      if (k.includes(c) || c.includes(k)) {
        const original = Object.keys(lowered).find((kk) => normalise(kk) === k)
        if (!original) continue
        const value = lowered[original]
        if (Array.isArray(value) && value.length > 0 && String(value[0]).trim().length > 0) return true
        if (typeof value === 'string' && value.trim().length > 0) return true
      }
    }
  }
  return false
}
