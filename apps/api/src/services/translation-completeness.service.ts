import { resolveContentBatch, translationMissing, type ContentProduct } from './pim/content-resolver.js'
import { normalizeLanguage } from './pim/content-language.js'
import { isPresent } from './pim/resolve-channel-field.js'

export function translationCoverage(product: ContentProduct, requested: string, fields: readonly string[] = ['title', 'description', 'bulletPoints', 'keywords']) {
  requested = normalizeLanguage(requested)
  const resolved = resolveContentBatch({ members: [{ product, parent: product.parent as ContentProduct }], fields, addresses: [{ requested }] })[0].fields
  const filled = Object.values(resolved).filter(value => !translationMissing(value, requested) && isPresent(value.value))
  return { hasContent: filled.length > 0, fieldCount: filled.length,
    reviewed: filled.length > 0 && filled.every(value => !value.translation || !!value.translation.reviewedAt && !value.translation.outdated) }
}
