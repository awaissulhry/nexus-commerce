/**
 * F4 — bulk AI content generation for /products grid.
 *
 *   POST /api/products/ai/bulk-generate
 *     body: { productIds: string[]; fields: ContentField[]; marketplace: string; dryRun?: boolean }
 *     → { results: Array<{ productId, ok, generated?, error? }> }
 *
 * Loops the requested products, calls the same ListingContentService
 * the listing wizard uses (so quality + terminology + per-language
 * prompts are identical), and either writes the result back to
 * Product columns immediately or returns a dry-run preview.
 *
 * Writes go through PATCH /api/products/bulk's same code path
 * conceptually — direct prisma.product.update for fields that don't
 * cascade (description, bulletPoints, keywords). Title is written
 * to Product.name only when explicitly requested.
 *
 * Returns 503 when GEMINI_API_KEY isn't set so the client can show
 * a helpful message instead of hanging.
 *
 * Per-product errors don't fail the whole batch — each is returned
 * in the results array with `ok: false` + `error` so the UI can
 * highlight the failures and let the user retry.
 *
 * Rate limit: 5 requests/min. Each call can fan out to many
 * products + many fields, so the limit is set low to keep AI cost
 * + Gemini quota predictable. Caller should batch productIds rather
 * than call once per product.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  ListingContentService,
  type ContentField,
  type GenerationResult,
} from '../services/ai/listing-content.service.js'
import { auditLogService } from '../services/audit-log.service.js'
import { logUsage } from '../services/ai/usage-logger.service.js'
import {
  isPrimaryLanguage,
  languageForMarketplace,
} from '../services/products/translation-resolver.service.js'
import { getProvider } from '../services/ai/providers/index.js'

const ALLOWED_FIELDS = new Set<ContentField>([
  'title',
  'bullets',
  'description',
  'keywords',
])
const MAX_PRODUCTS_PER_CALL = 50

const service = new ListingContentService()

interface BulkGenerateBody {
  productIds?: string[]
  fields?: string[]
  marketplace?: string
  /** When true, return generated content but skip the write. */
  dryRun?: boolean
  /** H.7 — provider override. 'gemini' | 'anthropic'. Falls back to
   *  AI_PROVIDER env or first configured provider. */
  provider?: string
  /** A4.3 — model override. e.g. 'claude-sonnet-4-6'. Only used when
   *  provider supports model selection; ignored by Gemini path. */
  model?: string
}

interface BulkGenerateResult {
  productId: string
  ok: boolean
  generated?: GenerationResult
  /** Fields actually written when dryRun=false. */
  written?: ContentField[]
  error?: string
}

const productsAiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: BulkGenerateBody }>(
    '/products/ai/bulk-generate',
    {
      // F4 — AI fan-out is cheap on the server side (Gemini does the
      // heavy lift) but billable per call. Keep the rate limit tight
      // so a stuck client retry loop can't pin Gemini quota.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!service.isConfigured()) {
        return reply.code(503).send({
          error:
            'Gemini API not configured — set GEMINI_API_KEY on the API server.',
        })
      }

      const body = request.body ?? {}
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      const marketplace = (body.marketplace ?? '').trim().toUpperCase()
      const requestedFieldsRaw = Array.isArray(body.fields) ? body.fields : []
      const dryRun = body.dryRun === true
      const providerName = body.provider
      const modelOverride = body.model ?? undefined

      if (productIds.length === 0) {
        return reply.code(400).send({ error: 'productIds[] required' })
      }
      if (productIds.length > MAX_PRODUCTS_PER_CALL) {
        return reply.code(400).send({
          error: `max ${MAX_PRODUCTS_PER_CALL} products per call (got ${productIds.length}); split into smaller batches`,
        })
      }
      if (!marketplace) {
        return reply.code(400).send({ error: 'marketplace required' })
      }
      const requestedFields = requestedFieldsRaw.filter(
        (f): f is ContentField => ALLOWED_FIELDS.has(f as ContentField),
      )
      if (requestedFields.length === 0) {
        return reply.code(400).send({
          error: `fields must include one or more of ${Array.from(ALLOWED_FIELDS).join(', ')}`,
        })
      }

      // Pre-fetch all products in one query so the loop only does AI
      // work + (if writing) one update per product.
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          sku: true,
          name: true,
          brand: true,
          description: true,
          bulletPoints: true,
          keywords: true,
          weightValue: true,
          weightUnit: true,
          dimLength: true,
          dimWidth: true,
          dimHeight: true,
          dimUnit: true,
          productType: true,
          variantAttributes: true,
          categoryAttributes: true,
        },
      })
      const byId = new Map(products.map((p) => [p.id, p]))

      // Per-brand+marketplace terminology — fetched once for the
      // batch since most batches share a brand. brand=null rows
      // apply to every brand on the marketplace.
      const distinctBrands = Array.from(
        new Set(products.map((p) => p.brand).filter((b): b is string => !!b)),
      )
      const terminologyRows = await prisma.terminologyPreference.findMany({
        where: {
          marketplace,
          OR: [
            { brand: null },
            ...(distinctBrands.length > 0
              ? [{ brand: { in: distinctBrands } }]
              : []),
          ],
        },
        select: { brand: true, preferred: true, avoid: true, context: true },
      })
      const terminologyByBrand = new Map<string | null, typeof terminologyRows>()
      for (const t of terminologyRows) {
        const arr = terminologyByBrand.get(t.brand) ?? []
        arr.push(t)
        terminologyByBrand.set(t.brand, arr)
      }

      const results: BulkGenerateResult[] = []
      for (const id of productIds) {
        const product = byId.get(id)
        if (!product) {
          results.push({ productId: id, ok: false, error: 'Product not found' })
          continue
        }

        try {
          const terminology = [
            ...(terminologyByBrand.get(product.brand) ?? []),
            ...(terminologyByBrand.get(null) ?? []),
          ].map((t) => ({
            preferred: t.preferred,
            avoid: t.avoid,
            context: t.context,
          }))

          const generated = await service.generate({
            product: {
              id: product.id,
              sku: product.sku,
              name: product.name,
              brand: product.brand,
              description: product.description,
              bulletPoints: product.bulletPoints ?? [],
              keywords: product.keywords ?? [],
              weightValue:
                product.weightValue != null ? Number(product.weightValue) : null,
              weightUnit: product.weightUnit,
              dimLength:
                product.dimLength != null ? Number(product.dimLength) : null,
              dimWidth:
                product.dimWidth != null ? Number(product.dimWidth) : null,
              dimHeight:
                product.dimHeight != null ? Number(product.dimHeight) : null,
              dimUnit: product.dimUnit,
              productType: product.productType,
              variantAttributes: product.variantAttributes,
              categoryAttributes: product.categoryAttributes,
            },
            marketplace,
            fields: requestedFields,
            terminology,
            provider: providerName,
            modelOverride,
          })

          // H.7 — flush per-field cost telemetry. Failures don't bubble
          // (logUsage swallows DB errors); the user already paid the
          // round-trip and we don't want to fail their write to record
          // accounting.
          for (const u of generated.usage) {
            logUsage({
              provider: u.provider,
              model: u.model,
              feature: 'products-ai-bulk',
              entityType: 'Product',
              entityId: id,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              costUSD: u.costUSD,
              latencyMs: generated.metadata.elapsedMs,
              ok: true,
              metadata: {
                marketplace,
                fields: requestedFields,
                dryRun,
              },
            })
          }

          let written: ContentField[] = []
          if (!dryRun) {
            // H.10 — route the write based on language. If the marketplace
            // resolves to the primary language (Italian for Xavia), write
            // to the Product master row (existing behaviour). Otherwise
            // upsert a ProductTranslation row keyed on (productId,
            // language) so the master keeps its primary-language content.
            const targetLang = languageForMarketplace(marketplace)
            const writeToMaster = isPrimaryLanguage(targetLang)

            const titleVal =
              generated.title && requestedFields.includes('title')
                ? generated.title.content
                : undefined
            const descVal = generated.description?.content
            const bulletsVal = generated.bullets?.content
            const keywordsVal = generated.keywords
              ? generated.keywords.content
                  .split(',')
                  .map((k) => k.trim())
                  .filter(Boolean)
              : undefined

            if (titleVal !== undefined) written.push('title')
            if (descVal !== undefined) written.push('description')
            if (bulletsVal !== undefined) written.push('bullets')
            if (keywordsVal !== undefined) written.push('keywords')

            if (writeToMaster) {
              const updateData: Record<string, unknown> = {
                version: { increment: 1 },
              }
              if (titleVal !== undefined) updateData.name = titleVal
              if (descVal !== undefined) updateData.description = descVal
              if (bulletsVal !== undefined) updateData.bulletPoints = bulletsVal
              if (keywordsVal !== undefined) updateData.keywords = keywordsVal
              if (Object.keys(updateData).length > 1) {
                await prisma.product.update({ where: { id }, data: updateData })
              }
            } else if (written.length > 0) {
              // Non-primary language → upsert ProductTranslation. Each
              // requested field overrides; unrequested fields leave the
              // existing translation row untouched.
              const data: Record<string, unknown> = {}
              if (titleVal !== undefined) data.name = titleVal
              if (descVal !== undefined) data.description = descVal
              if (bulletsVal !== undefined) data.bulletPoints = bulletsVal
              if (keywordsVal !== undefined) data.keywords = keywordsVal
              const aiSource =
                generated.metadata.provider === 'anthropic'
                  ? 'ai-anthropic'
                  : 'ai-gemini'
              await prisma.productTranslation.upsert({
                where: {
                  productId_language: { productId: id, language: targetLang },
                },
                create: {
                  productId: id,
                  language: targetLang,
                  name: typeof titleVal === 'string' ? titleVal : null,
                  description: typeof descVal === 'string' ? descVal : null,
                  bulletPoints: Array.isArray(bulletsVal) ? bulletsVal : [],
                  keywords: Array.isArray(keywordsVal) ? keywordsVal : [],
                  source: aiSource,
                  sourceModel: generated.metadata.model,
                  reviewedAt: null, // AI-generated; needs operator review
                },
                update: {
                  ...data,
                  source: aiSource,
                  sourceModel: generated.metadata.model,
                  reviewedAt: null, // re-AIing wipes prior review
                },
              })
            }

            if (written.length > 0) {
              // Audit row so the activity tab (F3) shows the AI write
              // attributed to the source.
              auditLogService.write({
                userId: 'ai',
                entityType: 'Product',
                entityId: id,
                action: 'update',
                after: { fields: written, marketplace, language: targetLang },
                metadata: {
                  source: 'products-ai-bulk',
                  marketplace,
                  language: targetLang,
                  target: writeToMaster ? 'master' : 'translation',
                  fields: written,
                  model: generated.metadata.model,
                  provider: generated.metadata.provider,
                },
              })
            }
          }

          results.push({
            productId: id,
            ok: true,
            generated,
            written: dryRun ? [] : written,
          })
        } catch (err) {
          results.push({
            productId: id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // P.13 — roll up usage so the modal can show "spent $0.12 on
      // 8 products with anthropic/claude-3-5-sonnet". The per-result
      // generated.usage array already carries cost; we sum across
      // every successful result. Failed calls don't contribute (no
      // usage object on a thrown call).
      let totalCostUSD = 0
      let totalInputTokens = 0
      let totalOutputTokens = 0
      const providersUsed = new Set<string>()
      const modelsUsed = new Set<string>()
      for (const r of results) {
        if (!r.ok || !r.generated?.usage) continue
        for (const u of r.generated.usage) {
          totalCostUSD += u.costUSD ?? 0
          totalInputTokens += u.inputTokens ?? 0
          totalOutputTokens += u.outputTokens ?? 0
          if (u.provider) providersUsed.add(u.provider)
          if (u.model) modelsUsed.add(u.model)
        }
      }

      return {
        results,
        summary: {
          total: results.length,
          succeeded: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          dryRun,
          // P.13 — cost + token visibility for the modal.
          totalCostUSD,
          totalInputTokens,
          totalOutputTokens,
          providersUsed: Array.from(providersUsed),
          modelsUsed: Array.from(modelsUsed),
        },
      }
    },
  )

  /**
   * P.14 — POST /api/products/:id/ai/suggest-fields
   *
   * Asks the LLM to fill in master-data fields that are commonly
   * missing (brand + productType today). Returns suggestions only
   * — the operator decides whether to apply each one via PATCH
   * /api/products/:id. No auto-write here. Suggestions surface in
   * the drawer's DetailGrid next to empty fields.
   *
   * Why these two fields specifically:
   *   - brand and productType drive faceted filtering, AI listing
   *     content terminology lookup (IT_TERMS), and per-channel
   *     category mapping. They're the highest-impact missing-data
   *     to fix.
   *   - title/description/bullets/keywords have a dedicated bulk
   *     flow (POST /products/ai/bulk-generate). Don't duplicate.
   *
   * Body (optional): { provider?: 'gemini' | 'anthropic' }
   * Query: none
   *
   * Response (200):
   *   {
   *     productId,
   *     suggestions: { brand?: string; productType?: string; reasoning?: string },
   *     usage: ProviderUsage,
   *   }
   *
   * Returns 503 when no AI provider is configured.
   */
  fastify.post<{
    Params: { id: string }
    Body: { provider?: string }
  }>(
    '/products/:id/ai/suggest-fields',
    {
      // Same rate-limit philosophy as bulk-generate — AI calls are
      // billable and one stuck retry loop can pin quota. Per-product
      // is cheaper than fan-out so 20/min is generous enough for
      // sweeping a small batch by hand.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = request.params
      const provider = getProvider(request.body?.provider)
      if (!provider) {
        return reply.code(503).send({
          error:
            'No AI provider configured — set GEMINI_API_KEY or ANTHROPIC_API_KEY on the API server.',
        })
      }

      const product = await prisma.product.findUnique({
        where: { id },
        select: {
          id: true,
          sku: true,
          name: true,
          description: true,
          brand: true,
          productType: true,
          // bullet points + first image give the model more signal
          // for products with sparse name/description.
          bulletPoints: true,
          images: { select: { url: true }, take: 1 },
        },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }

      const startedAt = Date.now()
      // Plain-text prompt; jsonMode asks the provider to return
      // JSON-only output. Anthropic emits JSON-shaped text; Gemini
      // honours jsonMode natively. Both work with parseJson below.
      const prompt = [
        'You are a product-catalog assistant. Given the product info',
        'below, suggest the most likely brand and productType.',
        'productType is a short canonical English noun (e.g. "Jacket",',
        '"Helmet", "Glove", "Bag"). brand is the manufacturer / brand',
        'name as it appears on the product. Both fields can be null',
        'if you genuinely cannot tell from the info given.',
        '',
        'Return strict JSON: {"brand": string|null, "productType":',
        'string|null, "reasoning": string}',
        '',
        'Product info:',
        `SKU: ${product.sku}`,
        `Name: ${product.name}`,
        product.description
          ? `Description: ${product.description.slice(0, 800)}`
          : null,
        product.brand ? `Existing brand (override?): ${product.brand}` : null,
        product.productType
          ? `Existing productType (override?): ${product.productType}`
          : null,
        product.bulletPoints && product.bulletPoints.length > 0
          ? `Bullets: ${product.bulletPoints.slice(0, 5).join(' | ')}`
          : null,
      ]
        .filter(Boolean)
        .join('\n')

      try {
        const result = await provider.generate({
          prompt,
          temperature: 0.2, // low — we want deterministic-ish answers
          jsonMode: true,
          feature: 'products-ai-suggest-fields',
          entityType: 'Product',
          entityId: id,
        })
        // Strip code-fences in case the provider emits ```json wrappers
        // even with jsonMode set.
        const cleaned = result.text
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim()
        let parsed: { brand?: string | null; productType?: string | null; reasoning?: string }
        try {
          parsed = JSON.parse(cleaned)
        } catch {
          throw new Error(`Provider returned invalid JSON: ${result.text.slice(0, 200)}`)
        }
        // Normalise — drop empty strings + treat 'null' string as null
        const norm = (v: unknown): string | null => {
          if (typeof v !== 'string') return null
          const t = v.trim()
          if (!t || t.toLowerCase() === 'null') return null
          return t
        }
        const suggestions = {
          brand: norm(parsed.brand) ?? undefined,
          productType: norm(parsed.productType) ?? undefined,
          reasoning:
            typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
        }

        // Telemetry — same logUsage shape as bulk-generate so the
        // /settings/ai dashboard rolls everything up uniformly.
        logUsage({
          provider: result.usage.provider,
          model: result.usage.model,
          feature: 'products-ai-suggest-fields',
          entityType: 'Product',
          entityId: id,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUSD: result.usage.costUSD,
          latencyMs: Date.now() - startedAt,
          ok: true,
          metadata: { suggestions },
        })

        return {
          productId: id,
          suggestions,
          usage: result.usage,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logUsage({
          provider: provider.name,
          model: provider.defaultModel,
          feature: 'products-ai-suggest-fields',
          entityType: 'Product',
          entityId: id,
          inputTokens: 0,
          outputTokens: 0,
          costUSD: 0,
          latencyMs: Date.now() - startedAt,
          ok: false,
          errorMessage: message,
        })
        fastify.log.error(
          { err, productId: id },
          '[products/ai/suggest-fields] failed',
        )
        return reply.code(500).send({ error: message })
      }
    },
  )
}

export default productsAiRoutes
