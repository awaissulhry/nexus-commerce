/**
 * P1.1 — eBay flat-file create/reparent pure decision logic.
 *
 * PURE MODULE — no prisma, no fastify, no network. All DB knowledge
 * arrives via function arguments (existingBySku, existingParentById).
 *
 * A later task (P1.2) wires these to the PATCH /api/ebay/flat-file/rows
 * route and the prisma write path.
 *
 * Key background fact (ebay-variation-push.service.ts:1423):
 *   buildFlatRow sets platformProductId = product.parentId ?? product.id
 *   → for a CHILD:  platformProductId = parentId  (points to parent)
 *   → for a PARENT: platformProductId = product.id (points to self)
 *
 * Aspect key derivation mirrors :523-553 in ebay-variation-push.service.ts
 * so stored variantAttributes keys line up with what push validates.
 */

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type EbayRow = Record<string, unknown>

/** Shape returned by buildEbayProductCreateInput; suitable for prisma.product.create({ data }) */
export type ProductCreateData = {
  sku: string
  name: string
  basePrice: number         // P1.2 wraps in new Decimal(); kept as number here
  totalStock: number
  status: string
  syncChannels: string[]
  importSource: string
  localizedContent: Record<string, Record<string, unknown>>
  brand?: string
  isParent?: boolean
  variationTheme?: string | null
  variationAxes?: string[]
  parentId?: string         // intentionally absent (not undefined-typed) for parents
  variantAttributes?: Record<string, string>
  categoryAttributes?: { variations: Record<string, string> }
}

export type ExistingProduct = {
  id: string
  parentId: string | null
  variationTheme: string | null
  isParent: boolean
}

export type ExistingParent = {
  id: string
  variationTheme: string | null
  isParent: boolean
}

