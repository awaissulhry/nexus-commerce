/**
 * W2.5 — ProductFamily CRUD.
 *
 * Endpoints (all under /api):
 *   GET    /families                       — list all families
 *   GET    /families/:id                   — single family detail
 *   GET    /families/:id/effective         — resolver result (uses W2.4)
 *   POST   /families                       — create
 *   PATCH  /families/:id                   — update label/desc/parent
 *   DELETE /families/:id                   — delete (cascades:
 *                                              child families → parent SET NULL,
 *                                              attached products → familyId SET NULL,
 *                                              FamilyAttribute rows → CASCADE)
 *
 * FamilyAttribute attach/detach is a separate concern; lives in
 * W2.7 (likely under /families/:id/attributes).
 *
 * Validation:
 *   - code: required, lowercase snake_case (Akeneo convention)
 *   - label: required, non-empty
 *   - parentFamilyId (when set): must exist; setting it must NOT
 *     create a cycle (walk the candidate's chain looking for self)
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { familyHierarchyService } from '../services/family-hierarchy.service.js'

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const MAX_DEPTH = 8

const familiesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/families — list with attribute counts.
  fastify.get('/families', async (request, reply) => {
    const q = request.query as { includeAttributes?: string }
    const includeAttrs =
      q.includeAttributes === '1' || q.includeAttributes === 'true'
    const families = await prisma.productFamily.findMany({
      orderBy: [{ label: 'asc' }],
      include: {
        _count: {
          select: { products: true, familyAttributes: true, childFamilies: true },
        },
        ...(includeAttrs
          ? {
              familyAttributes: {
                select: {
                  attributeId: true,
                  required: true,
                  channels: true,
                  sortOrder: true,
                },
              },
            }
          : {}),
      },
    })
    return { families }
  })

  // GET /api/families/:id — single family + counts.
  fastify.get('/families/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const family = await prisma.productFamily.findUnique({
      where: { id },
      include: {
        parentFamily: { select: { id: true, code: true, label: true } },
        childFamilies: { select: { id: true, code: true, label: true } },
        familyAttributes: {
          orderBy: [{ sortOrder: 'asc' }],
          include: {
            attribute: {
              select: { id: true, code: true, label: true, type: true, groupId: true },
            },
          },
        },
        _count: { select: { products: true } },
      },
    })
    if (!family) return reply.code(404).send({ error: 'family not found' })
    return { family }
  })

  // GET /api/families/:id/effective — resolved attribute set walking
  // the parent chain (W2.4 service). Used by the editor + completeness
  // recompute paths.
  fastify.get('/families/:id/effective', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const effective =
        await familyHierarchyService.resolveEffectiveAttributes(id)
      return { familyId: id, attributes: effective }
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (/not found/i.test(msg)) return reply.code(404).send({ error: msg })
      if (/cycle|depth exceeded/i.test(msg))
        return reply.code(409).send({ error: msg })
      throw err
    }
  })

  // POST /api/families — create.
  fastify.post('/families', async (request, reply) => {
    const body = request.body as {
      code?: string
      label?: string
      description?: string | null
      parentFamilyId?: string | null
    }
    if (!body.code || !CODE_PATTERN.test(body.code)) {
      return reply.code(400).send({
        error:
          'code is required and must be lowercase snake_case (matches /^[a-z][a-z0-9_]{0,63}$/)',
      })
    }
    if (!body.label || !body.label.trim()) {
      return reply.code(400).send({ error: 'label is required' })
    }
    if (body.parentFamilyId) {
      const parent = await prisma.productFamily.findUnique({
        where: { id: body.parentFamilyId },
        select: { id: true },
      })
      if (!parent)
        return reply.code(400).send({ error: 'parentFamilyId does not exist' })
    }
    try {
      const family = await prisma.productFamily.create({
        data: {
          code: body.code,
          label: body.label.trim(),
          description: body.description?.trim() || null,
          parentFamilyId: body.parentFamilyId ?? null,
        },
      })
      return reply.code(201).send({ family })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply.code(409).send({ error: `family code "${body.code}" already exists` })
      throw err
    }
  })

  // PATCH /api/families/:id — update mutable fields. Cycle-detect on
  // parentFamilyId changes by walking the candidate's chain.
  fastify.patch('/families/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      label?: string
      description?: string | null
      parentFamilyId?: string | null
    }

    const current = await prisma.productFamily.findUnique({
      where: { id },
      select: { id: true, parentFamilyId: true },
    })
    if (!current) return reply.code(404).send({ error: 'family not found' })

    const data: Record<string, unknown> = {}
    if (body.label !== undefined) {
      if (!body.label.trim())
        return reply.code(400).send({ error: 'label cannot be empty' })
      data.label = body.label.trim()
    }
    if (body.description !== undefined) {
      data.description = body.description?.trim() || null
    }
    if (body.parentFamilyId !== undefined) {
      // Self-parent guard.
      if (body.parentFamilyId === id) {
        return reply
          .code(400)
          .send({ error: 'family cannot be its own parent' })
      }
      if (body.parentFamilyId !== null) {
        // Verify candidate exists.
        const candidate = await prisma.productFamily.findUnique({
          where: { id: body.parentFamilyId },
          select: { id: true },
        })
        if (!candidate)
          return reply
            .code(400)
            .send({ error: 'parentFamilyId does not exist' })

        // Cycle detection: walk candidate's chain; if we hit `id`, the
        // proposed reparent would create a loop.
        let cursor: string | null = body.parentFamilyId
        let depth = 0
        while (cursor && depth < MAX_DEPTH) {
          if (cursor === id) {
            return reply.code(409).send({
              error:
                'reparent rejected: would create a cycle in the family hierarchy',
            })
          }
          const next = await prisma.productFamily.findUnique({
            where: { id: cursor },
            select: { parentFamilyId: true },
          })
          cursor = next?.parentFamilyId ?? null
          depth++
        }
        if (depth >= MAX_DEPTH && cursor) {
          return reply.code(409).send({
            error: `reparent rejected: hierarchy depth would exceed ${MAX_DEPTH}`,
          })
        }
      }
      data.parentFamilyId = body.parentFamilyId
    }

    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    }

    const family = await prisma.productFamily.update({
      where: { id },
      data,
    })
    return { family }
  })

  // DELETE /api/families/:id — drop the family. FK cascades:
  //   childFamilies.parentFamilyId → SET NULL (children become roots)
  //   Product.familyId → SET NULL (products keep their data; family
  //                                 detached, falls back to legacy
  //                                 categoryAttributes JSON path)
  //   FamilyAttribute → CASCADE (rows deleted alongside the family)
  fastify.delete('/families/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.productFamily.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'family not found' })
      throw err
    }
  })
}

export default familiesRoutes
