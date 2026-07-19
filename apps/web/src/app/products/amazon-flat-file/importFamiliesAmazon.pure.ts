/**
 * FFT.5b / AMX.1 — Amazon import family analysis (pure, mirrors the eBay
 * wizard's importBlocks.pure).
 *
 * Groups the mapped+coerced FILE rows into families (parentage_level /
 * parent_sku) and checks each family against the CURRENT grid for the four
 * integrity scenarios that previously slipped through unbadged:
 *   reparent        — a child the grid knows under a DIFFERENT parent
 *   orphan          — children whose parent exists neither in file nor grid
 *   type-mismatch   — a child's product type differs from the family's
 *   theme-mismatch  — a child's variation theme differs from the parent's
 *   incomplete      — a NEW family whose theme names an axis some children
 *                     leave blank (partial variation set)
 * The wizard renders one card per family with an Import/Skip decision; skipped
 * families are removed from the plan before anything is written.
 */

export interface AmazonFamilyBadge {
  kind: 'reparent' | 'orphan' | 'type-mismatch' | 'theme-mismatch' | 'incomplete'
  detail: string
}

export interface AmazonImportFamily {
  /** Parent SKU, or '(standalone)' for keyless rows. */
  key: string
  parentInFile: boolean
  /** Parent SKU unknown to the current grid → this import CREATES the family. */
  isNewFamily: boolean
  productType: string | null
  theme: string | null
  rowCount: number
  newCount: number
  updateCount: number
  /** Indexes into the file-rows array (the wizard filters the plan by these). */
  rowIndexes: number[]
  badges: AmazonFamilyBadge[]
}

const STANDALONE = '(standalone)'

const str = (v: unknown) => String(v ?? '').trim()
const lower = (v: unknown) => str(v).toLowerCase()

/** Theme token → the grid column that carries that axis's value. Only the
 *  universally-mapped axes are completeness-checked; unknown tokens are skipped. */
const AXIS_COLUMN: Record<string, string> = {
  size: 'size_name', sizename: 'size_name', size_name: 'size_name', taglia: 'size_name',
  color: 'color_name', colorname: 'color_name', color_name: 'color_name', colore: 'color_name',
}

function themeAxisColumns(theme: string): string[] {
  const tokens = theme.split(/[,/]+/).flatMap((t) => t.split(/[-_]/)).map((t) => lower(t)).filter(Boolean)
  const cols = new Set<string>()
  for (const t of tokens) {
    const col = AXIS_COLUMN[t.replace(/\s+/g, '')]
    if (col) cols.add(col)
  }
  return [...cols]
}

const sample = (items: string[], n = 3) =>
  items.slice(0, n).join(', ') + (items.length > n ? ` +${items.length - n} more` : '')

