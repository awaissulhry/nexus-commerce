/**
 * H.10 — per-language master content CRUD.
 *
 *   GET    /api/products/:id/translations
 *     → { translations: [{ language, name, description, ... }] }
 *
 *   GET    /api/products/:id/translations/:language
 *     → resolved content (translation if present, master fallback
 *       otherwise) so the drawer can render a single field-set
 *       per language without two lookups.
 *
 *   PUT    /api/products/:id/translations/:language
 *     body: { name?, description?, bulletPoints?, keywords?,
 *             source?, sourceModel?, reviewedAt? }
 *     → upsert. Empty / missing fields are NOT cleared — pass
 *       explicit null to wipe. Any write bumps updatedAt and (for
 *       AI-source rows) clears reviewedAt unless explicitly set.
 *
 *   POST   /api/products/:id/translations/:language/review
 *     Marks the row as reviewed. Replaces an explicit
 *     `reviewedAt: now()` field set in PUT for the common "I
 *     looked at this and it's fine" gesture.
 *
 *   DELETE /api/products/:id/translations/:language
 *     Tear down a translation. Channel reads fall back to master.
 *
 * Primary-language writes (NEXUS_PRIMARY_LANGUAGE, default 'it')
 * forward to PATCH /api/products/:id instead of touching this
 * table — the master row IS the primary translation.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  getPrimaryLanguage,
  isPrimaryLanguage,
  marketplaceForLanguage,
  resolveProductContent,
} from '../services/products/translation-resolver.service.js'
import {
  ListingContentService,
  type ContentField,
} from '../services/ai/listing-content.service.js'

const listingContentService = new ListingContentService()

interface TranslationBody {
  name?: string | null
  description?: string | null
  bulletPoints?: string[] | null
  keywords?: string[] | null
  source?: string
  sourceModel?: string
  reviewedAt?: string | null
}

const productTranslationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/translations',
    async (request, reply) => {
      const { id } = request.params
      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })
      const rows = await prisma.productTranslation.findMany({
        where: { productId: id },
        orderBy: { language: 'asc' },
      })
      return {
        primaryLanguage: getPrimaryLanguage(),
        translations: rows,
      }
    },
  )

  fastify.get<{ Params: { id: string; language: string } }>(
    '/products/:id/translations/:language',
    async (request, reply) => {
      const { id, language } = request.params
      const resolved = await resolveProductContent(prisma, id, language)
      if (!resolved) return reply.code(404).send({ error: 'Product not found' })
      return resolved
    },
  )

  fastify.put<{
    Params: { id: string; language: string }
    Body: TranslationBody
  }>('/products/:id/translations/:language', async (request, reply) => {
    const { id, language } = request.params
    const lang = language.toLowerCase()
    const body = request.body ?? {}

    const product = await prisma.product.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!product) return reply.code(404).send({ error: 'Product not found' })

    if (isPrimaryLanguage(lang)) {
      // Primary language is the master row, not a translation. Forward
      // intent rather than silently no-op so the caller knows.
      return reply.code(400).send({
        error: `language '${lang}' is the primary language; PATCH /api/products/${id} instead`,
      })
    }

    // Build the upsert payload defensively. `null` values explicitly
    // clear; `undefined` leaves the existing value alone.
    const setData: Record<string, unknown> = {}
    if (body.name !== undefined) setData.name = body.name
    if (body.description !== undefined) setData.description = body.description
    if (Array.isArray(body.bulletPoints)) setData.bulletPoints = body.bulletPoints
    else if (body.bulletPoints === null) setData.bulletPoints = []
    if (Array.isArray(body.keywords)) setData.keywords = body.keywords
    else if (body.keywords === null) setData.keywords = []
    if (body.source !== undefined) setData.source = body.source
    if (body.sourceModel !== undefined) setData.sourceModel = body.sourceModel
    if (body.reviewedAt !== undefined) {
      setData.reviewedAt = body.reviewedAt ? new Date(body.reviewedAt) : null
    } else if (
      body.source &&
      body.source.startsWith('ai-')
    ) {
      // New AI-sourced write without explicit review → reset reviewedAt
      // so the UI flags it as needing eyes.
      setData.reviewedAt = null
    }

    const row = await prisma.productTranslation.upsert({
      where: { productId_language: { productId: id, language: lang } },
      create: {
        productId: id,
        language: lang,
        name: typeof body.name === 'string' ? body.name : null,
        description:
          typeof body.description === 'string' ? body.description : null,
        bulletPoints: Array.isArray(body.bulletPoints)
          ? body.bulletPoints
          : [],
        keywords: Array.isArray(body.keywords) ? body.keywords : [],
        source: body.source ?? 'manual',
        sourceModel: body.sourceModel ?? null,
        reviewedAt: body.reviewedAt
          ? new Date(body.reviewedAt)
          : body.source && body.source.startsWith('ai-')
            ? null
            : new Date(),
      },
      update: setData,
    })
    return row
  })

  fastify.post<{ Params: { id: string; language: string } }>(
    '/products/:id/translations/:language/review',
    async (request, reply) => {
      const { id, language } = request.params
      const lang = language.toLowerCase()
      const result = await prisma.productTranslation.updateMany({
        where: { productId: id, language: lang },
        data: { reviewedAt: new Date() },
      })
      if (result.count === 0) {
        return reply
          .code(404)
          .send({ error: `no translation for ${lang}` })
      }
      return { ok: true, reviewedAt: new Date().toISOString() }
    },
  )

  fastify.delete<{ Params: { id: string; language: string } }>(
    '/products/:id/translations/:language',
    async (request, reply) => {
      const { id, language } = request.params
      const lang = language.toLowerCase()
      if (isPrimaryLanguage(lang)) {
        return reply.code(400).send({
          error: 'cannot delete primary-language master',
        })
      }
      const result = await prisma.productTranslation.deleteMany({
        where: { productId: id, language: lang },
      })
      return { ok: true, deleted: result.count }
    },
  )

  // W4.2 — AI translate a product into the target language and persist
  // to the ProductTranslation row.
  //
  //   POST /api/products/:id/translations/:language/ai-translate
  //     body: { fields?: ('title' | 'bullets' | 'description' | 'keywords')[] }
  //     → { row, fieldsTranslated, fieldsSkipped }
  //
  // Resolves the language to a representative marketplace via
  // marketplaceForLanguage() because ListingContentService is keyed
  // by marketplace (it picks per-locale prompt + glossary). The
  // resulting copy is written back with source='ai-gemini' and
  // reviewedAt cleared so the LocalesTab UI flags it as needing eyes.
  //
  // Returns 503 when GEMINI_API_KEY isn't set so the client can show
  // a "configure provider" hint rather than hanging.
  //
  // Rate limit: 60/min/IP. AI calls cost real money; this is generous
  // for legit per-locale fan-out (8 supported locales × 4 fields = a
  // handful of calls in a typical session) and blocks runaway loops.
  const ALLOWED_FIELDS = new Set<ContentField>([
    'title',
    'bullets',
    'description',
    'keywords',
  ])
  fastify.post<{
    Params: { id: string; language: string }
    Body: { fields?: string[] }
  }>(
    '/products/:id/translations/:language/ai-translate',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      if (!listingContentService.isConfigured()) {
        return reply.code(503).send({
          error:
            'Gemini API not configured — set GEMINI_API_KEY on the API server.',
        })
      }
      const { id } = request.params
      const lang = request.params.language.toLowerCase()
      if (isPrimaryLanguage(lang)) {
        return reply.code(400).send({
          error: `language '${lang}' is the primary language; nothing to translate`,
        })
      }
      const requested = (
        request.body?.fields && request.body.fields.length > 0
          ? request.body.fields
          : ['title', 'bullets', 'description', 'keywords']
      ).filter((f): f is ContentField => ALLOWED_FIELDS.has(f as ContentField))
      if (requested.length === 0) {
        return reply.code(400).send({
          error: `fields must include one or more of ${Array.from(
            ALLOWED_FIELDS,
          ).join(', ')}`,
        })
      }

      const product = await prisma.product.findUnique({
        where: { id },
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
      if (!product) {
        return reply.code(404).send({ error: `Product ${id} not found` })
      }

      const marketplace = marketplaceForLanguage(lang)
      const terminology = await prisma.terminologyPreference.findMany({
        where: {
          marketplace,
          OR: [{ brand: product.brand }, { brand: null }],
        },
        select: { preferred: true, avoid: true, context: true },
        orderBy: [{ brand: 'desc' }, { preferred: 'asc' }],
      })

      let result
      try {
        result = await listingContentService.generate({
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
            brand: product.brand,
            description: product.description,
            bulletPoints: product.bulletPoints,
            keywords: product.keywords,
            weightValue: product.weightValue
              ? Number(product.weightValue)
              : null,
            weightUnit: product.weightUnit,
            dimLength: product.dimLength ? Number(product.dimLength) : null,
            dimWidth: product.dimWidth ? Number(product.dimWidth) : null,
            dimHeight: product.dimHeight ? Number(product.dimHeight) : null,
            dimUnit: product.dimUnit,
            productType: product.productType,
            variantAttributes: product.variantAttributes,
            categoryAttributes: product.categoryAttributes,
          },
          marketplace,
          fields: requested,
          variant: 0,
          terminology,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        request.log.error(
          { err, productId: id, language: lang, marketplace },
          '[products/translations/ai-translate] generate failed',
        )
        return reply.code(502).send({
          error: `AI generation failed: ${message}`,
        })
      }

      // Map ContentField result → ProductTranslation columns.
      const updates: Record<string, unknown> = {
        source: 'ai-gemini',
        sourceModel: 'gemini-2.0-flash',
        reviewedAt: null,
      }
      const fieldsTranslated: string[] = []
      const fieldsSkipped: string[] = []
      for (const f of requested) {
        const r = (result as any)[f]
        if (!r || r.content == null) {
          fieldsSkipped.push(f)
          continue
        }
        if (f === 'title') {
          updates.name = String(r.content)
          fieldsTranslated.push(f)
        } else if (f === 'description') {
          updates.description = String(r.content)
          fieldsTranslated.push(f)
        } else if (f === 'bullets') {
          if (Array.isArray(r.content)) {
            const cleaned = r.content
              .filter(
                (b: unknown): b is string =>
                  typeof b === 'string' && b.trim().length > 0,
              )
              .map((b: string) => b.trim())
            updates.bulletPoints = cleaned
            fieldsTranslated.push(f)
          } else {
            fieldsSkipped.push(f)
          }
        } else if (f === 'keywords') {
          let kw: string[] = []
          if (Array.isArray(r.content)) {
            kw = r.content
              .filter(
                (k: unknown): k is string =>
                  typeof k === 'string' && k.trim().length > 0,
              )
              .map((k: string) => k.trim())
          } else if (typeof r.content === 'string') {
            kw = r.content
              .split(/[,\n]/)
              .map((k) => k.trim())
              .filter(Boolean)
          }
          if (kw.length > 0) {
            updates.keywords = kw
            fieldsTranslated.push(f)
          } else {
            fieldsSkipped.push(f)
          }
        }
      }

      // Upsert. On create we still want any non-touched fields to land
      // sensibly (empty arrays for bulletPoints/keywords).
      const row = await prisma.productTranslation.upsert({
        where: { productId_language: { productId: id, language: lang } },
        create: {
          productId: id,
          language: lang,
          name: typeof updates.name === 'string' ? (updates.name as string) : null,
          description:
            typeof updates.description === 'string'
              ? (updates.description as string)
              : null,
          bulletPoints: Array.isArray(updates.bulletPoints)
            ? (updates.bulletPoints as string[])
            : [],
          keywords: Array.isArray(updates.keywords)
            ? (updates.keywords as string[])
            : [],
          source: 'ai-gemini',
          sourceModel: 'gemini-2.0-flash',
          reviewedAt: null,
        },
        update: updates,
      })

      return {
        row,
        marketplace,
        fieldsTranslated,
        fieldsSkipped,
      }
    },
  )
}

export default productTranslationsRoutes
