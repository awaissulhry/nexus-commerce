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
  upsertFieldMapping,
  removeFieldMapping,
  validateFieldRule,
  MarketplaceNotFoundError,
  InvalidMappingError,
  type FieldMappingRule,
} from '../services/pim/schema-mapping.service.js'

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
  fastify.get<{ Params: { channel: string; code: string } }>(
    '/pim/mappings/:channel/:code',
    async (request, reply) => {
      const { channel, code } = request.params

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
        rule: mapping.fields[f.fieldKey] ?? null,
      }))

      return reply.send({
        channel,
        code,
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
    Body: FieldMappingRule
  }>(
    '/pim/mappings/:channel/:code/:fieldKey',
    async (request, reply) => {
      const { channel, code, fieldKey } = request.params
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
        const next = await upsertFieldMapping(channel, code, fieldKey, rule)
        return reply.send({ ok: true, rule: next.fields[fieldKey] })
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

  // ── DELETE /pim/mappings/:channel/:code/:fieldKey ───────────────
  fastify.delete<{ Params: { channel: string; code: string; fieldKey: string } }>(
    '/pim/mappings/:channel/:code/:fieldKey',
    async (request, reply) => {
      const { channel, code, fieldKey } = request.params
      try {
        await removeFieldMapping(channel, code, fieldKey)
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
