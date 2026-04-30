/**
 * Variation parser & attribute-name inference.
 *
 * Detects parent/child variation groups from Amazon-style product titles.
 * Each variation child is titled identically to its parent + a trailing
 * parenthetical of comma-separated attribute values, e.g.:
 *
 *   parent: "XAVIA AIRMESH Giacca Moto Uomo – Estiva Traspirante"
 *   child:  "XAVIA AIRMESH Giacca Moto Uomo – Estiva Traspirante (Uomo, Nero, M)"
 *
 * The values inside the parenthetical are positional and unlabelled;
 * inferAttributeName() classifies each position by inspecting the values
 * across all sibling rows in the group:
 *
 *   {S, M, L, XL, 3XL}  → "Size"
 *   {44, 46, 48, 50}    → "Size"
 *   {Uomo, Donna}       → "Body Type"
 *   {Nero, Bianco, Crema E Vino} → "Color"
 *   {Pelle, Rete}       → "Material"
 *   anything else       → "Attribute"
 *
 * The classifier is multilingual (Italian + English) because the live
 * catalog is Italian-language.
 */

// ── Title parsing ───────────────────────────────────────────────────────

export interface ParsedTitle {
  baseName: string
  attrs: string[]
}

const TRAILING_PAREN = /^(.+?)\s*\(([^()]+)\)\s*$/
const MAX_ATTR_LEN = 60 // longer parens are descriptive prose, not attrs

export function parseTitle(title: string): ParsedTitle {
  const trimmed = (title ?? '').trim()
  const m = trimmed.match(TRAILING_PAREN)
  if (!m) return { baseName: trimmed, attrs: [] }
  const inside = m[2].trim()
  if (inside.length > MAX_ATTR_LEN) return { baseName: trimmed, attrs: [] }
  const attrs = inside
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return { baseName: m[1].trim(), attrs }
}

// ── Attribute name inference ────────────────────────────────────────────

const SIZE_ALPHA = new Set([
  'xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl',
  '2xl', '3xl', '4xl', '5xl', '6xl',
  'one size', 'one-size', 'onesize',
])

const BODY_TYPE_WORDS = new Set([
  'uomo', 'donna', 'unisex', 'men', 'women', 'kids', 'bambino', 'bambina',
  'ragazzo', 'ragazza', 'man', 'woman', 'boy', 'girl',
])

const COLOR_WORDS_SINGLE = new Set([
  // English
  'black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple',
  'pink', 'gray', 'grey', 'brown', 'beige', 'cream', 'navy', 'gold', 'silver',
  // Italian
  'nero', 'bianco', 'rosso', 'blu', 'verde', 'giallo', 'arancione', 'arancia',
  'viola', 'rosa', 'grigio', 'marrone', 'crema', 'vino', 'azzurro', 'celeste',
  'oro', 'argento', 'beige',
])

// Compound color phrases (case-insensitive)
const COMPOUND_COLOR_RE = /(crema\s+e\s+vino|nero\s+neo|navy\s+blue|royal\s+blue|forest\s+green|sky\s+blue)/i

const MATERIAL_WORDS = new Set([
  'leather', 'pelle', 'cotton', 'cotone', 'polyester', 'poliestere',
  'mesh', 'rete', 'nylon', 'kevlar', 'cordura', 'denim', 'jeans',
])

const isAlphaSize = (v: string) => SIZE_ALPHA.has(v.toLowerCase())
const isNumericSize = (v: string) => /^\d+(\.\d+)?$/.test(v)
const isSize = (v: string) => isAlphaSize(v) || isNumericSize(v)
const isBodyType = (v: string) => BODY_TYPE_WORDS.has(v.toLowerCase())
const isColor = (v: string) => {
  const lc = v.toLowerCase()
  if (COMPOUND_COLOR_RE.test(lc)) return true
  // Single-word: any token in the value matches a known color word
  const tokens = lc.split(/\s+/)
  return tokens.length <= 3 && tokens.every((t) => COLOR_WORDS_SINGLE.has(t))
}
const isMaterial = (v: string) => {
  const lc = v.toLowerCase()
  const tokens = lc.split(/\s+/)
  return tokens.some((t) => MATERIAL_WORDS.has(t))
}

/**
 * Classify a column of attribute values by majority vote.
 * Returns "Size" / "Body Type" / "Color" / "Material" / "Attribute".
 *
 * The set is allowed to mix some unrecognised values (e.g. "Standard")
 * but the dominant pattern wins. Threshold: 60% of values must match.
 */
