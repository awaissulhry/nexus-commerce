'use client'

import type { BulkProduct } from '../BulkOperationsClient'

export type DisplayMode = 'flat' | 'hierarchy' | 'grouped'

const MODE_STORAGE_KEY = 'nexus_bulkops_displaymode'
const EXPANDED_STORAGE_KEY = 'nexus_bulkops_expanded'

export function loadDisplayMode(): DisplayMode {
  if (typeof window === 'undefined') return 'flat'
  const v = window.localStorage.getItem(MODE_STORAGE_KEY)
  if (v === 'hierarchy' || v === 'grouped') return v
  return 'flat'
}

export function saveDisplayMode(mode: DisplayMode) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(MODE_STORAGE_KEY, mode)
}

export function loadExpandedParents(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed) : new Set()
  } catch {
    return new Set()
  }
}

export function saveExpandedParents(s: Set<string>) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...s]))
}

export interface HierarchyMeta {
  level: number
  hasChildren: boolean
  childCount: number
  isExpanded: boolean
  /** Aggregates derived from children — only set on parents with kids. */
  aggregates?: {
    totalStock: number
    minPrice: number
    maxPrice: number
    activeChildren: number
  }
  /** Variation attributes lifted to the row for child-row badge rendering. */
  variations?: Record<string, string> | null
}

export interface HierarchyRow extends BulkProduct {
  _hier: HierarchyMeta
}

/**
 * Build a flat list of HierarchyRow, in display order:
 *
 *   parent_1
 *     [child_1.1 …]   (only if parent_1 is expanded)
 *     [child_1.2 …]
 *   parent_2
 *   …
 *
 * Standalone products (parentId === null AND no children) appear as
 * level=0 rows with hasChildren=false (no chevron, no indent).
 *
 * Children whose parentId points to a missing product are surfaced as
 * level=0 (defensive — shouldn't happen, but the alternative is hiding
 * them silently).
 */
export function buildHierarchy(
  products: BulkProduct[],
  expanded: Set<string>
): HierarchyRow[] {
  const productById = new Map(products.map((p) => [p.id, p]))
  const childrenByParent = new Map<string, BulkProduct[]>()

  for (const p of products) {
    if (p.parentId && productById.has(p.parentId)) {
      let arr = childrenByParent.get(p.parentId)
      if (!arr) {
        arr = []
        childrenByParent.set(p.parentId, arr)
      }
      arr.push(p)
    }
  }

  const out: HierarchyRow[] = []

  for (const p of products) {
    // Skip children at the top level — they render under their parent
    if (p.parentId && productById.has(p.parentId)) continue

    const kids = childrenByParent.get(p.id) ?? []
    const isExp = kids.length > 0 && expanded.has(p.id)

    out.push({
      ...p,
      _hier: {
        level: 0,
        hasChildren: kids.length > 0,
        childCount: kids.length,
        isExpanded: isExp,
        aggregates:
          kids.length > 0
            ? {
                totalStock: kids.reduce((s, c) => s + (c.totalStock ?? 0), 0),
                minPrice: kids.reduce(
                  (m, c) => Math.min(m, Number(c.basePrice ?? Infinity)),
                  Infinity
                ),
                maxPrice: kids.reduce(
                  (m, c) => Math.max(m, Number(c.basePrice ?? 0)),
                  0
                ),
                activeChildren: kids.filter((c) => c.status === 'ACTIVE').length,
              }
            : undefined,
      },
    })

    if (isExp) {
      for (const c of kids) {
        const variations = readVariations(c)
        out.push({
          ...c,
          _hier: {
            level: 1,
            hasChildren: false,
            childCount: 0,
            isExpanded: false,
            variations,
          },
        })
      }
    }
  }

  return out
}

/** Lift Product.variantAttributes (D.3 era) or
 * Product.categoryAttributes.variations (Phase 31 PIM era) onto a flat
 * Record for rendering. Returns null if neither shape contains values. */
function readVariations(p: BulkProduct): Record<string, string> | null {
  const va = (p as any).variantAttributes
  if (va && typeof va === 'object' && !Array.isArray(va)) {
    return va as Record<string, string>
  }
  const ca = (p as any).categoryAttributes
  if (
    ca &&
    typeof ca === 'object' &&
    !Array.isArray(ca) &&
    ca.variations &&
    typeof ca.variations === 'object'
  ) {
    return ca.variations as Record<string, string>
  }
  return null
}

export function aggregateDisplayValue(
  row: HierarchyRow,
  fieldId: string
): string | null {
  const agg = row._hier.aggregates
  if (!agg || row._hier.level !== 0) return null
  switch (fieldId) {
    case 'totalStock':
      return `${agg.totalStock.toLocaleString()}`
    case 'basePrice':
      if (agg.maxPrice === 0 && agg.minPrice === Infinity) return null
      if (agg.minPrice === agg.maxPrice) return `€${agg.minPrice.toFixed(2)}`
      return `€${agg.minPrice.toFixed(2)} – €${agg.maxPrice.toFixed(2)}`
    default:
      return null
  }
}

export function isAggregatableField(fieldId: string): boolean {
  return fieldId === 'totalStock' || fieldId === 'basePrice'
}
