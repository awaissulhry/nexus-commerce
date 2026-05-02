/**
 * P0 #27: Per-brand / per-marketplace terminology preferences.
 *
 *   GET    /api/terminology?brand=&marketplace=
 *   POST   /api/terminology
 *   PATCH  /api/terminology/:id
 *   DELETE /api/terminology/:id
 *
 * Used by ListingContentService to inject brand glossary into the
 * Gemini prompt (Giubbotto vs Giacca and similar). Read by the
 * /settings/terminology admin UI.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

interface CreateBody {
  brand?: string | null
  marketplace?: string
  language?: string
  preferred?: string
  avoid?: string[]
  context?: string | null
}

interface PatchBody {
  brand?: string | null
  marketplace?: string
  language?: string
  preferred?: string
  avoid?: string[]
  context?: string | null
}

const terminologyRoutes: FastifyPluginAsync = async (fastify) => {
  // List — optional brand / marketplace filters. `brand=*` (or omit)
  // returns everything; `brand=Xavia%20Racing` returns brand-specific
  // + brand=null defaults; `brand=__none__` returns only defaults.
  fastify.get<{
    Querystring: { brand?: string; marketplace?: string }
  }>('/terminology', async (request) => {
    const { brand, marketplace } = request.query
    const where: any = {}
    if (marketplace) {
      where.marketplace = marketplace.toUpperCase()
    }
    if (brand === '__none__') {
      where.brand = null
    } else if (brand && brand !== '*') {
      // Brand specified — include both brand-specific and defaults
      // (defaults apply to all brands in the marketplace).
      where.OR = [{ brand }, { brand: null }]
    }
    const items = await prisma.terminologyPreference.findMany({
      where,
      orderBy: [{ marketplace: 'asc' }, { brand: 'asc' }, { preferred: 'asc' }],
    })
    return { items, count: items.length }
  })

  fastify.post<{ Body: CreateBody }>('/terminology', async (request, reply) => {
    const body = request.body ?? {}
    const marketplace = body.marketplace?.toUpperCase()
    const language = body.language?.toLowerCase()
    const preferred = body.preferred?.trim()
    if (!marketplace || !language || !preferred) {
      return reply.code(400).send({
        error: 'marketplace, language, preferred are required',
      })
    }
    const avoid = Array.isArray(body.avoid)
      ? body.avoid
          .map((s) => String(s).trim())
          .filter((s) => s.length > 0)
      : []
    const created = await prisma.terminologyPreference.create({
      data: {
        brand: body.brand ?? null,
        marketplace,
        language,
        preferred,
        avoid,
        context: body.context?.trim() || null,
      },
    })
    return { item: created }
  })

  fastify.patch<{ Params: { id: string }; Body: PatchBody }>(
    '/terminology/:id',
    async (request, reply) => {
      const body = request.body ?? {}
      const data: any = {}
      if (body.brand !== undefined) data.brand = body.brand
      if (body.marketplace !== undefined) {
        data.marketplace = body.marketplace.toUpperCase()
      }
      if (body.language !== undefined) {
        data.language = body.language.toLowerCase()
      }
      if (body.preferred !== undefined) data.preferred = body.preferred.trim()
      if (body.avoid !== undefined) {
        data.avoid = Array.isArray(body.avoid)
          ? body.avoid
              .map((s) => String(s).trim())
              .filter((s) => s.length > 0)
          : []
      }
      if (body.context !== undefined) {
        data.context = body.context?.trim() || null
      }
      try {
        const updated = await prisma.terminologyPreference.update({
          where: { id: request.params.id },
          data,
        })
        return { item: updated }
      } catch (err: any) {
        if (err?.code === 'P2025') {
          return reply.code(404).send({ error: 'Not found' })
        }
        throw err
      }
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/terminology/:id',
    async (request, reply) => {
      try {
        await prisma.terminologyPreference.delete({
          where: { id: request.params.id },
        })
        return { ok: true }
      } catch (err: any) {
        if (err?.code === 'P2025') {
          return reply.code(404).send({ error: 'Not found' })
        }
        throw err
      }
    },
  )
}

export default terminologyRoutes
