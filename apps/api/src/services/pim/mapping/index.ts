/**
 * PES.6 — the mapping engine's IN-PROCESS entry point.
 *
 * Hub ruling #15 drew the line: `POST /pim/channel-mapping/:channel/:code/resolve` is the
 * /channels/mapping page's preview surface, and any OTHER server-side reader (PES.5's
 * channel-scope sheet read) composes the resolver in-process so a sheet cell has exactly one
 * source and no HTTP hop. This barrel is that entry point.
 *
 * The contract for a caller who already has products loaded and only wants the channel values:
 *
 *   import { resolveChannelValues } from '../pim/mapping/index.js'
 *   const { byProduct } = await resolveChannelValues({
 *     channel: 'AMAZON', marketplace: 'IT',
 *     productIds: rows.map(r => r.id),
 *     fieldKeys: visibleChannelColumns,   // omit for the whole catalogue
 *     locale: 'it',
 *   })
 *   byProduct['<productId>']['item_name']  // → ResolvedCell
 *
 * Every cell carries `{ value, status, provenance, appliedTransforms, warnings, errors,
 * autoCorrected, required, overLimit }`, so a sheet renders 🔗 derived values, their source and
 * their problems without deriving anything itself.
 *
 * COST, so nobody is surprised: one pass is ~7 queries plus one per distinct channel category
 * in the batch (the field catalogue). It is batched, not per row — 100 products cost roughly
 * what 1 does. Cap a call at 250 products.
 */

export {
  resolveBatch,
  type ResolveBatchResult,
  type ResolvedCell,
  type ResolvedProduct,
} from './resolve-batch.service.js'

export {
  getFieldCatalogue,
  describeRule,
  type CatalogueField,
  type CatalogueGroup,
  type FieldCatalogue,
  type FieldPriority,
  type RuleKind,
} from './field-catalogue.service.js'

export {
  resolveCategoriesForProducts,
  resolveCategoryForProduct,
  listCategoryMappings,
  upsertCategoryMapping,
  removeCategoryMapping,
  listChannelCategories,
  categoryName,
  type ResolvedCategory,
  type CategoryResolutionSource,
  type CategoryMappingRow,
} from './category-mapping.service.js'

export {
  evaluateExpr,
  validateExpr,
  exprDependencies,
  parseExpr,
  EXPR_FUNCTIONS,
  type ExprResult,
  type ExprContext,
  type ExprFunctionDoc,
} from './expr.js'

import { resolveBatch } from './resolve-batch.service.js'
import type { ResolvedCell } from './resolve-batch.service.js'
import type { ResolvedCategory } from './category-mapping.service.js'

/**
 * The shape a SHEET wants: cells keyed by productId → fieldKey, with nothing else to unwrap.
 * A thin projection of `resolveBatch` — same engine, same values, no second implementation.
 */
export async function resolveChannelValues(input: {
  channelConnectionId?: string | null
  aliasKey?: string
  channel: string
  marketplace: string
  productIds: string[]
  /** The channel fields the sheet is showing. Omit for the whole catalogue (slower). */
  fieldKeys?: string[]
  locale?: string
  /** Pin one channel category for every product; omit to use each product's own. */
  productType?: string | null
}): Promise<{
  byProduct: Record<string, Record<string, ResolvedCell>>
  categoryByProduct: Record<string, ResolvedCategory>
  missingProductIds: string[]
}> {
  const byProduct: Record<string, Record<string, ResolvedCell>> = {}
  const categoryByProduct: Record<string, ResolvedCategory> = {}
  const missingProductIds: string[] = []
  const ids = [...new Set(input.productIds)]
  // Keep each database/validation batch bounded without truncating a family.
  // Sequential batches bound database pressure even with many listing aliases.
  for (let offset = 0; offset < ids.length; offset += 250) {
    const result = await resolveBatch({ ...input, productIds: ids.slice(offset, offset + 250), includeCatalogue: false })
    for (const p of result.products) {
      byProduct[p.productId] = p.cells
      categoryByProduct[p.productId] = p.category
    }
    missingProductIds.push(...result.missingProductIds)
  }
  return { byProduct, categoryByProduct, missingProductIds }
}
