/**
 * E2 — family-aware import planning (pure).
 *
 * The legacy import keyed rows by SKU alone (`bySku` last-wins) and stamped
 * every new row under ONE optional target parent — so a file describing the
 * owner's multi-listing model (N parents with different ItemIDs SHARING the
 * same child SKUs) collapsed into a single family and lost the duplicates.
 *
 * This planner groups the imported rows into families by `parent_sku`:
 *   • identity is (family, sku) — the same SKU may appear once per family;
 *   • an existing grid row only matches within the SAME family (the update
 *     branch still never re-parents);
 *   • a SKU that exists in the grid only under a DIFFERENT family is ADDED
 *     under its own family (the shared-SKU duplicate validator governs it);
 *   • new rows resolve their parent from the grid first (stamp its platform
 *     id), else from a parent row in the same file (link by parent_sku; the
 *     save pre-pass creates and links the products).
 */

export interface PlannedParent {
  sku: string
  /** Grid parent's platform/product id when the family already exists. */
  platformId?: string
  /** variation_theme used for aspect-splitting imported axis values. */
  theme: string
  /** True when the parent row comes from the imported file itself. */
  inFile: boolean
}

export interface ImportAction {
  kind: 'update' | 'add'
  imp: Record<string, unknown>
  /** kind 'update' — the grid row to merge into. */
  targetRowId?: string
  /** kind 'add' — the resolved family parent (null = standalone). */
  parent?: PlannedParent | null
  /** kind 'add' — this imported row IS a family parent. */
  isParent?: boolean
}

type Row = Record<string, unknown>
const str = (v: unknown): string => (v == null ? '' : String(v)).trim()

export function planFamilyImport(imported: Row[], gridRows: Row[]): ImportAction[] {
  // Parents present in the FILE: explicit parentage, or referenced as parent_sku.
  const referencedAsParent = new Set(imported.map((r) => str(r.parent_sku)).filter(Boolean))
  const importedParentBySku = new Map<string, Row>()
  for (const r of imported) {
    const sku = str(r.sku)
    if (!sku) continue
    if (str(r.parentage) === 'parent' || r._isParent === true || (referencedAsParent.has(sku) && !str(r.parent_sku))) {
      importedParentBySku.set(sku, r)
    }
  }

  // Grid indexes: rows by sku; family key per row (parents key by own sku,
  // children by parent_sku, standalone by '').
  const gridParentBySku = new Map<string, Row>()
  for (const g of gridRows) {
    const sku = str(g.sku)
    if (sku && (g._isParent === true || str(g.parentage) === 'parent')) gridParentBySku.set(sku, g)
  }
  const gridFamilyKey = (g: Row): string => {
    if (g._isParent === true || str(g.parentage) === 'parent') return str(g.sku)
    return str(g.parent_sku)
  }
  const gridBySku = new Map<string, Row[]>()
  for (const g of gridRows) {
    const sku = str(g.sku)
    if (!sku) continue
    if (!gridBySku.has(sku)) gridBySku.set(sku, [])
    gridBySku.get(sku)!.push(g)
  }

  const actions: ImportAction[] = []
  for (const imp of imported) {
    const sku = str(imp.sku)
    const parentSku = str(imp.parent_sku)
    const isParent = !parentSku && importedParentBySku.has(sku)
    const famKey = parentSku || (isParent ? sku : '')

    const candidates = sku ? (gridBySku.get(sku) ?? []) : []
    // Same-family match: with a family, match only rows in that family; a
    // standalone import row keeps the legacy any-match so plain price/content
    // files (no parent_sku column) still update in place.
    const exact = famKey
      ? candidates.find((g) => gridFamilyKey(g) === famKey)
      : candidates[0]
    if (exact) {
      actions.push({ kind: 'update', imp, targetRowId: str(exact._rowId) })
      continue
    }

    let parent: PlannedParent | null = null
    if (parentSku) {
      const gridParent = gridParentBySku.get(parentSku)
      if (gridParent) {
        parent = {
          sku: parentSku,
          platformId: str(gridParent._productId) || str(gridParent.platformProductId) || str(gridParent._rowId),
          theme: str(gridParent.variation_theme),
          inFile: false,
        }
      } else if (importedParentBySku.has(parentSku)) {
        parent = { sku: parentSku, theme: str(importedParentBySku.get(parentSku)!.variation_theme), inFile: true }
      }
    }
    actions.push({ kind: 'add', imp, parent, isParent })
  }
  return actions
}
