/**
 * Phase 5.3: ListingWizard CRUD.
 *
 *   POST /api/listing-wizard/start   — find-or-create by
 *                                       (productId, channel, marketplace)
 *   GET  /api/listing-wizard/:id     — read one wizard
 *   PATCH /api/listing-wizard/:id    — partial state merge + step
 *                                       advance
 *   POST /api/listing-wizard/:id/submit — placeholder, returns 501
 *                                          until Phase 6 wires the
 *                                          channel push.
 *
 * The state column is a free-form JSONB blob. Callers PATCH partial
 * objects and the merge layer here preserves keys that aren't in the
 * patch (so Step 1 doesn't blow away Step 6's draft etc.).
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { CategorySchemaService } from '../services/categories/schema-sync.service.js'
import {
  ProductTypesService,
  type ProductTypeListItem,
} from '../services/listing-wizard/product-types.service.js'
import { SchemaParserService } from '../services/listing-wizard/schema-parser.service.js'
import { VariationsService } from '../services/listing-wizard/variations.service.js'

const amazonService = new AmazonService()
const categorySchemaService = new CategorySchemaService(
  prisma as any,
  amazonService,
)
const productTypesService = new ProductTypesService(
  prisma as any,
  amazonService,
  categorySchemaService,
)
const schemaParserService = new SchemaParserService(
  prisma as any,
  categorySchemaService,
)
const variationsService = new VariationsService(prisma as any)

interface StartBody {
  productId?: string
  channel?: string
  marketplace?: string
}

interface PatchBody {
  currentStep?: number
  state?: Record<string, unknown>
  status?: string
}

const VALID_CHANNELS = new Set([
  'AMAZON',
  'EBAY',
  'SHOPIFY',
  'WOOCOMMERCE',
])

const listingWizardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: StartBody }>(
    '/listing-wizard/start',
    async (request, reply) => {
      const { productId, channel, marketplace } = request.body ?? {}
      if (!productId || !channel || !marketplace) {
        return reply.code(400).send({
          error: 'productId, channel, and marketplace are all required',
        })
      }
      if (!VALID_CHANNELS.has(channel)) {
        return reply
          .code(400)
          .send({ error: `Unsupported channel: ${channel}` })
      }
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          sku: true,
          name: true,
          isParent: true,
          brand: true,
          upc: true,
          ean: true,
          gtin: true,
        },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }
      // Find an existing DRAFT wizard for this combo so the user can
      // resume; SUBMITTED/LIVE/FAILED wizards are terminal and a new
      // one starts fresh.
      let wizard = await prisma.listingWizard.findFirst({
        where: {
          productId,
          channel,
          marketplace,
          status: 'DRAFT',
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!wizard) {
        wizard = await prisma.listingWizard.create({
          data: {
            productId,
            channel,
            marketplace,
            currentStep: 1,
            state: {},
            status: 'DRAFT',
          },
        })
      }
      return { wizard, product }
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: {
          id: true,
          sku: true,
          name: true,
          isParent: true,
          brand: true,
          upc: true,
          ean: true,
          gtin: true,
        },
      })
      return { wizard, product }
    },
  )

  fastify.patch<{ Params: { id: string }; Body: PatchBody }>(
    '/listing-wizard/:id',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      if (wizard.status !== 'DRAFT') {
        return reply
          .code(409)
          .send({ error: `Wizard is ${wizard.status.toLowerCase()}` })
      }
      const body = request.body ?? {}
      const merged = {
        ...((wizard.state as Record<string, unknown> | null) ?? {}),
        ...((body.state ?? {}) as Record<string, unknown>),
      }
      const next = await prisma.listingWizard.update({
        where: { id: wizard.id },
        data: {
          currentStep:
            typeof body.currentStep === 'number'
              ? Math.min(Math.max(body.currentStep, 1), 10)
              : wizard.currentStep,
          state: merged as any,
        },
      })
      return { wizard: next }
    },
  )

  // ── Step 3 — Product Type picker ──────────────────────────────
  // GET /api/listing-wizard/product-types?channel=AMAZON&marketplace=IT&search=jacket
  //
  // Returns a candidate list. Live SP-API results when configured;
  // bundled fallback otherwise so the picker works pre-keys.
  fastify.get('/listing-wizard/product-types', async (request, reply) => {
    const q = request.query as {
      channel?: string
      marketplace?: string
      search?: string
    }
    if (!q.channel) {
      return reply.code(400).send({ error: 'channel is required' })
    }
    try {
      const items = await productTypesService.listProductTypes({
        channel: q.channel,
        marketplace: q.marketplace ?? null,
        search: q.search,
      })
      return { items, count: items.length }
    } catch (err) {
      fastify.log.error({ err }, '[listing-wizard] product-types failed')
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // POST /api/listing-wizard/:id/suggest-product-types
  // Body: { candidates: ProductTypeListItem[] }
  //
  // Returns ranked suggestions. Falls back to rule-based ranking when
  // GEMINI_API_KEY is unset, never blocking — the manual picker stays
  // usable.
  fastify.post<{
    Params: { id: string }
    Body: { candidates?: ProductTypeListItem[] }
  }>(
    '/listing-wizard/:id/suggest-product-types',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: {
          id: true,
          name: true,
          brand: true,
          productType: true,
          description: true,
        },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }
      const candidates = Array.isArray(request.body?.candidates)
        ? request.body!.candidates
        : []
      try {
        const result = await productTypesService.suggestProductTypes(
          {
            productId: product.id,
            name: product.name,
            brand: product.brand,
            productType: product.productType,
            description: product.description,
          },
          candidates,
        )
        return result
      } catch (err) {
        fastify.log.error(
          { err },
          '[listing-wizard] suggest-product-types failed',
        )
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  // POST /api/listing-wizard/:id/prefetch-schema
  // Body: { productType: string }
  //
  // Fire-and-forget warm of the CategorySchema cache so Step 4 lands
  // instantly. Returns { ok, reason? } so the UI can know whether the
  // warm worked but doesn't block.
  fastify.post<{
    Params: { id: string }
    Body: { productType?: string }
  }>(
    '/listing-wizard/:id/prefetch-schema',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const productType = request.body?.productType?.trim()
      if (!productType) {
        return reply.code(400).send({ error: 'productType is required' })
      }
      const result = await productTypesService.prefetchSchema({
        channel: wizard.channel,
        marketplace: wizard.marketplace,
        productType,
      })
      return result
    },
  )

  // ── Step 4 — Required Attributes ──────────────────────────────
  // GET /api/listing-wizard/:id/required-fields
  //
  // Returns a flat field manifest for the productType selected in
  // Step 3. Smart defaults are sourced from the master product so the
  // user can confirm rather than re-type. Unsupported field shapes
  // are surfaced as kind='unsupported' so the UI can degrade
  // gracefully without crashing on exotic schema corners.
  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id/required-fields',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const state = (wizard.state ?? {}) as Record<string, any>
      const productType = state?.productType?.productType
      if (typeof productType !== 'string' || productType.length === 0) {
        return reply.code(409).send({
          error:
            'Pick a product type in Step 3 first — required-fields needs a productType to render.',
        })
      }
      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: {
          name: true,
          brand: true,
          description: true,
          productType: true,
        },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }
      try {
        const manifest = await schemaParserService.getRequiredFields({
          channel: wizard.channel,
          marketplace: wizard.marketplace,
          productType,
          product: {
            name: product.name,
            brand: product.brand,
            description: product.description,
            productType: product.productType,
          },
        })
        return manifest
      } catch (err) {
        fastify.log.error(
          { err },
          '[listing-wizard] required-fields failed',
        )
        const msg = err instanceof Error ? err.message : String(err)
        const isAuth = /SP-API not configured|credentials|auth/i.test(msg)
        return reply.code(isAuth ? 503 : 500).send({ error: msg })
      }
    },
  )

  // ── Step 5 — Variations ───────────────────────────────────────
  // GET /api/listing-wizard/:id/variations?theme=SIZE_COLOR
  //
  // Returns the children of the master product plus the available
  // variation themes pulled from the cached CategorySchema. When a
  // theme is passed, each child is annotated with which required
  // attributes it's missing so the UI can flag incomplete rows.
  fastify.get<{ Params: { id: string }; Querystring: { theme?: string } }>(
    '/listing-wizard/:id/variations',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const state = (wizard.state ?? {}) as Record<string, any>
      const productType = state?.productType?.productType
      let cachedThemes: unknown = null
      if (typeof productType === 'string' && productType.length > 0) {
        const schema = await prisma.categorySchema.findFirst({
          where: {
            channel: wizard.channel,
            marketplace: wizard.marketplace,
            productType,
            isActive: true,
          },
          orderBy: { fetchedAt: 'desc' },
          select: { variationThemes: true },
        })
        cachedThemes = schema?.variationThemes ?? null
      }
      try {
        const payload = await variationsService.getVariationsPayload({
          productId: wizard.productId,
          selectedTheme: request.query?.theme ?? null,
          cachedThemes,
        })
        return payload
      } catch (err) {
        fastify.log.error(
          { err },
          '[listing-wizard] variations failed',
        )
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  // ── Step 7 — Images ──────────────────────────────────────────
  // GET /api/listing-wizard/:id/images
  //
  // Returns the master product's image rows in display order (MAIN
  // first). The frontend reorders + filters in-place; the saved
  // ordering lives in wizardState.images.orderedUrls.
  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id/images',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const rows = await prisma.productImage.findMany({
        where: { productId: wizard.productId },
        orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, url: true, alt: true, type: true },
      })
      // Sort MAIN to the front; alphabetical orderBy gets us close
      // (ALT < LIFESTYLE < MAIN < SWATCH) but we want MAIN first.
      const main = rows.filter((r) => r.type === 'MAIN')
      const rest = rows.filter((r) => r.type !== 'MAIN')
      return { images: [...main, ...rest] }
    },
  )

  // ── Step 8 — Pricing ─────────────────────────────────────────
  // GET /api/listing-wizard/:id/pricing-context
  //
  // Returns the product's basePrice + costPrice, plus default
  // marketplace fee assumptions for the wizard's channel. The
  // frontend uses these to seed the calculator without re-fetching
  // the master product.
  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id/pricing-context',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: {
          basePrice: true,
          costPrice: true,
          minPrice: true,
          maxPrice: true,
          buyBoxPrice: true,
          competitorPrice: true,
        },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }
      const currency = currencyForMarketplace(wizard.marketplace)
      const fees = defaultFeesForChannel(wizard.channel)
      return {
        currency,
        product: {
          basePrice: Number(product.basePrice),
          costPrice: product.costPrice ? Number(product.costPrice) : null,
          minPrice: product.minPrice ? Number(product.minPrice) : null,
          maxPrice: product.maxPrice ? Number(product.maxPrice) : null,
          buyBoxPrice: product.buyBoxPrice
            ? Number(product.buyBoxPrice)
            : null,
          competitorPrice: product.competitorPrice
            ? Number(product.competitorPrice)
            : null,
        },
        fees,
      }
    },
  )

  // Phase 5.3 ships the route stub so the client can wire its
  // submit button without a 404. The actual SP-API push lands in
  // Phase 6 after the per-step content is filled in.
  fastify.post<{ Params: { id: string } }>(
    '/listing-wizard/:id/submit',
    async (_request, reply) => {
      return reply.code(501).send({
        error:
          'Submit is not yet implemented — the channel push lands in Phase 6 once the per-step data is collected.',
      })
    },
  )
}

// ── pricing helpers ────────────────────────────────────────────

function currencyForMarketplace(marketplace: string): string {
  const upper = marketplace.toUpperCase()
  if (upper === 'US' || upper === 'CA' || upper === 'MX') return 'USD'
  if (upper === 'UK' || upper === 'GB') return 'GBP'
  if (upper === 'JP') return 'JPY'
  if (upper === 'AU') return 'AUD'
  // EU marketplaces (IT, DE, FR, ES, NL, BE, SE, PL) all use EUR
  // when listing on Amazon.
  return 'EUR'
}

function defaultFeesForChannel(channel: string): {
  referralPercent: number
  fulfillmentFee: number
  notes: string
} {
  const ch = channel.toUpperCase()
  if (ch === 'AMAZON') {
    // 15% is the modal Amazon referral fee for clothing/accessories;
    // categories like electronics are 8%, jewelry 20%. Surfaced as a
    // default the user can override per listing.
    return {
      referralPercent: 15,
      fulfillmentFee: 3.5,
      notes:
        'Amazon clothing/accessories default — 15% referral, ~€3.50 FBA. Override per category as needed.',
    }
  }
  if (ch === 'SHOPIFY') {
    return {
      referralPercent: 0,
      fulfillmentFee: 0,
      notes: 'Shopify takes payment-processing fees, not referral fees.',
    }
  }
  if (ch === 'EBAY') {
    return {
      referralPercent: 12.9,
      fulfillmentFee: 0.3,
      notes: 'eBay default — 12.9% final value fee + 30c per order.',
    }
  }
  return {
    referralPercent: 10,
    fulfillmentFee: 0,
    notes: 'Generic default. Override per channel.',
  }
}

export default listingWizardRoutes
