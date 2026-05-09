/**
 * W2.6 — Custom-attribute admin CRUD: AttributeGroup, CustomAttribute,
 * AttributeOption.
 *
 * Three resources in one routes file because they form a single
 * concept (the Magento+Akeneo attribute system) and the products
 * surface convention (products.routes.ts) is to co-locate related
 * resources rather than fragmenting them across many small files.
 *
 * Endpoints (all under /api):
 *
 *   AttributeGroup:
 *     GET    /attribute-groups               list with _count
 *     GET    /attribute-groups/:id           detail + nested attrs
 *     POST   /attribute-groups               create
 *     PATCH  /attribute-groups/:id           update
 *     DELETE /attribute-groups/:id           refuses if attrs attached
 *                                              (RESTRICT FK at the DB)
 *
 *   CustomAttribute:
 *     GET    /attributes                     list (?groupId, ?type)
 *     GET    /attributes/:id                 detail + options
 *     POST   /attributes                     create
 *     PATCH  /attributes/:id                 update (cannot change
 *                                              `type` — would
 *                                              orphan stored values)
 *     DELETE /attributes/:id                 cascades to options
 *
 *   AttributeOption (only meaningful in context of an attribute):
 *     POST   /attributes/:attrId/options     create option
 *     PATCH  /attribute-options/:id          update label/metadata/order
 *     DELETE /attribute-options/:id          delete
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

const VALID_ATTRIBUTE_TYPES = new Set([
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  'multiselect',
  'date',
  'reference',
  'asset',
])

const VALID_SCOPES = new Set(['global', 'per_variant'])

const attributesRoutes: FastifyPluginAsync = async (fastify) => {
  // ── AttributeGroup ───────────────────────────────────────────

  fastify.get('/attribute-groups', async () => {
    const groups = await prisma.attributeGroup.findMany({
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      include: { _count: { select: { attributes: true } } },
    })
    return { groups }
  })

  fastify.get('/attribute-groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const group = await prisma.attributeGroup.findUnique({
      where: { id },
      include: {
        attributes: {
          orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
          select: { id: true, code: true, label: true, type: true, sortOrder: true },
        },
      },
    })
    if (!group) return reply.code(404).send({ error: 'group not found' })
    return { group }
  })

  fastify.post('/attribute-groups', async (request, reply) => {
    const body = request.body as {
      code?: string
      label?: string
      description?: string | null
      sortOrder?: number
    }
    if (!body.code || !CODE_PATTERN.test(body.code))
      return reply.code(400).send({
        error:
          'code is required and must be lowercase snake_case (matches /^[a-z][a-z0-9_]{0,63}$/)',
      })
    if (!body.label?.trim())
      return reply.code(400).send({ error: 'label is required' })
    try {
      const group = await prisma.attributeGroup.create({
        data: {
          code: body.code,
          label: body.label.trim(),
          description: body.description?.trim() || null,
          sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
        },
      })
      return reply.code(201).send({ group })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply
          .code(409)
          .send({ error: `group code "${body.code}" already exists` })
      throw err
    }
  })

  fastify.patch('/attribute-groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      label?: string
      description?: string | null
      sortOrder?: number
    }
    const data: Record<string, unknown> = {}
    if (body.label !== undefined) {
      if (!body.label.trim())
        return reply.code(400).send({ error: 'label cannot be empty' })
      data.label = body.label.trim()
    }
    if (body.description !== undefined)
      data.description = body.description?.trim() || null
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const group = await prisma.attributeGroup.update({ where: { id }, data })
      return { group }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'group not found' })
      throw err
    }
  })

  fastify.delete('/attribute-groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.attributeGroup.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'group not found' })
      // P2003 = FK constraint failed (RESTRICT — group still has
      // attributes). Surface a 409 so the UI can prompt the operator
      // to move/delete attributes first.
      if (err?.code === 'P2003')
        return reply.code(409).send({
          error:
            'cannot delete group: attributes are still attached. Move or delete them first.',
        })
      throw err
    }
  })

  // ── CustomAttribute ──────────────────────────────────────────

  fastify.get('/attributes', async (request) => {
    const q = request.query as { groupId?: string; type?: string }
    const where: Record<string, unknown> = {}
    if (q.groupId) where.groupId = q.groupId
    if (q.type) where.type = q.type
    const attributes = await prisma.customAttribute.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      include: {
        group: { select: { id: true, code: true, label: true } },
        _count: { select: { options: true, familyAttributes: true } },
      },
    })
    return { attributes }
  })

  fastify.get('/attributes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const attribute = await prisma.customAttribute.findUnique({
      where: { id },
      include: {
        group: { select: { id: true, code: true, label: true } },
        options: { orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] },
      },
    })
    if (!attribute)
      return reply.code(404).send({ error: 'attribute not found' })
    return { attribute }
  })

  fastify.post('/attributes', async (request, reply) => {
    const body = request.body as {
      code?: string
      label?: string
      description?: string | null
      groupId?: string
      type?: string
      validation?: unknown
      defaultValue?: unknown
      localizable?: boolean
      scope?: string
      sortOrder?: number
    }
    if (!body.code || !CODE_PATTERN.test(body.code))
      return reply.code(400).send({
        error:
          'code is required and must be lowercase snake_case (matches /^[a-z][a-z0-9_]{0,63}$/)',
      })
    if (!body.label?.trim())
      return reply.code(400).send({ error: 'label is required' })
    if (!body.groupId)
      return reply.code(400).send({ error: 'groupId is required' })
    if (!body.type || !VALID_ATTRIBUTE_TYPES.has(body.type))
      return reply.code(400).send({
        error: `type must be one of ${[...VALID_ATTRIBUTE_TYPES].join(', ')}`,
      })
    if (body.scope && !VALID_SCOPES.has(body.scope))
      return reply.code(400).send({
        error: `scope must be one of ${[...VALID_SCOPES].join(', ')}`,
      })

    const groupExists = await prisma.attributeGroup.findUnique({
      where: { id: body.groupId },
      select: { id: true },
    })
    if (!groupExists)
      return reply.code(400).send({ error: 'groupId does not exist' })

    try {
      const attribute = await prisma.customAttribute.create({
        data: {
          code: body.code,
          label: body.label.trim(),
          description: body.description?.trim() || null,
          groupId: body.groupId,
          type: body.type,
          validation: (body.validation as never) ?? null,
          defaultValue: (body.defaultValue as never) ?? null,
          localizable: body.localizable ?? false,
          scope: body.scope ?? 'global',
          sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
        },
      })
      return reply.code(201).send({ attribute })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply
          .code(409)
          .send({ error: `attribute code "${body.code}" already exists` })
      throw err
    }
  })

  fastify.patch('/attributes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      label?: string
      description?: string | null
      groupId?: string
      validation?: unknown
      defaultValue?: unknown
      localizable?: boolean
      scope?: string
      sortOrder?: number
    }
    // Deliberately not allowing `type` or `code` changes — type
    // would orphan stored values; code is the stable identifier
    // referenced by FamilyAttribute and product values.
    const data: Record<string, unknown> = {}
    if (body.label !== undefined) {
      if (!body.label.trim())
        return reply.code(400).send({ error: 'label cannot be empty' })
      data.label = body.label.trim()
    }
    if (body.description !== undefined)
      data.description = body.description?.trim() || null
    if (body.groupId !== undefined) {
      const exists = await prisma.attributeGroup.findUnique({
        where: { id: body.groupId },
        select: { id: true },
      })
      if (!exists)
        return reply.code(400).send({ error: 'groupId does not exist' })
      data.groupId = body.groupId
    }
    if (body.validation !== undefined)
      data.validation = (body.validation as never) ?? null
    if (body.defaultValue !== undefined)
      data.defaultValue = (body.defaultValue as never) ?? null
    if (body.localizable !== undefined) data.localizable = body.localizable
    if (body.scope !== undefined) {
      if (!VALID_SCOPES.has(body.scope))
        return reply.code(400).send({
          error: `scope must be one of ${[...VALID_SCOPES].join(', ')}`,
        })
      data.scope = body.scope
    }
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const attribute = await prisma.customAttribute.update({
        where: { id },
        data,
      })
      return { attribute }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'attribute not found' })
      throw err
    }
  })

  fastify.delete('/attributes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.customAttribute.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'attribute not found' })
      throw err
    }
  })

  // ── AttributeOption ──────────────────────────────────────────

  fastify.post('/attributes/:attrId/options', async (request, reply) => {
    const { attrId } = request.params as { attrId: string }
    const body = request.body as {
      code?: string
      label?: string
      metadata?: unknown
      sortOrder?: number
    }
    if (!body.code || !CODE_PATTERN.test(body.code))
      return reply.code(400).send({
        error:
          'code is required and must be lowercase snake_case (matches /^[a-z][a-z0-9_]{0,63}$/)',
      })
    if (!body.label?.trim())
      return reply.code(400).send({ error: 'label is required' })
    const attr = await prisma.customAttribute.findUnique({
      where: { id: attrId },
      select: { id: true, type: true },
    })
    if (!attr) return reply.code(404).send({ error: 'attribute not found' })
    if (attr.type !== 'select' && attr.type !== 'multiselect')
      return reply.code(400).send({
        error: `attribute type "${attr.type}" does not accept options (only select/multiselect)`,
      })
    try {
      const option = await prisma.attributeOption.create({
        data: {
          attributeId: attrId,
          code: body.code,
          label: body.label.trim(),
          metadata: (body.metadata as never) ?? null,
          sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
        },
      })
      return reply.code(201).send({ option })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply.code(409).send({
          error: `option code "${body.code}" already exists on this attribute`,
        })
      throw err
    }
  })

  fastify.patch('/attribute-options/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      label?: string
      metadata?: unknown
      sortOrder?: number
    }
    const data: Record<string, unknown> = {}
    if (body.label !== undefined) {
      if (!body.label.trim())
        return reply.code(400).send({ error: 'label cannot be empty' })
      data.label = body.label.trim()
    }
    if (body.metadata !== undefined)
      data.metadata = (body.metadata as never) ?? null
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const option = await prisma.attributeOption.update({
        where: { id },
        data,
      })
      return { option }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'option not found' })
      throw err
    }
  })

  fastify.delete('/attribute-options/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.attributeOption.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'option not found' })
      throw err
    }
  })
}

export default attributesRoutes
