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
import { auditLogService } from '../services/audit-log.service.js'

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

  // ── W2.7 — FamilyAttribute attach/detach ────────────────────────
  //
  // The cornerstone parent-wins write-time enforcement. POST refuses
  // any attribute that already appears (directly or by inheritance)
  // in the family's effective set — that's the Akeneo-strict
  // additive invariant the resolver assumes.

  // POST /api/families/:id/attributes — attach attribute to family.
  //
  // Refuses with 409 if the attribute is already declared by this
  // family OR by any ancestor. The ancestor case is what makes
  // inheritance work: a child can never re-declare (and thereby
  // attempt to override) what a parent has already locked in.
  fastify.post('/families/:id/attributes', async (request, reply) => {
    const { id: familyId } = request.params as { id: string }
    const body = request.body as {
      attributeId?: string
      required?: boolean
      channels?: string[]
      sortOrder?: number
    }
    if (!body.attributeId)
      return reply.code(400).send({ error: 'attributeId is required' })

    const attribute = await prisma.customAttribute.findUnique({
      where: { id: body.attributeId },
      select: { id: true },
    })
    if (!attribute)
      return reply.code(400).send({ error: 'attributeId does not exist' })

    let chain
    try {
      chain = await familyHierarchyService.walkFamilyChain(familyId)
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (/cycle|depth exceeded/i.test(msg))
        return reply.code(409).send({ error: msg })
      throw err
    }
    if (chain.length === 0)
      return reply.code(404).send({ error: 'family not found' })

    // Akeneo-strict additive: refuse if any ancestor (or self)
    // already has this attributeId. Walking the entire chain (incl.
    // self) is correct — the unique constraint at the DB protects
    // self-duplicates too, but checking up front gives a clearer
    // error than a P2002 collision.
    for (const node of chain) {
      const conflict = node.familyAttributes.find(
        (fa) => fa.attributeId === body.attributeId,
      )
      if (conflict) {
        const isSelf = node.id === familyId
        return reply.code(409).send({
          error: isSelf
            ? 'attribute already attached to this family'
            : `attribute already inherited from ancestor family ${node.id}; child cannot redeclare it (Akeneo-strict additive invariant)`,
          conflictFamilyId: node.id,
          isInherited: !isSelf,
        })
      }
    }

    const created = await prisma.familyAttribute.create({
      data: {
        familyId,
        attributeId: body.attributeId,
        required: body.required ?? false,
        channels: Array.isArray(body.channels) ? body.channels : [],
        sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
      },
    })
    return reply.code(201).send({ familyAttribute: created })
  })

  // PATCH /api/family-attributes/:id — update required/channels/order.
  // attributeId + familyId are immutable (would invalidate the
  // ancestor-conflict check that gated the original create).
  fastify.patch('/family-attributes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      required?: boolean
      channels?: string[]
      sortOrder?: number
    }
    const data: Record<string, unknown> = {}
    if (body.required !== undefined) data.required = body.required
    if (body.channels !== undefined) {
      if (!Array.isArray(body.channels))
        return reply.code(400).send({ error: 'channels must be an array' })
      data.channels = body.channels
    }
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const familyAttribute = await prisma.familyAttribute.update({
        where: { id },
        data,
      })
      return { familyAttribute }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'family-attribute not found' })
      throw err
    }
  })

  // DELETE /api/family-attributes/:id — detach attribute from family.
  // Note: removing a parent's attribute means children stop
  // inheriting it. Stored values on Products are NOT touched (the
  // attribute itself still exists; only the family→attribute link
  // breaks). Callers who want to wipe values must call into a
  // separate "purge values" service which doesn't exist yet (W2.x).
  fastify.delete('/family-attributes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.familyAttribute.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'family-attribute not found' })
      throw err
    }
  })

  // ── W2.8 — bulk attach/detach family on N products ─────────────
  //
  // Lives in families.routes.ts (not products.routes.ts, which is
  // already 2k+ LOC) but uses the /products/bulk-* path family for
  // discoverability — every other bulk product mutation is at
  // /api/products/bulk-*, so co-locating the path matters more
  // than co-locating the file.
  //
  // Single endpoint with dual semantics:
  //   familyId = '<id>'  → attach this family to all productIds
  //   familyId = null    → detach (clear familyId on all productIds)
  //
  // Per-product audit row written. updates run inside one
  // $transaction so a partial failure rolls back cleanly.
  //
  // Hard cap at 500 productIds per call (matches bulk-status etc.)
  // — operator can always call again. Larger jobs should go through
  // the BulkOperation queue, but at 280-product catalogs this cap
  // never bites in practice.
  fastify.post('/products/bulk-attach-family', async (request, reply) => {
    const body = request.body as {
      productIds?: string[]
      familyId?: string | null
    }
    if (!Array.isArray(body.productIds) || body.productIds.length === 0)
      return reply
        .code(400)
        .send({ error: 'productIds must be a non-empty array' })
    if (body.productIds.length > 500)
      return reply
        .code(400)
        .send({ error: 'productIds cannot exceed 500 per call' })

    const targetFamilyId = body.familyId ?? null
    if (targetFamilyId !== null) {
      const family = await prisma.productFamily.findUnique({
        where: { id: targetFamilyId },
        select: { id: true },
      })
      if (!family)
        return reply.code(400).send({ error: 'familyId does not exist' })
    }

    // Read current state for the audit before/after diff. Skips
    // soft-deleted products (deletedAt IS NOT NULL) — operators
    // shouldn't be able to attach a family to a row that's in
    // the trash.
    const products = await prisma.product.findMany({
      where: { id: { in: body.productIds }, deletedAt: null },
      select: { id: true, familyId: true },
    })
    if (products.length === 0)
      return reply
        .code(404)
        .send({ error: 'no matching active products found' })

    const startTs = Date.now()

    await prisma.$transaction(async (tx) => {
      await tx.product.updateMany({
        where: { id: { in: products.map((p) => p.id) } },
        data: { familyId: targetFamilyId },
      })
    })

    // Fail-open audit: never throws, so a Redis blip can't roll back
    // the attach operation. Each row diffs only the changed field.
    const auditRows = products
      .filter((p) => p.familyId !== targetFamilyId) // no-op rows skipped
      .map((p) => ({
        userId: null,
        ip: request.ip ?? null,
        entityType: 'Product',
        entityId: p.id,
        action: 'update',
        before: { familyId: p.familyId },
        after: { familyId: targetFamilyId },
        metadata: {
          source: 'bulk-attach-family',
          attachOrDetach: targetFamilyId === null ? 'detach' : 'attach',
        },
      }))
    if (auditRows.length > 0) {
      void auditLogService.writeMany(auditRows)
    }

    const skipped = body.productIds.length - products.length
    const noOpCount = products.length - auditRows.length
    return {
      ok: true,
      familyId: targetFamilyId,
      requested: body.productIds.length,
      updated: products.length,
      changed: auditRows.length,
      noOp: noOpCount,
      skipped,
      elapsedMs: Date.now() - startTs,
    }
  })
}

export default familiesRoutes
