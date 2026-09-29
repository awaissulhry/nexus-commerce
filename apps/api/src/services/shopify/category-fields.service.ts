/**
 * Shopify category fields — sheet parity with Shopify's bulk editor (docs/studies/shopify-linked-variations-PLAN.md §5.1).
 *
 * Shopify offers each taxonomy category its own standard fields (Apparel > Clothing: Color, Age group, Target gender, …).
 * A store holds values only in the ones it has switched on. The sheet shows the rest read-only; this switches one on, on
 * an operator's click. Only a field Shopify offers now for one of the family's OWN categories is switched on — never a
 * key just because a client named it.
 */
import { z } from 'zod'
import prisma from '../../db.js'
import { shopifyAdmin } from './admin-client.js'
import { contentDestination, type ContentScope } from './content-workspace.service.js'
import { enableStandardShopifyDefinition, readCategoryTemplates } from './linked-products-gateway.js'
import { productCategoryContext } from '../pim/product-category-context.js'
import { invalidateShopifyMappingSchema, readShopifyMappingSchema } from '../pim/channel-specs/shopify.js'
import { clearSheetColumnCache } from '../pim/sheet-columns.service.js'
import { clearStudioColumnCache } from '../pim/studio-columns.js'
import { publishListingEvent } from '../listing-events.service.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

const categoryFieldSchema = z.object({ ownerType: z.enum(['PRODUCT', 'PRODUCTVARIANT']), namespace: z.string().min(1).max(255), key: z.string().min(1).max(255) }).strict()
/** The most family categories checked against Shopify's offer in one switch-on. */
const CATEGORY_CHECK_LIMIT = 20

export async function enableShopifyCategoryField(productId: string, scope: ContentScope, body: unknown) {
  const target = categoryFieldSchema.parse(body)
  const destination = await contentDestination(productId, scope)
  const family = await prisma.product.findFirst({ where: { id: destination.familyId, deletedAt: null }, select: { id: true, children: { where: { deletedAt: null }, select: { id: true } } } })
  if (!family) throw new WorkspaceScopeError('This product is unavailable.', 404)
  const { categories } = await productCategoryContext([family.id, ...family.children.map(child => child.id)], 'SHOPIFY', destination.marketplace, destination.accountId)
  if (!categories.length) throw new WorkspaceScopeError('Choose this family’s Shopify category first: its category fields come from it. Nothing was switched on.', 422)
  const { graphql } = await shopifyAdmin(destination.accountId)
  // Fresh, not cached: the field must be one Shopify offers now for one of the family's own categories.
  const offered = await Promise.all(categories.slice(0, CATEGORY_CHECK_LIMIT).map(category =>
    readCategoryTemplates(graphql, category.startsWith('gid://') ? category : `gid://shopify/TaxonomyCategory/${category}`, { fresh: true })))
  if (!offered.flat().some(template => template.namespace === target.namespace && template.key === target.key && template.ownerTypes.includes(target.ownerType)))
    throw new WorkspaceScopeError('Shopify does not offer this field for this family’s Shopify category. Nothing was switched on.', 422)
  const definition = await enableStandardShopifyDefinition(graphql, target)
  // Every reader of the store's fields sees it at once: the schema cache (read fresh here, so a cache-only sheet read
  // already finds the field), both column caches, and open sheets (the event makes them reload).
  invalidateShopifyMappingSchema(destination.accountId)
  const schema = await readShopifyMappingSchema(destination.accountId, true)
  clearSheetColumnCache(); clearStudioColumnCache()
  publishListingEvent({ type: 'shopify.schema.changed', accountId: destination.accountId, ts: Date.now() })
  return { definition, revision: schema.revision }
}
