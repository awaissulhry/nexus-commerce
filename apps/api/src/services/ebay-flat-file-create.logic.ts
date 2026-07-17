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

import { parseThemeAxes, axisSynonymKey } from './ebay-theme-axes.js'

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
    /** null when newParentTempRowId is set (temp-parent reparent) or when detaching */
    newParentId: string | null
    /** Set when reparenting to a parent being created in this same save (batch or synthetic).
     *  The service resolves this tempRowId → real productId via tempToRealId before updating. */
    newParentTempRowId?: string
  }>
  /** P2: existing STANDALONE products that must be promoted to isParent=true so children
   *  can attach to them. Deduped by productId. Applied by the service BEFORE childCreates
   *  and reparents so promoted products are valid parents when children point at them. */
  parentPromotions: Array<{ productId: string; variationTheme: string | null }>
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
  const exact = String(raw ?? '').trim()
  if (exact) return exact

  // EFX D5 — synonym fallback. The exact aspect_<Name> key missed, so the row
  // may carry the axis under a locale/naming synonym (theme "Colour" but the
  // row has aspect_Colore, or the Amazon alias "color name"). Scan the row's
  // aspect_* keys for one whose synonym-dimension key matches the wanted axis.
  // Only known synonym dimensions (__dim*__) participate — a custom/unmapped
  // axis keys by its own lowercase name, so an exact miss there stays a miss.
  const wantKey = axisSynonymKey(axisName)
  if (!wantKey.startsWith('__dim')) return ''
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('aspect_') || v == null) continue
    const candidateAxis = k.slice('aspect_'.length).replace(/_/g, ' ')
    if (!candidateAxis) continue
    if (axisSynonymKey(candidateAxis) !== wantKey) continue
    const val = String(v).trim()
    if (val) return val
  }
  return ''
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

/**
 * FIX B (P3) — Derive variation_theme from aspect_* keys when the row has no
 * explicit variation_theme. Used when auto-creating a synthetic parent.
 *
 * Mirrors the comma-joined axis list buildFlatRow writes
 * (ebay-variation-push.service.ts:1506): `variationAxisNames.join(',')`.
 *
 * Collects all `aspect_X` keys with non-empty values, strips the `aspect_`
 * prefix, deduplicates case-insensitively (aspect_Colore + aspect_colore
 * both map to the same axis), then joins with ','.
 * Returns null when no axis values are present.
 */
function inferVariationThemeFromRow(row: EbayRow): string | null {
  const seenLower = new Set<string>()
  const axisNames: string[] = []
  for (const key of Object.keys(row)) {
    if (!key.startsWith('aspect_')) continue
    const suffix = key.slice('aspect_'.length) // e.g. 'Colore', 'colore', 'Taglia'
    const lower = suffix.toLowerCase()
    if (seenLower.has(lower)) continue          // dedup: aspect_Colore + aspect_colore → one entry
    const val = String(row[key] ?? '').trim()
    if (!val) continue                           // key present but empty → skip
    seenLower.add(lower)
    axisNames.push(suffix)
  }
  return axisNames.length > 0 ? axisNames.join(',') : null
}

// ──────────────────────────────────────────────────────────────────────
// Exported functions
// ──────────────────────────────────────────────────────────────────────

