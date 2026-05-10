/**
 * MC.10.1 — Brand Kit CRUD.
 *
 * One BrandKit per brand label (unique). Operator typically has
 * 1–3 brands so the list is small + always-loaded; pagination is
 * unnecessary.
 *
 * Endpoints (under /api):
 *   GET    /brand-kits                 list every kit (with brand product count)
 *   GET    /brand-kits/:brand          detail by brand label
 *   PUT    /brand-kits/:brand          upsert by brand
 *   DELETE /brand-kits/:brand          remove + cascade watermarks
 *
 * Watermark CRUD lands in MC.10.3 alongside the renderer.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { checkBrandConsistency } from '../services/brand-consistency.service.js'

const brandKitRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/brand-kits', async () => {
    const kits = await prisma.brandKit.findMany({
      orderBy: { brand: 'asc' },
      include: {
        _count: { select: { watermarks: true } },
      },
    })
    // Surface the per-brand product count so the operator sees how
    // many products inherit each kit. Non-blocking — empty array if
    // the lookup fails.
    const brands = kits.map((k) => k.brand)
    let productCounts: Record<string, number> = {}
    try {
      const counts = await prisma.product.groupBy({
        by: ['brand'],
        where: { brand: { in: brands } },
        _count: { _all: true },
      })
      productCounts = counts.reduce(
        (acc, row) => {
          if (row.brand) acc[row.brand] = row._count._all
          return acc
        },
        {} as Record<string, number>,
      )
    } catch {
      /* keep empty */
    }
    return {
      kits: kits.map((k) => ({
        ...k,
        productCount: productCounts[k.brand] ?? 0,
      })),
    }
  })

  fastify.get('/brand-kits/:brand', async (request, reply) => {
    const { brand } = request.params as { brand: string }
    const kit = await prisma.brandKit.findUnique({
      where: { brand },
      include: { watermarks: { orderBy: { createdAt: 'asc' } } },
    })
    if (!kit)
      return reply.code(404).send({ error: 'Brand kit not found' })
    return { kit }
  })

  // Upsert by brand. Body fields all optional except `brand` is
  // implicit from the route. Allows partial-edit semantics — the
  // operator saves the colors section without re-sending fonts.
  fastify.put('/brand-kits/:brand', async (request, reply) => {
    const { brand } = request.params as { brand: string }
    if (!brand?.trim())
      return reply.code(400).send({ error: 'brand is required in path' })
    const body = request.body as {
      displayName?: string | null
      tagline?: string | null
      voiceNotes?: string | null
      colors?: unknown
      fonts?: unknown
      logos?: unknown
      notes?: string | null
    }

    // Validate the JSON-array fields are arrays. The PATCH-style
    // semantics mean we only touch the fields the caller sent.
    const data: Record<string, unknown> = {}
    if (body.displayName !== undefined)
      data.displayName = body.displayName?.trim() || null
    if (body.tagline !== undefined)
      data.tagline = body.tagline?.trim() || null
    if (body.voiceNotes !== undefined)
      data.voiceNotes = body.voiceNotes?.trim() || null
    if (body.notes !== undefined) data.notes = body.notes?.trim() || null
    for (const key of ['colors', 'fonts', 'logos'] as const) {
      if (body[key] !== undefined) {
        if (!Array.isArray(body[key]))
          return reply
            .code(400)
            .send({ error: `${key} must be an array` })
        data[key] = body[key] as never
      }
    }

    const kit = await prisma.brandKit.upsert({
      where: { brand },
      update: data,
      create: {
        brand,
        displayName: (body.displayName?.trim() || brand) as string,
        tagline: body.tagline?.trim() || null,
        voiceNotes: body.voiceNotes?.trim() || null,
        notes: body.notes?.trim() || null,
        colors: (Array.isArray(body.colors)
          ? (body.colors as never)
          : []) as never,
        fonts: (Array.isArray(body.fonts)
          ? (body.fonts as never)
          : []) as never,
        logos: (Array.isArray(body.logos)
          ? (body.logos as never)
          : []) as never,
      },
      include: { watermarks: true },
    })
    return { kit }
  })

  // ── MC.10.3 — Watermark template CRUD ───────────────────

  fastify.get('/brand-kits/:brand/watermarks', async (request, reply) => {
    const { brand } = request.params as { brand: string }
    const kit = await prisma.brandKit.findUnique({
      where: { brand },
      select: { id: true },
    })
    if (!kit)
      return reply.code(404).send({ error: 'Brand kit not found' })
    const watermarks = await prisma.brandWatermarkTemplate.findMany({
      where: { brand },
      orderBy: { createdAt: 'asc' },
    })
    return { watermarks }
  })

  fastify.post(
    '/brand-kits/:brand/watermarks',
    async (request, reply) => {
      const { brand } = request.params as { brand: string }
      const body = request.body as {
        name?: string
        type?: string
        config?: unknown
        enabled?: boolean
      }
      if (!body.name?.trim())
        return reply.code(400).send({ error: 'name is required' })
      if (!body.type?.trim())
        return reply.code(400).send({ error: 'type is required' })

      const kit = await prisma.brandKit.findUnique({
        where: { brand },
        select: { id: true },
      })
      if (!kit)
        return reply.code(404).send({ error: 'Brand kit not found' })

      const watermark = await prisma.brandWatermarkTemplate.create({
        data: {
          brand,
          name: body.name.trim(),
          type: body.type.trim(),
          config: (body.config as never) ?? {},
          enabled: body.enabled ?? true,
        },
      })
      return reply.code(201).send({ watermark })
    },
  )

  fastify.patch(
    '/brand-watermarks/:id',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as {
        name?: string
        type?: string
        config?: unknown
        enabled?: boolean
      }
      const data: Record<string, unknown> = {}
      if (body.name !== undefined) data.name = body.name.trim()
      if (body.type !== undefined) data.type = body.type.trim()
      if (body.config !== undefined)
        data.config = (body.config as never) ?? {}
      if (body.enabled !== undefined) data.enabled = body.enabled
      if (Object.keys(data).length === 0)
        return reply
          .code(400)
          .send({ error: 'no mutable fields supplied' })
      try {
        const watermark = await prisma.brandWatermarkTemplate.update({
          where: { id },
          data,
        })
        return { watermark }
      } catch (err: any) {
        if (err?.code === 'P2025')
          return reply
            .code(404)
            .send({ error: 'watermark template not found' })
        throw err
      }
    },
  )

  fastify.delete('/brand-watermarks/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.brandWatermarkTemplate.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply
          .code(404)
          .send({ error: 'watermark template not found' })
      throw err
    }
  })

  fastify.delete('/brand-kits/:brand', async (request, reply) => {
    const { brand } = request.params as { brand: string }
    try {
      await prisma.brandKit.delete({ where: { brand } })
      return { ok: true, brand }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'Brand kit not found' })
      throw err
    }
  })

  // ── MC.10.4 — Consistency monitoring ─────────────────────

  fastify.get(
    '/brand-kits/:brand/consistency',
    async (request) => {
      const { brand } = request.params as { brand: string }
      const result = await checkBrandConsistency(brand)
      return { result }
    },
  )

  // List the catalogue's brand labels — feeds the create-kit
  // dropdown so operators pick existing brand values rather than
  // typing arbitrary strings (which would orphan from products).
  fastify.get('/brand-kits/_meta/brands', async () => {
    const rows = await prisma.product.groupBy({
      by: ['brand'],
      where: { brand: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { brand: 'desc' } },
    })
    const kits = await prisma.brandKit.findMany({
      select: { brand: true },
    })
    const kitBrands = new Set(kits.map((k) => k.brand))
    return {
      brands: rows
        .filter((r) => r.brand)
        .map((r) => ({
          brand: r.brand as string,
          productCount: r._count._all,
          hasKit: kitBrands.has(r.brand as string),
        })),
    }
  })
}

export default brandKitRoutes
