/**
 * Step 2.6b (A-27, R-23) — `categoryAttributes.variations` is the one store for a variant's size and colour.
 *
 * Four writers used to REPLACE the whole `categoryAttributes` bag (organize publish, the eBay Inventory
 * import, the Amazon reconciliation enrich, `PATCH /api/catalog/products/:id`) and so deleted that store,
 * or every other attribute with it. Each now writes through one of these two statements — atomic, so a
 * concurrent writer's keys are never replaced by a stale read.
 */
type RawWriter = { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> }

/** Set these keys; every other key — `variations` included, unless the patch sets it — is kept. */
export const mergeCategoryAttributes = (db: RawWriter, productId: string, patch: Record<string, unknown>) =>
  db.$executeRaw`UPDATE "Product"
    SET "categoryAttributes" = COALESCE("categoryAttributes", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, "updatedAt" = now()
    WHERE id = ${productId}`

/** Replace the bag with the caller's, but keep the stored `variations` unless the caller sends that key. */
export const replaceCategoryAttributesKeepingVariations = (db: RawWriter, productId: string, bag: Record<string, unknown>) =>
  db.$executeRaw`UPDATE "Product"
    SET "categoryAttributes" = CASE
          WHEN ${JSON.stringify(bag)}::jsonb ? 'variations' OR NOT (COALESCE("categoryAttributes", '{}'::jsonb) ? 'variations')
            THEN ${JSON.stringify(bag)}::jsonb
          ELSE ${JSON.stringify(bag)}::jsonb || jsonb_build_object('variations', "categoryAttributes" -> 'variations')
        END,
        "updatedAt" = now()
    WHERE id = ${productId}`

/** R-23 (Step 2.6c-2) — THE writer of a product's variation values. `set` / `unset` go to the one store,
 * `categoryAttributes.variations`; `legacyDrop` keys leave the legacy `variantAttributes`, which is never written.
 * `replaceStore` replaces the whole `variations` object (organize publish sets a child's full axis map). */
export const writeVariationValues = (db: RawWriter, productId: string,
  plan: { set: Record<string, unknown>; unset: readonly string[]; legacyDrop: readonly string[] }, options: { replaceStore?: boolean } = {}) =>
  db.$executeRaw`UPDATE "Product"
    SET "categoryAttributes" = COALESCE("categoryAttributes", '{}'::jsonb) || jsonb_build_object('variations',
          CASE WHEN ${options.replaceStore === true}::boolean
            THEN ${JSON.stringify(plan.set)}::jsonb
            ELSE ((CASE WHEN jsonb_typeof("categoryAttributes" -> 'variations') = 'object' THEN "categoryAttributes" -> 'variations' ELSE '{}'::jsonb END)
                  - ${[...plan.unset]}::text[]) || ${JSON.stringify(plan.set)}::jsonb
          END),
        "variantAttributes" = CASE WHEN jsonb_typeof("variantAttributes") = 'object' THEN "variantAttributes" - ${[...plan.legacyDrop]}::text[] ELSE "variantAttributes" END,
        "updatedAt" = now()
    WHERE id = ${productId}`
