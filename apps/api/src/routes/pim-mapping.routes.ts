/**
 * PIM D.2 — Mapping editor backend.
 *
 * Surfaces ChannelSchema field definitions joined with the
 * Marketplace.schemaMapping FieldMappingRule the operator has
 * authored for that field. Writes go through the A.3 service so the
 * JSONB merge + validation stay centralized.
 *
 * Endpoints (mounted under /api):
 *   GET    /pim/mappings/marketplaces
 *     → list of (channel, code, name, fieldCount, mappedCount)
 *
 *   GET    /pim/mappings/:channel/:code
 *     → list of every ChannelSchema field for the marketplace, each
 *       joined with the FieldMappingRule when present.
 *
 *   PUT    /pim/mappings/:channel/:code/:fieldKey
 *     → upsert one rule. Body: FieldMappingRule shape from A.3.
 *
 *   DELETE /pim/mappings/:channel/:code/:fieldKey
 *     → remove one rule. Idempotent.
 *
 * D.1 (live SP-API/eBay/Shopify schema fetch) will populate
 * ChannelSchema rows; until then operators map against whatever
 * rows already exist.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  getMappingForMarketplace,
  getRulesFor,
  upsertFieldMapping,
  removeFieldMapping,
  bulkUpsertFieldMappings,
  bulkRemoveFieldMappings,
  cloneMapping,
  validateFieldRule,
  MarketplaceNotFoundError,
  InvalidMappingError,
  type FieldMappingRule,
} from '../services/pim/schema-mapping.service.js'
import { validatePublish } from '../services/pim/publish-validator.js'
import { previewPayload } from '../services/pim/payload-preview.js'
import { suggestMappings } from '../services/pim/mapping-suggest.service.js'
import { suggestMappingsAI } from '../services/pim/mapping-suggest-ai.service.js'
import { recordMappingRevision, listMappingRevisions, rollbackMapping } from '../services/pim/mapping-revision.service.js'
import { computeCoverageMatrix } from '../services/pim/mapping-coverage.service.js'
import { simulateRuleChange } from '../services/pim/mapping-simulate.service.js'
import { syncSchemaToChannelSchema } from '../services/pim/schema-sync-bridge.js'
import { syncEbayCategoryAspects } from '../services/pim/ebay-schema-sync.service.js'
import { CategorySchemaService } from '../services/categories/schema-sync.service.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { seedBuiltInSchemasForChannel } from '../services/feed/channel-schema.service.js'
import { recordSchemaSync } from '../services/pim/schema-mapping.service.js'

const pimMappingRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /pim/mappings/marketplaces ──────────────────────────────
  // List every marketplace with how many schema fields it has + how
  // many of those are mapped. Drives the picker on the UI.
  fastify.get('/pim/mappings/marketplaces', async (_request, reply) => {
    const marketplaces = await prisma.marketplace.findMany({
      where: { isActive: true },
      select: {
        channel: true,
        code: true,
        name: true,
        currency: true,
        language: true,
        schemaMapping: true,
      },
      orderBy: [{ channel: 'asc' }, { code: 'asc' }],
    })

    // Field counts per (channel, marketplace) for the schema side.
    // Group locally rather than running N queries.
    const allFields = await prisma.channelSchema.findMany({
      select: { channel: true, marketplace: true, fieldKey: true },
    })
    type Key = string
    const keyOf = (ch: string, mk: string | null): Key => `${ch}:${mk ?? '*'}`
    const fieldsByKey = new Map<Key, number>()
    for (const f of allFields) {
      const k = keyOf(f.channel, f.marketplace)
      fieldsByKey.set(k, (fieldsByKey.get(k) ?? 0) + 1)
    }

    const result = marketplaces.map((m) => {
      // ChannelSchema.marketplace can be null (applies to all) so we
      // count specific + null entries.
      const specific = fieldsByKey.get(keyOf(m.channel, m.code)) ?? 0
      const generic = fieldsByKey.get(keyOf(m.channel, null)) ?? 0
      const fieldCount = specific + generic
      const mapping = (m.schemaMapping as Record<string, unknown> | null) ?? {}
      const fields = (mapping as { fields?: Record<string, unknown> }).fields ?? {}
      const mappedCount = typeof fields === 'object' && fields !== null
        ? Object.keys(fields).length
        : 0
      return {
        channel: m.channel,
        code: m.code,
        name: m.name,
        currency: m.currency,
        language: m.language,
        fieldCount,
        mappedCount,
      }
    })

    return reply.send({ marketplaces: result })
  })

  // ── GET /pim/mappings/:channel/:code ────────────────────────────
  // Every schema field for the marketplace + the current rule (or null).
  fastify.get<{ Params: { channel: string; code: string }; Querystring: { productType?: string } }>(
    '/pim/mappings/:channel/:code',
    async (request, reply) => {
      const { channel, code } = request.params
      // FM.9 — when a productType is selected, the canvas edits + shows the
      // per-productType overlay merged over the default bucket.
      const productType = request.query.productType?.trim() || undefined

      // Verify marketplace exists. Throws → 404.
      let mapping
      try {
        mapping = await getMappingForMarketplace(channel, code)
      } catch (err) {
        if (err instanceof MarketplaceNotFoundError) {
          return reply.status(404).send({ error: err.message })
        }
        throw err
      }

      const resolved = getRulesFor(mapping, productType)
      const overlay = productType ? (mapping.byProductType?.[productType] ?? {}) : {}

      // Pull schema fields: anything for this specific marketplace
      // OR marketplace-agnostic (null) entries for this channel.
      const fields = await prisma.channelSchema.findMany({
        where: {
          channel,
          OR: [{ marketplace: code }, { marketplace: null }],
        },
        orderBy: { fieldKey: 'asc' },
      })

      const rows = fields.map((f) => ({
        fieldKey: f.fieldKey,
        label: f.label,
        maxLength: f.maxLength,
        required: f.required,
        allowedValues: f.allowedValues,
        notes: f.notes,
        rule: resolved[f.fieldKey] ?? null,
        // FM.9 — true when this rule comes from the productType overlay
        // (vs inherited from the default bucket) so the UI can badge it.
        overlay: productType
          ? Object.prototype.hasOwnProperty.call(overlay, f.fieldKey)
          : false,
      }))

      return reply.send({
        channel,
        code,
        productType: productType ?? null,
        // Known overlay productTypes so the UI selector can list them.
        productTypes: Object.keys(mapping.byProductType ?? {}).sort(),
        version: mapping.version,
        lastSyncedAt: mapping.lastSyncedAt,
        schemaSnapshotVersion: mapping.schemaSnapshotVersion,
        fields: rows,
      })
    },
  )

  // ── PUT /pim/mappings/:channel/:code/:fieldKey ──────────────────
  // Upsert one rule. Validates via the A.3 service which rejects bad
  // shapes with InvalidMappingError (→ 400).
  fastify.put<{
    Params: { channel: string; code: string; fieldKey: string }
    Querystring: { productType?: string }
    Body: FieldMappingRule
  }>(
    '/pim/mappings/:channel/:code/:fieldKey',
    async (request, reply) => {
      const { channel, code, fieldKey } = request.params
      const productType = request.query.productType?.trim() || undefined
      const rule = request.body

      // Cheap pre-check so the API returns 400 with rich error info
      // instead of letting upsertFieldMapping throw further in.
      const validationErrors = validateFieldRule(fieldKey, rule)
      if (validationErrors.length > 0) {
        return reply.status(400).send({
          error: 'invalid_rule',
          details: validationErrors,
        })
      }

      try {
        // FM.13 — snapshot the pre-edit mapping for version history/rollback.
        await recordMappingRevision(channel, code, {
          changedBy: (request as any).user?.id ?? null,
          reason: `upsert ${fieldKey}${productType ? ` [${productType}]` : ''}`,
        }).catch((e) => request.log.warn({ e }, 'recordMappingRevision failed (non-blocking)'))
        const next = await upsertFieldMapping(channel, code, fieldKey, rule, productType)
        const saved = productType
          ? next.byProductType?.[productType]?.[fieldKey]
          : next.fields[fieldKey]
        return reply.send({ ok: true, rule: saved })
      } catch (err) {
        if (err instanceof MarketplaceNotFoundError) {
          return reply.status(404).send({ error: err.message })
        }
        if (err instanceof InvalidMappingError) {
          return reply.status(400).send({ error: 'invalid_rule', details: err.errors })
        }
        throw err
      }
    },
  )

  // ── POST /pim/mappings/:channel/:code/sync-schema ───────────────
  // PIM D.1 — Pull live schema from Amazon SP-API for a product type
  // and lift its fields into ChannelSchema rows so the mapping editor
  // can render them. Body: { productType: string }
  //
  // Returns SchemaSyncResult { upserted, skipped, totalProperties,
  // schemaSnapshotVersion } — UI surfaces those counts in a toast.
  //
  // eBay/Shopify schema sync deferred to D.1b (different APIs, eBay
  // GetCategorySpecifics + Shopify metafield schema).
  fastify.post<{
    Params: { channel: string; code: string }
    Body: { productType?: string }
  }>('/pim/mappings/:channel/:code/sync-schema', async (request, reply) => {
    const { channel, code } = request.params
    const productType = request.body?.productType?.trim()

    // ── eBay + Shopify: seed built-in schemas (D.1b) ─────────────
    // Schema is fixed (vs Amazon's per-productType JSON Schema), so
    // we just re-run the channel-scoped built-in seed. Operators
    // don't need to supply a productType — the seed covers every
    // known field for that channel in one shot.
    //
    // D.1c will replace this with live API fetches:
    //   - eBay: GetCategorySpecifics (per leaf category)
    //   - Shopify: metafield definitions per resource
    if (channel === 'EBAY' || channel === 'SHOPIFY') {
      try {
        // Built-in listing fields are channel-wide (marketplace=null). Seed
        // once — the (channel, marketplace, fieldKey) unique treats NULL
        // marketplaces as distinct, so a blind re-upsert would duplicate them.
        const builtInCount = await prisma.channelSchema.count({
          where: { channel, marketplace: null },
        })
        let builtIn = 0
        if (builtInCount === 0) {
          const seed = await seedBuiltInSchemasForChannel(prisma as any, channel)
          builtIn = seed.upserted
        }

        // eBay: also pull real per-category Item Aspects (Taxonomy API) for the
        // categories this marketplace's listings use. Best-effort — the
        // built-in fields are still seeded if the aspect fetch fails.
        let aspectFields = 0
        let categories = 0
        if (channel === 'EBAY') {
          const r = await syncEbayCategoryAspects(code).catch((e) => {
            request.log.warn({ e }, '[pim-mapping] eBay aspect sync failed (built-in still seeded)')
            return { upserted: 0, categories: 0, aspects: 0 }
          })
          aspectFields = r.upserted
          categories = r.categories
        }

        const snapshot = `${channel}:${channel === 'EBAY' ? 'taxonomy' : 'built-in'}:${new Date().toISOString()}`
        await recordSchemaSync(channel, code, snapshot).catch(() => {
          /* marketplace row may not exist; the seed itself succeeded */
        })
        return reply.send({
          channel,
          marketplace: code,
          productType: channel === 'EBAY' ? 'ebay-aspects' : 'built-in',
          schemaSnapshotVersion: snapshot,
          upserted: builtIn + aspectFields,
          skipped: 0,
          totalProperties: builtIn + aspectFields,
          source: channel === 'EBAY' ? 'built-in+taxonomy' : 'built-in',
          ...(channel === 'EBAY' ? { aspectFields, categories } : {}),
        })
      } catch (err: any) {
        request.log.error({ err }, '[pim-mapping] sync-schema (built-in) failed')
        return reply.status(500).send({ error: err?.message ?? 'Built-in seed failed' })
      }
    }

    // ── Amazon: live SP-API sync (D.1) ───────────────────────────
    if (channel !== 'AMAZON') {
      return reply
        .status(400)
        .send({ error: `Unsupported channel for sync-schema: ${channel}` })
    }
    if (!productType) {
      return reply.status(400).send({ error: 'productType is required for AMAZON sync' })
    }

    try {
      // Step 1: ensure the JSON Schema is cached for this productType.
      // CategorySchemaService.getSchema returns cached on hit, fetches
      // SP-API on miss. Force-refresh on demand can be added later via
      // a query flag — D.1 trusts the 24h cache.
      const amazon = new AmazonService()
      const catService = new CategorySchemaService(prisma as any, amazon)
      await catService.getSchema({
        channel: 'AMAZON',
        marketplace: code,
        productType,
      })

      // Step 2: bridge the cached JSON Schema → ChannelSchema rows +
      // record snapshot on Marketplace.schemaMapping.
      const result = await syncSchemaToChannelSchema({
        channel: 'AMAZON',
        marketplace: code,
        productType,
      })

      return reply.send({ ...result, source: 'sp-api' })
    } catch (err: any) {
      const msg = err?.message ?? 'Schema sync failed'
      // Common error: Amazon SP-API not configured (no creds locally).
      // Surface that distinctly so the operator gets an actionable hint.
      const isAuthError = /credential|auth|sp-api|access denied/i.test(msg)
      request.log.error({ err }, '[pim-mapping] sync-schema failed')
      return reply.status(isAuthError ? 503 : 500).send({
        error: msg,
        hint: isAuthError
          ? 'Configure Amazon SP-API credentials (LWA refresh token + role) for this marketplace.'
          : undefined,
      })
    }
  })

  // ── GET /pim/mappings/:channel/:code/preview/:productId ─────────
  // PIM D.6 — Dry-run payload preview. Runs the mapping rules against
  // one product (resolves source/fallback, applies transforms), returns
  // the exact payload that would publish + per-field provenance for
  // operator inspection.
  fastify.get<{
    Params: { channel: string; code: string; productId: string }
    Querystring: { locale?: string }
  }>(
    '/pim/mappings/:channel/:code/preview/:productId',
    async (request, reply) => {
      const { channel, code, productId } = request.params
      const locale = request.query.locale ?? 'en'
      try {
        const result = await previewPayload({ productId, channel, marketplace: code, locale })
        return reply.send(result)
      } catch (err: any) {
        const msg = err?.message ?? 'Preview failed'
        if (msg.startsWith('Product not found') || msg.startsWith('Marketplace not found')) {
          return reply.status(404).send({ error: msg })
        }
        request.log.error({ err }, 'payload-preview failed')
        return reply.status(500).send({ error: msg })
      }
    },
  )

  // ── GET /pim/mappings/:channel/:code/validate/:productId ────────
  // PIM D.5 — Pre-publish validation. Walks mapping rules + resolves
  // each source against the product via attribute-resolver, returns
  // structured errors for required fields that don't resolve.
  fastify.get<{
    Params: { channel: string; code: string; productId: string }
    Querystring: { locale?: string }
  }>(
    '/pim/mappings/:channel/:code/validate/:productId',
    async (request, reply) => {
      const { channel, code, productId } = request.params
      const locale = request.query.locale ?? 'en'
      try {
        const result = await validatePublish({ productId, channel, marketplace: code, locale })
        return reply.send(result)
      } catch (err: any) {
        const msg = err?.message ?? 'Validation failed'
        if (msg.startsWith('Product not found') || msg.startsWith('Marketplace not found')) {
          return reply.status(404).send({ error: msg })
        }
        request.log.error({ err }, 'publish-validation failed')
        return reply.status(500).send({ error: msg })
      }
    },
  )

  // ── GET /pim/mappings/:channel/:code/suggest ────────────────────
  // FM.13 — suggest a master source for each unmapped field (heuristic
  // name match). Read-only; the operator applies via PUT.
  fastify.get<{
    Params: { channel: string; code: string }
    Querystring: { productType?: string }
  }>('/pim/mappings/:channel/:code/suggest', async (request, reply) => {
    const { channel, code } = request.params
    const productType = request.query.productType?.trim() || undefined
    try {
      const result = await suggestMappings({ channel, code, productType })
      return reply.send(result)
    } catch (err: any) {
      request.log.error({ err }, 'mapping suggest failed')
      return reply.status(500).send({ error: err?.message ?? 'suggest failed' })
    }
  })

  // ── POST /pim/mappings/:channel/:code/suggest-ai ────────────────
  // BM.2 — AI maps the long-tail fields the heuristic can't. Opt-in,
  // budget/kill-switch-aware, review-gated (caller confirms before write).
  fastify.post<{
    Params: { channel: string; code: string }
    Querystring: { productType?: string }
  }>('/pim/mappings/:channel/:code/suggest-ai', async (request, reply) => {
    const { channel, code } = request.params
    const productType = request.query.productType?.trim() || undefined
    try {
      const result = await suggestMappingsAI({ channel, code, productType })
      return reply.send(result)
    } catch (err: any) {
      request.log.error({ err }, 'mapping suggest-ai failed')
      return reply.status(500).send({ error: err?.message ?? 'suggest-ai failed' })
    }
  })

  // ── DELETE /pim/mappings/:channel/:code/:fieldKey ───────────────
  fastify.delete<{ Params: { channel: string; code: string; fieldKey: string }; Querystring: { productType?: string } }>(
    '/pim/mappings/:channel/:code/:fieldKey',
    async (request, reply) => {
      const { channel, code, fieldKey } = request.params
      const productType = request.query.productType?.trim() || undefined
      try {
        // FM.13 — snapshot the pre-delete mapping for version history/rollback.
        await recordMappingRevision(channel, code, {
          changedBy: (request as any).user?.id ?? null,
          reason: `delete ${fieldKey}${productType ? ` [${productType}]` : ''}`,
        }).catch((e) => request.log.warn({ e }, 'recordMappingRevision failed (non-blocking)'))
        await removeFieldMapping(channel, code, fieldKey, productType)
        return reply.send({ ok: true })
      } catch (err) {
        if (err instanceof MarketplaceNotFoundError) {
          return reply.status(404).send({ error: err.message })
        }
        throw err
      }
    },
  )

  // ── GET /pim/mappings/:channel/:code/revisions ──────────────────
  // FM.13 — version history (metadata) for this marketplace's mapping.
  fastify.get<{ Params: { channel: string; code: string } }>(
    '/pim/mappings/:channel/:code/revisions',
    async (request, reply) => {
      const { channel, code } = request.params
      const revisions = await listMappingRevisions(channel, code)
      return reply.send({ revisions })
    },
  )

  // ── POST /pim/mappings/:channel/:code/rollback/:revisionId ──────
  // FM.13 — restore a revision's snapshot (records the current state first,
  // so the rollback is itself undoable).
  fastify.post<{ Params: { channel: string; code: string; revisionId: string } }>(
    '/pim/mappings/:channel/:code/rollback/:revisionId',
    async (request, reply) => {
      const { channel, code, revisionId } = request.params
      try {
        const restored = await rollbackMapping(channel, code, revisionId)
        return reply.send({ ok: true, mapping: restored })
      } catch (err: any) {
        const msg = err?.message ?? 'rollback failed'
        if (msg.includes('not found')) return reply.status(404).send({ error: msg })
        if (msg.includes('invalid')) return reply.status(400).send({ error: msg })
        request.log.error({ err }, 'mapping rollback failed')
        return reply.status(500).send({ error: msg })
      }
    },
  )

  // ── POST /pim/mappings/:channel/:code/bulk ──────────────────────
  // BM.1 — upsert many rules in one revision (the auto-map apply path).
  fastify.post<{
    Params: { channel: string; code: string }
    Querystring: { productType?: string }
    Body: { rules: Array<{ fieldKey: string; rule: FieldMappingRule }> }
  }>('/pim/mappings/:channel/:code/bulk', async (request, reply) => {
    const { channel, code } = request.params
    const productType = request.query.productType?.trim() || undefined
    const rules = request.body?.rules
    if (!Array.isArray(rules) || rules.length === 0) {
      return reply.status(400).send({ error: 'rules (non-empty array of { fieldKey, rule }) is required' })
    }
    if (rules.length > 500) return reply.status(400).send({ error: 'Max 500 rules per call' })
    try {
      await recordMappingRevision(channel, code, {
        changedBy: (request as any).user?.id ?? null,
        reason: `bulk upsert ${rules.length}${productType ? ` [${productType}]` : ''}`,
      }).catch((e) => request.log.warn({ e }, 'recordMappingRevision failed (non-blocking)'))
      const result = await bulkUpsertFieldMappings(channel, code, rules, productType)
      return reply.send({ ok: true, count: result.count })
    } catch (err: any) {
      if (err instanceof InvalidMappingError) {
        return reply.status(400).send({ error: 'invalid_rules', details: err.errors })
      }
      if (err instanceof MarketplaceNotFoundError) return reply.status(404).send({ error: err.message })
      request.log.error({ err }, 'bulk mapping upsert failed')
      return reply.status(500).send({ error: err?.message ?? 'bulk upsert failed' })
    }
  })

  // ── DELETE /pim/mappings/:channel/:code/bulk ────────────────────
  // BM.1 — remove many rules in one revision (bulk clear).
  fastify.delete<{
    Params: { channel: string; code: string }
    Querystring: { productType?: string }
    Body: { fieldKeys: string[] }
  }>('/pim/mappings/:channel/:code/bulk', async (request, reply) => {
    const { channel, code } = request.params
    const productType = request.query.productType?.trim() || undefined
    const fieldKeys = request.body?.fieldKeys
    if (!Array.isArray(fieldKeys) || fieldKeys.length === 0) {
      return reply.status(400).send({ error: 'fieldKeys (non-empty array) is required' })
    }
    try {
      await recordMappingRevision(channel, code, {
        changedBy: (request as any).user?.id ?? null,
        reason: `bulk remove ${fieldKeys.length}${productType ? ` [${productType}]` : ''}`,
      }).catch((e) => request.log.warn({ e }, 'recordMappingRevision failed (non-blocking)'))
      const result = await bulkRemoveFieldMappings(channel, code, fieldKeys, productType)
      return reply.send({ ok: true, count: result.count })
    } catch (err: any) {
      if (err instanceof MarketplaceNotFoundError) return reply.status(404).send({ error: err.message })
      request.log.error({ err }, 'bulk mapping remove failed')
      return reply.status(500).send({ error: err?.message ?? 'bulk remove failed' })
    }
  })

  // ── POST /pim/mappings/clone ────────────────────────────────────
  // BM.4 — clone a coordinate's rules to other markets/types (filtered to
  // each target's fields; optional auto-translate for text fields).
  fastify.post<{
    Body: {
      from: { channel: string; code: string }
      targets: Array<{ channel: string; code: string }>
      productType?: string
      addTranslate?: boolean
    }
  }>('/pim/mappings/clone', async (request, reply) => {
    const b = request.body
    if (!b?.from?.channel || !b?.from?.code || !Array.isArray(b.targets) || b.targets.length === 0) {
      return reply.status(400).send({ error: 'from {channel, code} + non-empty targets[] are required' })
    }
    const productType = b.productType?.trim() || undefined
    try {
      // Snapshot each target before clone (FM.13 rollback).
      for (const t of b.targets) {
        await recordMappingRevision(t.channel, t.code, {
          changedBy: (request as any).user?.id ?? null,
          reason: `clone from ${b.from.channel}/${b.from.code}${productType ? ` [${productType}]` : ''}`,
        }).catch(() => {})
      }
      const result = await cloneMapping({ from: b.from, targets: b.targets, productType, addTranslate: b.addTranslate })
      return reply.send(result)
    } catch (err: any) {
      const msg = err?.message ?? 'clone failed'
      if (err instanceof MarketplaceNotFoundError) return reply.status(404).send({ error: msg })
      request.log.error({ err }, 'mapping clone failed')
      return reply.status(500).send({ error: msg })
    }
  })

  // ── GET /pim/mappings/coverage ──────────────────────────────────
  // FM.13 — cross-market coverage matrix (% mapped, required-unmapped per
  // channel×market×productType).
  fastify.get<{ Querystring: { channel?: string } }>(
    '/pim/mappings/coverage',
    async (request, reply) => {
      const channel = request.query.channel?.trim() || undefined
      const result = await computeCoverageMatrix(channel)
      return reply.send(result)
    },
  )

  // ── POST /pim/mappings/:channel/:code/simulate ──────────────────
  // FM.14 — estimate a proposed rule's blast radius (affected products +
  // sample before→after diffs) before saving. Read-only.
  fastify.post<{
    Params: { channel: string; code: string }
    Body: { fieldKey: string; rule: any; productType?: string; limit?: number }
  }>('/pim/mappings/:channel/:code/simulate', async (request, reply) => {
    const { channel, code } = request.params
    const b = request.body
    if (!b?.fieldKey || !b.rule || typeof b.rule.source !== 'string') {
      return reply.status(400).send({ error: 'fieldKey + rule.source are required' })
    }
    try {
      const result = await simulateRuleChange({
        channel,
        code,
        fieldKey: b.fieldKey,
        rule: b.rule,
        productType: b.productType?.trim() || undefined,
        limit: b.limit,
      })
      return reply.send(result)
    } catch (err: any) {
      request.log.error({ err }, 'mapping simulate failed')
      return reply.status(500).send({ error: err?.message ?? 'simulate failed' })
    }
  })
}

export default pimMappingRoutes
