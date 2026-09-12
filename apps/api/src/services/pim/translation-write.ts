import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { contentSlots, CONTENT_COLUMNS, stampContentReview } from './content-locale.js'
import { mergeLocalizedContent, validateLocalizedPatch } from './localized-content.js'

/** Compatibility writes commit to the canonical content contract in the same
 * transaction as the legacy record. No existing content is bulk migrated. */
export async function writeTranslation<T>(input: {
  productId: string; locale: string; values: Record<string, unknown>; state: 'draft' | 'reviewed';
  remove?: boolean; userId?: string | null; ip?: string;
}, legacy: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const patch = Object.fromEntries(Object.entries(CONTENT_COLUMNS).filter(([, column]) => input.values[column] !== undefined).map(([key, column]) => [key, input.values[column]]))
  const errors = validateLocalizedPatch({ [input.locale]: patch })
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { statusCode: 400 })
  return prisma.$transaction(async tx => {
    const product = await tx.product.findUnique({ where: { id: input.productId }, include: { translations: true, parent: { include: { translations: true } } } })
    if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 })
    const prior = contentSlots(product)
    if (!input.remove && !Object.keys(patch).length && !prior[input.locale]) throw Object.assign(new Error(`No translation for ${input.locale}`), { statusCode: 404 })
    const changed = input.remove ? Object.fromEntries(Object.keys(CONTENT_COLUMNS).map(key => [key, null])) : Object.keys(patch).length ? patch
      : Object.fromEntries(Object.keys(CONTENT_COLUMNS).filter(key => prior[input.locale]?.[key] !== undefined).map(key => [key, prior[input.locale][key]]))
    // A delete means intentional removal of the translation; null shadows the
    // compatibility store and stays distinct from a missing locale value.
    const merged = mergeLocalizedContent(prior, { [input.locale]: changed })
    const localizedContent = stampContentReview(product, merged, { [input.locale]: changed }, input.state)
    const result = await legacy(tx)
    const updated = await tx.product.updateMany({ where: { id: product.id, version: product.version }, data: { localizedContent: localizedContent as any, version: { increment: 1 } } })
    if (!updated.count) throw Object.assign(new Error('This product changed. Reload before saving the translation.'), { statusCode: 409 })
    if (Object.keys(changed).length) await tx.auditLog.createMany({ data: Object.keys(changed).map(key => ({
      entityType: 'Product', entityId: product.id, action: 'update', userId: input.userId ?? null, ip: input.ip,
      before: { field: key, value: prior[input.locale]?.[key] ?? null }, after: { field: key, value: changed[key] ?? null },
      metadata: { source: 'manual', layer: 'master', locale: input.locale, intent: input.remove ? 'remove' : 'set' },
    })) as any })
    return result
  })
}
