import prisma from '../../../db.js'
import { resolveAttributes, type ProductLike } from '../attribute-resolver.js'
import { ALLOWED_MASTER_FIELDS } from '../master-field-gate.js'
import { isPresent, resolveSourcePath } from '../resolve-channel-field.js'
import { languageForMarketplace } from '../../products/translation-resolver.service.js'

export interface MappingSource {
  path: string
  group: string
  source: string
  sampleValue: string | null
  hasValue: boolean
}

/** Enumerate declared Master attributes even when the sample has no value. Samples and deep
 * paths use the same source-path reader as rules, including inherited variant values. */
export function mappingSources(product: ProductLike | null, parent: ProductLike | null, locale: string, declared: string[]): MappingSource[] {
  const resolved = product ? resolveAttributes({ product, parent, locale }) : {}
  const flat = Object.fromEntries(Object.entries(resolved).map(([key, value]) => [key, value.value]))
  const paths = new Map<string, string>([...ALLOWED_MASTER_FIELDS, 'sku', 'title', ...declared, ...Object.keys(resolved)]
    .map(key => [key, 'Master attributes']))
  // These legacy paths are valid even when the selected product has not populated the
  // declared custom attribute yet; the source reader resolves them through the same cascade.
  for (const code of declared) paths.set(`categoryAttributes.${code}`, 'Structured Master attributes')
  const walk = (root: string, value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue
      const path = `${root}.${key}`
      paths.set(path, 'Structured Master attributes')
      walk(path, child, depth + 1)
    }
  }
  for (const row of [parent, product]) if (row) {
    walk('categoryAttributes', row.categoryAttributes)
    walk('variantAttributes', row.variantAttributes)
    walk('localizedContent', row.localizedContent)
  }
  return [...paths].map(([path, group]) => {
    const value = product ? resolveSourcePath(path, flat, product, locale) : null
    return { path, group, source: resolved[path]?.source ?? 'master', hasValue: isPresent(value),
      sampleValue: !isPresent(value) ? null : (typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(0, 120) }
  }).sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path))
}

export async function getMappingSources(input: { marketplace: string; productId?: string; locale?: string }) {
  const [product, attributes] = await Promise.all([
    input.productId
      ? prisma.product.findFirst({ where: { id: input.productId, deletedAt: null } })
      : prisma.product.findFirst({ where: { deletedAt: null }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] }),
    prisma.customAttribute.findMany({ select: { code: true } }),
  ])
  if (input.productId && !product) throw new Error('The preview product is no longer available.')
  const parent = product?.parentId ? await prisma.product.findUnique({ where: { id: product.parentId } }) : null
  return {
    sources: mappingSources(product as unknown as ProductLike | null, parent as unknown as ProductLike | null,
      input.locale ?? await languageForMarketplace(input.marketplace, 'AMAZON'), attributes.map(a => a.code)),
    sampledFrom: product ? { productId: product.id, sku: product.sku, name: product.name } : null,
    note: !product ? 'Master definitions are available; there is no product to preview.'
      : input.productId ? null : 'Values are sampled from the most recently updated product. Select a preview SKU to inspect its Master values.',
  }
}
