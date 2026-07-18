/**
 * EI.5 — aspect header unification + category intelligence for eBay imports
 * (pure, fully testable).
 *
 * The Nexus export (and operator-built files) carry item specifics in TWO
 * spellings: the localized canonical set (`Taglia (Size)`, `Colore (Color)`)
 * and an English warning-suffixed twin set (`Size ⚠`, `Colore ⚠`) whose values
 * must stay identical. On import both must land on ONE canonical aspect
 * column (`aspect_Taglia`) — mapping them to two different columns would split
 * the axis and un-group live variants. `variantAttributes ⚠` is serialization
 * junk and is auto-skipped.
 *
 * Aspect columns are dynamic (per loaded category schema) and rows accept
 * arbitrary `aspect_*` keys (ghost columns) — so unmatched aspect-looking
 * headers get a SYNTHESIZED target column instead of being dropped.
 *
 * Category intelligence: non-numeric Category ID cells are flagged (the grid's
 * category search resolves names → ids; a push needs the numeric id), and
 * category-required item specifics missing from the file are reported per
 * category using the schema metadata the columns already carry
 * (`requiredForCategories`).
 */

export interface AspectDerivedTarget {
  target: string
  /** true when the target column does not exist yet (ghost — synthesize it). */
  synth: boolean
  /** headers folded into the same target (the EN twin), for the mapping note. */
  foldedFrom?: string
}

const canonKey = (name: string) => `aspect_${name.trim().replace(/\s+/g, '_')}`

/** Incident #29 — bare ENGLISH headers ("Color", "Size", "Brand") map to the
 *  LOCALIZED canonical aspect. MIRRORS apps/api/src/services/ebay-theme-axes.ts
 *  ASPECT_SYNONYM_GROUPS (keep both in sync); group[0] = canonical Italian.
 *  Unmapped headers (Team Name, Body Type…) still import — as their own ghost
 *  aspect columns, visible with ⚠. */
const IMPORT_ASPECT_SYNONYMS: ReadonlyArray<ReadonlyArray<string>> = [
  ['colore', 'color', 'colour', 'color name'],
  ['taglia', 'size', 'size name', 'misura'],
  ['stile', 'style', 'style name'],
  ['materiale', 'material', 'material name'],
  ['genere', 'gender', 'department'],
  ['marca', 'brand'],
  ['stagione', 'season'],
  ['paese di fabbricazione', 'country/region of manufacture', 'country of manufacture', 'made in'],
  ['tipo di giacca', 'jacket type'],
  ['tipo di prodotto', 'product type'],
  ['adatto a', 'suitable for'],
  ['livello di protezione', 'protection level'],
  ['reparto'],
  ['vestibilità', 'vestibilita', 'fit'],
]
const titleCase = (x: string) => x.replace(/^\w/, (c) => c.toUpperCase())
/** Localized canonical target for a bare header, resolved against known
 *  column ids case-insensitively; null when the header is no known synonym. */
export function synonymAspectTarget(header: string, knownColumnIds: Set<string>): string | null {
  const lower = header.trim().toLowerCase()
  const group = IMPORT_ASPECT_SYNONYMS.find((g) => (g as string[]).includes(lower))
  if (!group) return null
  const canonicalLower = group[0]
  const wanted = `aspect_${canonicalLower.replace(/ /g, '_')}`
  for (const id of knownColumnIds) {
    if (id.toLowerCase() === wanted) return id
  }
  return canonKey(titleCase(canonicalLower))
}

const PAIR_RE = /^(.+?)\s*\((.+?)\)$/
const WARN_RE = /^(.+?)\s*⚠$/
const JUNK_RE = /^variantAttributes\s*⚠?$/i

/**
 * Fallback mapping tier for headers the exact/normalized tiers missed.
 * Returns header → derived aspect target (or SKIP via `null`).
 */
