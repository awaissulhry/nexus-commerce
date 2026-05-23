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
  validatePiva,
  validateCodiceFiscale,
  validateSdi,
  validatePec,
  validateInvoicingRouting,
  isVatScheme,
} from '../lib/italian-fiscal.js'

const BRAND_SNAPSHOT_FIELDS = [
  'companyName',
  'addressLines',
  'taxId',
  'contactEmail',
  'contactPhone',
  'websiteUrl',
  'logoUrl',
  'signatureBlockText',
  'defaultPoNotes',
  'factoryEmailFrom',
  'piva',
  'codiceFiscale',
  'sdiCode',
  'pecEmail',
  'vatScheme',
] as const

function brandSnapshot(
  row: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const k of BRAND_SNAPSHOT_FIELDS) out[k] = row[k] ?? null
  return out
}

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
        // Phase D — Italian fiscal fields.
        piva?: string | null
        codiceFiscale?: string | null
        sdiCode?: string | null
        pecEmail?: string | null
        vatScheme?: string | null
        // PO.7 — purchase-order approval ladder.
        requireApprovalForPo?: boolean
        poApprovalThresholdCents?: number | null
        poApprovalApproverEmail?: string | null
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
        // Phase D additions — same trim/normalize treatment as other
        // string columns; specific validation happens below.
        'piva',
        'codiceFiscale',
        'sdiCode',
        'pecEmail',
        'vatScheme',
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

      // PO.7 — approval ladder fields, written through with the same
      // null-out-on-empty contract used by the string columns above.
      if ('requireApprovalForPo' in body) {
        update.requireApprovalForPo = !!body.requireApprovalForPo
      }
      if ('poApprovalThresholdCents' in body) {
        const v = body.poApprovalThresholdCents
        update.poApprovalThresholdCents =
          v == null ? null : Math.max(0, Math.round(Number(v)))
      }
      if ('poApprovalApproverEmail' in body) {
        const v = body.poApprovalApproverEmail
        update.poApprovalApproverEmail =
          v == null || v === '' ? null : String(v).trim().toLowerCase()
      }

      // Phase D — strict fiscal validation. Per the operator's
      // explicit choice (AskUserQuestion in the rebuild plan), bad
      // checksums reject the save outright. Per-field errors so the
      // UI can highlight exactly what's wrong instead of a
      // generic "save failed" toast.
      const fieldErrors: Record<string, string> = {}
      // Tiny helper: discriminated-union narrowing on `r.valid` via
      // !r.valid was flaky under TS 5's inference here, so we
      // narrow via `if (r.valid === false)` which always works.
      const check = (
        field: string,
        r: { valid: true } | { valid: false; reason: string },
      ) => {
        if (r.valid === false) fieldErrors[field] = r.reason
      }
      if (typeof update.piva === 'string' && update.piva) {
        check('piva', validatePiva(update.piva))
      }
      if (typeof update.codiceFiscale === 'string' && update.codiceFiscale) {
        check('codiceFiscale', validateCodiceFiscale(update.codiceFiscale))
      }
      if (typeof update.sdiCode === 'string' && update.sdiCode) {
        check('sdiCode', validateSdi(update.sdiCode))
      }
      if (typeof update.pecEmail === 'string' && update.pecEmail) {
        check('pecEmail', validatePec(update.pecEmail))
      }
      if (update.vatScheme != null && !isVatScheme(update.vatScheme)) {
        fieldErrors.vatScheme =
          'VAT scheme must be one of: ORDINARIO, FORFETTARIO, OSS, IOSS, ESENTE.'
      }
      // SDI-OR-PEC routing check: only fires when the operator
      // provides a P.IVA (or when one already exists on the row and
      // they're updating other fiscal data).
      const existing = await prisma.brandSettings.findFirst()
      const effectivePiva =
        (typeof update.piva === 'string' ? update.piva : existing?.piva) ?? ''
      const effectiveSdi =
        (typeof update.sdiCode === 'string' ? update.sdiCode : existing?.sdiCode) ?? ''
      const effectivePec =
        (typeof update.pecEmail === 'string' ? update.pecEmail : existing?.pecEmail) ?? ''
      if (effectivePiva && (typeof update.piva === 'string' || typeof update.sdiCode === 'string' || typeof update.pecEmail === 'string')) {
        check('routing', validateInvoicingRouting({
          piva: effectivePiva,
          sdiCode: effectiveSdi,
          pecEmail: effectivePec,
        }))
      }
      // Uppercase normalisation for two fields where the spec is
      // case-insensitive but downstream parsers expect uppercase.
      if (typeof update.sdiCode === 'string' && update.sdiCode) {
        update.sdiCode = update.sdiCode.toUpperCase()
      }
      if (typeof update.codiceFiscale === 'string' && update.codiceFiscale) {
        update.codiceFiscale = update.codiceFiscale.toUpperCase()
      }
      if (Object.keys(fieldErrors).length > 0) {
        return reply.code(400).send({
          error: 'Validation failed',
          fieldErrors,
        })
      }

      // Single-row upsert: read-then-update keeps the contract simple.
      // We already fetched `existing` above for the routing check;
      // reuse it instead of doing a second read.
      let row = existing
      const before = row
      if (!row) {
        row = await prisma.brandSettings.create({ data: update })
      } else {
        row = await prisma.brandSettings.update({
          where: { id: row.id },
          data: update,
        })
      }
      // Phase B — settings change history. Use the canonical helper so
      // /settings/audit surfaces these alongside web-action saves.
      await writeSettingsAudit({
        key: 'company',
        action: before ? 'update' : 'create',
        before: brandSnapshot(before as any),
        after: brandSnapshot(row as any),
      })
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
