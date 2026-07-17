/**
 * EI.2 — block/family detection + per-block decisions for eBay imports (pure).
 *
 * The Nexus multi-listing file model: ONE eBay listing = one block = a parent
 * row + its child rows (children link via parent_sku; every row of a block
 * carries the block's live Item ID when the listing exists on eBay). The same
 * child SKU may appear in several blocks — that is the owner's shared-stock
 * model, and it must be reviewed, not guessed:
 *
 *  • blocks with a live Item ID default to ADOPT (memberships on save — the
 *    listing is never re-created; the push-side adopt belt enforces this too)
 *  • blocks without one default to CREATE (a real publish creates them)
 *  • any block can be SKIPPED (its rows never enter the grid)
 *
 * Pool analysis: SKUs appearing in ≥2 non-skipped blocks pool stock; if any
 * such block's parent is not flagged shared, the import would re-trip the
 * duplicate-SKU error — `markAllPooledShared` is the one-click fix.
 */

import { truthyFlag } from './validateRows.shared'

export type BlockDecision = 'adopt' | 'create' | 'skip'

export interface ImportBlockIssue {
  level: 'error' | 'warn'
  message: string
}

export interface ImportBlock {
  /** Stable key — the parent SKU (or the single row's SKU for standalone rows). */
  key: string
  parentSku: string
  title: string
  itemId: string
  /** Row indexes (into the import batch) belonging to this block, parent first. */
  rowIndexes: number[]
  childSkus: string[]
  variationTheme: string
  /** Parent row flagged shared (any truthy spelling). */
  shared: boolean
  /** True when this block has no parent row (single standalone row). */
  standalone: boolean
  decision: BlockDecision
  issues: ImportBlockIssue[]
}

export interface BlockAnalysis {
  blocks: ImportBlock[]
  /** SKU → block keys it appears in (only SKUs present in ≥2 blocks). */
  pooledSkus: Map<string, string[]>
  /** True when the file has no block structure at all (flat list — no review step). */
  flat: boolean
  /** Pooled SKUs exist but ≥1 involved block is not flagged shared. */
  needsSharedFix: boolean
}

const str = (v: unknown): string => (v == null ? '' : String(v)).trim()

function isParentRow(r: Record<string, unknown>): boolean {
  const parentage = str(r.parentage).toLowerCase()
  if (parentage === 'parent') return true
  if (parentage === 'child' || parentage === 'variant') return false
  return r._isParent === true
}

function rowItemId(r: Record<string, unknown>): string {
  for (const key of Object.keys(r)) {
    if (/^(it|de|fr|es|uk)_item_id$/.test(key) || key === 'ebay_item_id') {
      const v = str(r[key])
      if (v) return v
    }
  }
  return ''
}

/**
 * Group mapped+coerced import rows into listing blocks. Grouping precedence:
 * children attach to the parent named by their parent_sku; rows without any
 * parentage/parent linkage but sharing a live Item ID with a parent join that
 * parent's block; everything else is standalone.
 */