export function deriveAspectMapping(
  headers: string[],
  knownColumnIds: Set<string>,
): Map<string, AspectDerivedTarget | null> {
  const out = new Map<string, AspectDerivedTarget | null>()

  // First pass — the localized pair set anchors canonical targets, keyed by
  // BOTH its primary (Taglia) and secondary (Size) names.
  const canonicalByName = new Map<string, string>() // lowercase name → target id
  for (const h of headers) {
    const pair = PAIR_RE.exec(h.trim())
    if (!pair) continue
    if (JUNK_RE.test(h.trim())) continue
    const primary = pair[1].trim()
    const secondary = pair[2].trim()
    const target = canonKey(primary)
    canonicalByName.set(primary.toLowerCase(), target)
    canonicalByName.set(secondary.toLowerCase(), target)
    out.set(h, { target, synth: !knownColumnIds.has(target) })
  }

  // Second pass — warning-suffixed twins fold into the canonical target when
  // one exists; otherwise they become their own aspect column.
  for (const h of headers) {
    const t = h.trim()
    if (JUNK_RE.test(t)) {
      out.set(h, null) // junk — skip
      continue
    }
    const warn = WARN_RE.exec(t)
    if (!warn || out.has(h)) continue
    const name = warn[1].trim()
    const canonical = canonicalByName.get(name.toLowerCase())
    if (canonical) {
      out.set(h, { target: canonical, synth: !knownColumnIds.has(canonical), foldedFrom: name })
    } else {
      const syn = synonymAspectTarget(name, knownColumnIds)
      const target = syn ?? canonKey(name)
      out.set(h, { target, synth: !knownColumnIds.has(target), ...(syn ? { foldedFrom: name } : {}) })
    }
  }

  // Third pass — BARE headers (no ⚠, no pair) that are language synonyms of a
  // localized aspect ("Color", "Brand", "Size") land on the canonical column
  // instead of spawning an English twin (incident #29).
  for (const h of headers) {
    const t = h.trim()
    if (out.has(h) || JUNK_RE.test(t) || PAIR_RE.test(t) || WARN_RE.test(t)) continue
    const anchored = canonicalByName.get(t.toLowerCase())
    if (anchored) {
      out.set(h, { target: anchored, synth: !knownColumnIds.has(anchored), foldedFrom: t })
      continue
    }
    const syn = synonymAspectTarget(t, knownColumnIds)
    if (syn) out.set(h, { target: syn, synth: !knownColumnIds.has(syn), foldedFrom: t })
  }

  return out
}

export interface CategoryAudit {
  rowIndex: number
  value: string
  message: string
}

/** Non-numeric Category ID cells — pushes need the numeric id. */
export function auditCategoryIds(rows: Record<string, unknown>[]): CategoryAudit[] {
  const out: CategoryAudit[] = []
  rows.forEach((r, i) => {
    const v = String(r.category_id ?? '').trim()
    if (v === '' || /^\d+$/.test(v)) return
    out.push({
      rowIndex: i,
      value: v,
      message: `Category "${v}" is not a numeric eBay category ID — use the grid's category search to resolve it before pushing`,
    })
  })
  return out
}

export interface MissingRequiredAspects {
  categoryId: string
  missing: string[] // column labels
}

/**
 * Per category id present in the import rows: required item-specific columns
 * (schema metadata on the columns) that neither arrive via the mapping nor
 * already carry a value on the import rows.
 */
export function findMissingRequiredAspectsForImport(
  rows: Record<string, unknown>[],
  columns: Array<{ id: string; label: string; requiredForCategories?: string[] }>,
  mappedTargetIds: Set<string>,
): MissingRequiredAspects[] {
  const categories = new Set<string>()
  for (const r of rows) {
    const v = String(r.category_id ?? '').trim()
    if (/^\d+$/.test(v)) categories.add(v)
  }
  if (categories.size === 0) return []

  const out: MissingRequiredAspects[] = []
  for (const cat of categories) {
    const required = columns.filter((c) => c.requiredForCategories?.includes(cat))
    if (required.length === 0) continue
    const missing: string[] = []
    for (const col of required) {
      if (mappedTargetIds.has(col.id)) continue
      const anyValue = rows.some((r) => String(r[col.id] ?? '').trim() !== '')
      if (!anyValue) missing.push(col.label)
    }
    if (missing.length > 0) out.push({ categoryId: cat, missing })
  }
  return out
}
