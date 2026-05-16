/**
 * BV.1 (list-wizard) — BrandVoice service.
 *
 * Resolves the most-specific ACTIVE BrandVoice row for a (brand,
 * marketplace, language) scope and renders the prompt-block fragment
 * the listing-content prompts inline as {brandVoiceBlock}.
 *
 * Matcher specificity (mirrors PromptTemplate's tiered fallback):
 *   1. exact (brand + marketplace + language)
 *   2. brand + marketplace
 *   3. brand + language
 *   4. brand only
 *   5. marketplace + language
 *   6. marketplace only
 *   7. global (all null)
 *
 * Returns an empty string when nothing matches, so the prompt simply
 * skips the brand-voice section without a visible gap.
 */

import type { PrismaClient } from '@nexus/database'
import { logger } from '../../utils/logger.js'

export interface BrandVoiceScope {
  brand?: string | null
  marketplace?: string | null
  language?: string | null
}

export interface BrandVoiceRow {
  id: string
  brand: string | null
  marketplace: string | null
  language: string | null
  body: string
  notes: string | null
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
}

export async function resolveBrandVoice(
  prisma: PrismaClient,
  scope: BrandVoiceScope = {},
): Promise<BrandVoiceRow | null> {
  try {
    const brand = scope.brand?.trim() || null
    const marketplace = scope.marketplace?.toUpperCase() ?? null
    const language = scope.language?.toLowerCase() ?? null
    // Pull every ACTIVE row in one query, then pick the most-specific
    // match. Matches PromptTemplate's pattern — cheaper than seven
    // sequential queries against an indexed table.
    const rows = await prisma.brandVoice.findMany({
      where: { isActive: true },
      orderBy: [{ updatedAt: 'desc' }],
    })
    if (rows.length === 0) return null

    const eq = (a: string | null | undefined, b: string | null | undefined) =>
      (a ?? null) === (b ?? null)
    const matchBrandM = (r: { brand: string | null }) =>
      eq(r.brand?.trim() || null, brand)
    const matchMarket = (r: { marketplace: string | null }) =>
      eq(r.marketplace?.toUpperCase() || null, marketplace)
    const matchLang = (r: { language: string | null }) =>
      eq(r.language?.toLowerCase() || null, language)

    const tiers: Array<(r: BrandVoiceRow) => boolean> = [
      // Most specific → least specific.
      (r) => matchBrandM(r) && matchMarket(r) && matchLang(r),
      (r) => matchBrandM(r) && matchMarket(r) && r.language == null,
      (r) => matchBrandM(r) && r.marketplace == null && matchLang(r),
      (r) => matchBrandM(r) && r.marketplace == null && r.language == null,
      (r) => r.brand == null && matchMarket(r) && matchLang(r),
      (r) => r.brand == null && matchMarket(r) && r.language == null,
      (r) => r.brand == null && r.marketplace == null && r.language == null,
    ]
    for (const isMatch of tiers) {
      const hit = rows.find(isMatch as (r: any) => boolean)
      if (hit) return hit as BrandVoiceRow
    }
    return null
  } catch (err) {
    logger.warn('brand-voice-service: resolve failed (returning null)', {
      err: err instanceof Error ? err.message : String(err),
      scope,
    })
    return null
  }
}

/**
 * Render the brand-voice prompt-block. Wraps the body in a "Brand
 * voice:" prefix so the AI sees the section as guidance, not as an
 * assertion about the product. Returns an empty string when no
 * match — callers concat unconditionally without an "if" guard.
 *
 * MB.1 — when NEXUS_ENABLE_BRAND_BRAIN=1, augments the block with up
 * to 2 retrieved examples from the vector store so the LLM sees past
 * high-performing A+ content that matched the same brand/productType.
 * Degrades silently if pgvector is unavailable.
 */
export async function renderBrandVoiceBlock(
  prisma: PrismaClient,
  scope: BrandVoiceScope = {},
): Promise<string> {
  const row = await resolveBrandVoice(prisma, scope)
  if (!row) return ''
  const body = row.body?.trim()
  if (!body) return ''

  let block = `\n\nBrand voice:\n${body}`

  // MB.1 RAG augmentation — retrieve similar past content
  if (process.env.NEXUS_ENABLE_BRAND_BRAIN === '1') {
    try {
      const { queryBrandBrain } = await import('./brand-brain.service.js')
      const query = [scope.brand, body.slice(0, 200)].filter(Boolean).join(' ')
      const hits = await queryBrandBrain(query, { entityType: 'APLUS_CONTENT', limit: 2 })
      if (hits.length > 0) {
        const examples = hits
          .map((h, i) => `Example ${i + 1}: ${h.snippet.slice(0, 300)}`)
          .join('\n')
        block += `\n\nPast high-performing A+ content (retrieved for reference):\n${examples}`
      }
    } catch {
      // Degrade gracefully — never let RAG failure break listing generation
    }
  }

  return block
}

/**
 * Admin list — operator surface on /settings/ai (or sibling). Capped
 * at 200 rows so a runaway A/B fork doesn't drown the UI.
 */
export async function listBrandVoices(
  prisma: PrismaClient,
  filter: { isActive?: boolean } = {},
): Promise<BrandVoiceRow[]> {
  const where: { isActive?: boolean } = {}
  if (typeof filter.isActive === 'boolean') where.isActive = filter.isActive
  const rows = await prisma.brandVoice.findMany({
    where,
    orderBy: [
      { isActive: 'desc' },
      { brand: 'asc' },
      { marketplace: 'asc' },
      { language: 'asc' },
      { updatedAt: 'desc' },
    ],
    take: 200,
  })
  return rows as BrandVoiceRow[]
}
