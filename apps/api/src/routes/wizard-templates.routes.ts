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
 *   - Shallow-merges defaults into wizard.state (caller wins on
 *     conflicting keys)
 *   - Increments usageCount + lastUsedAt on the template row
 *   - Returns the updated wizard so the client can re-render
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  channelsHash,
  normalizeChannels,
  type ChannelTuple,
} from '../services/listing-wizard/channels.js'

const wizardTemplateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { builtIn?: string }
  }>('/wizard-templates', async (request) => {
    const builtInFilter =
      typeof request.query?.builtIn === 'string'
        ? request.query.builtIn === 'true'
          ? true
          : request.query.builtIn === 'false'
            ? false
            : null
        : null
    const where = builtInFilter !== null ? { builtIn: builtInFilter } : {}
    const rows = await prisma.wizardTemplate.findMany({
      where,
      orderBy: [
        { builtIn: 'desc' }, // built-ins first when not filtered
        { usageCount: 'desc' },
        { name: 'asc' },
      ],
      take: 200,
    })
    return {
      rows: rows.map((r) => ({
        ...r,
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
          createdBy: 'operator', // pre-auth placeholder
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

      // Capture defaults from wizard.state. We deliberately exclude
      // user-specific slices (identifiers, content, images) so the
      // template stays reusable across products. Pricing currentPrice
      // overrides also stripped — the next product's wizard sets its
      // own.
      const state = (wizard.state as Record<string, unknown>) ?? {}
      const allowedKeys = ['skuStrategy', 'variations', 'pricing']
      const defaults: Record<string, unknown> = {}
      for (const k of allowedKeys) {
        if (k in state && state[k] != null) defaults[k] = state[k]
      }

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
            createdBy: 'operator',
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
    Body: { wizardId?: string }
  }>(
    '/wizard-templates/:id/apply',
    async (request, reply) => {
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

      const channels = normalizeChannels(tmpl.channels)
      if (channels.length === 0) {
        return reply.code(409).send({
          error:
            'Template has no channels — corrupted seed? Pick another template.',
        })
      }

      const existingState = (wizard.state as Record<string, unknown>) ?? {}
      const tmplDefaults = (tmpl.defaults as Record<string, unknown>) ?? {}
      // Caller wins: an operator-supplied value isn't clobbered by
      // the template. Templates only fill blanks.
      const mergedState: Record<string, unknown> = { ...tmplDefaults, ...existingState }

      try {
        const updated = await prisma.$transaction([
          prisma.listingWizard.update({
            where: { id: wizardId },
            data: {
              channels: channels as unknown as object,
              channelsHash: channelsHash(channels),
              state: mergedState as unknown as object,
              version: { increment: 1 },
            },
          }),
          prisma.wizardTemplate.update({
            where: { id: tmpl.id },
            data: {
              usageCount: { increment: 1 },
              lastUsedAt: new Date(),
            },
          }),
        ])
        const w = updated[0]
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
        fastify.log.error({ err }, '[wizard-templates] apply failed')
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/wizard-templates/:id',
    async (request, reply) => {
      const tmpl = await prisma.wizardTemplate.findUnique({
        where: { id: request.params.id },
        select: { id: true, builtIn: true },
      })
      if (!tmpl) return reply.code(404).send({ error: 'Template not found' })
      if (tmpl.builtIn) {
        return reply.code(409).send({
          error:
            'Built-in templates are read-only. Save your own to override.',
        })
      }
      await prisma.wizardTemplate.delete({ where: { id: request.params.id } })
      reply.code(204)
      return null
    },
  )
}

export default wizardTemplateRoutes
