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
import { writeSettingsAudit } from '../utils/settings-audit.js'
import {
  brandSnapshot,
  ensureBrandSettings,
  readPrimaryMarketplace,
  saveBrandSettings,
  type BrandSettingsInput,
} from '../services/settings/brand-settings.service.js'

const brandSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/settings/brand', async (_request, reply) => {
    try {
      // MCP full control P3: read (and created when missing) by services/settings/brand-settings.service.ts.
      return await ensureBrandSettings()
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
      const before = row
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

      // Logo upload is technically a single-field change on the
      // company row, so we audit-log it under the same 'company' key
      // — operators will see "logoUrl changed" in the history.
      await writeSettingsAudit({
        key: 'company',
        action: before ? 'update' : 'create',
        before: brandSnapshot(before as any),
        after: brandSnapshot(row as any),
        metadata: {
          event: 'logo_uploaded',
          width: uploaded.width,
          height: uploaded.height,
          bytes: uploaded.bytes,
        },
      })

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
      // MCP full control P10: sanitized, checked and saved by services/settings/brand-settings.service.ts, the same
      // code Claude's set-business-settings saves through.
      const saved = await saveBrandSettings((request.body ?? {}) as BrandSettingsInput)
      if ('fieldErrors' in saved) {
        return reply.code(400).send({
          error: 'Validation failed',
          fieldErrors: saved.fieldErrors,
        })
      }
      return saved.row
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
      return { primaryMarketplace: await readPrimaryMarketplace() }
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
