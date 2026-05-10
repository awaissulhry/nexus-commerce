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
import {
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
} from '../services/cloudinary.service.js'

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

  // Constraint #4 — Logo upload via multipart. Sends the file to
  // Cloudinary under brand-logos/, persists the secure URL on
  // BrandSettings.logoUrl. Returns the new URL so the UI can update
  // its preview without a second GET.
  //
  // Cloudinary creds missing → 503 with a clear message instructing the
  // user to either configure the env vars OR paste a logo URL directly
  // into the PATCH endpoint as a fallback.
  fastify.post('/settings/brand/logo', async (request, reply) => {
    try {
      if (!isCloudinaryConfigured()) {
        return reply.code(503).send({
          error:
            'Cloudinary not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, or use PATCH /api/settings/brand to set logoUrl directly.',
        })
      }
      // Fastify-multipart's request.file() throws when the request isn't
      // multipart. Catch the throw and turn it into a clean 400 instead
      // of letting it bubble as a 500.
      let data: any
      try {
        data = await (request as any).file?.()
      } catch (err) {
        return reply.code(400).send({
          error:
            'multipart upload required (Content-Type: multipart/form-data, field name: "file")',
        })
      }
      if (!data) {
        return reply
          .code(400)
          .send({ error: 'multipart upload required (field name: "file")' })
      }
      const buffer = await data.toBuffer()
      // Sanity cap — letterhead logos are tiny; reject anything > 4MB.
      if (buffer.length > 4 * 1024 * 1024) {
        return reply
          .code(413)
          .send({ error: 'logo too large (4 MB limit)' })
      }

      const uploaded = await uploadBufferToCloudinary(buffer, {
        folder: 'brand-logos',
        // Stable public_id per tenant; for now single-tenant so a fixed
        // ID lets re-uploads overwrite the same asset. Multi-tenant
        // version would key on tenantId.
        publicId: 'letterhead-logo',
      })

      // Persist on the (single) BrandSettings row.
      let row = await prisma.brandSettings.findFirst()
      if (!row) {
        row = await prisma.brandSettings.create({
          data: { logoUrl: uploaded.url },
        })
      } else {
        row = await prisma.brandSettings.update({
          where: { id: row.id },
          data: { logoUrl: uploaded.url },
        })
      }

      return {
        ok: true,
        logoUrl: uploaded.url,
        width: uploaded.width,
        height: uploaded.height,
        bytes: uploaded.bytes,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[settings/brand/logo POST] failed')
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

  // PSM.1 — primary marketplace. Read-only convenience endpoint so the
  // wizard's Step 1 can default-select without threading the field
  // through the wide initial-props chain. Returns null when no row
  // exists OR the column is unset; consumers fall back to no-default
  // behaviour rather than failing.
  fastify.get('/settings/primary-marketplace', async (_request, reply) => {
    try {
      const row = await (prisma as any).accountSettings.findFirst({
        select: { primaryMarketplace: true },
      })
      return { primaryMarketplace: row?.primaryMarketplace ?? null }
    } catch (error: any) {
      fastify.log.error(
        { err: error },
        '[settings/primary-marketplace GET] failed',
      )
      // Fail soft — wizard can survive without this signal.
      return { primaryMarketplace: null }
    }
  })
}

export default brandSettingsRoutes
