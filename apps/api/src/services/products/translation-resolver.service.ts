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

const PRIMARY_LANGUAGE = (
  process.env.NEXUS_PRIMARY_LANGUAGE ?? 'it'
).toLowerCase()

/** ISO 639-1 lowercase for each Amazon marketplace we support. */
const LANGUAGE_FOR_MARKETPLACE: Record<string, string> = {
  IT: 'it',
  DE: 'de',
  FR: 'fr',
  ES: 'es',
  UK: 'en',
  US: 'en',
  CA: 'en',
  NL: 'nl',
  SE: 'sv',
  PL: 'pl',
  MX: 'es',
  AU: 'en',
  IE: 'en',
  AT: 'de',
  BE: 'fr',
  CH: 'de',
  HK: 'en',
  SG: 'en',
  MY: 'en',
}

export function languageForMarketplace(marketplace: string): string {
  const upper = marketplace.toUpperCase()
  return LANGUAGE_FOR_MARKETPLACE[upper] ?? PRIMARY_LANGUAGE
}

/** W4.2 — pick a representative marketplace for a target language.
 *
 *  Used by the per-locale AI translate endpoint, which needs to call
 *  ListingContentService.generate() (which is keyed by marketplace,
 *  not language). We pick the first marketplace whose language
 *  matches; the underlying terminology lookup widens via
 *  `OR: [{ brand }, { brand: null }]` so the fallback is graceful
 *  even when the picked marketplace has no brand-specific glossary.
 *
 *  Falls back to 'US' for any language not in our marketplace map
 *  (still produces a valid en-US prompt for the AI; the operator
 *  can override per channel later).
 */
const MARKETPLACE_PREFERENCE: Record<string, string> = {
  it: 'IT',
  de: 'DE',
  fr: 'FR',
  es: 'ES',
  en: 'UK',
  nl: 'NL',
  sv: 'SE',
  pl: 'PL',
}
export function marketplaceForLanguage(language: string): string {
  const lower = language.toLowerCase()
  const preferred = MARKETPLACE_PREFERENCE[lower]
  if (preferred) return preferred
  for (const [mkt, lang] of Object.entries(LANGUAGE_FOR_MARKETPLACE)) {
    if (lang === lower) return mkt
  }
  return 'US'
}

export function getPrimaryLanguage(): string {
  return PRIMARY_LANGUAGE
}

export function isPrimaryLanguage(language: string): boolean {
  return language.toLowerCase() === PRIMARY_LANGUAGE
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
}

export async function resolveProductContent(
  prisma: PrismaClient,
  productId: string,
  language: string,
): Promise<ResolvedProductContent | null> {
  const lang = language.toLowerCase()
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      description: true,
      bulletPoints: true,
      keywords: true,
    },
  })
  if (!product) return null

  // Primary language never hits the translation table — the master
  // row IS the primary translation.
  if (lang === PRIMARY_LANGUAGE) {
    return {
      name: product.name,
      description: product.description,
      bulletPoints: product.bulletPoints,
      keywords: product.keywords,
      source: 'master',
      language: lang,
    }
  }

  const translation = await prisma.productTranslation.findUnique({
    where: { productId_language: { productId, language: lang } },
    select: {
      name: true,
      description: true,
      bulletPoints: true,
      keywords: true,
      source: true,
      reviewedAt: true,
    },
  })
  if (!translation) {
    // No translation row — fall back to master so the channel still
    // gets *some* content. Caller can branch on `source==='master'`
    // to show "untranslated" in the UI.
    return {
      name: product.name,
      description: product.description,
      bulletPoints: product.bulletPoints,
      keywords: product.keywords,
      source: 'master',
      language: lang,
    }
  }
  // Field-level fallback: a partial translation row (e.g. only
  // description filled) should still surface master values for the
  // unfilled fields. Empty arrays count as "not translated".
  return {
    name: translation.name?.trim() ? translation.name : product.name,
    description:
      translation.description?.trim() && translation.description.length > 0
        ? translation.description
        : product.description,
    bulletPoints:
      translation.bulletPoints.length > 0
        ? translation.bulletPoints
        : product.bulletPoints,
    keywords:
      translation.keywords.length > 0
        ? translation.keywords
        : product.keywords,
    source: 'translation',
    language: lang,
    reviewedAt: translation.reviewedAt,
    generatedBy: translation.source,
  }
}

/**
 * Bulk variant: resolve content for many (productId, language)
 * pairs at once. Used by the catalog publish path which fans out
 * many products × marketplaces in one go.
 */
export async function resolveProductContentBatch(
  prisma: PrismaClient,
  productIds: string[],
  language: string,
): Promise<Map<string, ResolvedProductContent>> {
  const lang = language.toLowerCase()
  const map = new Map<string, ResolvedProductContent>()
  if (productIds.length === 0) return map
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      name: true,
      description: true,
      bulletPoints: true,
      keywords: true,
    },
  })
  const byId = new Map(products.map((p) => [p.id, p]))
  if (lang === PRIMARY_LANGUAGE) {
    for (const p of products) {
      map.set(p.id, {
        name: p.name,
        description: p.description,
        bulletPoints: p.bulletPoints,
        keywords: p.keywords,
        source: 'master',
        language: lang,
      })
    }
    return map
  }
  const translations = await prisma.productTranslation.findMany({
    where: { productId: { in: productIds }, language: lang },
    select: {
      productId: true,
      name: true,
      description: true,
      bulletPoints: true,
      keywords: true,
      source: true,
      reviewedAt: true,
    },
  })
  const tByProduct = new Map(translations.map((t) => [t.productId, t]))
  for (const id of productIds) {
    const p = byId.get(id)
    if (!p) continue
    const t = tByProduct.get(id)
    if (!t) {
      map.set(id, {
        name: p.name,
        description: p.description,
        bulletPoints: p.bulletPoints,
        keywords: p.keywords,
        source: 'master',
        language: lang,
      })
      continue
    }
    map.set(id, {
      name: t.name?.trim() ? t.name : p.name,
      description:
        t.description?.trim() && t.description.length > 0
          ? t.description
          : p.description,
      bulletPoints:
        t.bulletPoints.length > 0 ? t.bulletPoints : p.bulletPoints,
      keywords: t.keywords.length > 0 ? t.keywords : p.keywords,
      source: 'translation',
      language: lang,
      reviewedAt: t.reviewedAt,
      generatedBy: t.source,
    })
  }
  return map
}
