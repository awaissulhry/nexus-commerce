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
 *     POST   /attributes/concepts/options    add the colour/size concept values as options (dryRun by default)
 *   P6 (§4.4) — the open dropdown:
 *     GET    /attributes/:code/choices       the business's options + each channel's values, merged, with sources
 */

import type { FastifyPluginAsync } from 'fastify'
import { invalidateAttributeSchemasAfterWrites } from '../services/pim/attribute-schema-invalidation.js'
import prisma from '../db.js'
import { ATTRIBUTE_CONCEPTS, CONCEPTS_REVISION } from '@nexus/shared/attribute-concepts'
import { applyConceptDictionary, applyConceptOptions, conceptDictionaryPlan, ConceptOptionsError } from '../services/pim/attribute-concepts.service.js'
import { attributeChoices, ChoicesError } from '../services/pim/attribute-choices.service.js'
import { DictionaryError, upsertAttributes, type AttributeUpsert } from '../services/pim/attribute-dictionary.service.js'
import {
  AttributeAdminError, createAttributeGroup, createAttributeOption, createCustomAttribute, deleteAttributeGroup, deleteAttributeOption,
  updateAttributeGroup, updateAttributeOption, updateCustomAttribute,
  type AttributeCreateInput, type AttributeUpdateInput, type GroupInput, type OptionCreateInput, type OptionUpdateInput,
} from '../services/pim/attribute-admin.service.js'
import { archiveAttribute, deleteAttribute, PlacementError, restoreAttribute, setAttributePlacement, undoPlacementChange, type Actor } from '../services/pim/attribute-placement.service.js'
import { applyPlacementProposal, placementProposalPreview, undoPlacementProposal } from '../services/pim/attribute-placement-correction.js'
import { attributeUsages } from '../services/pim/attribute-usage.service.js'
import type { FastifyReply, FastifyRequest } from 'fastify'

/** MCP full control P8 — a write refused by attribute-admin.service.ts: its status and sentence, as the page always got them. */
async function adminReply<T>(reply: FastifyReply, work: () => Promise<T>) {
  try { return await work() }
  catch (error) {
    if (error instanceof AttributeAdminError) return reply.code(error.status).send({ error: error.message })
    throw error
  }
}

const actorOf = (request: FastifyRequest): Actor => ({ userId: (request as { authUser?: { id?: string } }).authUser?.id ?? null, ip: request.ip ?? null })

/** A placement refusal is the operator's answer (400/404/409 with the reason); anything else is a real failure. */
async function placementReply<T>(reply: FastifyReply, work: () => Promise<T>) {
  try { return await work() }
  catch (error) {
    if (error instanceof PlacementError) return reply.code(error.status).send({ error: error.message, ...(error.details ? { details: error.details } : {}) })
    throw error
  }
}

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
    const body = request.body as GroupInput
    return adminReply(reply, async () => {
      const group = await createAttributeGroup(body)
      return reply.code(201).send({ group })
    })
  })

  fastify.patch('/attribute-groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as Omit<GroupInput, 'code'>
    return adminReply(reply, async () => ({ group: await updateAttributeGroup(id, body) }))
  })

  fastify.delete('/attribute-groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    return adminReply(reply, () => deleteAttributeGroup(id))
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
    const body = request.body as AttributeCreateInput
    return adminReply(reply, async () => {
      const attribute = await createCustomAttribute(body)
      return reply.code(201).send({ attribute })
    })
  })

  // Deliberately not allowing `type` or `code` changes — type would orphan stored values; code is the stable
  // identifier referenced by FamilyAttribute and product values (attribute-admin.service.ts).
  fastify.patch('/attributes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as AttributeUpdateInput
    return adminReply(reply, async () => ({ attribute: await updateCustomAttribute(id, body) }))
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
  // P3b S6 — which connected channels use each attribute, and which are dormant (for the settings list, S8).
  fastify.get('/attributes/usage', async () => ({ attributes: [...(await attributeUsages()).values()].sort((a, b) => a.code.localeCompare(b.code)) }))

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
    const body = request.body as OptionCreateInput
    return adminReply(reply, async () => {
      const option = await createAttributeOption(attrId, body)
      return reply.code(201).send({ option })
    })
  })

  fastify.patch('/attribute-options/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as OptionUpdateInput
    return adminReply(reply, async () => ({ option: await updateAttributeOption(id, body) }))
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

  // The concept value lists as business options (colour and size by default). A write only on an explicit
  // `dryRun: false`; an existing option is never changed.
  fastify.post('/attributes/concepts/options', async (request, reply) => {
    const body = (request.body ?? {}) as { dryRun?: boolean; concepts?: unknown }
    const concepts = Array.isArray(body.concepts) ? body.concepts.filter((c): c is string => typeof c === 'string') : undefined
    try { return await applyConceptOptions({ concepts, dryRun: body.dryRun !== false }) }
    catch (error) {
      if (error instanceof ConceptOptionsError) return reply.code(400).send({ error: error.message })
      throw error
    }
  })

  fastify.delete('/attribute-options/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    return adminReply(reply, () => deleteAttributeOption(id))
  })
}

export default attributesRoutes
