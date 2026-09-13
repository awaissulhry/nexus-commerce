import { previewPresentationAssignment } from '../services/pim/mapping/presentation-assignment.service.js'
import type { PresentationRule } from '../services/pim/mapping/presentation-rules.js'
/** Canonical mapping catalogue, resolution and durable impact reviews. Broad formula,
 * category and clone changes use review → activation; direct legacy mutation URLs return 409.
 * Field previews and reviews share the existing resolver and revision-CAS writer. */

import type { FastifyPluginAsync } from 'fastify'
import { listMappingTemplates, listMappingPreviewProducts } from '../services/pim/mapping/editor-catalogue.service.js'
import {
  getMappingForMarketplace,
  getMappingForMarketplaceWithWarnings,
  findExpressionUsage,
  MarketplaceNotFoundError,
  InvalidMappingError,
  mergeRulesIntoMapping,
  validateFieldRule,
  type FieldMappingRule,
} from '../services/pim/schema-mapping.service.js'
import { createMappingImpact, readMappingImpact, activateMappingImpact, recoverMappingImpacts, type MappingChange } from '../services/pim/mapping/impact.service.js'
import type { ExpressionChange, CategoryChange } from '../services/pim/mapping/review-draft.js'
import { mappingToken, MappingConflict } from '../services/pim/mapping/revision-token.js'
import { getFieldCatalogue } from '../services/pim/mapping/field-catalogue.service.js'
import { resolveBatch } from '../services/pim/mapping/resolve-batch.service.js'
import {
  listCategoryMappings,
  listChannelCategories,
} from '../services/pim/mapping/category-mapping.service.js'
import { validateExpr, exprDependencies, EXPR_FUNCTIONS } from '../services/pim/mapping/expr.js'
import { getMappingSources } from '../services/pim/mapping/mapping-sources.service.js'
import { resolveChannelConnectionId } from '../services/connection-resolver.service.js'
// VT.1b — the Variations rule route (VX §11.1). The read model and the ONE blast-radius simulation.
import { draftVariationRule, getVariationRuleView, simulateVariationRule } from '../services/pim/variation-rule-view.service.js'
import type { StoredVariationRule } from '../services/pim/variation-rule-store.js'

/** One place to turn a service throw into the right status. */
function fail(reply: any, err: unknown) {
  if (err instanceof MarketplaceNotFoundError) return reply.status(404).send({ error: err.message })
  if (err instanceof InvalidMappingError) return reply.status(400).send({ error: 'invalid', details: (err as any).errors })
  throw err
}

