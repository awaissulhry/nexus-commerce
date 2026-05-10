/**
 * Phase 5.4: GTIN-exemption application CRUD + package generation.
 *
 *   GET  /api/gtin-exemption/check?brand=&marketplace=
 *      → { approved?: app, pending?: app, latest?: app }
 *
 *   POST /api/gtin-exemption
 *      → create or upsert a DRAFT for (brand, marketplace, productIds)
 *
 *   GET  /api/gtin-exemption/:id
 *      → full record + product summaries
 *
 *   PATCH /api/gtin-exemption/:id
 *      → update form fields, status transitions, etc.
 *
 *   POST /api/gtin-exemption/:id/validate-images
 *      → re-runs the image validator and stores the result
 *
 *   GET  /api/gtin-exemption/:id/brand-letter.pdf
 *      → on-the-fly PDF render of the (possibly customised) text
 *
 *   GET  /api/gtin-exemption/:id/package.zip
 *      → the full submission package — never stored, regenerated each
 *        download from the application's current state
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  generateBrandLetterText,
  renderBrandLetterPdf,
} from '../services/gtin-exemption/brand-letter.service.js'
import { validateImages } from '../services/gtin-exemption/image-validator.service.js'
import { buildPackageZip } from '../services/gtin-exemption/exemption-package.service.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'

// GTIN.2 — single instance for the SP-API inference call. Same
// pattern as routes/amazon.routes.ts; lifting this into a shared
// singleton is a separate refactor.
const amazonService = new AmazonService()

const ALLOWED_REGISTRATION_TYPES = new Set([
  'TRADEMARK',
  'BRAND_STAND_IN',
  'WEBSITE_ONLY',
])
const ALLOWED_STATUS = new Set([
  'DRAFT',
  'PACKAGE_READY',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'ABANDONED',
])

interface CreateBody {
  brandName?: string
  marketplace?: string
  productIds?: string[]
  brandRegistrationType?: string
  trademarkNumber?: string
  trademarkCountry?: string
  trademarkDate?: string
  brandWebsite?: string
}

interface CreateMultiBody extends Omit<CreateBody, 'marketplace'> {
  /** Marketplaces to fan out to. The same brand letter / image package
   *  / trademark info is cloned to one DRAFT per marketplace. */
  marketplaces?: string[]
}

interface PatchBody {
  brandRegistrationType?: string
  trademarkNumber?: string | null
  trademarkCountry?: string | null
  trademarkDate?: string | null
  trademarkCertUrl?: string | null
  brandWebsite?: string | null
  productIds?: string[]
  brandLetter?: string
  brandLetterCustomised?: boolean
  imagesProvided?: string[]
  status?: string
  amazonCaseId?: string | null
  rejectionReason?: string | null
}

const gtinExemptionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { brand?: string; marketplace?: string }
  }>('/gtin-exemption/check', async (request, reply) => {
    const { brand, marketplace } = request.query
    if (!brand || !marketplace) {
      return reply
        .code(400)
        .send({ error: 'brand and marketplace required' })
    }
    const approved = await prisma.gtinExemptionApplication.findFirst({
      where: { brandName: brand, marketplace, status: 'APPROVED' },
      orderBy: { approvedAt: 'desc' },
    })
    if (approved) {
      return { approved }
    }
    const pending = await prisma.gtinExemptionApplication.findFirst({
      where: {
        brandName: brand,
        marketplace,
        status: { in: ['SUBMITTED', 'PACKAGE_READY', 'DRAFT'] },
      },
      orderBy: { submittedAt: 'desc' },
    })
    if (pending) {
      return { pending }
    }
    // GTIN.2 — no local record; ask Amazon. If the seller has any
    // existing ACTIVE Amazon listing under this brand AND it has no
    // GTIN attribute on the SP-API response, the brand has GTIN
    // exemption (Amazon would have rejected the listing creation
    // otherwise). The wizard pre-selects "have-exemption" when
    // amazonInference.inferred === 'exempt'.
    let amazonInference:
      | {
          inferred: 'exempt' | 'not_exempt' | 'unknown'
          evidenceSku?: string
          evidenceAsin?: string
          reason: string
        }
      | undefined
    try {
      amazonInference = await amazonService.inferBrandGtinExemption(
        brand,
        marketplace,
      )
    } catch (err) {
      fastify.log.warn(
        { err, brand, marketplace },
        '[gtin-exemption/check] Amazon inference failed',
      )
      amazonInference = {
        inferred: 'unknown',
        reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      }
    }
    return { amazonInference }
  })

  fastify.post<{ Body: CreateBody }>(
    '/gtin-exemption',
    async (request, reply) => {
      const body = request.body ?? {}
      if (!body.brandName || !body.marketplace || !body.productIds?.length) {
        return reply.code(400).send({
          error: 'brandName, marketplace, productIds[] required',
        })
      }
      const regType = body.brandRegistrationType ?? 'TRADEMARK'
      if (!ALLOWED_REGISTRATION_TYPES.has(regType)) {
        return reply.code(400).send({
          error: `brandRegistrationType must be one of ${Array.from(
            ALLOWED_REGISTRATION_TYPES,
          ).join(', ')}`,
        })
      }
      // Reuse an existing DRAFT for the same (brand, marketplace) so
      // the user doesn't accidentally create duplicates by clicking
      // around. APPROVED / REJECTED / SUBMITTED are terminal.
      const existing = await prisma.gtinExemptionApplication.findFirst({
        where: {
          brandName: body.brandName,
          marketplace: body.marketplace,
          status: 'DRAFT',
        },
        orderBy: { createdAt: 'desc' },
      })
      const products = await prisma.product.findMany({
        where: { id: { in: body.productIds } },
        select: { id: true, sku: true, name: true, brand: true },
      })
      if (products.length === 0) {
        return reply
          .code(404)
          .send({ error: 'None of the productIds resolved to products' })
      }
      const productLines = products.map((p) => ({
        sku: p.sku,
        name: p.name,
      }))
      const account = await prisma.accountSettings
        .findFirst()
        .catch(() => null)
      const ownerName =
        (account as any)?.ownerName ??
        (account as any)?.businessName ??
        body.brandName
      const initialLetter = generateBrandLetterText({
        brandName: body.brandName,
        ownerName,
        companyName:
          (account as any)?.businessName ?? body.brandName,
        companyAddress:
          [
            (account as any)?.addressLine1,
            (account as any)?.addressLine2,
            (account as any)?.city,
            (account as any)?.state,
            (account as any)?.postalCode,
            (account as any)?.country,
          ]
            .filter(Boolean)
            .join(', ') || undefined,
        trademarkNumber: body.trademarkNumber,
        trademarkCountry: body.trademarkCountry,
        productLines,
        marketplace: body.marketplace,
      })
      const trademarkDate = body.trademarkDate
        ? new Date(body.trademarkDate)
        : null

      if (existing) {
        const updated = await prisma.gtinExemptionApplication.update({
          where: { id: existing.id },
          data: {
            productIds: body.productIds,
            brandRegistrationType: regType,
            trademarkNumber: body.trademarkNumber ?? existing.trademarkNumber,
            trademarkCountry:
              body.trademarkCountry ?? existing.trademarkCountry,
            trademarkDate: trademarkDate ?? existing.trademarkDate,
            brandWebsite: body.brandWebsite ?? existing.brandWebsite,
            // Don't blow away a customised letter on re-create.
            brandLetter: existing.brandLetterCustomised
              ? existing.brandLetter
              : initialLetter,
          },
        })
        return { application: updated }
      }
      const created = await prisma.gtinExemptionApplication.create({
        data: {
          brandName: body.brandName,
          productIds: body.productIds,
          marketplace: body.marketplace,
          brandRegistrationType: regType,
          trademarkNumber: body.trademarkNumber,
          trademarkCountry: body.trademarkCountry,
          trademarkDate,
          brandWebsite: body.brandWebsite,
          brandLetter: initialLetter,
          status: 'DRAFT',
        },
      })
      return { application: created }
    },
  )

  /**
   * POST /api/gtin-exemption/multi — fan out one application across N
   * marketplaces. TECH_DEBT #28 entry's "while we're there" note: the
   * brand letter, trademark info, image package, and product list are
   * all marketplace-agnostic — submitting to AMAZON IT/DE/FR/UK/ES one
   * at a time was forcing the operator through five wizard runs for
   * the same package.
   *
   * Per-marketplace DRAFT semantics are preserved so each application
   * still lifecycles independently (one might land APPROVED on IT
   * while DE bounces with REJECTED). The shared brand letter is
   * regenerated per-marketplace because the canned text references
   * the marketplace name.
   *
   * Reuse rule: if a DRAFT exists for (brandName, marketplace), it's
   * upserted (matches the single-create path's behaviour). The
   * response carries `created` and `updated` arrays so the operator's
   * wizard can show "3 created, 2 already had drafts."
   */
  fastify.post<{ Body: CreateMultiBody }>(
    '/gtin-exemption/multi',
    async (request, reply) => {
      const body = request.body ?? {}
      if (
        !body.brandName ||
        !Array.isArray(body.marketplaces) ||
        body.marketplaces.length === 0 ||
        !body.productIds?.length
      ) {
        return reply.code(400).send({
          error: 'brandName, marketplaces[], productIds[] required',
        })
      }
      const regType = body.brandRegistrationType ?? 'TRADEMARK'
      if (!ALLOWED_REGISTRATION_TYPES.has(regType)) {
        return reply.code(400).send({
          error: `brandRegistrationType must be one of ${Array.from(
            ALLOWED_REGISTRATION_TYPES,
          ).join(', ')}`,
        })
      }
      const products = await prisma.product.findMany({
        where: { id: { in: body.productIds } },
        select: { id: true, sku: true, name: true, brand: true },
      })
      if (products.length === 0) {
        return reply
          .code(404)
          .send({ error: 'None of the productIds resolved to products' })
      }
      const productLines = products.map((p) => ({ sku: p.sku, name: p.name }))
      const account = await prisma.accountSettings.findFirst().catch(() => null)
      const ownerName =
        (account as any)?.ownerName ??
        (account as any)?.businessName ??
        body.brandName
      const companyName = (account as any)?.businessName ?? body.brandName
      const companyAddress =
        [
          (account as any)?.addressLine1,
          (account as any)?.addressLine2,
          (account as any)?.city,
          (account as any)?.state,
          (account as any)?.postalCode,
          (account as any)?.country,
        ]
          .filter(Boolean)
          .join(', ') || undefined
      const trademarkDate = body.trademarkDate
        ? new Date(body.trademarkDate)
        : null

      const created: any[] = []
      const updated: any[] = []
      const failed: Array<{ marketplace: string; error: string }> = []

      // De-dupe + uppercase the marketplace list. Operator might send
      // 'IT' twice or 'it' / 'IT' mixed; we treat them all as the same.
      const marketplaces = Array.from(
        new Set(
          body.marketplaces
            .map((m) => String(m).trim().toUpperCase())
            .filter(Boolean),
        ),
      )

      for (const marketplace of marketplaces) {
        try {
          const initialLetter = generateBrandLetterText({
            brandName: body.brandName,
            ownerName,
            companyName,
            companyAddress,
            trademarkNumber: body.trademarkNumber,
            trademarkCountry: body.trademarkCountry,
            productLines,
            marketplace,
          })
          const existing = await prisma.gtinExemptionApplication.findFirst({
            where: { brandName: body.brandName, marketplace, status: 'DRAFT' },
            orderBy: { createdAt: 'desc' },
          })
          if (existing) {
            const u = await prisma.gtinExemptionApplication.update({
              where: { id: existing.id },
              data: {
                productIds: body.productIds,
                brandRegistrationType: regType,
                trademarkNumber: body.trademarkNumber ?? existing.trademarkNumber,
                trademarkCountry: body.trademarkCountry ?? existing.trademarkCountry,
                trademarkDate: trademarkDate ?? existing.trademarkDate,
                brandWebsite: body.brandWebsite ?? existing.brandWebsite,
                brandLetter: existing.brandLetterCustomised
                  ? existing.brandLetter
                  : initialLetter,
              },
            })
            updated.push(u)
          } else {
            const c = await prisma.gtinExemptionApplication.create({
              data: {
                brandName: body.brandName,
                productIds: body.productIds,
                marketplace,
                brandRegistrationType: regType,
                trademarkNumber: body.trademarkNumber,
                trademarkCountry: body.trademarkCountry,
                trademarkDate,
                brandWebsite: body.brandWebsite,
                brandLetter: initialLetter,
                status: 'DRAFT',
              },
            })
            created.push(c)
          }
        } catch (err) {
          failed.push({
            marketplace,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      return {
        created,
        updated,
        failed,
        summary: {
          createdCount: created.length,
          updatedCount: updated.length,
          failedCount: failed.length,
          totalRequested: marketplaces.length,
        },
      }
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/gtin-exemption/:id',
    async (request, reply) => {
      const app = await prisma.gtinExemptionApplication.findUnique({
        where: { id: request.params.id },
      })
      if (!app) return reply.code(404).send({ error: 'Not found' })
      const products = await prisma.product.findMany({
        where: { id: { in: app.productIds } },
        select: { id: true, sku: true, name: true },
      })
      return { application: app, products }
    },
  )

  fastify.patch<{ Params: { id: string }; Body: PatchBody }>(
    '/gtin-exemption/:id',
    async (request, reply) => {
      const id = request.params.id
      const body = request.body ?? {}
      const existing = await prisma.gtinExemptionApplication.findUnique({
        where: { id },
      })
      if (!existing) return reply.code(404).send({ error: 'Not found' })
      if (
        body.brandRegistrationType &&
        !ALLOWED_REGISTRATION_TYPES.has(body.brandRegistrationType)
      ) {
        return reply
          .code(400)
          .send({ error: 'Invalid brandRegistrationType' })
      }
      if (body.status && !ALLOWED_STATUS.has(body.status)) {
        return reply.code(400).send({ error: 'Invalid status' })
      }
      // Status-transition stamping. The approvedAt / rejectedAt /
      // submittedAt timestamps are user-driven (no Amazon API to
      // confirm), but we always stamp them at the moment of the
      // status flip so downstream queries (the brand cache) work.
      const now = new Date()
      const data: any = {
        ...body,
      }
      if (body.trademarkDate !== undefined) {
        data.trademarkDate = body.trademarkDate
          ? new Date(body.trademarkDate)
          : null
      }
      if (body.status === 'SUBMITTED' && existing.status !== 'SUBMITTED') {
        data.submittedAt = now
      }
      if (body.status === 'APPROVED' && existing.status !== 'APPROVED') {
        data.approvedAt = now
      }
      if (body.status === 'REJECTED' && existing.status !== 'REJECTED') {
        data.rejectedAt = now
      }
      const updated = await prisma.gtinExemptionApplication.update({
        where: { id },
        data,
      })
      return { application: updated }
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/gtin-exemption/:id/validate-images',
    async (request, reply) => {
      const app = await prisma.gtinExemptionApplication.findUnique({
        where: { id: request.params.id },
      })
      if (!app) return reply.code(404).send({ error: 'Not found' })
      // Pull the current product images each time so re-validation
      // picks up newly-added images on the master product.
      const products = await prisma.product.findMany({
        where: { id: { in: app.productIds } },
        select: { id: true, images: { select: { url: true } } },
      })
      const urls = products.flatMap((p) => p.images.map((i) => i.url))
      const unique = Array.from(new Set(urls))
      const result = await validateImages(unique)
      const next = await prisma.gtinExemptionApplication.update({
        where: { id: app.id },
        data: {
          imagesProvided: unique,
          imageValidation: result as any,
        },
      })
      return { application: next, validation: result }
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/gtin-exemption/:id/brand-letter.pdf',
    async (request, reply) => {
      const app = await prisma.gtinExemptionApplication.findUnique({
        where: { id: request.params.id },
      })
      if (!app) return reply.code(404).send({ error: 'Not found' })
      const pdf = await renderBrandLetterPdf(app.brandLetter)
      reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `attachment; filename="brand-letter-${app.brandName.replace(
            /[^a-z0-9-_]/gi,
            '-',
          )}.pdf"`,
        )
      return reply.send(pdf)
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/gtin-exemption/:id/package.zip',
    async (request, reply) => {
      const app = await prisma.gtinExemptionApplication.findUnique({
        where: { id: request.params.id },
      })
      if (!app) return reply.code(404).send({ error: 'Not found' })
      const products = await prisma.product.findMany({
        where: { id: { in: app.productIds } },
        select: { id: true, sku: true, name: true },
      })
      const account = await prisma.accountSettings
        .findFirst()
        .catch(() => null)
      const ownerName =
        (account as any)?.ownerName ??
        (account as any)?.businessName ??
        app.brandName
      const productLines = products.map((p) => ({
        sku: p.sku,
        name: p.name,
      }))
      const buf = await buildPackageZip({
        applicationId: app.id,
        brandName: app.brandName,
        marketplace: app.marketplace,
        brandRegistrationType: app.brandRegistrationType,
        trademarkNumber: app.trademarkNumber,
        trademarkCountry: app.trademarkCountry,
        trademarkDate: app.trademarkDate,
        brandWebsite: app.brandWebsite,
        imageUrls: app.imagesProvided,
        ownerName,
        companyName:
          (account as any)?.businessName ?? app.brandName,
        productLines,
        brandLetterOverride: app.brandLetterCustomised
          ? app.brandLetter
          : undefined,
      })
      // Mark as PACKAGE_READY the first time the user downloads.
      if (app.status === 'DRAFT') {
        await prisma.gtinExemptionApplication.update({
          where: { id: app.id },
          data: {
            status: 'PACKAGE_READY',
            packageGeneratedAt: new Date(),
          },
        })
      }
      reply
        .header('Content-Type', 'application/zip')
        .header(
          'Content-Disposition',
          `attachment; filename="gtin-exemption-${app.brandName.replace(
            /[^a-z0-9-_]/gi,
            '-',
          )}.zip"`,
        )
      return reply.send(buf)
    },
  )
}

export default gtinExemptionRoutes
