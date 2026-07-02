/**
 * Task 3 — Membership → row synthesis (pure + loader)
 *
 * Pure helpers (`reverseVariationSpecifics`, `synthesizeSharedRow`) are
 * free of Prisma/IO so they unit-test without a DB. The loader
 * (`loadSharedMembershipRows`) accepts an injectable prisma-like object.
 */

import { buildFlatRow } from './ebay-variation-push.service.js'

// ── pure helpers ─────────────────────────────────────────────────────────────

/**
 * Convert variationSpecifics into flat-file aspect_* columns.
 * Writes both cased and lowercase keys, mirroring buildFlatRow:1450-1451.
 *
 * e.g. { Colore: 'Nero', 'Base Color': 'Black' }
 *   → { aspect_Colore: 'Nero', aspect_colore: 'Nero',
 *       aspect_Base_Color: 'Black', aspect_base_color: 'Black' }
 */
export function reverseVariationSpecifics(
  specifics: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, val] of Object.entries(specifics)) {
    out[`aspect_${name.replace(/ /g, '_')}`] = val
    out[`aspect_${name.toLowerCase().replace(/ /g, '_')}`] = val
  }
  return out
}

/**
 * Build a synthesized flat-file row for a shared-child SKU.
 *
 * Rules:
 * - Spreads `childBaseRow` (built via buildFlatRow) as the base.
 * - Overwrites identity/family fields with membership values.
 * - Membership `price` WINS over the child base row's price for the
 *   membership's marketplace (`${mp}_price` and generic `price`).
 * - Sets `_isParent=false`, `_shared=true`, `_readonly=true`.
 */
export function synthesizeSharedRow(opts: {
  membership: {
    sku: string
    itemId: string
    marketplace: string
    price: number | null
    lastQtyPushed: number | null
    variationSpecifics: Record<string, string>
  }
  childBaseRow: Record<string, unknown> | null
  parentProductId: string
}): Record<string, unknown> {
  const { membership: m, childBaseRow, parentProductId } = opts
  const mp = m.marketplace.toLowerCase()
  const base: Record<string, unknown> = childBaseRow ? { ...childBaseRow } : { sku: m.sku }
  return {
    ...base,
    _shared: true,
    _readonly: true,
    _isParent: false,
    platformProductId: parentProductId,
    ebay_item_id: m.itemId,
    [`${mp}_item_id`]: m.itemId,
    ...(m.price != null ? { [`${mp}_price`]: m.price, price: m.price } : {}),
    ...(m.lastQtyPushed != null ? { [`${mp}_qty`]: m.lastQtyPushed, quantity: m.lastQtyPushed } : {}),
    ...reverseVariationSpecifics(m.variationSpecifics),
  }
}

// ── prisma-injectable loader ──────────────────────────────────────────────────

/** Minimal Decimal-like returned by Prisma for Decimal? fields. */
interface DecimalLike {
  valueOf(): unknown
}

/** Membership row as returned by Prisma findMany. */
interface MembershipRow {
  sku: string
  itemId: string
  marketplace: string
  parentSku: string
  productId: string | null
  variationSpecifics: unknown
  price: DecimalLike | null
  lastQtyPushed: number | null
}

/** Minimal child Product shape that buildFlatRow accepts. */
type ChildProduct = Parameters<typeof buildFlatRow>[0]

/** Prisma-injectable interface (real PrismaClient satisfies this). */
export interface SharedMembershipPrismaLike {
  sharedListingMembership: {
    findMany(args: {
      where: { parentSku: { in: string[] }; status: string }
    }): Promise<MembershipRow[]>
  }
  product: {
    findMany(args: {
      where: { id: { in: string[] } }
      include: {
        channelListings: { where: { channel: string } }
        images: { select: { url: boolean; sortOrder: boolean; type: boolean }; orderBy: { sortOrder: string } }
      }
    }): Promise<ChildProduct[]>
  }
}

/**
 * For each parent row (rows with `_isParent === true`) look up
 * `SharedListingMembership` records and synthesize extra flat-file rows for
 * shared children. Children already present in `normalRows` (same
 * `platformProductId|sku` key) are skipped to avoid duplicates.
 *
 * @param prisma - injectable prisma-like object (real or mock)
 * @param parentRows - flat-file rows that are parent rows (_isParent === true)
 * @param normalRows - all normally-built rows to use for dedup
 */
export async function loadSharedMembershipRows(
  prisma: SharedMembershipPrismaLike,
  parentRows: Record<string, unknown>[],
  normalRows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  // 1. Derive parent SKUs
  const parentSkus = parentRows
    .filter((r) => r._isParent === true)
    .map((r) => r.sku as string)
    .filter(Boolean)

  if (parentSkus.length === 0) return []

  // 2. Fetch ACTIVE memberships for those parents
  const memberships = await prisma.sharedListingMembership.findMany({
    where: { parentSku: { in: parentSkus }, status: 'ACTIVE' },
  })

  if (memberships.length === 0) return []

  // 3. Build parentIdBySku: sku → _productId (from parentRows)
  const parentIdBySku = new Map<string, string>()
  for (const row of parentRows) {
    if (
      row._isParent === true &&
      typeof row.sku === 'string' &&
      typeof row._productId === 'string'
    ) {
      parentIdBySku.set(row.sku, row._productId)
    }
  }

  // 4. Batch-load child Products that have a productId
  const childProductIds = [
    ...new Set(memberships.map((m) => m.productId).filter((id): id is string => !!id)),
  ]

  const childRowById = new Map<string, Record<string, unknown>>()
  if (childProductIds.length > 0) {
    const childProducts = await prisma.product.findMany({
      where: { id: { in: childProductIds } },
      include: {
        channelListings: { where: { channel: 'EBAY' } },
        images: { select: { url: true, sortOrder: true, type: true }, orderBy: { sortOrder: 'asc' } },
      },
    })
    for (const p of childProducts) {
      childRowById.set(p.id, buildFlatRow(p))
    }
  }

  // 5. Build existing dedup set from normalRows
  const existing = new Set<string>()
  for (const row of normalRows) {
    const platformProductId = row.platformProductId as string | undefined
    const sku = row.sku as string | undefined
    if (platformProductId && sku) {
      existing.add(`${platformProductId}|${sku}`)
    }
  }

  // 6. Synthesize rows for memberships not already in normalRows
  const result: Record<string, unknown>[] = []
  for (const m of memberships) {
    const parentProductId = parentIdBySku.get(m.parentSku)
    if (!parentProductId) continue // unresolved parent — skip

    const dedupKey = `${parentProductId}|${m.sku}`
    if (existing.has(dedupKey)) continue // already in normalRows — skip

    const childBaseRow = m.productId ? (childRowById.get(m.productId) ?? null) : null

    // Convert Prisma Decimal → number
    const price = m.price != null ? Number(m.price) : null

    result.push(
      synthesizeSharedRow({
        membership: {
          sku: m.sku,
          itemId: m.itemId,
          marketplace: m.marketplace,
          price,
          lastQtyPushed: m.lastQtyPushed,
          variationSpecifics: (m.variationSpecifics as Record<string, string>) ?? {},
        },
        childBaseRow,
        parentProductId,
      }),
    )

    // Mark as existing so a second membership for the same parent+sku doesn't
    // produce a duplicate row within the same call.
    existing.add(dedupKey)
  }

  return result
}
