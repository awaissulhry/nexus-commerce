import { marketLanguages } from '../pim/market-languages.js'
/**
 * H.10 — resolve a product's content for a target language.
 *
 *   resolveProductContent(prisma, productId, language)
 *     → { name, description, bulletPoints, keywords, source }
 *
 * If a ProductTranslation row exists for that language, return its
 * (non-null) fields with field-level fallback to Product master.
 * If no translation row, return Product master values verbatim.
 *
 * `source` distinguishes 'master' (no translation row, or matched
 * primary language) from 'translation' (rendered from PT row). The
 * caller can use this to e.g. show a "translated" pill in the UI.
 *
 * The primary language is read from NEXUS_PRIMARY_LANGUAGE (default
 * 'it' for Xavia). Calling with the primary language never reads
 * the translation table — Product fields ARE the primary-language
 * master.
 *
 * Marketplace→language convenience: most callers know the
 * marketplace code (IT/DE/FR/...) not the ISO language. Use
 * `languageForMarketplace(marketplace)` to map.
 */

import type { PrismaClient } from '@prisma/client'

import { PRIMARY_CONTENT_LOCALE, CONTENT_COLUMNS } from '../pim/content-locale.js'
import { resolveContentAttributes, contentWireValue } from '../pim/content-read.js'
import { normalizeLanguage } from '../pim/content-language.js'
const PRIMARY_LANGUAGE = PRIMARY_CONTENT_LOCALE

export { marketplaceForLanguage } from '../pim/market-languages.js'

/** Compatibility name; all language facts come from the channel-qualified row. */
export async function languageForMarketplace(marketplace: string, channel = 'AMAZON'): Promise<string> {
  return (await marketLanguages(channel, marketplace))[0]
}

export function getPrimaryLanguage(): string {
  return PRIMARY_LANGUAGE
}

export function isPrimaryLanguage(language: string): boolean {
  return normalizeLanguage(language) === PRIMARY_LANGUAGE
}

export interface ResolvedProductContent {
  name: string
  description: string | null
  bulletPoints: string[]
  keywords: string[]
  /** 'master' when from Product, 'translation' when from PT row. */
  source: 'master' | 'translation'
  /** The language requested. Lowercased. */
  language: string
  /** When source='translation', the row's reviewedAt (null if AI
   *  generated and not yet reviewed). */
  reviewedAt?: Date | null
  /** When source='translation', the PT row's `source` field. */
  generatedBy?: string | null
  fields?: Record<string, import('../pim/attribute-resolver.js').ResolvedValue>
}

const CONTENT_SELECT = {
  workspaceId: true,
  id: true, parentId: true, name: true, description: true, bulletPoints: true, keywords: true,
  categoryAttributes: true, variantAttributes: true, translations: true,
  parent: { include: { translations: true } },
} as const

export function resolvedContent(product: any, language: string): ResolvedProductContent {
  language = normalizeLanguage(language)
  const resolved = resolveContentAttributes({ product, parent: product.parent ?? null, requested: language })
  const fields = Object.fromEntries(Object.entries(CONTENT_COLUMNS).map(([key, column]) => [column, {
    ...resolved[key], value: contentWireValue(resolved[key].value, ['bulletPoints', 'keywords'].includes(key) ? 'list' : undefined),
  }]))
  return {
    name: String(fields.name?.value ?? ''),
    description: fields.description?.value as string | null ?? null,
    bulletPoints: fields.bulletPoints?.value as string[] ?? [], keywords: fields.keywords?.value as string[] ?? [],
    source: Object.values(fields).some(field => field.effectiveLocale === language && ['masterLocale', 'variantLocale'].includes(field.source ?? '')) ? 'translation' : 'master',
    language, fields,
  }
}

export async function resolveProductContent(prisma: PrismaClient, productId: string, language: string): Promise<ResolvedProductContent | null> {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: CONTENT_SELECT })
  return product ? resolvedContent(product, normalizeLanguage(language)) : null
}

/** Both historical and current callers use the same per-field locale contract. */
export async function resolveProductContentBatch(prisma: PrismaClient, productIds: string[], language: string): Promise<Map<string, ResolvedProductContent>> {
  const result = new Map<string, ResolvedProductContent>()
  if (!productIds.length) return result
  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: CONTENT_SELECT })
  for (const product of products) result.set(product.id, resolvedContent(product, normalizeLanguage(language)))
  return result
}
