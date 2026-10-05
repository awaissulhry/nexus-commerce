/**
 * MCP full control L7 — creating a product (and its variations) in one transaction: the create wizard's own rules and
 * writes, moved here from `routes/products.routes.ts` (POST /api/products/create-wizard) without a change, so the route and
 * Claude's create-product tool create a product the same way. Channel listings are NOT created here (drafts start from a
 * listing; publish sends them).
 *
 * The route answers exactly as before (routes/products-create-wizard.vitest.test.ts held it before and after the move).
 */
import prisma from '../../db.js'
import { activeDatabaseTransaction, afterDatabaseCommit } from '../../lib/database-context.js'
import { auditLogService } from '../audit-log.service.js'
import { listingSkuRefusal, skusUsedByListings } from '../identity/identity-write-guards.js'
import { channelSkuCreateRefusal } from '../listings/channel-sku-rename.js'

export interface CreateProductInput {
  sku: string
  name: string
  brand?: string | null
  productType?: string | null
  description?: string | null
  basePrice: number
  costPrice?: number | null
  totalStock?: number | null
  lowStockThreshold?: number | null
  upc?: string | null
  ean?: string | null
  gtin?: string | null
  weightValue?: number | null
  weightUnit?: string | null
  dimLength?: number | null
  dimWidth?: number | null
  dimHeight?: number | null
  dimUnit?: string | null
  manufacturer?: string | null
  categoryAttributes?: Record<string, unknown>
  variations?: Array<{
    sku: string
    name?: string | null
    variationAttributes?: Record<string, string>
    price?: number | null
    stock?: number | null
  }>
}

/** A refusal before anything is written, with the status and code the route has always answered with. */
export class CreateProductError extends Error {
  constructor(readonly statusCode: 400 | 409, readonly code: 'INVALID_REQUEST' | 'DUPLICATE_SKU', message: string) {
    super(message)
    this.name = 'CreateProductError'
  }
}

/** The wizard's guards, in its order: required fields, the price, the variation SKUs, then SKUs already in the catalogue. */
export async function assertCreatable(body: CreateProductInput): Promise<void> {
  // Required-field guards. Mirror the catalog endpoint so error
  // shape matches and clients can branch the same way.
  if (!body.sku?.trim()) throw new CreateProductError(400, 'INVALID_REQUEST', 'sku is required')
  if (!body.name?.trim()) throw new CreateProductError(400, 'INVALID_REQUEST', 'name is required')
  if (typeof body.basePrice !== 'number' || Number.isNaN(body.basePrice) || body.basePrice < 0) {
    throw new CreateProductError(400, 'INVALID_REQUEST', 'basePrice must be a non-negative number')
  }

  // SKU uniqueness — check master + every variation up front so we
  // can return a clean conflict before the transaction starts.
  const variationSkus = (body.variations ?? []).map((v) => v.sku?.trim())
  if (variationSkus.some((s) => !s)) throw new CreateProductError(400, 'INVALID_REQUEST', 'every variation must have a non-empty sku')
  const allSkus = [body.sku.trim(), ...variationSkus]
  if (new Set(allSkus).size !== allSkus.length) {
    throw new CreateProductError(400, 'DUPLICATE_SKU', 'duplicate SKUs in this request — master and variations must be unique')
  }
  const conflict = await prisma.product.findFirst({
    where: { sku: { in: allSkus } },
    select: { sku: true },
  })
  if (conflict) throw new CreateProductError(409, 'DUPLICATE_SKU', `SKU "${conflict.sku}" already exists`)
  // I4 / G4 — nor may a new product take a SKU an extra listing already uses as its own (the wizard route and
  // Claude's create-product both come through here; integration: I4 put this check in the route before L7 moved
  // the route's guards into this service).
  const [listingSku] = await skusUsedByListings(allSkus)
  if (listingSku) throw new CreateProductError(409, 'DUPLICATE_SKU', listingSkuRefusal(listingSku))
  // S9 — nor a SKU another product's listing holds or sends as its channel SKU (a listing that kept its old SKU after a
  // rename, a listing's own SKU): an order or a channel file would name two products by it.
  const held = await channelSkuCreateRefusal(allSkus)
  if (held) throw new CreateProductError(409, 'DUPLICATE_SKU', held)
}

/**
 * The product and (optionally) its variation rows in one transaction, so a partial create can't leave orphaned variants;
 * then the audit row, fire-and-forget as the route always wrote it. Call `assertCreatable` first.
 */
