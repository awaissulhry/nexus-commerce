/**
 * ED.1/ED.2 — eBay description-theme CRUD + preview.
 *
 * Themes wrap the per-market body copy at push time (see
 * services/ebay-description-theme.service.ts). Preview renders exactly what a
 * push would send for a product × market, without touching eBay or the DB.
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import {
  listThemes,
  setDefaultTheme,
  renderListingDescriptionSafe,
} from '../services/ebay-description-theme.service.js'

export default async function ebayDescriptionThemesRoutes(fastify: FastifyInstance) {
  // ── List (seeds the built-in starters on first call) ─────────────────────
  fastify.get('/ebay/description-themes', async (_request, reply) => {
    const themes = await listThemes(prisma)
    return reply.send({ themes })
  })

  fastify.post<{ Body: { name?: string; html?: string; notes?: string } }>(
    '/ebay/description-themes',
    async (request, reply) => {
      const { name, html, notes } = request.body ?? {}
      if (!name?.trim() || !html?.trim()) {
        return reply.code(400).send({ error: 'name and html are required' })
      }
      try {
        const theme = await prisma.ebayDescriptionTheme.create({
          data: { name: name.trim(), html, notes: notes ?? null },
        })
        return reply.send({ theme })
      } catch (err: any) {
        if (err?.code === 'P2002') return reply.code(409).send({ error: `A theme named "${name.trim()}" already exists` })
        throw err
      }
    },
  )

  fastify.put<{ Params: { id: string }; Body: { name?: string; html?: string; notes?: string; active?: boolean } }>(
    '/ebay/description-themes/:id',
    async (request, reply) => {
      const { id } = request.params
      const { name, html, notes, active } = request.body ?? {}
      const existing = await prisma.ebayDescriptionTheme.findUnique({ where: { id } })
      if (!existing) return reply.code(404).send({ error: 'Theme not found' })
      const theme = await prisma.ebayDescriptionTheme.update({
        where: { id },
        data: {
          ...(name?.trim() ? { name: name.trim() } : {}),
          ...(typeof html === 'string' && html.trim() ? { html } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(typeof active === 'boolean' ? { active } : {}),
          version: { increment: 1 },
        },
      })
      return reply.send({ theme })
    },
  )

  fastify.delete<{ Params: { id: string } }>('/ebay/description-themes/:id', async (request, reply) => {
    const existing = await prisma.ebayDescriptionTheme.findUnique({ where: { id: request.params.id } })
    if (!existing) return reply.code(404).send({ error: 'Theme not found' })
    if (existing.builtIn) {
      return reply.code(400).send({ error: 'Built-in starter themes can be edited or deactivated, not deleted' })
    }
    await prisma.ebayDescriptionTheme.delete({ where: { id: request.params.id } })
    // Listings referencing it by id simply fall back to the default at render.
    return reply.send({ ok: true })
  })

  fastify.post<{ Params: { id: string } }>('/ebay/description-themes/:id/default', async (request, reply) => {
    const id = request.params.id === 'none' ? null : request.params.id
    if (id) {
      const existing = await prisma.ebayDescriptionTheme.findUnique({ where: { id } })
      if (!existing) return reply.code(404).send({ error: 'Theme not found' })
    }
    await setDefaultTheme(prisma, id)
    return reply.send({ ok: true })
  })

  // ── Preview — render exactly what a push would send (no eBay, no writes) ──
  fastify.post<{
    Body: {
      productId?: string
      marketplace?: string
      sku?: string
      mode?: 'single' | 'group'
      body?: string
      title?: string
      themeId?: string
    }
  }>('/ebay/description-preview', async (request, reply) => {
    const { productId, marketplace = 'IT', sku, mode = 'group', body, title, themeId } = request.body ?? {}
    if (!productId) return reply.code(400).send({ error: 'productId required' })
    const listing = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', region: marketplace.toUpperCase() === 'UK' ? 'GB' : marketplace.toUpperCase() },
      select: { description: true, title: true },
    })
    const result = await renderListingDescriptionSafe(prisma, {
      productId,
      marketplace,
      mode,
      sku,
      body: body ?? listing?.description ?? '',
      title: title ?? listing?.title ?? undefined,
      themeIdOverride: themeId,
    })
    return reply.send(result)
  })
}
