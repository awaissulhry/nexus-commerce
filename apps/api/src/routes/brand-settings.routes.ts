/**
 * F.6.2 — Brand settings routes.
 *
 * GET  /api/settings/brand   → fetch the single BrandSettings row, creating
 *                              an empty default if none exists.
 * PATCH /api/settings/brand  → update the row (single-row pattern; the GET
 *                              guarantees existence so PATCH never has to
 *                              choose between create vs update).
 */
import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

const brandSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/settings/brand', async (_request, reply) => {
    try {
      let row = await prisma.brandSettings.findFirst()
      if (!row) {
        row = await prisma.brandSettings.create({ data: {} })
      }
      return row
    } catch (error: any) {
      fastify.log.error({ err: error }, '[settings/brand GET] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.patch('/settings/brand', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        companyName?: string | null
        addressLines?: string[]
        taxId?: string | null
        contactEmail?: string | null
        contactPhone?: string | null
        websiteUrl?: string | null
        logoUrl?: string | null
        signatureBlockText?: string | null
        defaultPoNotes?: string | null
        factoryEmailFrom?: string | null
      }

      // Sanitize: trim strings, drop unknown keys, coerce addressLines.
      const update: Record<string, unknown> = {}
      const stringKeys = [
        'companyName',
        'taxId',
        'contactEmail',
        'contactPhone',
        'websiteUrl',
        'logoUrl',
        'signatureBlockText',
        'defaultPoNotes',
        'factoryEmailFrom',
      ] as const
      for (const k of stringKeys) {
        if (k in body) {
          const v = (body as any)[k]
          update[k] = v == null || v === '' ? null : String(v).trim()
        }
      }
      if ('addressLines' in body && Array.isArray(body.addressLines)) {
        update.addressLines = body.addressLines
          .map((s) => (typeof s === 'string' ? s.trim() : ''))
          .filter((s) => s.length > 0)
      }

      // Single-row upsert: read-then-update keeps the contract simple.
      let row = await prisma.brandSettings.findFirst()
      if (!row) {
        row = await prisma.brandSettings.create({ data: update })
      } else {
        row = await prisma.brandSettings.update({
          where: { id: row.id },
          data: update,
        })
      }
      return row
    } catch (error: any) {
      fastify.log.error({ err: error }, '[settings/brand PATCH] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })
}

export default brandSettingsRoutes
