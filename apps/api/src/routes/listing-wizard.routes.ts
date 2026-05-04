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
import { SubmissionService } from '../services/listing-wizard/submission.service.js'
import {
  channelsHash,
  legacyFirstChannel,
  normalizeChannels,
} from '../services/listing-wizard/channels.js'

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
const submissionService = new SubmissionService(prisma as any)

interface StartBody {
  productId?: string
  // New multi-channel signature.
  channels?: Array<{ platform?: string; marketplace?: string }>
  // Legacy single-channel signature; auto-wrapped into channels[]
  // on the way through. Kept for the existing /products/:id/edit
  // entry point and old deep-links.
  channel?: string
  marketplace?: string
}

interface MarketplaceOption {
  code: string
  label: string
}

interface PlatformStatus {
  platform: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE'
  connected: boolean
  reason?: 'not_implemented' | 'no_credentials' | 'inactive' | 'error'
  marketplaces: MarketplaceOption[]
}

const AMAZON_MARKETPLACES: MarketplaceOption[] = [
  { code: 'IT', label: 'Italy' },
  { code: 'DE', label: 'Germany' },
  { code: 'FR', label: 'France' },
  { code: 'ES', label: 'Spain' },
  { code: 'UK', label: 'United Kingdom' },
  { code: 'US', label: 'United States' },
  { code: 'CA', label: 'Canada' },
  { code: 'MX', label: 'Mexico' },
]

const EBAY_MARKETPLACES: MarketplaceOption[] = [
  { code: 'IT', label: 'Italy' },
  { code: 'DE', label: 'Germany' },
  { code: 'FR', label: 'France' },
  { code: 'ES', label: 'Spain' },
  { code: 'UK', label: 'United Kingdom' },
  { code: 'US', label: 'United States' },
]

interface PatchBody {
  currentStep?: number
  state?: Record<string, unknown>
  // Per-channel overrides keyed by "PLATFORM:MARKET". PATCHed slices
  // are shallow-merged with existing channelStates, same pattern as
  // `state`.
  channelStates?: Record<string, Record<string, unknown>>
  // Phase B: Step 1 (Channels & Markets) writes the final channels
  // selection here. The handler recomputes channelsHash from the
  // submitted array.
  channels?: Array<{ platform?: string; marketplace?: string }>
  status?: string
}

const VALID_CHANNELS = new Set([
  'AMAZON',
  'EBAY',
  'SHOPIFY',
  'WOOCOMMERCE',
])

const listingWizardRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Phase B — Step 1 connection-status surface ────────────────
  // GET /api/listing-wizard/connection-status
  //
  // Single endpoint the new Step 1 (Channels & Markets) consults to
  // know which platforms are usable + which marketplaces are valid
  // per platform. Honest about state: Amazon = env-var driven, eBay =
  // ChannelConnection.isActive, Shopify/Woo = not_implemented.
  fastify.get('/listing-wizard/connection-status', async (_request, reply) => {
    try {
      // Amazon: configured if any of the SP-API credential env vars
      // are set. Use the same "isConfigured" check the AmazonService
      // does internally so this stays in sync.
      const amazonConnected = amazonService.isConfigured()

      // eBay: any active ChannelConnection of channelType=EBAY counts.
      const ebayActive = await prisma.channelConnection.count({
        where: { channelType: 'EBAY', isActive: true },
      })
      const ebayConnected = ebayActive > 0

      const platforms: PlatformStatus[] = [
        {
          platform: 'AMAZON',
          connected: amazonConnected,
          reason: amazonConnected ? undefined : 'no_credentials',
          marketplaces: AMAZON_MARKETPLACES,
        },
        {
          platform: 'EBAY',
          connected: ebayConnected,
          reason: ebayConnected ? undefined : 'inactive',
          marketplaces: EBAY_MARKETPLACES,
        },
        {
          platform: 'SHOPIFY',
          connected: false,
          reason: 'not_implemented',
          marketplaces: [{ code: 'GLOBAL', label: 'Shopify Store' }],
        },
        {
          platform: 'WOOCOMMERCE',
          connected: false,
          reason: 'not_implemented',
          marketplaces: [{ code: 'GLOBAL', label: 'WooCommerce Store' }],
        },
      ]
      return { platforms }
    } catch (err) {
      fastify.log.error(
        { err },
        '[listing-wizard] connection-status failed',
      )
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  fastify.post<{ Body: StartBody }>(
    '/listing-wizard/start',
    async (request, reply) => {
      const body = request.body ?? {}
      if (!body.productId) {
        return reply.code(400).send({ error: 'productId is required' })
      }

      // Multi-channel input (Phase B canonical form): { productId,
      // channels: [{platform, marketplace}, ...] }.
      // Legacy input (kept for /products/:id/edit deep-links and old
      // bookmarks): { productId, channel, marketplace } — we wrap
      // into a single-entry channels[] array.
      let inputChannels: Array<{ platform?: string; marketplace?: string }>
      if (Array.isArray(body.channels)) {
        inputChannels = body.channels
      } else if (body.channel && body.marketplace) {
        inputChannels = [
          { platform: body.channel, marketplace: body.marketplace },
        ]
      } else {
        // No channels at all — caller can pick them in Step 1. We
        // start the draft with an empty channels array; the wizard
        // refuses to advance past Step 1 until at least one is
        // selected. This is the path the new "List on channels"
        // entry from /products/:id/edit will use.
        inputChannels = []
      }

      const channels = normalizeChannels(inputChannels)
      // Validate platforms when any were passed in.
      for (const c of channels) {
        if (!VALID_CHANNELS.has(c.platform)) {
          return reply
            .code(400)
            .send({ error: `Unsupported platform: ${c.platform}` })
        }
      }

      const product = await prisma.product.findUnique({
        where: { id: body.productId },
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

      const hash = channelsHash(channels)

      // Find an existing DRAFT wizard for this exact channels-set so
      // the user can resume; SUBMITTED/LIVE/FAILED wizards are terminal
      // and a new one starts fresh.
      let wizard = await prisma.listingWizard.findFirst({
        where: {
          productId: body.productId,
          channelsHash: hash,
          status: 'DRAFT',
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!wizard) {
        wizard = await prisma.listingWizard.create({
          data: {
            productId: body.productId,
            channels: channels as any,
            channelsHash: hash,
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
      // channelStates merge — outer keys (channel keys) shallow-merge,
      // inner slices replace wholesale (caller is expected to spread
      // their existing slice if they want to merge inside).
      const mergedChannelStates: Record<string, Record<string, unknown>> = {
        ...((wizard.channelStates as Record<string, Record<string, unknown>> | null) ??
          {}),
        ...((body.channelStates ?? {}) as Record<
          string,
          Record<string, unknown>
        >),
      }

      // Phase B: Step 1 writes the channels selection here. We
      // recompute channelsHash so the resume key stays consistent.
      // PATCHing channels is only allowed while the wizard is in
      // DRAFT (already gated above).
      let channelsUpdate:
        | { channels: any; channelsHash: string }
        | null = null
      if (Array.isArray(body.channels)) {
        const next = normalizeChannels(body.channels)
        for (const c of next) {
          if (!VALID_CHANNELS.has(c.platform)) {
            return reply
              .code(400)
              .send({ error: `Unsupported platform: ${c.platform}` })
          }
        }
        channelsUpdate = {
          channels: next as any,
          channelsHash: channelsHash(next),
        }
      }

      const next = await prisma.listingWizard.update({
        where: { id: wizard.id },
        data: {
          currentStep:
            typeof body.currentStep === 'number'
              ? Math.min(Math.max(body.currentStep, 1), 11)
              : wizard.currentStep,
          state: merged as any,
          channelStates: mergedChannelStates as any,
          ...(channelsUpdate ?? {}),
        },
      })
      return { wizard: next }
    },
  )

  // ── Phase C — Conditional GTIN exemption ──────────────────────
  // GET /api/listing-wizard/:id/gtin-status
  //
  // Surfaces whether Step 4 (GTIN exemption) needs to render or can
  // be auto-skipped. Resolution order:
  //   1. Product already has any GTIN identifier (gtin / upc / ean)
  //      → not needed (`has_gtin`).
  //   2. An APPROVED GtinExemptionApplication exists for this
  //      (brand, marketplace) — Amazon grants exemptions at the
  //      brand+marketplace level, so any approved app covers every
  //      product under that brand → not needed (`existing_exemption`).
  //   3. A pending application (DRAFT/PACKAGE_READY/SUBMITTED) is
  //      already in flight for the same (brand, marketplace) →
  //      needed=true with `in_progress` so the UI can resume.
  //   4. Otherwise needed=true with `needed`.
  //
  // GTIN exemption is an Amazon-only concept; for non-Amazon-only
  // wizards (no AMAZON channel selected) the step is implicitly
  // skipped — needed=false with `non_amazon_wizard`. The wizard
  // currently always touches Amazon if any (channel, marketplace)
  // pair has platform=AMAZON; we check for that.
  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id/gtin-status',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const channels = normalizeChannels(wizard.channels)
      const amazonChannels = channels.filter((c) => c.platform === 'AMAZON')
      if (amazonChannels.length === 0) {
        return {
          needed: false,
          reason: 'non_amazon_wizard',
        }
      }

      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: { id: true, brand: true, gtin: true, upc: true, ean: true },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }

      const hasIdentifier = !!(product.gtin || product.upc || product.ean)
      if (hasIdentifier) {
        return {
          needed: false,
          reason: 'has_gtin',
          identifier: product.gtin ?? product.upc ?? product.ean ?? null,
        }
      }

      // Without a brand we can't look up exemptions; the user must go
      // through the full Step 4 flow (or fix the master product).
      if (!product.brand) {
        return { needed: true, reason: 'needed' }
      }

      // Amazon exemptions are granted per (brand, marketplace). When
      // the wizard targets multiple Amazon marketplaces, we check
      // each — if every selected Amazon market has an APPROVED app,
      // we skip; if any one is missing, the user has to walk Step 4
      // to cover the gap.
      const exemptions = await prisma.gtinExemptionApplication.findMany({
        where: {
          brandName: product.brand,
          marketplace: { in: amazonChannels.map((c) => c.marketplace) },
        },
        orderBy: { updatedAt: 'desc' },
      })

      const approvedMarkets = new Set(
        exemptions
          .filter((e) => e.status === 'APPROVED')
          .map((e) => e.marketplace),
      )
      const allCovered = amazonChannels.every((c) =>
        approvedMarkets.has(c.marketplace),
      )

      if (allCovered) {
        // Pick the most recent approval for the UI banner.
        const latest = exemptions.find((e) => e.status === 'APPROVED')
        return {
          needed: false,
          reason: 'existing_exemption',
          applicationId: latest?.id ?? null,
          brand: product.brand,
          marketplaces: amazonChannels.map((c) => c.marketplace),
        }
      }

      // Anything pending? (PACKAGE_READY / SUBMITTED / DRAFT)
      const pending = exemptions.find(
        (e) =>
          e.status === 'SUBMITTED' ||
          e.status === 'PACKAGE_READY' ||
          e.status === 'DRAFT',
      )
      if (pending) {
        return {
          needed: true,
          reason: 'in_progress',
          applicationId: pending.id,
          status: pending.status,
        }
      }

      return { needed: true, reason: 'needed' }
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
      const first = legacyFirstChannel(wizard)
      const result = await productTypesService.prefetchSchema({
        channel: first.channel,
        marketplace: first.marketplace,
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
        const first = legacyFirstChannel(wizard)
        const manifest = await schemaParserService.getRequiredFields({
          channel: first.channel,
          marketplace: first.marketplace,
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
        const first = legacyFirstChannel(wizard)
        const schema = await prisma.categorySchema.findFirst({
          where: {
            channel: first.channel,
            marketplace: first.marketplace,
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
      const first = legacyFirstChannel(wizard)
      const currency = currencyForMarketplace(first.marketplace)
      const fees = defaultFeesForChannel(first.channel)
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

  // ── Step 9 — Review ───────────────────────────────────────────
  // GET /api/listing-wizard/:id/review
  //
  // Returns the validation report (per-step status) plus the prepared
  // channel payload. Lets the user inspect exactly what would be sent
  // before they hit Submit.
  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id/review',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const first = legacyFirstChannel(wizard)
      const w = {
        id: wizard.id,
        channel: first.channel,
        marketplace: first.marketplace,
        state: (wizard.state ?? {}) as Record<string, any>,
      }
      const report = submissionService.validate(w)
      const amazonPayload =
        first.channel.toUpperCase() === 'AMAZON'
          ? submissionService.composeAmazonPayload(w)
          : null
      return {
        wizard: {
          id: wizard.id,
          channels: wizard.channels,
          status: wizard.status,
          currentStep: wizard.currentStep,
        },
        report,
        amazonPayload,
      }
    },
  )

  // ── Step 10 — Submit ──────────────────────────────────────────
  // POST /api/listing-wizard/:id/submit
  //
  // Validates the wizard state and, if ready, transitions to
  // SUBMITTED. The actual channel push (Amazon putListingsItem,
  // Shopify createProduct, etc.) is the missing integration —
  // tracked in TECH_DEBT. For now this endpoint:
  //
  //   1. validates state with SubmissionService.validate()
  //   2. composes the channel payload (so the user can see what
  //      would be sent)
  //   3. transitions wizard.status to SUBMITTED so the UI moves
  //      forward and the user can see the prepared payload
  //
  // When the channel client lands, this same handler picks up the
  // payload, dispatches it, and updates status based on the result.
  fastify.post<{ Params: { id: string } }>(
    '/listing-wizard/:id/submit',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      if (wizard.status !== 'DRAFT') {
        return reply.code(409).send({
          error: `Wizard is already ${wizard.status.toLowerCase()}.`,
        })
      }
      const first = legacyFirstChannel(wizard)
      const w = {
        id: wizard.id,
        channel: first.channel,
        marketplace: first.marketplace,
        state: (wizard.state ?? {}) as Record<string, any>,
      }
      const report = submissionService.validate(w)
      if (!report.ready) {
        return reply.code(400).send({
          error: 'Wizard state has incomplete steps.',
          report,
        })
      }
      const amazonPayload =
        first.channel.toUpperCase() === 'AMAZON'
          ? submissionService.composeAmazonPayload(w)
          : null
      const updated = await prisma.listingWizard.update({
        where: { id: wizard.id },
        data: {
          status: 'SUBMITTED',
          completedAt: new Date(),
          state: {
            ...(w.state as Record<string, any>),
            submission: {
              submittedAt: new Date().toISOString(),
              channelPayloadPending: true,
              integrationStatus:
                'channel-publish-pending — actual push not yet wired',
            },
          } as any,
        },
      })
      return {
        wizard: {
          id: updated.id,
          status: updated.status,
          completedAt: updated.completedAt,
        },
        report,
        amazonPayload,
        // Honest about what's wired vs not. UI surfaces this so the
        // user knows the row was saved but hasn't actually been
        // pushed to Amazon yet.
        channelPushed: false,
        channelPushReason:
          'The Amazon SP-API putListingsItem integration is not yet wired. The wizard state is saved as SUBMITTED so the prepared payload is reviewable; the actual channel push lands in a future phase. See TECH_DEBT entry on listing-wizard publish.',
      }
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