const channelMappingRoutes: FastifyPluginAsync = async (fastify) => {
  const actor = (request: any): string | null => request.user?.id ?? request.authUser?.id ?? null
  fastify.post<{ Params: { channel: string; code: string }; Body: { restoreRevisionId?: string; category?: string | null; changes?: MappingChange[]; expectedToken: string; presentationChange?: { id: string; rule: PresentationRule | null }; expression?: ExpressionChange; categoryChange?: CategoryChange; clone?: { channel: string; market: string; token: string; addTranslate?: boolean } } }>(
    '/pim/channel-mapping/:channel/:code/impact', async (request, reply) => {
      try {
        return reply.code(202).send(await createMappingImpact({ channel: request.params.channel.toUpperCase(), market: request.params.code,
          restoreRevisionId: request.body?.restoreRevisionId, presentationChange: request.body?.presentationChange, expression: request.body?.expression, categoryChange: request.body?.categoryChange, clone: request.body?.clone, category: request.body?.category, changes: request.body?.changes, expectedToken: request.body?.expectedToken, userId: actor(request) }))
      } catch (err) { return fail(reply, err) }
    })
  fastify.get<{ Params: { jobId: string }; Querystring: { page?: string } }>('/pim/channel-mapping/impact/:jobId', async (request, reply) => {
    const result = await readMappingImpact(request.params.jobId, actor(request), Math.max(0, Number.parseInt(request.query.page ?? '0', 10) || 0))
    return result ?? reply.code(404).send({ error: 'Mapping impact not found' })
  })
  fastify.post<{ Params: { jobId: string } }>('/pim/channel-mapping/impact/:jobId/activate', async (request, reply) => {
    const result = await activateMappingImpact(request.params.jobId, actor(request))
    return result ?? reply.code(404).send({ error: 'Mapping impact not found' })
  })
  fastify.post<{ Params: { jobId: string } }>('/pim/channel-mapping/impact/:jobId/assign-once', async (request, reply) => {
    const result = await previewPresentationAssignment(request.params.jobId, actor(request))
    return result ?? reply.code(404).send({ error: 'Mapping review not found' })
  })
  const recovery = setInterval(() => { void recoverMappingImpacts().catch(err => fastify.log.warn({ err }, 'Mapping preview recovery deferred')) }, 30_000)
  recovery.unref()
  fastify.addHook('onClose', async () => { clearInterval(recovery) })
  fastify.get<{ Params: { channel: string; code: string } }>('/pim/channel-mapping/:channel/:code/presentation', async (request, reply) => {
    const mapping = await getMappingForMarketplace(request.params.channel.toUpperCase(), request.params.code)
    return reply.send({ token: mappingToken(mapping), rules: mapping.presentationRules ?? [], orderActivationAvailable: false })
  })
  // ── GET /pim/channel-mapping/templates ──────────────────────────
  // The channel × market list the editor opens on. One row per Marketplace, with how many of
  // its stored schema fields carry a rule — the rail's "59/236".
  fastify.get('/pim/channel-mapping/templates', async (_request, reply) => {
    return reply.send({ templates: await listMappingTemplates() })
  })

  // ── GET /pim/channel-mapping/functions ──────────────────────────
  // The formula language, for the editor's help + autocomplete. Static.
  fastify.get('/pim/channel-mapping/functions', async (_request, reply) => {
    return reply.send({ functions: EXPR_FUNCTIONS })
  })

  // ── POST /pim/channel-mapping/expressions/validate ──────────────
  // Syntax-check a formula WITHOUT saving it, and list what it reads. The editor calls this
  // on every keystroke-pause; it touches no database.
  fastify.post<{ Body: { expr?: string } }>(
    '/pim/channel-mapping/expressions/validate',
    async (request, reply) => {
      const expr = request.body?.expr ?? ''
      const bad = validateExpr(expr)
      return reply.send({
        ok: bad === null,
        error: bad ? { message: bad.message, pos: bad.pos } : null,
        // null (not an empty list) when it does not parse — an empty list means "depends on
        // nothing", which is a different and legitimate answer.
        dependencies: bad ? null : exprDependencies(expr),
      })
    },
  )

  // ── GET /pim/channel-mapping/:channel/:code/fields ──────────────
  fastify.get<{
    Params: { channel: string; code: string }
    Querystring: { productType?: string; accountId?: string }
  }>('/pim/channel-mapping/:channel/:code/fields', async (request, reply) => {
    try {
      const catalogue = await getFieldCatalogue({
        channel: request.params.channel,
        marketplace: request.params.code,
        productType: request.query.productType,
        accountId: request.params.channel.toUpperCase() === 'SHOPIFY' ? await resolveChannelConnectionId('SHOPIFY', request.query.accountId) : undefined,
      })
      return reply.send(catalogue)
    } catch (err) {
      return fail(reply, err)
    }
  })

  // ── POST /pim/channel-mapping/:channel/:code/resolve ────────────
  // THE resolver. The editor sends one productId (the Preview SKU); the product sheet sends a
  // page of them. Same code path, same values publish will use.
  fastify.post<{
    Params: { channel: string; code: string }
    Body: {
      channelConnectionId?: string | null
      aliasKey?: string
      productIds?: string[]
      fieldKeys?: string[]
      locale?: string
      productType?: string | null
      includeCatalogue?: boolean
      candidate?: { fieldKey: string; rule: FieldMappingRule; expectedToken: string }
    }
  }>('/pim/channel-mapping/:channel/:code/resolve', async (request, reply) => {
    const productIds = request.body?.productIds ?? []
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return reply.status(400).send({ error: 'productIds is required and must be a non-empty array' })
    }
    // A page of a sheet is ~100 rows; anything larger is a client bug, and saying so beats
    // quietly resolving 10,000 products against a schema.
    if (productIds.length > 250) {
      return reply.status(400).send({ error: `productIds is capped at 250 per call (got ${productIds.length})` })
    }
    try {
      const candidate = request.body?.candidate
      if (request.body?.channelConnectionId) await resolveChannelConnectionId(request.params.channel.toUpperCase(), request.body.channelConnectionId)
      let mappingSnapshot
      if (candidate) {
        const errors = validateFieldRule(candidate.fieldKey, candidate.rule)
        if (errors.length) throw new InvalidMappingError(errors)
        const current = await getMappingForMarketplace(request.params.channel.toUpperCase(), request.params.code)
        if (!candidate.expectedToken || candidate.expectedToken !== mappingToken(current)) throw new MappingConflict()
        mappingSnapshot = mergeRulesIntoMapping(current, [candidate], request.body.productType)
      }
      const result = await resolveBatch({
        channel: request.params.channel,
        marketplace: request.params.code,
        productIds,
        channelConnectionId: request.body?.channelConnectionId, aliasKey: request.body?.aliasKey,
        fieldKeys: request.body?.fieldKeys,
        locale: request.body?.locale,
        productType: request.body?.productType,
        includeCatalogue: request.body?.includeCatalogue,
        mappingSnapshot,
      })
      return reply.send(result)
    } catch (err) {
      return fail(reply, err)
    }
  })

  // ── GET /pim/channel-mapping/:channel/:code/preview-skus ────────
  // The Preview SKU typeahead: `SKU: Product name`, exactly Rithum's row.
  fastify.get<{
    Params: { channel: string; code: string }
    Querystring: { q?: string; limit?: string; productId?: string }
  }>('/pim/channel-mapping/:channel/:code/preview-skus', async (request, reply) => {
    return reply.send({ skus: await listMappingPreviewProducts({ ...request.query, channel: request.params.channel, marketplace: request.params.code }) })
  })

  // ── GET /pim/channel-mapping/:channel/:code/sources ─────────────
  // What an operator can map FROM, read off a real product rather than a hand-kept registry.
  // The old canvas shipped a 30-entry hardcoded list of "internal variables"; a list like that
  // is wrong the day someone adds an attribute. This resolves an actual product through the
  // SAME resolver the rules use, so every key offered is a key that will resolve, and each
  // comes with the value it currently holds for that product.
  fastify.get<{
    Params: { channel: string; code: string }
    Querystring: { productId?: string; locale?: string }
  }>('/pim/channel-mapping/:channel/:code/sources', async (request, reply) => {
    return reply.send(await getMappingSources({
      marketplace: request.params.code, productId: request.query.productId, locale: request.query.locale,
    }))
  })

  // ── Category mapping ────────────────────────────────────────────
  fastify.get<{ Params: { channel: string; code: string } }>(
    '/pim/channel-mapping/:channel/:code/categories',
    async (request, reply) => {
      const result = await listCategoryMappings({
        channel: request.params.channel,
        marketplace: request.params.code,
      })
      const mapping = await getMappingForMarketplace(request.params.channel.toUpperCase(), request.params.code)
      return reply.send({ ...result, token: mappingToken(mapping) })
    },
  )

  fastify.get<{ Params: { channel: string; code: string } }>(
    '/pim/channel-mapping/:channel/:code/channel-categories',
    async (request, reply) => {
      const result = await listChannelCategories({
        channel: request.params.channel,
        marketplace: request.params.code,
      })
      return reply.send(result)
    },
  )

  fastify.put<{
    Params: { channel: string; code: string; categoryId: string }
    Body: {
      channelCategoryId?: string
      channelCategoryPath?: string | null
      browseNodeId?: string | null
      confidence?: string
      notes?: string | null
      /** '*' (default) applies to every market of the channel. */
      marketplace?: string
    }
  }>('/pim/channel-mapping/:channel/:code/categories/:categoryId', async (request, reply) => {
    return reply.code(409).send({ error: 'REVIEW_REQUIRED', message: 'Review this category change through the mapping impact endpoint before activation.' })
  })
  fastify.delete('/pim/channel-mapping/:channel/:code/categories/:categoryId', async (_request, reply) =>
    reply.code(409).send({ error: 'REVIEW_REQUIRED', message: 'Review removal of the exact-market category mapping before activation.' }))

  // ── Business rules (named expressions) ──────────────────────────
  fastify.get<{ Params: { channel: string; code: string } }>(
    '/pim/channel-mapping/:channel/:code/expressions',
    async (request, reply) => {
      try {
        const mapping = await getMappingForMarketplace(request.params.channel.toUpperCase(), request.params.code)
        const expressions = mapping.expressions ?? {}
        return reply.send({
          token: mappingToken(mapping),
          expressions: Object.entries(expressions).map(([name, expr]) => {
            const bad = validateExpr(expr)
            return {
              name,
              expr,
              // A stored rule that no longer parses is REPORTED, never shown as dependency-free:
              // every field pointing at it resolves to nothing, so the editor must be able to say
              // which rule is broken and where.
              dependencies: bad ? null : exprDependencies(expr),
              parseError: bad ? { message: bad.message, pos: bad.pos } : null,
              usedBy: findExpressionUsage(mapping, name),
            }
          }),
        })
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  // ── VT.1b — the Variations rule (VX §11.1, design §3.7) ─────────
  //
  // GET answers the whole group in one round trip, every count server-stated. PUT is the blast-radius simulation:
  // `dryRun: true` answers `<n> products follow this rule · <m> would gain a collision` and writes NOTHING; the
  // committing call goes through the SAME simulation and then hands the drafted mapping to the existing review →
  // activation path, so there is no second writer and no second simulation.
  const variationsHandler = async (request: any, reply: any) => {
    try {
      const view = await getVariationRuleView({
        channel: request.params.channel.toUpperCase(),
        market: request.params.code,
        categoryId: request.params.categoryId ?? null,
      })
      return reply.send(view)
    } catch (err) { return fail(reply, err) }
  }
  fastify.get<{ Params: { channel: string; code: string } }>('/pim/channel-mapping/:channel/:code/variations', variationsHandler)
  fastify.get<{ Params: { channel: string; code: string; categoryId: string } }>('/pim/channel-mapping/:channel/:code/variations/:categoryId', variationsHandler)

  const putVariations = async (request: any, reply: any) => {
    const channel = request.params.channel.toUpperCase()
    const market = request.params.code
    const categoryId: string | null = request.params.categoryId ?? null
    const body = (request.body ?? {}) as { expectedToken?: unknown; dryRun?: unknown; rule?: unknown }
    if (typeof body.expectedToken !== 'string' || !body.expectedToken) {
      return reply.code(400).send({ error: 'invalid', details: ['expectedToken is required — reload the mapping before saving'] })
    }
    if (typeof body.dryRun !== 'boolean') {
      // Required rather than defaulted: a commit that happened because a client forgot a field is the one mistake a
      // rule write must not make (the same reason `family/generate` requires it).
      return reply.code(400).send({ error: 'invalid', details: ['dryRun must be true or false'] })
    }
    const rule = (body.rule ?? null) as StoredVariationRule | null
    try {
      const { mapping } = await getMappingForMarketplaceWithWarnings(channel, market)
      if (mappingToken(mapping) !== body.expectedToken) throw new MappingConflict()
      // R-VT-2 (b) — the WRITE path validates and REFUSES, naming the offending key. Before the dry run too: a
      // simulation of a rule that can never be saved is a number an operator would act on for nothing.
      const draft = draftVariationRule(mapping, categoryId, rule, actor(request))
      if (draft.errors.length) return reply.code(400).send({ error: 'invalid', details: draft.errors })

      const simulation = await simulateVariationRule({ channel, market, categoryId, rule })
      if (body.dryRun === true) {
        return reply.send({ follow: simulation.follow, wouldCollide: simulation.wouldCollide })
      }
      // The commit goes through the EXISTING review → activation path — `createMappingImpact` with the
      // `variationChange` kind — so every mapping write on this marketplace still has one writer, one CAS token and
      // one audit trail. The page then activates it with `POST …/impact/:jobId/activate`, exactly as a field-rule
      // change does. `jobId` is present ONLY on this branch, which is the contract VT.3 codes against.
      const job = await createMappingImpact({
        channel, market, expectedToken: body.expectedToken, userId: actor(request),
        variationChange: { categoryId, rule },
      })
      return reply.code(202).send({ follow: simulation.follow, wouldCollide: simulation.wouldCollide, jobId: job.jobId })
    } catch (err) {
      if (err instanceof MappingConflict) return reply.code(409).send({ error: 'CONFLICT', message: err.message })
      return fail(reply, err)
    }
  }
  fastify.put<{ Params: { channel: string; code: string } }>('/pim/channel-mapping/:channel/:code/variations', putVariations)
  fastify.put<{ Params: { channel: string; code: string; categoryId: string } }>('/pim/channel-mapping/:channel/:code/variations/:categoryId', putVariations)

  const reviewRequired = async (_request: unknown, reply: any) => reply.code(409).send({ error: 'REVIEW_REQUIRED', message: 'Preview the business-rule change through the mapping impact endpoint, then activate the reviewed result.' })
  fastify.put('/pim/channel-mapping/:channel/:code/expressions/:name', reviewRequired)
  fastify.post('/pim/channel-mapping/:channel/:code/expressions/:name/rename', reviewRequired)
  fastify.delete('/pim/channel-mapping/:channel/:code/expressions/:name', reviewRequired)

}

export default channelMappingRoutes
