/**
 * Create one product from the Products page (2026-10-01) — `POST /api/products`.
 *
 * The Owner's journey: type a SKU and a name, choose "Single product" or "Product with variations" and, if wanted, a
 * product family, then open the new product in the studio. Before this the web form posted to this route while it did
 * not exist (404), and the only working path made a random `NEW-…` SKU and an ACTIVE blank product.
 *
 * What it writes, in one transaction inside the request's business:
 *   - the product: DRAFT (never ACTIVE: a blank product is not "live and selling"), price 0, `isParent` for a product
 *     with variations, the family when one was chosen;
 *   - a `PRODUCT_CREATED` product event (the product's timeline), as `family-generate.service.ts` writes its event;
 *   - the read-cache row, so the Products list shows it at once (`refreshInTransaction`, as the add-variation route).
 * After commit: the live update every open Products tab listens for, and the audit row.
 *
 * Refused, with a sentence that names the field: a SKU or name the shared rule refuses (`@nexus/shared/product-create`),
 * a SKU any product of this business already has (a deleted product keeps its SKU: the database key covers it), a SKU
 * that is an active channel listing's own SKU here (an import could not tell the two apart, the same rule
 * `listing-alias.service.ts` applies the other way round), and a family this business does not have.
 */
import type { Prisma } from '@prisma/client'
import { newProductProblems, normaliseNewProduct, type NewProductField, type NewProductInput } from '@nexus/shared/product-create'
import prisma from '../../db.js'
import { auditLogService } from '../audit-log.service.js'
import { productEventService } from '../product-event.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { channelSkuCreateRefusal } from '../listings/channel-sku-rename.js'

export class ProductCreateError extends Error {
  constructor(message: string, readonly statusCode: 400 | 409, readonly field?: NewProductField,
    /** The product that already has this SKU, when it is a live one the person can open. */
    readonly productId?: string) {
    super(message)
  }
}

export interface CreatedProduct { id: string; sku: string }

const uniqueViolation = (error: unknown): boolean => {
  const e = error as { code?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string; kind?: string } } } } | null
  const cause = e?.meta?.driverAdapterError?.cause
  return e?.code === 'P2002' || cause?.originalCode === '23505' || cause?.kind === 'UniqueConstraintViolation'
}

/** The refusal for a SKU a product of this business already holds. Reads outside the failed transaction. */
async function skuTaken(sku: string, db: Pick<Prisma.TransactionClient, 'product'> = prisma): Promise<ProductCreateError | null> {
  const existing = await db.product.findFirst({ where: { sku }, select: { id: true, deletedAt: true } })
  if (!existing) return null
  return existing.deletedAt
    ? new ProductCreateError(`${sku} belongs to a deleted product in this business. Choose another SKU.`, 409, 'sku')
    : new ProductCreateError(`${sku} already exists in this business.`, 409, 'sku', existing.id)
}

export async function createDraftProduct(body: unknown, actor: { userId: string | null; ip: string | null }): Promise<CreatedProduct> {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const problems = newProductProblems(raw)
  const first = (Object.keys(problems) as NewProductField[])[0]
  if (first) throw new ProductCreateError(problems[first]!, 400, first)
  const input = normaliseNewProduct(raw as unknown as NewProductInput)
  const { sku, name, kind, familyId } = input

  let created: { id: string; sku: string; name: string }
  try {
    created = await prisma.$transaction(async (tx) => {
      const taken = await skuTaken(sku, tx)
      if (taken) throw taken
      if (await tx.productListingAlias.findFirst({ where: { sku, status: 'ACTIVE' }, select: { id: true } })) {
        throw new ProductCreateError(`${sku} is already the SKU of a channel listing in this business. Choose another SKU for the product.`, 409, 'sku')
      }
      // S9 — nor a SKU another product's listing holds or sends as its channel SKU (one SKU names one product).
      const held = await channelSkuCreateRefusal([sku], tx)
      if (held) throw new ProductCreateError(held, 409, 'sku')
      if (familyId && !(await tx.productFamily.findFirst({ where: { id: familyId }, select: { id: true } }))) {
        throw new ProductCreateError('This product family is not in this business. Choose another family, or none.', 400, 'familyId')
      }
      const product = await tx.product.create({
        data: {
          sku,
          name,
          basePrice: 0,
          status: 'DRAFT',
          isParent: kind === 'parent',
          ...(familyId ? { familyId } : {}),
          syncChannels: [],
          validationStatus: 'VALID',
          validationErrors: [],
          hasChannelOverrides: false,
        },
        select: { id: true, sku: true, name: true },
      })
      await productEventService.emitTx(tx, {
        aggregateId: product.id,
        aggregateType: 'Product',
        eventType: 'PRODUCT_CREATED',
        data: { sku, name, kind, familyId },
        metadata: { source: 'OPERATOR', userId: actor.userId },
      })
      await productReadCacheService.refreshInTransaction(tx, [product.id])
      return product
    })
  } catch (error) {
    if (error instanceof ProductCreateError) throw error
    // Two people pressed Create with the same SKU at once: the database key let one through.
    if (uniqueViolation(error)) throw (await skuTaken(sku)) ?? new ProductCreateError(`${sku} already exists in this business.`, 409, 'sku')
    throw error
  }

  productEventService.notifyCommitted({ aggregateId: created.id, aggregateType: 'Product', eventType: 'PRODUCT_CREATED', metadata: { source: 'OPERATOR', userId: actor.userId } })
  void auditLogService.write({
    userId: actor.userId,
    ip: actor.ip,
    entityType: 'Product',
    entityId: created.id,
    action: 'create',
    after: { sku: created.sku, name: created.name, status: 'DRAFT', isParent: kind === 'parent', familyId },
    metadata: { source: 'products-page' },
  })
  return { id: created.id, sku: created.sku }
}
