import { commitWizardPreset } from '../services/listing-wizard/preset-application.service.js'
/**
 * WT.2 (list-wizard) — operator endpoints for WizardTemplate.
 *
 *   GET    /api/wizard-templates                — list (with optional
 *                                                  filter by builtIn)
 *   POST   /api/wizard-templates                — create from explicit
 *                                                  channels + defaults
 *   POST   /api/wizard-templates/from-wizard/:id — save current wizard
 *                                                  state as template
 *   POST   /api/wizard-templates/:id/apply       — apply to a wizard
 *                                                  (PATCH wizard state)
 *   DELETE /api/wizard-templates/:id             — refuse builtIn
 *
 * builtIn rows are read-only at the API surface; create / delete /
 * mutate paths reject any attempt to touch them. The 5 seeds shipped
 * in WT.1 are builtIn=true.
 *
 * Apply path:
 *   - Reads the template's channels[] + defaults
 *   - Updates the target wizard's channels (overwrites — operators
 *     are explicit about applying)
 *   - Fills missing reusable defaults in wizard.state, preserving each
 *     explicit field and product-owned slice
 *   - Increments usageCount + lastUsedAt on the template row
 *   - Returns the updated wizard so the client can re-render
 */

import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '@prisma/client'
import { fillPresetDefaults, reusablePresetDefaults } from '../services/listing-wizard/preset-defaults.js'
import { ProductPresetService, productPresetScopeOf } from '../services/listing-wizard/product-presets.js'
import prisma from '../db.js'
import {
  channelsHash,
  normalizeChannels,
  type ChannelTuple,
} from '../services/listing-wizard/channels.js'

const wizardTemplateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { builtIn?: string; channel?: string; market?: string; search?: string; offset?: string; limit?: string }
  }>('/wizard-templates', async (request) => {
    const builtInFilter =
      typeof request.query?.builtIn === 'string'
        ? request.query.builtIn === 'true'
          ? true
          : request.query.builtIn === 'false'
            ? false
            : null
        : null
    const where: Prisma.WizardTemplateWhereInput = builtInFilter !== null ? { builtIn: builtInFilter } : {}
    const channel = request.query.channel?.trim().toUpperCase()
    const market = request.query.market?.trim().toUpperCase()
    if (channel || market) where.channels = { array_contains: [{ ...(channel ? { platform: channel } : {}), ...(market ? { marketplace: market } : {}) }] }
    if (request.query.search?.trim()) where.name = { contains: request.query.search.trim(), mode: 'insensitive' }
    const pageNumber = (value: string | undefined, fallback: number) => value && Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback
    const limit = Math.min(200, Math.max(1, pageNumber(request.query.limit, 200)))
    const offset = Math.max(0, pageNumber(request.query.offset, 0))
    const total = await prisma.wizardTemplate.count({ where })
    const rows = await prisma.wizardTemplate.findMany({
      where,
      orderBy: [
        { builtIn: 'desc' }, // built-ins first when not filtered
        { usageCount: 'desc' },
        { name: 'asc' },
      ],
      take: Math.trunc(limit),
      skip: Math.trunc(offset),
    })
    return {
      total, limit, offset,
      rows: rows.map((r) => ({
        ...r,
        ...reusablePresetDefaults(r.defaults),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      })),
    }
  })

  fastify.post<{
    Body: {
      name?: string
      description?: string
      channels?: ChannelTuple[]
      defaults?: Record<string, unknown>
      categoryHint?: string
    }
  }>('/wizard-templates', async (request, reply) => {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
    if (name.length === 0) {
      return reply.code(400).send({ error: 'name is required' })
    }
    const channels = normalizeChannels(request.body?.channels ?? [])
    if (channels.length === 0) {
      return reply.code(400).send({
        error:
          'channels[] required and must contain at least one {platform, marketplace}',
      })
    }
    const defaults =
      request.body?.defaults && typeof request.body.defaults === 'object'
        ? (request.body.defaults as Record<string, unknown>)
        : {}
    const reusable = reusablePresetDefaults(defaults)
    if (reusable.excluded.length) return reply.code(400).send({ error: `Presets cannot store product-specific or unsupported fields: ${reusable.excluded.join(', ')}` })
    try {
      const row = await prisma.wizardTemplate.create({
        data: {
          name: name.slice(0, 120),
          description:
            typeof request.body?.description === 'string'
              ? request.body.description.slice(0, 500)
              : null,
          channels: channels as unknown as object,
          defaults: reusable.defaults as object,
          categoryHint:
            typeof request.body?.categoryHint === 'string' &&
            request.body.categoryHint.trim().length > 0
              ? request.body.categoryHint.trim().slice(0, 60)
              : null,
          builtIn: false,
          createdBy: (request as unknown as { authUser?: { id?: string } }).authUser?.id ?? null
        },
      })
      reply.code(201)
      return {
        row: {
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
        },
      }
    } catch (err) {
      fastify.log.error({ err }, '[wizard-templates] create failed')
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  fastify.post<{
    Params: { id: string }
    Body: {
      name?: string
      description?: string
      categoryHint?: string
    }
  }>(
    '/wizard-templates/from-wizard/:id',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) return reply.code(404).send({ error: 'Wizard not found' })

      const name =
        typeof request.body?.name === 'string' ? request.body.name.trim() : ''
      if (name.length === 0) {
        return reply.code(400).send({ error: 'name is required' })
      }
      const channels = normalizeChannels(wizard.channels)
      if (channels.length === 0) {
        return reply.code(409).send({
          error:
            'Wizard has no channels picked yet — nothing to template. Walk Step 1 first.',
        })
      }

      // Only reusable SKU and variation-theme settings belong in a preset.
      // Product prices, facts, media and selected variants remain with the source product.
      const state = (wizard.state as Record<string, unknown>) ?? {}
      const { defaults } = reusablePresetDefaults(state)

      try {
        const row = await prisma.wizardTemplate.create({
          data: {
            name: name.slice(0, 120),
            description:
              typeof request.body?.description === 'string'
                ? request.body.description.slice(0, 500)
                : null,
            channels: channels as unknown as object,
            defaults: defaults as unknown as object,
            categoryHint:
              typeof request.body?.categoryHint === 'string' &&
              request.body.categoryHint.trim().length > 0
                ? request.body.categoryHint.trim().slice(0, 60)
                : null,
            builtIn: false,
            createdBy: (request as unknown as { authUser?: { id?: string } }).authUser?.id ?? null,
          },
        })
        reply.code(201)
        return {
          row: {
            ...row,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            lastUsedAt: row.lastUsedAt
              ? row.lastUsedAt.toISOString()
              : null,
          },
        }
      } catch (err) {
        fastify.log.error({ err }, '[wizard-templates] from-wizard failed')
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  fastify.post<{
    Params: { id: string }
    Body: { wizardId?: string; dryRun?: boolean; expectedVersion?: number; expectedWizardUpdatedAt?: string; expectedPresetUpdatedAt?: string; productContext?: unknown; reviewKey?: string }
  }>(
    '/wizard-templates/:id/apply',
    async (request, reply) => {
      if (request.body && Object.prototype.hasOwnProperty.call(request.body, 'productContext')) {
        try {
          const service = new ProductPresetService(prisma)
          return request.body.dryRun
            ? { preview: await service.review(request.body.productContext, request.params.id, request.body.wizardId) }
            : await service.apply(request.body.productContext, request.params.id, request.body.reviewKey ?? '', request.body.wizardId)
        } catch (error) {
          const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500
          if (status === 500) fastify.log.error({ err: error }, '[wizard-templates] product apply failed')
          return reply.code(status).send({ error: error instanceof Error ? error.message : 'Could not apply this preset.' })
        }
      }
      const wizardId =
        typeof request.body?.wizardId === 'string' && request.body.wizardId
          ? request.body.wizardId
          : null
      if (!wizardId) {
        return reply.code(400).send({ error: 'body.wizardId is required' })
      }
      const [tmpl, wizard] = await Promise.all([
        prisma.wizardTemplate.findUnique({ where: { id: request.params.id } }),
        prisma.listingWizard.findUnique({ where: { id: wizardId } }),
      ])
      if (!tmpl) return reply.code(404).send({ error: 'Template not found' })
      if (!wizard) return reply.code(404).send({ error: 'Wizard not found' })

      if (productPresetScopeOf(wizard)) return reply.code(409).send({ error: 'Review this preset from the product destination. Its account and listing scope must be retained.' })

      const channels = normalizeChannels(tmpl.channels)
      if (channels.length === 0) {
        return reply.code(409).send({
          error:
            'Template has no channels — corrupted seed? Pick another template.',
        })
      }

      if (wizard.status !== 'DRAFT') return reply.code(409).send({ error: 'A preset can only be applied to a draft wizard' })
      if (!request.body.dryRun && (request.body.expectedVersion === undefined || !request.body.expectedWizardUpdatedAt || !request.body.expectedPresetUpdatedAt)) return reply.code(400).send({ error: 'Review the preset before applying it; wizard and preset versions are required.' })
      if (request.body.expectedVersion !== undefined && request.body.expectedVersion !== wizard.version ||
          request.body.expectedWizardUpdatedAt !== undefined && request.body.expectedWizardUpdatedAt !== wizard.updatedAt.toISOString() ||
          request.body.expectedPresetUpdatedAt !== undefined && request.body.expectedPresetUpdatedAt !== tmpl.updatedAt.toISOString()) {
        return reply.code(409).send({ error: 'The wizard or preset changed. Review the current values again.' })
      }
      const existingState = (wizard.state as Record<string, unknown>) ?? {}
      const reusable = reusablePresetDefaults(tmpl.defaults)
      const mergedState = fillPresetDefaults(existingState, reusable.defaults)
      if (request.body.dryRun) return { preview: {
        wizardId, expectedVersion: wizard.version, expectedWizardUpdatedAt: wizard.updatedAt.toISOString(), expectedPresetUpdatedAt: tmpl.updatedAt.toISOString(),
        before: { channels: normalizeChannels(wizard.channels), state: existingState },
        after: { channels, state: mergedState }, excluded: reusable.excluded,
        operation: 'apply-once', futureProducts: false, publication: 'separate',
      } }

      try {
        const w = await commitWizardPreset(wizard, tmpl, channels, mergedState)
        return {
          wizard: {
            id: w.id,
            channels: w.channels,
            state: w.state,
            currentStep: w.currentStep,
            status: w.status,
            updatedAt: w.updatedAt.toISOString(),
            version: w.version,
          },
          appliedTemplate: {
            id: tmpl.id,
            name: tmpl.name,
            channelCount: channels.length,
          },
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'PRESET_CONFLICT') return reply.code(409).send({ error: 'The wizard or preset changed during apply. Review it again.' })
        fastify.log.error({ err }, '[wizard-templates] apply failed')
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  fastify.delete<{ Params: { id: string }; Querystring: { expectedUpdatedAt?: string } }>(
    '/wizard-templates/:id',
    async (request, reply) => {
      const tmpl = await prisma.wizardTemplate.findUnique({
        where: { id: request.params.id },
        select: { id: true, builtIn: true, updatedAt: true },
      })
      if (!tmpl) return reply.code(404).send({ error: 'Template not found' })
      if (tmpl.builtIn) {
        return reply.code(409).send({
          error:
            'Built-in templates are read-only. Save your own to override.',
        })
      }
      if (request.query.expectedUpdatedAt && request.query.expectedUpdatedAt !== tmpl.updatedAt.toISOString()) return reply.code(409).send({ error: 'The preset changed. Reload it before deleting.' })
      const deleted = await prisma.wizardTemplate.deleteMany({ where: { id: request.params.id, updatedAt: tmpl.updatedAt, builtIn: false } })
      if (!deleted.count) return reply.code(409).send({ error: 'The preset changed during deletion. Reload it.' })
      reply.code(204)
      return null
    },
  )

  // WT.5a — patch a non-builtIn template's display fields. Channels +
  // defaults stay fixed at create time (re-shaping a template would
  // surprise operators who applied it last week); for that an
  // operator deletes + re-saves from a fresh wizard.
  fastify.patch<{
    Params: { id: string }
    Body: {
      expectedUpdatedAt?: string
      name?: string
      description?: string
      categoryHint?: string
    }
  }>(
    '/wizard-templates/:id',
    async (request, reply) => {
      const tmpl = await prisma.wizardTemplate.findUnique({
        where: { id: request.params.id },
        select: { id: true, builtIn: true, updatedAt: true },
      })
      if (!tmpl) return reply.code(404).send({ error: 'Template not found' })
      if (tmpl.builtIn) {
        return reply.code(409).send({
          error:
            'Built-in templates are read-only. Save your own to override.',
        })
      }

      if (request.body.expectedUpdatedAt && request.body.expectedUpdatedAt !== tmpl.updatedAt.toISOString()) return reply.code(409).send({ error: 'The preset changed. Reload it before saving.' })
      const data: Record<string, unknown> = {}
      if (typeof request.body?.name === 'string') {
        const n = request.body.name.trim()
        if (n.length === 0) {
          return reply.code(400).send({ error: 'name cannot be empty' })
        }
        data.name = n.slice(0, 120)
      }
      if (typeof request.body?.description === 'string') {
        const d = request.body.description.trim()
        data.description = d.length > 0 ? d.slice(0, 500) : null
      }
      if (typeof request.body?.categoryHint === 'string') {
        const c = request.body.categoryHint.trim()
        data.categoryHint = c.length > 0 ? c.slice(0, 60) : null
      }
      if (Object.keys(data).length === 0) {
        return reply.code(400).send({
          error: 'no recognised fields — pass name / description / categoryHint',
        })
      }
      try {
        const updated = await prisma.$transaction(async tx => {
          const result = await tx.wizardTemplate.updateMany({ where: { id: request.params.id, updatedAt: tmpl.updatedAt, builtIn: false }, data })
          if (!result.count) throw new Error('PRESET_CONFLICT')
          return tx.wizardTemplate.findUniqueOrThrow({ where: { id: request.params.id } })
        })
        return {
          row: {
            ...updated,
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
            lastUsedAt: updated.lastUsedAt
              ? updated.lastUsedAt.toISOString()
              : null,
          },
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'PRESET_CONFLICT') return reply.code(409).send({ error: 'The preset changed during save. Reload it.' })
        fastify.log.error({ err }, '[wizard-templates] patch failed')
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )
}

export default wizardTemplateRoutes