export type CreatePlan = {
  parentCreates: Array<{
    tempRowId: string
    sku: string
    row: EbayRow
    variationTheme: string | null
  }>
  childCreates: Array<{
    tempRowId: string
    sku: string
    row: EbayRow
    parentRef: { kind: 'temp'; tempRowId: string } | { kind: 'existing'; productId: string }
    variationTheme: string | null
  }>
  reparents: Array<{
    productId: string
    sku: string
    newParentId: string | null
  }>
  errors: Array<{ sku?: string; tempRowId?: string; reason: string }>
  warnings: Array<{ sku?: string; reason: string }>
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Canonical aspect key derivation matching ebay-variation-push.service.ts:535-537.
 *   key1 = `aspect_${name.replace(/\s+/g,'_')}`
 *   key2 = `aspect_${name.toLowerCase().replace(/\s+/g,'_')}`
 *   val  = row[key1] ?? row[key2]
 */
function readAspectValue(row: EbayRow, axisName: string): string {
  const key1 = `aspect_${axisName.replace(/\s+/g, '_')}`
  const key2 = `aspect_${axisName.toLowerCase().replace(/\s+/g, '_')}`
  const raw = row[key1] ?? row[key2]
  return String(raw ?? '').trim()
}

/**
 * Infer whether a row is a child (vs parent/standalone).
 *
 * Rule from brief (mirrors ebay-variation-push.service.ts:286-291):
 *   selfId = _productId ?? _rowId ?? ''
 *   ppid   = platformProductId ?? ''
 *   child  ⟺  ppid !== '' && ppid !== selfId
 */
function inferIsChild(row: EbayRow): { isChild: boolean; selfId: string; ppid: string } {
  const selfId = String(row._productId ?? row._rowId ?? '')
  const ppid = String(row.platformProductId ?? '')
  const isChild = ppid !== '' && ppid !== selfId
  return { isChild, selfId, ppid }
}

/**
 * P2.A — Explicit-first row classification.
 *
 * Reads `parentage` + `parent_sku` columns first; falls back to the
 * `platformProductId` heuristic when `parentage` is absent/undefined.
 *
 *  parentage='child'           → isChild=true; parentSku from parent_sku (non-empty)
 *  parentage='parent' | ''     → isChild=false (explicit non-child)
 *  parentage absent/undefined  → ppid heuristic via inferIsChild (back-compat)
 */
function classifyRow(row: EbayRow): {
  isChild: boolean
  /** Non-null only when explicit parent_sku is present and non-empty. */
  parentSku: string | null
  selfId: string
  ppid: string
  /** True when parentage is 'parent', 'child', or '' (any explicit value). */
  hasExplicitParentage: boolean
} {
  const selfId = String(row._productId ?? row._rowId ?? '')
  const ppid = String(row.platformProductId ?? '')
  const parentSkuRaw = row.parent_sku
  const parentSku =
    parentSkuRaw !== undefined && String(parentSkuRaw).trim() !== ''
      ? String(parentSkuRaw).trim()
      : null

  if (row.parentage === 'child') {
    return { isChild: true, parentSku, selfId, ppid, hasExplicitParentage: true }
  }
  if (row.parentage === 'parent' || row.parentage === '') {
    return { isChild: false, parentSku: null, selfId, ppid, hasExplicitParentage: true }
  }
  // parentage absent/undefined → ppid heuristic (back-compat)
  const { isChild } = inferIsChild(row)
  return { isChild, parentSku: null, selfId, ppid, hasExplicitParentage: false }
}

/** Parse the first non-empty price field in eBay field priority order. */
function parsePriceFields(row: EbayRow): number {
  const fields = ['it_price', 'de_price', 'fr_price', 'es_price', 'uk_price', 'price'] as const
  for (const field of fields) {
    const raw = row[field]
    if (raw !== undefined && raw !== null && raw !== '') {
      const n = Number(raw)
      if (!isNaN(n)) return n
    }
  }
  return 0
}

// ──────────────────────────────────────────────────────────────────────
// Exported functions
// ──────────────────────────────────────────────────────────────────────

/**
 * Extract variant axis values from an eBay flat-file row.
 *
 * For each axis name, reads the value using the canonical two-key
 * lookup (key1 = aspect_<Name_with_underscores>,
 *           key2 = aspect_<name_lowercased_underscores>).
 * Keyed by the axis name exactly as given. Empty values are omitted.
 * De-duplication is implicit: each axis name yields at most one entry.
 */
export function extractVariantAttributes(
  row: EbayRow,
  axisNames: string[],
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of axisNames) {
    const val = readAspectValue(row, name)
    if (val) {
      result[name] = val
    }
  }
  return result
}

/**
 * Build a plain-object product-create payload for an eBay flat-file row.
 *
 * Suitable to pass directly to prisma.product.create({ data }) in P1.2
 * (P1.2 wraps basePrice in new Decimal() and adds importedAt).
 */
export function buildEbayProductCreateInput(
  row: EbayRow,
  opts: { parentId: string | null; variationTheme: string | null; isParent: boolean },
): ProductCreateData {
  const sku = String(row.sku ?? '').trim()
  const name = String(row.title ?? '').trim() || sku
  const basePrice = parsePriceFields(row)
  const brand = row.brand != null && String(row.brand).trim() ? String(row.brand).trim() : undefined

  const data: ProductCreateData = {
    sku,
    name,
    basePrice,
    totalStock: 0,
    status: 'ACTIVE',
    syncChannels: ['EBAY'],
    importSource: 'EBAY_FLAT_FILE',
    localizedContent: { en: {}, it: {} },
  }

  if (brand) data.brand = brand

  if (opts.isParent) {
    data.isParent = true
    if (opts.variationTheme) {
      data.variationTheme = opts.variationTheme
      const axes = opts.variationTheme.split(',').map(s => s.trim()).filter(Boolean)
      if (axes.length) data.variationAxes = axes
    }
    // parentId intentionally absent for parents
  } else {
    data.isParent = false
    if (opts.parentId) data.parentId = opts.parentId
    if (opts.variationTheme) data.variationTheme = opts.variationTheme

    // Extract variant attributes using the axis names from variationTheme
    const axisNames = opts.variationTheme
      ? opts.variationTheme.split(',').map(s => s.trim()).filter(Boolean)
      : []
    if (axisNames.length) {
      const attrs = extractVariantAttributes(row, axisNames)
      if (Object.keys(attrs).length) {
        data.variantAttributes = attrs
        data.categoryAttributes = { variations: attrs }
      }
    }
  }

  return data
}

