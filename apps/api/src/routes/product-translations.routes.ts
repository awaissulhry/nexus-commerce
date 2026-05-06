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
  resolveProductContent,
} from '../services/products/translation-resolver.service.js'

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
}

export default productTranslationsRoutes
