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
 *     PATCH  /attribute-options/:id          update label/metadata/order/synonyms/archived
 *     DELETE /attribute-options/:id          delete
 *
 *   P3 (docs/attributes/PLAN.md §4.1) — the dictionary at scale and the shared concepts:
 *     POST   /attributes/bulk                create/update up to 500 attributes and their options,
 *                                              all-or-nothing, per-row errors (dryRun supported)
 *     GET    /attributes/concepts            the concept catalogue + this business's link plan
 *     POST   /attributes/concepts/apply      link/create concept attributes (dryRun by default)
 *   P6 (§4.4) — the open dropdown:
 *     GET    /attributes/:code/choices       the business's options + each channel's values, merged, with sources
 */

import type { FastifyPluginAsync } from 'fastify'
import { invalidateAttributeSchemasAfterWrites } from '../services/pim/attribute-schema-invalidation.js'
import prisma from '../db.js'
import { CODE_NOT_LOCALIZABLE, CODE_TYPES, localizableRefusalFor } from '../services/pim/attribute-rules.js'
import { parseAttributeRules } from '@nexus/shared/attributes'
import { ATTRIBUTE_CONCEPTS, CONCEPTS_REVISION } from '@nexus/shared/attribute-concepts'
import { applyConceptDictionary, conceptDictionaryPlan } from '../services/pim/attribute-concepts.service.js'
import { attributeChoices, ChoicesError } from '../services/pim/attribute-choices.service.js'
import { DictionaryError, OPTION_TYPES, semanticKeyRefusal, upsertAttributes, type AttributeUpsert } from '../services/pim/attribute-dictionary.service.js'
import { archiveAttribute, deleteAttribute, PlacementError, restoreAttribute, setAttributePlacement, undoPlacementChange, type Actor } from '../services/pim/attribute-placement.service.js'
import { applyPlacementProposal, placementProposalPreview, undoPlacementProposal } from '../services/pim/attribute-placement-correction.js'
import type { FastifyReply, FastifyRequest } from 'fastify'

const actorOf = (request: FastifyRequest): Actor => ({ userId: (request as { authUser?: { id?: string } }).authUser?.id ?? null, ip: request.ip ?? null })

/** A placement refusal is the operator's answer (400/404/409 with the reason); anything else is a real failure. */
async function placementReply<T>(reply: FastifyReply, work: () => Promise<T>) {
  try { return await work() }
  catch (error) {
    if (error instanceof PlacementError) return reply.code(error.status).send({ error: error.message, ...(error.details ? { details: error.details } : {}) })
    throw error
  }
}

/** P3 — `validation` must satisfy the shared contract; the refusal names each problem. `null`/absent = no rules. */
function validationRefusal(validation: unknown): string | null {
  if (validation === undefined || validation === null) return null
  const rules = parseAttributeRules(validation)
  return rules.ok ? null : `validation is invalid: ${(rules as { errors: string[] }).errors.join('; ')}`
}

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

// A-25 (R-22): a closed choice list cannot be made per-language — the rule and its lookup live in the service.
export { CODE_NOT_LOCALIZABLE } from '../services/pim/attribute-rules.js'

