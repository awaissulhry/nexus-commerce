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
  validateFieldRule,
  MarketplaceNotFoundError,
  InvalidMappingError,
  type FieldMappingRule,
} from '../services/pim/schema-mapping.service.js'
import { validatePublish } from '../services/pim/publish-validator.js'
import { previewPayload } from '../services/pim/payload-preview.js'
import { syncSchemaToChannelSchema } from '../services/pim/schema-sync-bridge.js'
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
        const seed = await seedBuiltInSchemasForChannel(prisma as any, channel)
        const snapshot = `${channel}:built-in:${new Date().toISOString()}`
        await recordSchemaSync(channel, code, snapshot).catch(() => {
          /* recordSchemaSync needs the marketplace to exist; quietly
           * fall through when it doesn't — the seed itself succeeded. */
        })
        return reply.send({
          channel,
          marketplace: code,
          productType: 'built-in',
          schemaSnapshotVersion: snapshot,
          upserted: seed.upserted,
          skipped: 0,
          totalProperties: seed.upserted,
          source: 'built-in',
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

  // ── DELETE /pim/mappings/:channel/:code/:fieldKey ───────────────
  fastify.delete<{ Params: { channel: string; code: string; fieldKey: string }; Querystring: { productType?: string } }>(
    '/pim/mappings/:channel/:code/:fieldKey',
    async (request, reply) => {
      const { channel, code, fieldKey } = request.params
      const productType = request.query.productType?.trim() || undefined
      try {
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
}

export default pimMappingRoutes