export function inferAttributeName(values: Set<string> | string[]): string {
  const arr = [...values].map((v) => v.trim()).filter(Boolean)
  if (arr.length === 0) return 'Attribute'

  const counts = {
    size: arr.filter(isSize).length,
    bodyType: arr.filter(isBodyType).length,
    color: arr.filter(isColor).length,
    material: arr.filter(isMaterial).length,
  }
  const threshold = Math.ceil(arr.length * 0.6)

  // Pick the highest-scoring category that clears the threshold.
  // Order matters when ties happen: bodyType is most distinctive (small
  // closed vocabulary), then size (also closed), then color, then material.
  const ranked: Array<[number, string]> = [
    [counts.bodyType, 'Body Type'],
    [counts.size, 'Size'],
    [counts.color, 'Color'],
    [counts.material, 'Material'],
  ]
  ranked.sort((a, b) => b[0] - a[0])
  if (ranked[0][0] >= threshold) return ranked[0][1]
  return 'Attribute'
}

// ── Group detection ─────────────────────────────────────────────────────

export interface ProductLite {
  id: string
  sku: string
  name: string
  amazonAsin: string | null
  totalStock?: number | null
}

export interface VariationGroup {
  /** The parent's full name, used as group key */
  baseName: string
  /** Existing parent product if one with name === baseName exists */
  parentProduct: ProductLite | null
  /** Inferred name for each positional attribute, e.g. ["Body Type", "Color", "Size"] */
  attributeNames: string[]
  /** Children with their per-child structured variation map */
  children: Array<{
    product: ProductLite
    rawAttrs: string[]
    variations: Record<string, string>
  }>
}

/**
 * Build variation groups from a product list.
 *
 * Algorithm:
 *  1. Parse each product's title.
 *  2. Children = products whose title had attrs.
 *  3. For each unique baseName referenced by 2+ children:
 *     a. Look up an existing parent (a product whose name === baseName,
 *        no attrs) — that's the real Amazon parent listing if it was imported.
 *     b. Pad ragged attribute counts: if some siblings have 2 attrs and
 *        others have 3, align them by their position.
 *     c. For each attribute position, infer a name from the value set.
 *     d. Re-key each child's attrs to the inferred names.
 */
export function detectGroups(products: ProductLite[]): VariationGroup[] {
  type Parsed = ProductLite & { baseName: string; attrs: string[] }
  const parsed: Parsed[] = products.map((p) => {
    const { baseName, attrs } = parseTitle(p.name)
    return { ...p, baseName, attrs }
  })

  // Index potential parents (no attrs) by exact baseName.
  const parentByBase = new Map<string, Parsed>()
  for (const p of parsed) {
    if (p.attrs.length === 0 && !parentByBase.has(p.baseName)) {
      parentByBase.set(p.baseName, p)
    }
  }

  // Bucket children by baseName.
  const childrenByBase = new Map<string, Parsed[]>()
  for (const p of parsed) {
    if (p.attrs.length === 0) continue
    const arr = childrenByBase.get(p.baseName) ?? []
    arr.push(p)
    childrenByBase.set(p.baseName, arr)
  }

  // Build groups
  const groups: VariationGroup[] = []
  for (const [baseName, members] of childrenByBase) {
    if (members.length < 2) continue

    const numAttrs = Math.max(...members.map((m) => m.attrs.length))

    // Infer name for each positional attribute
    const attributeNames: string[] = []
    for (let i = 0; i < numAttrs; i++) {
      const valuesAtPosition = new Set<string>()
      for (const m of members) {
        const v = m.attrs[i]
        if (v) valuesAtPosition.add(v)
      }
      attributeNames.push(inferAttributeName(valuesAtPosition))
    }

    // Disambiguate duplicate names ("Color", "Color" → "Color", "Color (2)")
    // Rare in practice but happens when both colors and patterns coexist.
    const seen = new Map<string, number>()
    for (let i = 0; i < attributeNames.length; i++) {
      const name = attributeNames[i]
      const c = (seen.get(name) ?? 0) + 1
      seen.set(name, c)
      if (c > 1) attributeNames[i] = `${name} (${c})`
    }

    // Re-key each child's attrs to inferred names
    const children = members.map((m) => {
      const variations: Record<string, string> = {}
      for (let i = 0; i < attributeNames.length; i++) {
        const v = m.attrs[i]
        if (v !== undefined) variations[attributeNames[i]] = v
      }
      return { product: m, rawAttrs: m.attrs, variations }
    })

    groups.push({
      baseName,
      parentProduct: parentByBase.get(baseName) ?? null,
      attributeNames,
      children,
    })
  }

  // Sort largest groups first
  groups.sort((a, b) => b.children.length - a.children.length)
  return groups
}