export function computeAmazonImportFamilies(
  fileRows: Array<Record<string, unknown>>,
  gridRows: Array<Record<string, unknown>>,
): AmazonImportFamily[] {
  const gridBySku = new Map<string, Record<string, unknown>>()
  for (const g of gridRows) {
    const sku = str(g.item_sku)
    if (sku && !gridBySku.has(sku)) gridBySku.set(sku, g)
  }

  interface Bucket { parentRowIdx: number | null; rows: Array<{ idx: number; row: Record<string, unknown> }> }
  const buckets = new Map<string, Bucket>()
  const bucketFor = (key: string): Bucket => {
    let b = buckets.get(key)
    if (!b) { b = { parentRowIdx: null, rows: [] }; buckets.set(key, b) }
    return b
  }

  fileRows.forEach((row, idx) => {
    const sku = str(row.item_sku)
    const parentage = lower(row.parentage_level)
    const parentSku = str(row.parent_sku)
    if (parentage === 'parent' && sku) {
      const b = bucketFor(sku)
      b.parentRowIdx = idx
      b.rows.push({ idx, row })
    } else if (parentSku) {
      bucketFor(parentSku).rows.push({ idx, row })
    } else {
      bucketFor(STANDALONE).rows.push({ idx, row })
    }
  })

  const families: AmazonImportFamily[] = []
  for (const [key, bucket] of buckets) {
    const isStandalone = key === STANDALONE
    const parentRow = bucket.parentRowIdx != null ? fileRows[bucket.parentRowIdx] : null
    const gridParent = isStandalone ? undefined : gridBySku.get(key)
    const children = bucket.rows.filter(({ idx }) => idx !== bucket.parentRowIdx)

    const familyType =
      str(parentRow?.product_type) || str(gridParent?.product_type) ||
      str(children.find(({ row }) => str(row.product_type))?.row.product_type) || null
    const familyTheme = str(parentRow?.variation_theme) || str(gridParent?.variation_theme) || null

    let newCount = 0
    for (const { row } of bucket.rows) if (!gridBySku.has(str(row.item_sku))) newCount++

    const badges: AmazonFamilyBadge[] = []

    if (!isStandalone) {
      // reparent — the grid knows a child under a DIFFERENT parent
      const reparented: string[] = []
      for (const { row } of children) {
        const g = gridBySku.get(str(row.item_sku))
        const gridParentSku = str(g?.parent_sku)
        if (g && gridParentSku && gridParentSku !== key) reparented.push(`${str(row.item_sku)}: ${gridParentSku} → ${key}`)
      }
      if (reparented.length) badges.push({ kind: 'reparent', detail: sample(reparented) })

      // orphan — parent exists neither in the file nor the grid
      if (!parentRow && !gridParent) {
        badges.push({ kind: 'orphan', detail: `parent ${key} is in neither this file nor the grid` })
      }

      // type-mismatch
      if (familyType) {
        const off = children
          .filter(({ row }) => str(row.product_type) && str(row.product_type).toUpperCase() !== familyType.toUpperCase())
          .map(({ row }) => `${str(row.item_sku)} (${str(row.product_type)})`)
        if (off.length) badges.push({ kind: 'type-mismatch', detail: `family is ${familyType}: ${sample(off)}` })
      }

      // theme-mismatch
      if (familyTheme) {
        const off = children
          .filter(({ row }) => str(row.variation_theme) && lower(row.variation_theme) !== lower(familyTheme))
          .map(({ row }) => `${str(row.item_sku)} (${str(row.variation_theme)})`)
        if (off.length) badges.push({ kind: 'theme-mismatch', detail: `family theme is ${familyTheme}: ${sample(off)}` })
      }

      // incomplete — NEW family whose theme axis columns are blank on children
      if (!gridParent && familyTheme && children.length > 0) {
        for (const col of themeAxisColumns(familyTheme)) {
          const missing = children.filter(({ row }) => !str(row[col])).map(({ row }) => str(row.item_sku) || '(no sku)')
          if (missing.length) badges.push({ kind: 'incomplete', detail: `${missing.length}/${children.length} children have no ${col}: ${sample(missing)}` })
        }
      }
    }

    families.push({
      key,
      parentInFile: bucket.parentRowIdx != null,
      isNewFamily: !isStandalone && !gridParent,
      productType: familyType,
      theme: familyTheme,
      rowCount: bucket.rows.length,
      newCount,
      updateCount: bucket.rows.length - newCount,
      rowIndexes: bucket.rows.map(({ idx }) => idx).sort((a, b) => a - b),
      badges,
    })
  }

  // Big families first; standalone bucket last.
  return families.sort((a, b) =>
    (a.key === STANDALONE ? 1 : 0) - (b.key === STANDALONE ? 1 : 0) || b.rowCount - a.rowCount)
}

/** Row indexes excluded by the operator's per-family Skip decisions. */
export function skippedRowIndexes(
  families: AmazonImportFamily[],
  skippedKeys: ReadonlySet<string>,
): Set<number> {
  const out = new Set<number>()
  for (const f of families) {
    if (!skippedKeys.has(f.key)) continue
    for (const idx of f.rowIndexes) out.add(idx)
  }
  return out
}
