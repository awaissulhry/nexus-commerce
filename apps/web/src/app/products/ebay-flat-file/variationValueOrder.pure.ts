/**
 * Pure helpers for the VariationValueOrderModal.
 * Kept in a separate module so vitest can import them without loading
 * the full React component (VariationValueOrderModal.tsx) and its JSX / path-alias deps.
 *
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/VariationValueOrderModal.vitest.test.ts
 */

// ── Synonym groups (kept in sync with ebay-variation-push.service.ts) ─────
// Maps axis name aliases across languages to a stable key (__dim0__, __dim1__, …).
// Add new rows here as new axes are introduced; deriveAxes will auto-detect them.
export const AXIS_SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['colore', 'color', 'colour', 'color name', 'color_name', 'couleur', 'farbe', 'kleur', 'colour name', 'colori'],
  ['taglia', 'size', 'size name', 'size_name', 'misura', 'größe', 'grosse', 'taille', 'maat', 'maten', 'koko'],
  ['stile', 'style', 'style name', 'style_name'],
  ['materiale', 'material', 'material name', 'material_name'],
  ['genere', 'gender', 'department', 'target audience', 'target_audience'],
]

/** Maps an axis name to its stable storage key.
 *  Known synonym groups → __dim0__ / __dim1__ / …
 *  Custom/unmapped axes → lowercase axis name (the name itself is the stable key). */
export function axisSynonymKey(name: string): string {
  const lk = name.toLowerCase().trim()
  for (let i = 0; i < AXIS_SYNONYM_GROUPS.length; i++) {
    if ((AXIS_SYNONYM_GROUPS[i] as string[]).includes(lk)) return `__dim${i}__`
  }
  return lk
}

// ── Clothing/shoe size canonical order ────────────────────────────────────

export const STANDARD_SIZE_ORDER_MAP = new Map<string, number>(
  [
    'XXXS','XXS','XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL','5XL','6XL','7XL',
    '30','32','34','36','38','40','42','44','46','48','50','52','54','56','58','60','62','64',
    '33','34','35','35.5','36','36.5','37','37.5','38','38.5','39','39.5',
    '40','40.5','41','41.5','42','42.5','43','43.5','44','44.5','45','45.5','46','46.5','47','48',
    '1','1.5','2','2.5','3','3.5','4','4.5','5','5.5','6','6.5','7','7.5',
    '8','8.5','9','9.5','10','10.5','11','11.5','12','12.5','13','14','15',
  ].map((v, i) => [v.toUpperCase(), i] as [string, number]),
)

/** Sort values using the clothing/shoe canonical small → large order. */
export function sortClothing(values: string[]): string[] {
  return [...values].sort((a, b) => {
    const ai = STANDARD_SIZE_ORDER_MAP.get(a.toUpperCase()) ?? 9999
    const bi = STANDARD_SIZE_ORDER_MAP.get(b.toUpperCase()) ?? 9999
    return ai !== bi ? ai - bi : a.localeCompare(b)
  })
}

// ── Axis detection ────────────────────────────────────────────────────────

/** Minimal row shape required by deriveAxes — avoids importing EbayFlatFileClient. */
export interface AxisDetectRow {
  _isParent?: boolean
  parentage?: string
  [key: string]: unknown
}

export interface AxisEntry {
  /** Stable storage key: __dim0__ / __dim1__ / … or lowercase name for custom axes */
  key: string
  /** Human label — first axis name found in actual row data for this dimension */
  displayName: string
  /** All distinct values collected from all synonym aliases */
  values: string[]
}

/**
 * Scan variant rows for aspect_* columns, collapse synonym aliases into one entry per
 * semantic dimension. Returns one AxisEntry per dimension with >1 distinct value.
 *
 * Robustness: accepts both the legacy `_isParent === false` flag and the P2.B2
 * `parentage === 'child'` convention, so new-style child rows are never silently skipped.
 *
 * Any axis not in AXIS_SYNONYM_GROUPS gets its lowercase name as a stable key —
 * no hardcoding limit on the number of axes.
 */
export function deriveAxes(rows: AxisDetectRow[]): AxisEntry[] {
  // Include explicit variants (_isParent=false) AND P2.B2 child rows (parentage='child')
  // that haven't been back-filled with _isParent.
  const variantRows = rows.filter(
    (r) => r._isParent === false || r.parentage === 'child',
  )

  // synonymKey → { firstNameFound, all values }
  const groups = new Map<string, { displayName: string; values: Set<string> }>()

  for (const row of variantRows) {
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith('aspect_') || !v) continue
      // Convert column key back to axis name: aspect_Taglia → "Taglia"
      const rawName = k.slice('aspect_'.length).replace(/_/g, ' ').trim()
      if (!rawName) continue
      const val = String(v).trim()
      if (!val) continue

      const sk = axisSynonymKey(rawName)
      if (!groups.has(sk)) {
        groups.set(sk, { displayName: rawName, values: new Set() })
      }
      groups.get(sk)!.values.add(val)
    }
  }

  // Only keep dimensions with >1 distinct value (the true variation axes)
  const result: AxisEntry[] = []
  for (const [key, entry] of groups.entries()) {
    if (entry.values.size > 1) {
      result.push({ key, displayName: entry.displayName, values: [...entry.values] })
    }
  }
  return result
}