export async function createProduct(body: CreateProductInput, audit: { userId: string | null; ip: string | null; source: string }) {
  const result = await prisma.$transaction(async (tx) => {
    const isParent = (body.variations?.length ?? 0) > 0
    const masterData: Record<string, unknown> = {
      sku: body.sku.trim(),
      name: body.name.trim(),
      basePrice: body.basePrice,
      isParent,
      status: 'ACTIVE',
      syncChannels: [],
      validationStatus: 'VALID',
      validationErrors: [],
      hasChannelOverrides: false,
    }
    // Optional fields: only set when present so we don't blow
    // away DB defaults with explicit null/undefined.
    if (body.brand !== undefined) masterData.brand = body.brand
    if (body.productType !== undefined)
      masterData.productType = body.productType
    if (body.description !== undefined)
      masterData.description = body.description
    if (typeof body.costPrice === 'number')
      masterData.costPrice = body.costPrice
    if (typeof body.totalStock === 'number')
      masterData.totalStock = body.totalStock
    if (typeof body.lowStockThreshold === 'number')
      masterData.lowStockThreshold = body.lowStockThreshold
    if (body.upc !== undefined) masterData.upc = body.upc
    if (body.ean !== undefined) masterData.ean = body.ean
    if (body.gtin !== undefined) masterData.gtin = body.gtin
    if (typeof body.weightValue === 'number')
      masterData.weightValue = body.weightValue
    if (body.weightUnit !== undefined)
      masterData.weightUnit = body.weightUnit
    if (typeof body.dimLength === 'number')
      masterData.dimLength = body.dimLength
    if (typeof body.dimWidth === 'number')
      masterData.dimWidth = body.dimWidth
    if (typeof body.dimHeight === 'number')
      masterData.dimHeight = body.dimHeight
    if (body.dimUnit !== undefined) masterData.dimUnit = body.dimUnit
    if (body.manufacturer !== undefined)
      masterData.manufacturer = body.manufacturer
    if (
      body.categoryAttributes &&
      Object.keys(body.categoryAttributes).length > 0
    ) {
      masterData.categoryAttributes = body.categoryAttributes
    }

    const product = await tx.product.create({ data: masterData as any })
    const variations: Array<{ id: string; sku: string }> = []

    if (isParent && body.variations) {
      // Each variation gets a Product row with parentId set + the
      // variation's attribute map written to variantAttributes. This
      // is the canonical "child product" pattern (244 active rows in
      // prod under parentId; the PV mirror that used to live here was
      // removed in TECH_DEBT #43.4 once the listing-wizard reader
      // services migrated to parentId in #43.1-#43.3).
      for (const v of body.variations) {
        const child = await tx.product.create({
          data: {
            sku: v.sku.trim(),
            name: v.name?.trim() || `${body.name} — ${v.sku.trim()}`,
            basePrice: v.price ?? body.basePrice,
            totalStock: v.stock ?? 0,
            parentId: product.id,
            isParent: false,
            isMasterProduct: false,
            status: 'ACTIVE',
            syncChannels: [],
            validationStatus: 'VALID',
            validationErrors: [],
            hasChannelOverrides: false,
            // R-23 (Step 2.6c-2) — the one store; the legacy `variantAttributes` is never written.
            categoryAttributes: { variations: v.variationAttributes ?? {} } as any,
          } as any,
          select: { id: true, sku: true },
        })
        variations.push(child)
      }
    }

    return { product, variations }
  })

  // NN.4 — audit log the creation. Inside a caller's transaction (Claude's create-product also sets the family's axes
  // in it) the row is written once that commits; the route, which holds none, writes it as it always did.
  const write = () => auditLogService.write({
    userId: audit.userId,
    ip: audit.ip,
    entityType: 'Product',
    entityId: result.product.id,
    action: 'create',
    after: { sku: result.product.sku, name: result.product.name },
    metadata: {
      source: audit.source,
      variationCount: body.variations?.length ?? 0,
    },
  })
  if (activeDatabaseTransaction()) await afterDatabaseCommit(`audit:product-create:${result.product.id}`, write)
  else void write()

  return {
    product: { id: result.product.id, sku: result.product.sku, name: result.product.name, isParent: result.product.isParent },
    /** The new product's `version`: what a following family write (its axes) compares against. */
    version: result.product.version,
    variations: result.variations,
    variationCount: body.variations?.length ?? 0,
  }
}
