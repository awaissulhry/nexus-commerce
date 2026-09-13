import { normalizeLanguage, languageEntry } from '../services/pim/content-language.js'
import { PRIMARY_CONTENT_LOCALE } from '../services/pim/content-locale.js'
import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * W12 — Per-product SEO metadata CRUD.
 *
 *   GET    /api/products/:id/seo
 *     → ProductSeo[]   (all locales for the product)
 *
 *   GET    /api/products/:id/seo/:locale
 *     → ProductSeo | null
 *
 *   PUT    /api/products/:id/seo/:locale
 *     Upsert — creates if absent, updates if present.
 *     body: { metaTitle?, metaDescription?, urlHandle?, ogTitle?,
 *              ogDescription?, ogImageUrl?, canonicalUrl?, schemaOrgJson? }
 *     → ProductSeo
 *
 *   DELETE /api/products/:id/seo/:locale
 *     → { deleted: true }
 *
 * Locale is BCP 47, normalised to lower-case. 'default' is the
 * canonical entry; other locales inherit from it when fields are null.
 */

import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';

// Historical "default" is the source address, never a second language.
const seoLanguage = (tag: string) => normalizeLanguage(tag === 'default' ? PRIMARY_CONTENT_LOCALE : tag)
async function seoRow(productId: string, requested: string) {
  const rows = await prisma.productSeo.findMany({ where: { productId } })
  return languageEntry(rows.map(row => [seoLanguage(row.locale), row] as const), requested)
}
const productSeoRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET all locales ─────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/seo',
    async (req, reply) => {
      const rows = await prisma.productSeo.findMany({
        where: { productId: req.params.id },
        orderBy: { locale: 'asc' },
      })
      return reply.send(rows.map(row => ({ ...row, locale: seoLanguage(row.locale) })))
    },
  )

  // ── GET single locale ───────────────────────────────────────────────
  fastify.get<{ Params: { id: string; locale: string } }>(
    '/products/:id/seo/:locale',
    async (req, reply) => {
      const row = await seoRow(req.params.id, seoLanguage(req.params.locale))
      if (!row) return reply.status(404).send({ error: 'SEO_NOT_FOUND' })
      return reply.send({ ...row, locale: seoLanguage(row.locale) })
    },
  )

  // ── PUT (upsert) ────────────────────────────────────────────────────
  fastify.put<{
    Params: { id: string; locale: string };
    Body: {
      metaTitle?: string | null;
      metaDescription?: string | null;
      urlHandle?: string | null;
      ogTitle?: string | null;
      ogDescription?: string | null;
      ogImageUrl?: string | null;
      canonicalUrl?: string | null;
      schemaOrgJson?: Record<string, unknown> | null;
    };
  }>('/products/:id/seo/:locale', async (req, reply) => {
    const productId = req.params.id
    const locale = seoLanguage(req.params.locale)
    const body = req.body ?? {}

    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } })
    if (!product) return reply.status(404).send({ error: 'PRODUCT_NOT_FOUND' })

    const existing = await seoRow(productId, locale)
    const row = await prisma.productSeo.upsert({
      where: { productId_locale: workspaceKey({ productId, locale: existing?.locale ?? locale }) },
      create: {
        productId,
        locale,
        metaTitle: body.metaTitle ?? null,
        metaDescription: body.metaDescription ?? null,
        urlHandle: body.urlHandle ?? null,
        ogTitle: body.ogTitle ?? null,
        ogDescription: body.ogDescription ?? null,
        ogImageUrl: body.ogImageUrl ?? null,
        canonicalUrl: body.canonicalUrl ?? null,
        schemaOrgJson: (body.schemaOrgJson ?? null) as Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue,
      },
      update: {
        ...(body.metaTitle !== undefined && { metaTitle: body.metaTitle }),
        ...(body.metaDescription !== undefined && { metaDescription: body.metaDescription }),
        ...(body.urlHandle !== undefined && { urlHandle: body.urlHandle }),
        ...(body.ogTitle !== undefined && { ogTitle: body.ogTitle }),
        ...(body.ogDescription !== undefined && { ogDescription: body.ogDescription }),
        ...(body.ogImageUrl !== undefined && { ogImageUrl: body.ogImageUrl }),
        ...(body.canonicalUrl !== undefined && { canonicalUrl: body.canonicalUrl }),
        ...(body.schemaOrgJson !== undefined && { schemaOrgJson: body.schemaOrgJson as Prisma.InputJsonValue }),
      },
    })

    return reply.status(200).send({ ...row, locale: seoLanguage(row.locale) })
  })

  // ── DELETE ──────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string; locale: string } }>(
    '/products/:id/seo/:locale',
    async (req, reply) => {
      const productId = req.params.id
      const locale = seoLanguage(req.params.locale)
      const existing = await seoRow(productId, locale)
      if (!existing) return reply.status(404).send({ error: 'SEO_NOT_FOUND' })
      await prisma.productSeo.delete({ where: { id: existing.id } })
      return reply.send({ deleted: true })
    },
  )
}

export default productSeoRoutes