/**
 * Canonical family/group key for a row — the identity the create/reparent
 * planner groups by. Exported so the route can build `sharedFamilyKeys` with
 * the IDENTICAL keying (explicit rows key by sku, not product id).
 *   explicit parent/standalone → own sku
 *   explicit child             → parent_sku (fallback ppid)
 *   no explicit parentage      → platformProductId (back-compat)
 */
export function ebayFamilyKey(row: EbayRow): string {
  const cls = classifyRow(row)
  if (cls.hasExplicitParentage) {
    if (!cls.isChild) return String(row.sku ?? '').trim() || cls.selfId
    return cls.parentSku ?? cls.ppid
  }
  return String(row.platformProductId ?? row._productId ?? row._rowId ?? '')
}

/**
 * Plan all create + reparent operations needed for a batch of eBay flat-file rows.
 *
 * Pure: all existing-product knowledge comes via `existingBySku` and
 * `existingParentById`. Returns an ordered plan that P1.2 executes.
 * parentCreates always precede childCreates so temp-id resolution works.
 */
export function planEbayFamilyCreates(input: {
  rows: EbayRow[]
  existingBySku: Map<string, ExistingProduct>
  existingParentById: Map<string, ExistingParent>
  /** Shared-SKU family keys: a re-parent whose new or current parent is in this set is suppressed
   *  (emitted as a warnings entry instead) because SharedListingMembership owns that linkage. */
  sharedFamilyKeys?: Set<string>
}): CreatePlan {
  const { rows, existingBySku, existingParentById, sharedFamilyKeys = new Set() } = input

  const parentCreates: CreatePlan['parentCreates'] = []
  const childCreates: CreatePlan['childCreates'] = []
  const reparents: CreatePlan['reparents'] = []
  const errors: CreatePlan['errors'] = []
  const warnings: CreatePlan['warnings'] = []

  // ── Step 1: Dedupe by SKU ────────────────────────────────────────────
  const skuCounts = new Map<string, number>()
  for (const row of rows) {
    const sku = String(row.sku ?? '').trim()
    if (!sku) continue
    skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1)
  }
  // Family key of a row — same precedence the client's isSharedDuplicateAllowed uses.
  // P2.A: derive from explicit columns when present so new-format rows group correctly.
  // P2.B1 — shared with the route (sharedFamilyKeys must match) via ebayFamilyKey().
  const familyKeyOf = ebayFamilyKey
  const dupedSkus = new Set<string>()
  // Shared-allowed duplicates are NOT errors — they COLLAPSE to a single create (one
  // unique-SKU Product); the extra shared parents receive the child via
  // SharedListingMembership fan-out, so the Product must still be created here.
  const collapsedSkus = new Set<string>()
  for (const [sku, count] of skuCounts) {
    if (count < 2) continue
    // I3: mirror isSharedDuplicateAllowed — shared-allowed iff the occurrences span
    // >=2 DISTINCT family keys AND every such key is a shared family.
    const familyKeys = new Set(
      rows
        .filter(r => String(r.sku ?? '').trim() === sku)
        .map(familyKeyOf)
        .filter(Boolean),
    )
    const sharedAllowed = familyKeys.size >= 2 && [...familyKeys].every(k => sharedFamilyKeys.has(k))
    if (sharedAllowed) {
      collapsedSkus.add(sku)
    } else {
      dupedSkus.add(sku)
      errors.push({ sku, reason: 'duplicate SKU in payload' })
    }
  }
  // Rows with a (non-shared) duped SKU are excluded from all further processing.
  // For a shared-allowed duplicate keep exactly ONE occurrence (the first) and drop the rest.
  const keptCollapsed = new Set<string>()
  const validRows = rows.filter(row => {
    const sku = String(row.sku ?? '').trim()
    if (sku === '' || dupedSkus.has(sku)) return false
    if (collapsedSkus.has(sku)) {
      if (keptCollapsed.has(sku)) return false
      keptCollapsed.add(sku)
    }
    return true
  })

  // ── Step 2 + 4: First pass — collect parentCreates ──────────────────
  // Must be fully built before processing children so temp-id lookups work.
  for (const row of validRows) {
    const sku = String(row.sku ?? '').trim()
    const needsCreate = !existingBySku.has(sku)
    if (!needsCreate) continue

    const { isChild } = classifyRow(row)  // P2.A: explicit-first classification
    if (!isChild) {
      const tempRowId = String(
        row._rowId ?? row._productId ?? sku
      )
      const variationTheme = row.variation_theme ? String(row.variation_theme) : null
      parentCreates.push({ tempRowId, sku, row, variationTheme })
    }
  }

  // P2: synthetic-parent dedup map — populated during the second pass when a new child's
  // parent_sku resolves to neither a batch parent nor an existing product. Maps parentSku →
  // the tempRowId of the already-created synthetic parentCreate entry so multiple children
  // that share the same missing parent_sku reuse ONE synthetic parent (not N).
  const syntheticParentsBySku = new Map<string, string>()

  // ── Step 3 + 5 + 6: Second pass — childCreates, reparents, warnings ─
  for (const row of validRows) {
    const sku = String(row.sku ?? '').trim()
    // P2.A: explicit-first classification (falls back to ppid heuristic when parentage absent)
    const { isChild, parentSku, ppid } = classifyRow(row)
    const isParentInferred = !isChild
    const needsCreate = !existingBySku.has(sku)

    // Warn if _isParent hint contradicts inference
    if (row._isParent !== undefined) {
      const hintIsParent = row._isParent === true
      if (hintIsParent !== isParentInferred) {
        warnings.push({
          sku: sku || undefined,
          reason: `_isParent hint (${String(row._isParent)}) contradicts inference (inferred: ${isParentInferred ? 'parent' : 'child'}); using inference`,
        })
      }
    }

    if (needsCreate) {
      if (!isChild) {
        // Already added to parentCreates in the first pass — skip
        continue
      }

      // Resolve parentRef for new child.
      // P2.A: prefer explicit parent_sku → batch parent (by sku) or existingBySku;
      //        fall back to ppid path when parent_sku absent (back-compat).
      if (parentSku) {
        // Explicit parent_sku path: look for a batch parent being created in this same request
        const batchParent = parentCreates.find(p => p.sku === parentSku)
        if (batchParent) {
          const tempRowId = String(row._rowId ?? row._productId ?? sku)
          childCreates.push({
            tempRowId,
            sku,
            row,
            parentRef: { kind: 'temp', tempRowId: batchParent.tempRowId },
            variationTheme: batchParent.variationTheme,
          })
        } else {
          // Try an existing parent by SKU (ExistingProduct already carries variationTheme)
          const existingParentBySku = existingBySku.get(parentSku)
          if (existingParentBySku) {
            const tempRowId = String(row._rowId ?? row._productId ?? sku)
            childCreates.push({
              tempRowId,
              sku,
              row,
              parentRef: { kind: 'existing', productId: existingParentBySku.id },
              variationTheme: existingParentBySku.variationTheme,
            })
          } else {
            // P2: auto-create a synthetic parent so the whole family persists in one save.
            // Deduped: if another child in this batch already referenced the same missing
            // parentSku, reuse that synthetic parent's tempRowId instead of creating a second.
            const existingSynthId = syntheticParentsBySku.get(parentSku)
            if (existingSynthId) {
              const synthParent = parentCreates.find(p => p.tempRowId === existingSynthId)!
              const tempRowId = String(row._rowId ?? row._productId ?? sku)
              childCreates.push({
                tempRowId,
                sku,
                row,
                parentRef: { kind: 'temp', tempRowId: existingSynthId },
                variationTheme: synthParent.variationTheme,
              })
            } else {
              const synthTempRowId = `__synth__${parentSku}`
              const synthVariationTheme = row.variation_theme ? String(row.variation_theme) : null
              parentCreates.push({
                tempRowId: synthTempRowId,
                sku: parentSku,
                row: { sku: parentSku, parentage: 'parent' },
                variationTheme: synthVariationTheme,
              })
              syntheticParentsBySku.set(parentSku, synthTempRowId)
              const tempRowId = String(row._rowId ?? row._productId ?? sku)
              childCreates.push({
                tempRowId,
                sku,
                row,
                parentRef: { kind: 'temp', tempRowId: synthTempRowId },
                variationTheme: synthVariationTheme,
              })
            }
          }
        }
      } else {
        // ppid fallback path — unchanged from P1.1
        const tempParent = parentCreates.find(p => p.tempRowId === ppid)
        if (tempParent) {
          const tempRowId = String(row._rowId ?? row._productId ?? sku)
          childCreates.push({
            tempRowId,
            sku,
            row,
            parentRef: { kind: 'temp', tempRowId: ppid },
            variationTheme: tempParent.variationTheme,
          })
        } else {
          const existingParent = existingParentById.get(ppid)
          if (existingParent) {
            const tempRowId = String(row._rowId ?? row._productId ?? sku)
            childCreates.push({
              tempRowId,
              sku,
              row,
              parentRef: { kind: 'existing', productId: ppid },
              variationTheme: existingParent.variationTheme,
            })
          } else {
            errors.push({
              sku,
              reason: 'unresolved parent (platformProductId does not match any new or existing parent)',
            })
          }
        }
      }
    } else {
      // Existing row — check for reparent/detach.
      const existing = existingBySku.get(sku)!

      if (isChild) {
        // P2.A: resolve effective parent id — prefer parent_sku → existingBySku,
        //        fall back to ppid when parent_sku absent (back-compat).
        let resolvedParentId = ''
        let parentUnresolved = false
        if (parentSku) {
          const resolvedParent = existingBySku.get(parentSku)
          if (!resolvedParent) {
            errors.push({
              sku,
              reason: 'unresolved parent (parent_sku does not match any existing parent)',
            })
            parentUnresolved = true
          } else {
            resolvedParentId = resolvedParent.id
          }
        } else {
          resolvedParentId = ppid  // ppid fallback (isChild=true implies ppid !== '' here)
        }

        if (!parentUnresolved && resolvedParentId) {
          if (resolvedParentId === existing.id) {
            // Self-parent guard
            errors.push({ sku, reason: 'self-parent: platformProductId points to the product itself' })
          } else if (resolvedParentId !== (existing.parentId ?? '')) {
            // Suppress reparent for shared-SKU families — memberships own the parent linkage.
            if (sharedFamilyKeys.has(resolvedParentId) || sharedFamilyKeys.has(String(existing.parentId ?? ''))) {
              warnings.push({ sku, reason: 'reparent suppressed: shared family (membership-managed)' })
            } else {
              reparents.push({ productId: existing.id, sku, newParentId: resolvedParentId })
            }
          }
          // else resolvedParentId === existing.parentId → no-op (already on the right parent)
        }
      } else {
        // !isChild: existing row now standalone/parent.
        // Fires when: explicit parentage='parent'|'', OR ppid cleared (back-compat).
        if (existing.parentId != null) {
          // Was a child (had a parent), now standalone — detach = null-reparent.
          if (sharedFamilyKeys.has(String(existing.parentId ?? ''))) {
            warnings.push({ sku, reason: 'detach suppressed: shared family (membership-managed)' })
          } else {
            reparents.push({ productId: existing.id, sku, newParentId: null })
          }
        }
        // else existing.parentId == null → already standalone/parent → no-op
      }
    }
  }

  return { parentCreates, childCreates, reparents, errors, warnings }
}