export function detectImportBlocks(rows: Record<string, unknown>[]): BlockAnalysis {
  const blocks = new Map<string, ImportBlock>()
  const order: string[] = []

  const ensureBlock = (key: string, seed: Partial<ImportBlock>): ImportBlock => {
    let b = blocks.get(key)
    if (!b) {
      b = {
        key,
        parentSku: seed.parentSku ?? key,
        title: seed.title ?? '',
        itemId: seed.itemId ?? '',
        rowIndexes: [],
        childSkus: [],
        variationTheme: seed.variationTheme ?? '',
        shared: seed.shared ?? false,
        standalone: seed.standalone ?? false,
        decision: 'create',
        issues: [],
      }
      blocks.set(key, b)
      order.push(key)
    }
    return b
  }

  // Pass 1 — parents anchor blocks.
  const parentSkus = new Set<string>()
  rows.forEach((r, i) => {
    if (!isParentRow(r)) return
    const sku = str(r.sku)
    if (!sku) return
    parentSkus.add(sku)
    const b = ensureBlock(sku, {
      parentSku: sku,
      title: str(r.title),
      itemId: rowItemId(r),
      variationTheme: str(r.variation_theme),
      shared: truthyFlag(r.shared_sku_listing),
    })
    b.rowIndexes.unshift(i)
    if (!b.title) b.title = str(r.title)
    if (!b.itemId) b.itemId = rowItemId(r)
    if (!b.shared) b.shared = truthyFlag(r.shared_sku_listing)
  })

  // Item ID → block key (for rows that link only by Item ID).
  const blockKeyByItemId = new Map<string, string>()
  for (const b of blocks.values()) if (b.itemId) blockKeyByItemId.set(b.itemId, b.key)

  // Pass 2 — children + standalone rows.
  const orphanIndexes: number[] = []
  rows.forEach((r, i) => {
    if (isParentRow(r)) return
    const sku = str(r.sku)
    const parentSku = str(r.parent_sku)
    if (parentSku && blocks.has(parentSku)) {
      const b = blocks.get(parentSku)!
      b.rowIndexes.push(i)
      if (sku) b.childSkus.push(sku)
      if (!b.itemId) b.itemId = rowItemId(r)
      return
    }
    if (parentSku && !blocks.has(parentSku)) {
      orphanIndexes.push(i)
      return
    }
    const viaItem = rowItemId(r) ? blockKeyByItemId.get(rowItemId(r)) : undefined
    if (viaItem) {
      const b = blocks.get(viaItem)!
      b.rowIndexes.push(i)
      if (sku) b.childSkus.push(sku)
      return
    }
    // Standalone single-row listing.
    if (sku) {
      const b = ensureBlock(sku, {
        parentSku: sku,
        title: str(r.title),
        itemId: rowItemId(r),
        standalone: true,
        shared: truthyFlag(r.shared_sku_listing),
      })
      b.rowIndexes.push(i)
    }
  })

  // Orphans: parent_sku names a parent that is NOT in this file. They can
  // still update existing grid rows — keep them in a synthetic block per
  // missing parent so the operator sees them explicitly.
  const orphansByParent = new Map<string, number[]>()
  for (const i of orphanIndexes) {
    const p = str(rows[i].parent_sku)
    if (!orphansByParent.has(p)) orphansByParent.set(p, [])
    orphansByParent.get(p)!.push(i)
  }
  for (const [parentSku, idxs] of orphansByParent) {
    const b = ensureBlock(parentSku, { parentSku, standalone: false })
    b.rowIndexes.push(...idxs)
    for (const i of idxs) {
      const sku = str(rows[i].sku)
      if (sku) b.childSkus.push(sku)
      if (!b.itemId) b.itemId = rowItemId(rows[i])
      if (!b.shared) b.shared = truthyFlag(rows[i].shared_sku_listing)
    }
    b.issues.push({
      level: 'warn',
      message: `Parent "${parentSku}" is not in this file — rows update that family if it exists in the grid, otherwise a parent is created on save`,
    })
  }

  const list = order.map((k) => blocks.get(k)!)

  // Pool analysis across non-skip blocks (all blocks at detection time).
  const skuBlocks = new Map<string, string[]>()
  for (const b of list) {
    for (const sku of b.childSkus) {
      if (!skuBlocks.has(sku)) skuBlocks.set(sku, [])
      const arr = skuBlocks.get(sku)!
      if (!arr.includes(b.key)) arr.push(b.key)
    }
    // A standalone row's own SKU can also pool with other blocks' children.
    if (b.standalone) {
      const own = b.parentSku
      if (!skuBlocks.has(own)) skuBlocks.set(own, [])
      const arr = skuBlocks.get(own)!
      if (!arr.includes(b.key)) arr.push(b.key)
    }
  }
  const pooledSkus = new Map([...skuBlocks].filter(([, keys]) => keys.length >= 2))

  // Defaults + per-block issues.
  let needsSharedFix = false
  for (const b of list) {
    b.decision = b.itemId ? 'adopt' : 'create'
    const pooled = b.childSkus.some((s) => pooledSkus.has(s)) || (b.standalone && pooledSkus.has(b.parentSku))
    if (pooled && !b.shared) {
      needsSharedFix = true
      b.issues.push({
        level: 'error',
        message: 'Shares SKUs with other listings but is not flagged Shared-SKU — publish would block with duplicate-SKU errors',
      })
    }
    if (!b.standalone && b.childSkus.length > 1 && !b.variationTheme) {
      b.issues.push({ level: 'warn', message: 'No variation theme — variants will not group on eBay' })
    }
    if (b.rowIndexes.length > 0 && !b.standalone && b.childSkus.length === 0) {
      b.issues.push({ level: 'warn', message: 'Parent without children in this file' })
    }
  }

  const flat = list.every((b) => b.standalone) && pooledSkus.size === 0
  return { blocks: list, pooledSkus, flat, needsSharedFix }
}

/**
 * One-click fix: flag every pooled block's parent row as shared. Returns NEW
 * row objects (never mutates) and updated blocks.
 */
export function markAllPooledShared(
  rows: Record<string, unknown>[],
  analysis: BlockAnalysis,
): { rows: Record<string, unknown>[]; blocks: ImportBlock[] } {
  const pooledBlockKeys = new Set([...analysis.pooledSkus.values()].flat())
  const out = rows.map((r) => ({ ...r }))
  const blocks = analysis.blocks.map((b) => ({ ...b, issues: [...b.issues] }))
  for (const b of blocks) {
    if (!pooledBlockKeys.has(b.key) || b.shared) continue
    b.shared = true
    b.issues = b.issues.filter((i) => !i.message.includes('not flagged Shared-SKU'))
    const parentIdx = b.rowIndexes[0]
    if (parentIdx != null && out[parentIdx]) out[parentIdx].shared_sku_listing = true
    // Children carry the flag too in the export format — keep them consistent.
    for (const i of b.rowIndexes.slice(1)) if (out[i]) out[i].shared_sku_listing = true
  }
  return { rows: out, blocks }
}

/** Rows surviving the block decisions (skip-filtered), in original order. */
export function applyBlockDecisions(
  rows: Record<string, unknown>[],
  blocks: ImportBlock[],
): Record<string, unknown>[] {
  const skipped = new Set<number>()
  for (const b of blocks) {
    if (b.decision === 'skip') for (const i of b.rowIndexes) skipped.add(i)
  }
  return rows.filter((_, i) => !skipped.has(i))
}