const attributesRoutes: FastifyPluginAsync = async (fastify) => {
  invalidateAttributeSchemasAfterWrites(fastify)
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
      semanticKey?: string | null
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
    if (body.localizable && CODE_TYPES.has(body.type))
      return reply.code(400).send({ error: CODE_NOT_LOCALIZABLE })
    const invalidRules = validationRefusal(body.validation)
    if (invalidRules) return reply.code(400).send({ error: invalidRules })
    const conceptRefusal = semanticKeyRefusal(body.semanticKey)
    if (conceptRefusal) return reply.code(400).send({ error: conceptRefusal })

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
          semanticKey: body.semanticKey ?? null,
        },
      })
      return reply.code(201).send({ attribute })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply
          .code(409)
          .send({ error: String(err?.meta?.target ?? '').includes('semanticKey')
            ? `concept "${body.semanticKey}" is already linked to another attribute`
            : `attribute code "${body.code}" already exists` })
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
      semanticKey?: string | null
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
    if (body.validation !== undefined) {
      const invalidRules = validationRefusal(body.validation)
      if (invalidRules) return reply.code(400).send({ error: invalidRules })
      data.validation = (body.validation as never) ?? null
    }
    if (body.semanticKey !== undefined) {
      const conceptRefusal = semanticKeyRefusal(body.semanticKey)
      if (conceptRefusal) return reply.code(400).send({ error: conceptRefusal })
      data.semanticKey = body.semanticKey
    }
    if (body.defaultValue !== undefined)
      data.defaultValue = (body.defaultValue as never) ?? null
    if (body.localizable === true) {
      const refusal = await localizableRefusalFor(id)
      if (refusal) return reply.code(400).send({ error: refusal })
    }
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
      if (err?.code === 'P2002')
        return reply.code(409).send({ error: `concept "${body.semanticKey}" is already linked to another attribute` })
      throw err
    }
  })

  // P3b S3 (docs/attributes/PLAN.md §10.9) — delete only what nothing uses; otherwise 409 "archive instead".
  fastify.delete('/attributes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    return placementReply(reply, () => deleteAttribute(id, actorOf(request)))
  })

  // P3b S3 — placement (a label; the value stays where it is), archive / restore, and undo of a placement change.
  fastify.patch('/attributes/:id/placement', async (request, reply) => {
    const { id } = request.params as { id: string }
    return placementReply(reply, () => setAttributePlacement(id, (request.body ?? {}) as { placement?: unknown; channels?: unknown }, actorOf(request)))
  })
  fastify.post('/attributes/:id/archive', async (request, reply) => {
    const { id } = request.params as { id: string }
    return placementReply(reply, () => archiveAttribute(id, actorOf(request)))
  })
  fastify.post('/attributes/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string }
    return placementReply(reply, () => restoreAttribute(id, actorOf(request)))
  })
  // P3b S5 — the reviewed cleanup: preview (with a fingerprint), apply approved groups, undo a whole batch.
  fastify.get('/attributes/placement-proposal', async () => placementProposalPreview())
  fastify.post('/attributes/placement-proposal/apply', async (request, reply) => {
    const body = (request.body ?? {}) as { fingerprint?: unknown; groups?: unknown; includeDisputed?: unknown }
    if (typeof body.fingerprint !== 'string') return reply.code(400).send({ error: 'fingerprint is required (from GET /attributes/placement-proposal)' })
    return placementReply(reply, () => applyPlacementProposal({ fingerprint: body.fingerprint as string, groups: body.groups as never, includeDisputed: body.includeDisputed as never }, actorOf(request)))
  })
  fastify.post('/attributes/placement-proposal/:batchId/undo', async (request, reply) => {
    const { batchId } = request.params as { batchId: string }
    return placementReply(reply, () => undoPlacementProposal(batchId, actorOf(request)))
  })
  fastify.post('/attributes/placement-changes/:auditId/undo', async (request, reply) => {
    const { auditId } = request.params as { auditId: string }
    return placementReply(reply, () => undoPlacementChange(auditId, actorOf(request)))
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
    // P6 — a text attribute's options are suggestions for the open dropdown.
    if (!OPTION_TYPES.has(attr.type))
      return reply.code(400).send({
        error: `attribute type "${attr.type}" does not accept options (select, multiselect, text or textarea)`,
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
      synonyms?: string[]
      archived?: boolean
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
    if (body.synonyms !== undefined) {
      if (!Array.isArray(body.synonyms) || body.synonyms.some(s => typeof s !== 'string' || !s.trim()))
        return reply.code(400).send({ error: 'synonyms must be a list of non-empty text' })
      data.synonyms = body.synonyms.map(s => s.trim())
    }
    // P3 — retiring keeps every stored value valid; it only stops offering the option.
    if (body.archived !== undefined) data.archivedAt = body.archived ? new Date() : null
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

  // ── P3 — the dictionary at scale, and the shared concepts ────

  fastify.post('/attributes/bulk', async (request, reply) => {
    const body = (request.body ?? {}) as { attributes?: AttributeUpsert[]; dryRun?: boolean }
    try {
      const result = await upsertAttributes(body.attributes ?? [], { dryRun: body.dryRun === true })
      const failed = result.results.filter(r => !r.ok).length
      if (failed) return reply.code(400).send({ error: `Nothing was saved: ${failed} of ${result.results.length} attribute(s) need a fix.`, ...result })
      return result
    } catch (err) {
      if (err instanceof DictionaryError) return reply.code(400).send({ error: err.message })
      throw err
    }
  })

  // P6 — everything one dropdown may offer: the business's options + each channel's values, merged, with sources.
  // ?coordinates=EBAY:IT:177104,AMAZON:IT:OUTERWEAR (channel:market[:category]).
  fastify.get('/attributes/:code/choices', async (request, reply) => {
    const { code } = request.params as { code: string }
    const raw = String((request.query as { coordinates?: string }).coordinates ?? '')
    const coordinates = raw.split(',').map(part => part.trim()).filter(Boolean).map(part => {
      const [channel, marketplace, productType] = part.split(':')
      return { channel, marketplace, productType: productType || null }
    })
    if (coordinates.some(c => !c.channel || !c.marketplace)) return reply.code(400).send({ error: 'coordinates are channel:market[:category], comma-separated' })
    if (coordinates.length > 12) return reply.code(400).send({ error: 'at most 12 coordinates per call' })
    try {
      return await attributeChoices(code, coordinates)
    } catch (err) {
      if (err instanceof ChoicesError) return reply.code(404).send({ error: err.message })
      throw err
    }
  })

  fastify.get('/attributes/concepts', async () => ({
    revision: CONCEPTS_REVISION,
    concepts: ATTRIBUTE_CONCEPTS,
    plan: await conceptDictionaryPlan(),
  }))

  fastify.post('/attributes/concepts/apply', async (request) => {
    const body = (request.body ?? {}) as { dryRun?: boolean }
    // A write only on an explicit `dryRun: false`: linking changes what every channel reads.
    return applyConceptDictionary({ dryRun: body.dryRun !== false })
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