/**
 * Extract variant axis values from an eBay flat-file row.
 *
 * For each axis name, reads the value using the canonical two-key
 * lookup (key1 = aspect_<Name_with_underscores>,
 *           key2 = aspect_<name_lowercased_underscores>), then falls back to a
 * synonym scan (EFX D5) so a theme axis "Colour" still extracts a row's
 * aspect_Colore / aspect_color_name. Keyed by the DECLARED axis name exactly as
 * given (creation is new data — no live-listing rename concern). Empties omitted.
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
      const axes = parseThemeAxes(opts.variationTheme) // EFX D4 — one parser (, / | ;)
      if (axes.length) data.variationAxes = axes
    }
    // parentId intentionally absent for parents
  } else {
    data.isParent = false
    if (opts.parentId) data.parentId = opts.parentId
    if (opts.variationTheme) data.variationTheme = opts.variationTheme

    // Extract variant attributes using the axis names from variationTheme
    const axisNames = parseThemeAxes(opts.variationTheme) // EFX D4 — one parser (, / | ;)
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
  const parentPromotions: CreatePlan['parentPromotions'] = []
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

  // FIX A (P3): Build set of all child skus in the incoming rows for the child-as-parent guard.
  // A parent_sku that points to any of these skus is an error (cycle / typo), not a synthetic-parent trigger.
  // Uses `rows` (not validRows) per spec — duped rows still contribute to the safety set.
  const batchChildSkus = new Set(
    rows
      .filter(r => classifyRow(r).isChild)
      .map(r => String(r.sku ?? '').trim())
      .filter(Boolean),
  )

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
        } else if (batchChildSkus.has(parentSku)) {
          // FIX 2: batchChildSkus checked BEFORE existingBySku — batch-child status wins even
          // when parentSku also resolves to an existing standalone product. Without this order,
          // the standalone would be promoted and CHILD-A would attach while parentSku is
          // simultaneously turned into a child elsewhere → 3-level hierarchy.
          errors.push({ sku, reason: `parent_sku "${parentSku}" refers to a variant row in this sheet, not a parent` })
        } else {
          // Try an existing parent by SKU (ExistingProduct already carries variationTheme)
          const existingParentBySku = existingBySku.get(parentSku)
          if (existingParentBySku) {
            // P2: 3-level hierarchy guard — reject if X is itself a child (parentId != null).
            if (existingParentBySku.parentId != null) {
              errors.push({ sku, reason: `parent_sku "${parentSku}" is itself a variant of another product — cannot nest` })
            } else {
              // P2: promote standalone X to a real parent (dedup by productId).
              // Prefer X's existing variationTheme; fall back to the child row's variation_theme.
              if (!existingParentBySku.isParent) {
                const theme = existingParentBySku.variationTheme ?? (row.variation_theme ? String(row.variation_theme) : null)
                if (!parentPromotions.some(p => p.productId === existingParentBySku.id)) {
                  parentPromotions.push({ productId: existingParentBySku.id, variationTheme: theme })
                }
              }
              const tempRowId = String(row._rowId ?? row._productId ?? sku)
              childCreates.push({
                tempRowId,
                sku,
                row,
                parentRef: { kind: 'existing', productId: existingParentBySku.id },
                variationTheme: existingParentBySku.variationTheme,
              })
            }
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
              // FIX B (P3): fall back to axis inference when no explicit variation_theme.
              // Separator matches buildFlatRow (ebay-variation-push.service.ts:1506): join(',').
              const synthVariationTheme = row.variation_theme
                ? String(row.variation_theme)
                : inferVariationThemeFromRow(row)
              parentCreates.push({
                tempRowId: synthTempRowId,
                sku: parentSku,
                row: { sku: parentSku, parentage: 'parent' },
                variationTheme: synthVariationTheme,
              })
              syntheticParentsBySku.set(parentSku, synthTempRowId)
              // FIX 2: warn so operator sees "auto-created parent X" instead of silent junk.
              warnings.push({ sku: parentSku, reason: `auto-created parent from parent_sku "${parentSku}"` })
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
        // GALE incident guard (2026-07-17): a SKU that appears under MULTIPLE
        // parents in this batch is a shared multi-listing SKU by definition —
        // its extra parent linkages live on SharedListingMembership, and its
        // Product.parentId must stay with the primary family. Suppress before
        // any resolution so no key-space subtlety below can re-parent it.
        if (collapsedSkus.has(sku)) {
          warnings.push({ sku, reason: 'reparent suppressed: shared multi-listing SKU (memberships own the extra parents)' })
          continue
        }
        // Subject-is-parent guard (FIX 1): a variation parent cannot be turned into a child
        // of another parent — that would create grandparent→parent→children (3 levels).
        // The operator must detach the subject's variants first. This check is FIRST so no
        // resolution, promotion, synthetic creation, or reparent is attempted for this subject.
        if (existing.isParent) {
          errors.push({ sku, reason: 'cannot nest a parent (with variants) under another parent — detach its variants first' })
          continue
        }
        // FIX 1+2: resolve → guard → create order.
        // STEP 1: resolve target WITHOUT creating anything.
        // STEP 2: evaluate guards using the resolved target.
        // STEP 3: ONLY IF the reparent will actually be emitted AND needsSynthetic → create now.
        // This prevents a phantom synthetic parent being registered when the reparent is later
        // suppressed (e.g. shared family) — the phantom would squat the global unique-SKU slot.
        let resolvedParentId = ''
        // P2.1 — a standalone parent resolved by parent_sku; promoted to isParent ONLY if the
        // child actually lands under it (emit or no-op), never on self-parent/suppression.
        let resolvedStandaloneParent: ExistingProduct | null = null
        // tempRowId of a parent being created in this same save (batch or synthetic).
        // When set, newParentId in the reparent entry is null and the service resolves it.
        let resolvedTempRowId: string | undefined = undefined
        // True when parent_sku is set but not resolved anywhere — synthetic creation is DEFERRED
        // until after guards so a suppressed reparent never leaves a phantom synthetic parent.
        let needsSynthetic = false

        if (parentSku) {
          // FIX 2: batchChildSkus checked BEFORE existingBySku — batch-child status wins even
          // when parentSku also resolves to an existing standalone product, preventing 3-level
          // hierarchy via promotion + simultaneous reparent of the same SKU to another parent.
          if (batchChildSkus.has(parentSku)) {
            // parent_sku points to a child row in this batch — error, no synthetic.
            // resolvedParentId stays '' + needsSynthetic stays false → no reparent emitted.
            errors.push({ sku, reason: `parent_sku "${parentSku}" refers to a variant row in this sheet, not a parent` })
          } else {
            const resolvedParent = existingBySku.get(parentSku)
            if (resolvedParent) {
              // P2: 3-level hierarchy guard — reject if X is itself a child (parentId != null).
              if (resolvedParent.parentId != null) {
                errors.push({ sku, reason: `parent_sku "${parentSku}" is itself a variant of another product — cannot nest` })
                // resolvedParentId stays '' → no reparent will be emitted below
              } else {
                // P2.1: DEFER promotion — only record it once we know the child lands under X
                // (see the emit/no-op branches below). Recording here would wrongly promote on a
                // self-parent error or a suppressed shared-family reparent.
                if (!resolvedParent.isParent) {
                  resolvedStandaloneParent = resolvedParent
                }
                // Existing parent resolved by SKU
                resolvedParentId = resolvedParent.id
              }
            } else {
              // Escalate: batch parent → already-registered synthetic → defer creation
              // (batchChildSkus already handled above — no batchChildSkus check needed here)
              const batchParent = parentCreates.find(p => p.sku === parentSku)
              if (batchParent) {
                resolvedTempRowId = batchParent.tempRowId
              } else {
                const existingSynthId = syntheticParentsBySku.get(parentSku)
                if (existingSynthId) {
                  resolvedTempRowId = existingSynthId
                } else {
                  // Not found anywhere — defer synthetic creation until after guard evaluation.
                  needsSynthetic = true
                }
              }
            }
          }
        } else {
          resolvedParentId = ppid  // ppid fallback (isChild=true implies ppid !== '' here)
        }

        if (resolvedTempRowId || needsSynthetic) {
          // Temp-parent reparent path (batch parent or synthetic-to-be).
          // Self-parent is impossible (temp IDs can never equal an existing product's DB id).
          // No-op is impossible (new parent cannot already be the current parentId).
          // Shared-family suppression — KEY-SPACE COMPLETE (GALE incident fix):
          // sharedFamilyKeys holds ebayFamilyKey values, which are SKUs for
          // explicit rows and product ids for legacy rows. The NEW parent here
          // is identified by parentSku (its family key IS its SKU); the current
          // parent may be keyed either way. The old check tested only
          // existing.parentId (an id) and never matched SKU keys — every
          // explicit multi-listing child re-parented straight through it.
          if (sharedFamilyKeys.has(parentSku ?? '') || sharedFamilyKeys.has(String(existing.parentId ?? ''))) {
            // FIX 1: reparent suppressed — do NOT create a phantom synthetic parent.
            warnings.push({ sku, reason: 'reparent suppressed: shared family (membership-managed)' })
          } else {
            // FIX 1: reparent will be emitted — only NOW create synthetic if needed.
            if (needsSynthetic) {
              const synthTempRowId = `__synth__${parentSku!}`
              // FIX B (P3): fall back to axis inference when no explicit variation_theme.
              // Separator matches buildFlatRow (ebay-variation-push.service.ts:1506): join(',').
              const synthVariationTheme = row.variation_theme
                ? String(row.variation_theme)
                : inferVariationThemeFromRow(row)
              parentCreates.push({
                tempRowId: synthTempRowId,
                sku: parentSku!,
                row: { sku: parentSku!, parentage: 'parent' },
                variationTheme: synthVariationTheme,
              })
              syntheticParentsBySku.set(parentSku!, synthTempRowId)
              // FIX 2: warn so operator sees "auto-created parent X" instead of silent junk.
              warnings.push({ sku: parentSku!, reason: `auto-created parent from parent_sku "${parentSku!}"` })
              resolvedTempRowId = synthTempRowId
            }
            reparents.push({ productId: existing.id, sku, newParentId: null, newParentTempRowId: resolvedTempRowId! })
          }
        } else if (resolvedParentId) {
          if (resolvedParentId === existing.id) {
            // Self-parent guard
            errors.push({ sku, reason: 'self-parent: platformProductId points to the product itself' })
          } else if (resolvedParentId !== (existing.parentId ?? '')) {
            // Suppress reparent for shared-SKU families — memberships own the parent linkage.
            // Key-space complete: the new parent may be keyed by id (resolvedParentId)
            // OR by SKU (parentSku — explicit rows' family key); current parent by id.
            if (sharedFamilyKeys.has(resolvedParentId) || sharedFamilyKeys.has(parentSku ?? '') || sharedFamilyKeys.has(String(existing.parentId ?? ''))) {
              warnings.push({ sku, reason: 'reparent suppressed: shared family (membership-managed)' })
            } else {
              reparents.push({ productId: existing.id, sku, newParentId: resolvedParentId })
              // P2.1 — child now lands under X → promote X if it was a standalone.
              const promo = resolvedStandaloneParent
              if (promo && !parentPromotions.some(p => p.productId === promo.id)) {
                parentPromotions.push({ productId: promo.id, variationTheme: promo.variationTheme ?? (row.variation_theme ? String(row.variation_theme) : null) })
              }
            }
          } else {
            // resolvedParentId === existing.parentId → no-op (already on the right parent).
            // P2.1 — child already sits under X; if X is an un-flagged standalone, fix its isParent flag.
            const promo = resolvedStandaloneParent
            if (promo && !parentPromotions.some(p => p.productId === promo.id)) {
              parentPromotions.push({ productId: promo.id, variationTheme: promo.variationTheme ?? (row.variation_theme ? String(row.variation_theme) : null) })
            }
          }
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

  return { parentCreates, childCreates, reparents, parentPromotions, errors, warnings }
}
