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
  ChannelPublishService,
  type SubmissionEntry,
} from '../services/listing-wizard/channel-publish.service.js'
import { ImageResolutionService } from '../services/listing-images/image-resolution.service.js'
import { validateForPlatform } from '../services/listing-images/validation.service.js'
import { GeminiService } from '../services/ai/gemini.service.js'
import {
  ListingContentService,
  type ContentField,
} from '../services/ai/listing-content.service.js'
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
const imageResolutionService = new ImageResolutionService(prisma as any)
const listingContentService = new ListingContentService(new GeminiService())
const channelPublishService = new ChannelPublishService()

// ── Phase G — language + format derivation for content dedup ────
const MARKETPLACE_TO_LANGUAGE: Record<string, string> = {
  IT: 'it',
  DE: 'de',
  FR: 'fr',
  ES: 'es',
  UK: 'en',
  GB: 'en',
  US: 'en',
  CA: 'en',
  MX: 'es',
  AU: 'en',
  JP: 'ja',
  GLOBAL: 'en',
}

function languageForMarketplace(marketplace: string): string {
  return MARKETPLACE_TO_LANGUAGE[marketplace.toUpperCase()] ?? 'en'
}

/** Same content can be reused across channels iff (language, platform)
 *  match — the platform decides the format rules (Amazon: 200-char
 *  title, 5×500-char bullets; eBay: 80-char title; Shopify: long
 *  HTML; Woo: long HTML). */
function contentGroupKey(platform: string, marketplace: string): string {
  return `${languageForMarketplace(marketplace)}:${platform.toUpperCase()}`
}

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
      // channelStates merge — Phase D bumps the depth: the outer key
      // (channel key) and the inner slice key (attributes /
      // productType / variations / etc.) both shallow-merge, so a
      // patch to one slice doesn't blow away sibling slices for the
      // same channel. Slot contents themselves replace wholesale —
      // callers spread to retain inner field values.
      const currentChannelStates =
        (wizard.channelStates as Record<
          string,
          Record<string, unknown>
        > | null) ?? {}
      const mergedChannelStates: Record<string, Record<string, unknown>> = {}
      for (const [k, v] of Object.entries(currentChannelStates)) {
        mergedChannelStates[k] = { ...v }
      }
      for (const [chKey, sliceUpdate] of Object.entries(
        (body.channelStates ?? {}) as Record<
          string,
          Record<string, unknown>
        >,
      )) {
        mergedChannelStates[chKey] = {
          ...(mergedChannelStates[chKey] ?? {}),
          ...sliceUpdate,
        }
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
              ? Math.min(Math.max(body.currentStep, 1), 9)
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

      // K.7 — Amazon exemptions are granted per (brand, productType,
      // marketplace). Collect per-channel productType from
      // channelStates; any channel with no productType yet falls back
      // to the legacy shared state.productType slot for backwards
      // compat.
      const wizardState = (wizard.state ?? {}) as Record<string, any>
      const channelStatesObj =
        ((wizard.channelStates ?? {}) as Record<
          string,
          Record<string, any>
        >) ?? {}
      const fallbackProductType =
        typeof wizardState?.productType?.productType === 'string'
          ? (wizardState.productType.productType as string)
          : null
      const productTypeByMarketplace = new Map<string, string | null>()
      for (const c of amazonChannels) {
        const channelKey = `${c.platform}:${c.marketplace}`
        const ptSlice = channelStatesObj[channelKey]?.productType
        const productType =
          (ptSlice && typeof ptSlice.productType === 'string'
            ? ptSlice.productType
            : null) ?? fallbackProductType
        productTypeByMarketplace.set(c.marketplace, productType)
      }

      const exemptions = await prisma.gtinExemptionApplication.findMany({
        where: {
          brandName: product.brand,
          marketplace: { in: amazonChannels.map((c) => c.marketplace) },
        },
        orderBy: { updatedAt: 'desc' },
      })

      // P.1 — per-channel resolution. Each Amazon channel reports
      // its own status given the productType picked for that channel
      // (or the fallback). The top-level `needed` flag is the union
      // — true when ANY channel still needs an application.
      type PerChannelStatus = {
        needed: boolean
        reason:
          | 'has_gtin'
          | 'existing_exemption'
          | 'in_progress'
          | 'needed'
          | 'no_product_type'
        applicationId?: string
        status?: string
      }
      const perChannel: Record<string, PerChannelStatus> = {}
      for (const c of amazonChannels) {
        const channelKey = `${c.platform}:${c.marketplace}`
        const wantProductType = productTypeByMarketplace.get(c.marketplace) ?? null

        if (!wantProductType) {
          perChannel[channelKey] = {
            needed: true,
            reason: 'no_product_type',
          }
          continue
        }

        const approved = exemptions.find(
          (e) =>
            e.marketplace === c.marketplace &&
            e.status === 'APPROVED' &&
            (e.productType === null || e.productType === wantProductType),
        )
        if (approved) {
          perChannel[channelKey] = {
            needed: false,
            reason: 'existing_exemption',
            applicationId: approved.id,
          }
          continue
        }

        const pending = exemptions.find(
          (e) =>
            e.marketplace === c.marketplace &&
            (e.productType === null || e.productType === wantProductType) &&
            (e.status === 'SUBMITTED' ||
              e.status === 'PACKAGE_READY' ||
              e.status === 'DRAFT'),
        )
        if (pending) {
          perChannel[channelKey] = {
            needed: true,
            reason: 'in_progress',
            applicationId: pending.id,
            status: pending.status,
          }
          continue
        }

        perChannel[channelKey] = { needed: true, reason: 'needed' }
      }

      const allCovered = Object.values(perChannel).every((s) => !s.needed)

      // Backwards-compat: keep the existing top-level fields so the
      // Step 3 / Step 4 callers don't break. perChannel is the new
      // primary surface for the Step 2 banners (P.1).
      if (allCovered) {
        const latest = exemptions.find((e) => e.status === 'APPROVED')
        return {
          needed: false,
          reason: 'existing_exemption',
          applicationId: latest?.id ?? null,
          brand: product.brand,
          marketplaces: amazonChannels.map((c) => c.marketplace),
          perChannel,
        }
      }

      const anyPending = Object.values(perChannel).find(
        (s) => s.reason === 'in_progress',
      )
      if (anyPending) {
        return {
          needed: true,
          reason: 'in_progress',
          applicationId: anyPending.applicationId,
          status: anyPending.status,
          perChannel,
        }
      }

      return { needed: true, reason: 'needed', perChannel }
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

  // ── Step 5 — Required Attributes (Phase D union) ─────────────
  // GET /api/listing-wizard/:id/required-fields
  //
  // Returns the union of required fields across every selected
  // (channel, marketplace) the wizard targets. Each field carries
  // requiredFor[] / notUsedIn[] / overrides{} so the UI can render
  // the per-channel chips and the override editor without a second
  // round-trip per channel.
  //
  // Per-channel productType resolution:
  //   1. wizardState.channelStates[channelKey].productType.productType
  //   2. wizardState.productType.productType (legacy shared slot)
  //   3. (none — channel surfaced in `channelsMissingSchema` with
  //       reason='no_product_type')
  //
  // Non-Amazon channels are listed in `channelsMissingSchema` with
  // reason='unsupported_channel' for now — eBay lands in Phase 2A.
  fastify.get<{
    Params: { id: string }
    Querystring: { all?: string; refresh?: string }
  }>(
    '/listing-wizard/:id/required-fields',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }

      const includeAllOptional =
        request.query?.all === '1' || request.query?.all === 'true'
      const forceRefresh =
        request.query?.refresh === '1' || request.query?.refresh === 'true'

      const channels = normalizeChannels(wizard.channels)
      if (channels.length === 0) {
        return reply.code(409).send({
          error:
            'No channels selected — pick at least one (platform, marketplace) in Step 1 before configuring attributes.',
        })
      }

      const state = (wizard.state ?? {}) as Record<string, any>
      const channelStates =
        ((wizard.channelStates ?? {}) as Record<
          string,
          Record<string, any>
        >) ?? {}

      // Build per-channel productType + overrides maps from the
      // wizard state slices.
      const productTypeByChannel: Record<string, string | undefined> = {}
      const overridesByChannel: Record<string, Record<string, unknown>> = {}
      for (const c of channels) {
        const channelKey = `${c.platform}:${c.marketplace}`
        const slice = channelStates[channelKey] ?? {}
        const ptSlice = (slice as any).productType
        if (ptSlice && typeof ptSlice.productType === 'string') {
          productTypeByChannel[channelKey] = ptSlice.productType
        }
        const attrSlice = (slice as any).attributes
        if (attrSlice && typeof attrSlice === 'object') {
          overridesByChannel[channelKey] = attrSlice as Record<
            string,
            unknown
          >
        } else {
          overridesByChannel[channelKey] = {}
        }
      }
      const fallbackProductType =
        typeof state?.productType?.productType === 'string'
          ? (state.productType.productType as string)
          : undefined

      // Bail early if no channel has a productType resolvable. Step 2
      // (Product Type) needs to land first.
      const hasAnyProductType =
        Object.values(productTypeByChannel).some(
          (v) => typeof v === 'string' && v.length > 0,
        ) || (fallbackProductType?.length ?? 0) > 0
      if (!hasAnyProductType) {
        return reply.code(409).send({
          error:
            'Pick a product type in Step 2 first — required-fields needs at least one productType to render.',
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

      const baseAttributes =
        (state.attributes ?? {}) as Record<string, unknown>

      try {
        const manifest = await schemaParserService.getMultiChannelRequiredFields(
          {
            channels,
            productTypeByChannel,
            fallbackProductType,
            product: {
              name: product.name,
              brand: product.brand,
              description: product.description,
              productType: product.productType,
            },
            baseAttributes,
            overridesByChannel,
            productId: wizard.productId,
            includeAllOptional,
            forceRefresh,
          },
        )
        return manifest
      } catch (err) {
        fastify.log.error(
          { err },
          '[listing-wizard] required-fields union failed',
        )
        const msg = err instanceof Error ? err.message : String(err)
        const isAuth = /SP-API not configured|credentials|auth/i.test(msg)
        return reply.code(isAuth ? 503 : 500).send({ error: msg })
      }
    },
  )

  // ── Step 6 — Variations (Phase E multi-channel) ──────────────
  // GET /api/listing-wizard/:id/variations
  //
  // Returns per-channel variation themes + per-child attribute
  // completeness across every selected (channel, marketplace).
  // Common themes (intersection across channels) are surfaced
  // separately so the UI can recommend an "applies everywhere" pick.
  // Selected theme per channel is read from
  // wizardState.channelStates[channelKey].variations.theme.
  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id/variations',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }

      const channels = normalizeChannels(wizard.channels)
      if (channels.length === 0) {
        return reply.code(409).send({
          error:
            'No channels selected — pick at least one (platform, marketplace) in Step 1 first.',
        })
      }

      const state = (wizard.state ?? {}) as Record<string, any>
      const channelStates =
        ((wizard.channelStates ?? {}) as Record<
          string,
          Record<string, any>
        >) ?? {}

      const productTypeByChannel: Record<string, string | undefined> = {}
      const selectedThemeByChannel: Record<string, string | null> = {}
      for (const c of channels) {
        const channelKey = `${c.platform}:${c.marketplace}`
        const slice = channelStates[channelKey] ?? {}
        const ptSlice = (slice as any).productType
        if (ptSlice && typeof ptSlice.productType === 'string') {
          productTypeByChannel[channelKey] = ptSlice.productType
        }
        const varSlice = (slice as any).variations
        selectedThemeByChannel[channelKey] =
          varSlice && typeof varSlice.theme === 'string'
            ? varSlice.theme
            : null
      }
      const fallbackProductType =
        typeof state?.productType?.productType === 'string'
          ? (state.productType.productType as string)
          : undefined

      try {
        const payload =
          await variationsService.getMultiChannelVariationsPayload({
            productId: wizard.productId,
            channels,
            productTypeByChannel,
            fallbackProductType,
            selectedThemeByChannel,
          })
        return payload
      } catch (err) {
        fastify.log.error(
          { err },
          '[listing-wizard] variations multi-channel failed',
        )
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  // ── Step 7 — Images (Phase F multi-channel) ──────────────────
  // GET /api/listing-wizard/:id/images
  //
  // Returns:
  //   - master images: ProductImage rows for inline reorder (the
  //     wizard step keeps its lightweight controls — full multi-
  //     scope editing happens on the dedicated image-manager page).
  //   - resolvedByChannel: per-channel image set after the resolution
  //     cascade (variant → marketplace → platform → global → master).
  //   - validationByChannel: per-platform pass/warn/block status so
  //     the wizard can surface what each channel would see at submit.
  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id/images',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }

      // Master gallery first — sorted MAIN-first for the inline UI.
      const rows = await prisma.productImage.findMany({
        where: { productId: wizard.productId },
        orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, url: true, alt: true, type: true },
      })
      const main = rows.filter((r) => r.type === 'MAIN')
      const rest = rows.filter((r) => r.type !== 'MAIN')
      const masterImages = [...main, ...rest]

      const channels = normalizeChannels(wizard.channels)
      const resolvedByChannel: Record<
        string,
        Awaited<ReturnType<ImageResolutionService['resolveForChannel']>>
      > = {}
      const validationByChannel: Record<
        string,
        ReturnType<typeof validateForPlatform>
      > = {}

      for (const c of channels) {
        const channelKey = `${c.platform}:${c.marketplace}`
        try {
          const resolved = await imageResolutionService.resolveForChannel({
            productId: wizard.productId,
            platform: c.platform,
            marketplace: c.marketplace,
          })
          resolvedByChannel[channelKey] = resolved
          validationByChannel[channelKey] = validateForPlatform(
            resolved,
            c.platform,
            c.marketplace,
          )
        } catch (err) {
          fastify.log.error(
            { err, channelKey },
            '[listing-wizard] image resolution failed',
          )
          resolvedByChannel[channelKey] = []
          validationByChannel[channelKey] = validateForPlatform(
            [],
            c.platform,
            c.marketplace,
          )
        }
      }

      return {
        images: masterImages,
        resolvedByChannel,
        validationByChannel,
      }
    },
  )

  // ── Step 9 — Pricing (Phase H multi-channel) ─────────────────
  // GET /api/listing-wizard/:id/pricing-context
  //
  // Returns the master product's pricing intelligence plus per-channel
  // currency + default fee assumptions for every selected channel.
  // The frontend uses these to seed the base price + per-marketplace
  // override grid without re-fetching the master product.
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

      const channels = normalizeChannels(wizard.channels)
      const channelContexts = channels.map((c) => ({
        platform: c.platform,
        marketplace: c.marketplace,
        channelKey: `${c.platform}:${c.marketplace}`,
        currency: currencyForMarketplace(c.marketplace),
        defaultFees: defaultFeesForChannel(c.platform),
      }))

      return {
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
        channels: channelContexts,
      }
    },
  )

  // ── Step 8 — Content (Phase G dedup) ─────────────────────────
  // POST /api/listing-wizard/:id/generate-content
  // Body: { fields: ContentField[], variant?: number }
  //
  // Computes per-channel group keys (language:platform), groups the
  // wizard's channels, and fires ONE Gemini call per unique group.
  // Same language + same platform format = same call, broadcast to
  // every channel in the group. Returns per-channel results so the
  // frontend can render tabs by group with the channel chips that
  // share each tab's content.
  fastify.post<{
    Params: { id: string }
    Body: { fields?: string[]; variant?: number }
  }>(
    '/listing-wizard/:id/generate-content',
    async (request, reply) => {
      if (!listingContentService.isConfigured()) {
        return reply.code(503).send({
          error:
            'Gemini API not configured — set GEMINI_API_KEY on the API server.',
        })
      }
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const channels = normalizeChannels(wizard.channels)
      if (channels.length === 0) {
        return reply.code(409).send({
          error:
            'No channels selected — pick at least one (platform, marketplace) in Step 1 first.',
        })
      }

      const ALLOWED_FIELDS = new Set<ContentField>([
        'title',
        'bullets',
        'description',
        'keywords',
      ])
      const requested = (request.body?.fields ?? []).filter(
        (f): f is ContentField => ALLOWED_FIELDS.has(f as ContentField),
      )
      if (requested.length === 0) {
        return reply.code(400).send({
          error: `fields must include one or more of ${Array.from(
            ALLOWED_FIELDS,
          ).join(', ')}`,
        })
      }

      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: {
          id: true,
          sku: true,
          name: true,
          brand: true,
          description: true,
          bulletPoints: true,
          keywords: true,
          weightValue: true,
          weightUnit: true,
          dimLength: true,
          dimWidth: true,
          dimHeight: true,
          dimUnit: true,
          productType: true,
          variantAttributes: true,
          categoryAttributes: true,
        },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }

      // Group channels by (language, platform). Pick a representative
      // marketplace per group for the Gemini call's terminology
      // lookup — terminology is per (brand, marketplace), so any
      // marketplace in the group will do (we sort lexicographically
      // so the choice is deterministic).
      const groups = new Map<
        string,
        { language: string; platform: string; marketplaces: string[]; channelKeys: string[] }
      >()
      for (const c of channels) {
        const key = contentGroupKey(c.platform, c.marketplace)
        const channelKey = `${c.platform}:${c.marketplace}`
        if (!groups.has(key)) {
          groups.set(key, {
            language: languageForMarketplace(c.marketplace),
            platform: c.platform,
            marketplaces: [c.marketplace],
            channelKeys: [channelKey],
          })
        } else {
          const g = groups.get(key)!
          if (!g.marketplaces.includes(c.marketplace)) {
            g.marketplaces.push(c.marketplace)
          }
          g.channelKeys.push(channelKey)
        }
      }
      // Deterministic order — sort each group's lists.
      for (const g of groups.values()) {
        g.marketplaces.sort()
        g.channelKeys.sort()
      }

      const variant =
        typeof request.body?.variant === 'number'
          ? Math.max(0, Math.min(4, request.body.variant))
          : 0

      // Fire one Gemini call per group. Terminology is fetched per
      // group from the chosen marketplace. Errors per group don't
      // sink the others — the response includes both successes and
      // failures so the UI can retry-failed individually.
      const groupResults: Array<{
        groupKey: string
        platform: string
        language: string
        marketplaces: string[]
        channelKeys: string[]
        result?: any
        error?: string
      }> = []

      for (const [groupKey, g] of groups) {
        const representativeMarketplace = g.marketplaces[0]!
        try {
          const terminology = await prisma.terminologyPreference.findMany({
            where: {
              marketplace: representativeMarketplace.toUpperCase(),
              OR: [{ brand: product.brand }, { brand: null }],
            },
            select: { preferred: true, avoid: true, context: true },
            orderBy: [{ brand: 'desc' }, { preferred: 'asc' }],
          })
          const result = await listingContentService.generate({
            product: {
              id: product.id,
              sku: product.sku,
              name: product.name,
              brand: product.brand,
              description: product.description,
              bulletPoints: product.bulletPoints,
              keywords: product.keywords,
              weightValue: product.weightValue
                ? Number(product.weightValue)
                : null,
              weightUnit: product.weightUnit,
              dimLength: product.dimLength
                ? Number(product.dimLength)
                : null,
              dimWidth: product.dimWidth ? Number(product.dimWidth) : null,
              dimHeight: product.dimHeight
                ? Number(product.dimHeight)
                : null,
              dimUnit: product.dimUnit,
              productType: product.productType,
              variantAttributes: product.variantAttributes,
              categoryAttributes: product.categoryAttributes,
            },
            marketplace: representativeMarketplace,
            fields: requested,
            variant,
            terminology,
          })
          groupResults.push({
            groupKey,
            platform: g.platform,
            language: g.language,
            marketplaces: g.marketplaces,
            channelKeys: g.channelKeys,
            result,
          })
        } catch (err) {
          fastify.log.error(
            { err, groupKey },
            '[listing-wizard] generate-content group failed',
          )
          groupResults.push({
            groupKey,
            platform: g.platform,
            language: g.language,
            marketplaces: g.marketplaces,
            channelKeys: g.channelKeys,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Per-channel projection: map each channelKey to its group's
      // result. Frontend can read either shape — groups for the tab
      // structure, byChannel for downstream submission.
      const byChannel: Record<string, any> = {}
      for (const g of groupResults) {
        for (const channelKey of g.channelKeys) {
          byChannel[channelKey] = g.result ?? { error: g.error }
        }
      }

      return {
        groups: groupResults,
        byChannel,
        dedupSavings: {
          channelCount: channels.length,
          groupCount: groups.size,
        },
      }
    },
  )

  // ── Step 10 — Review (Phase I multi-channel) ─────────────────
  // GET /api/listing-wizard/:id/review
  //
  // Returns per-channel validation reports + per-channel prepared
  // payloads. Lets the user audit each channel before Submit.
  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id/review',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const channels = normalizeChannels(wizard.channels)
      const w = {
        id: wizard.id,
        channels,
        state: (wizard.state ?? {}) as Record<string, any>,
        channelStates:
          ((wizard.channelStates ?? {}) as Record<
            string,
            Record<string, any>
          >) ?? {},
      }
      const validation = submissionService.validateMultiChannel(w)
      const payloads = submissionService.composeMultiChannelPayloads(w)
      return {
        wizard: {
          id: wizard.id,
          channels: wizard.channels,
          status: wizard.status,
          currentStep: wizard.currentStep,
        },
        validation,
        payloads,
      }
    },
  )

  // ── Step 11 — Submit (Phase J multi-channel orchestration) ───
  // POST /api/listing-wizard/:id/submit
  //
  // Validates per-channel state, composes per-channel payloads, and
  // dispatches each (channel, marketplace) tuple in parallel via the
  // channel-publish service. Per-channel results are stored on
  // wizard.submissions so /poll and /retry can resume work later
  // without re-doing successful channels.
  //
  // v1: every adapter returns NOT_IMPLEMENTED (TECH_DEBT #35); the
  // orchestrator is real, the publishes are stubs. The wizard
  // transitions to SUBMITTED once the orchestrator runs — the UI
  // shows per-channel "Adapter not wired" status until the real
  // adapters land.
  fastify.post<{ Params: { id: string } }>(
    '/listing-wizard/:id/submit',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      if (wizard.status !== 'DRAFT' && wizard.status !== 'FAILED') {
        return reply.code(409).send({
          error: `Wizard is already ${wizard.status.toLowerCase()}.`,
        })
      }

      const channels = normalizeChannels(wizard.channels)
      if (channels.length === 0) {
        return reply.code(409).send({
          error: 'No channels selected — pick at least one in Step 1.',
        })
      }

      const w = {
        id: wizard.id,
        channels,
        state: (wizard.state ?? {}) as Record<string, any>,
        channelStates:
          ((wizard.channelStates ?? {}) as Record<
            string,
            Record<string, any>
          >) ?? {},
      }
      const validation = submissionService.validateMultiChannel(w)
      if (!validation.allReady) {
        return reply.code(400).send({
          error: 'Wizard state has incomplete steps for some channels.',
          validation,
        })
      }

      const payloads = submissionService.composeMultiChannelPayloads(w)
      // Dispatch all channels in parallel. Each adapter handles its
      // own errors and returns a SubmissionEntry — never throws.
      const submissions = await Promise.all(
        payloads.map((p) =>
          channelPublishService.publishToChannel({
            channelKey: p.channelKey,
            platform: p.platform,
            marketplace: p.marketplace,
            payload: p.payload as Record<string, unknown> | undefined,
            unsupported: p.unsupported,
            reason: p.reason,
          }),
        ),
      )

      // Wizard status: LIVE if every entry succeeded; FAILED if any
      // are FAILED; SUBMITTED otherwise (in-flight or NOT_IMPLEMENTED).
      const overallStatus = computeOverallStatus(submissions)
      const updated = await prisma.listingWizard.update({
        where: { id: wizard.id },
        data: {
          status: overallStatus,
          completedAt:
            overallStatus === 'LIVE' ? new Date() : wizard.completedAt,
          submissions: submissions as any,
        },
      })

      return {
        wizard: {
          id: updated.id,
          status: updated.status,
          completedAt: updated.completedAt,
        },
        submissions,
        validation,
        payloads,
      }
    },
  )

  // POST /api/listing-wizard/:id/poll
  //
  // Walks each submission entry through pollStatus (no-op until an
  // adapter is wired). Persists the updated array on the wizard row
  // so the next /poll can pick up where this one left off.
  fastify.post<{ Params: { id: string } }>(
    '/listing-wizard/:id/poll',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const current = (wizard.submissions ?? []) as unknown as SubmissionEntry[]
      if (!Array.isArray(current) || current.length === 0) {
        return { submissions: [] }
      }
      const polled = await Promise.all(
        current.map((entry) => channelPublishService.pollStatus(entry)),
      )
      const overallStatus = computeOverallStatus(polled)
      const updated = await prisma.listingWizard.update({
        where: { id: wizard.id },
        data: {
          submissions: polled as any,
          status: overallStatus,
          completedAt:
            overallStatus === 'LIVE' && !wizard.completedAt
              ? new Date()
              : wizard.completedAt,
        },
      })
      return {
        wizard: {
          id: updated.id,
          status: updated.status,
          completedAt: updated.completedAt,
        },
        submissions: polled,
      }
    },
  )

  // POST /api/listing-wizard/:id/retry
  // Body: { channelKeys: string[] }
  //
  // Re-runs publishToChannel for the specified failed/not-implemented
  // entries only. Successful channels are untouched, so retrying one
  // bad channel doesn't risk re-pushing the others.
  fastify.post<{
    Params: { id: string }
    Body: { channelKeys?: string[] }
  }>(
    '/listing-wizard/:id/retry',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const wantedKeys = new Set(
        (request.body?.channelKeys ?? []).filter(
          (k): k is string => typeof k === 'string' && k.length > 0,
        ),
      )
      if (wantedKeys.size === 0) {
        return reply.code(400).send({
          error: 'channelKeys[] is required and must not be empty.',
        })
      }

      const channels = normalizeChannels(wizard.channels)
      const w = {
        id: wizard.id,
        channels,
        state: (wizard.state ?? {}) as Record<string, any>,
        channelStates:
          ((wizard.channelStates ?? {}) as Record<
            string,
            Record<string, any>
          >) ?? {},
      }
      const payloadByKey = new Map<
        string,
        ReturnType<typeof submissionService.composeMultiChannelPayloads>[number]
      >()
      for (const p of submissionService.composeMultiChannelPayloads(w)) {
        payloadByKey.set(p.channelKey, p)
      }

      const current = (wizard.submissions ?? []) as unknown as SubmissionEntry[]
      const updatedSubmissions: SubmissionEntry[] = []
      for (const entry of current) {
        if (!wantedKeys.has(entry.channelKey)) {
          updatedSubmissions.push(entry)
          continue
        }
        const p = payloadByKey.get(entry.channelKey)
        if (!p) {
          // Shouldn't happen unless channels were edited mid-flight —
          // mark as FAILED with a clear reason.
          updatedSubmissions.push({
            ...entry,
            status: 'FAILED',
            error: 'Channel no longer in wizard.channels — cannot retry.',
            updatedAt: new Date().toISOString(),
          })
          continue
        }
        const next = await channelPublishService.publishToChannel({
          channelKey: p.channelKey,
          platform: p.platform,
          marketplace: p.marketplace,
          payload: p.payload as Record<string, unknown> | undefined,
          unsupported: p.unsupported,
          reason: p.reason,
        })
        updatedSubmissions.push(next)
      }

      const overallStatus = computeOverallStatus(updatedSubmissions)
      const updated = await prisma.listingWizard.update({
        where: { id: wizard.id },
        data: {
          submissions: updatedSubmissions as any,
          status: overallStatus,
          completedAt:
            overallStatus === 'LIVE' && !wizard.completedAt
              ? new Date()
              : wizard.completedAt,
        },
      })
      return {
        wizard: {
          id: updated.id,
          status: updated.status,
          completedAt: updated.completedAt,
        },
        submissions: updatedSubmissions,
        retried: Array.from(wantedKeys),
      }
    },
  )

  // Q.2 — single-channel schema for the product-edit page. Same shape
  // as /listing-wizard/:id/required-fields but scoped to one product +
  // channel + marketplace; baseAttributes seed comes from the existing
  // ChannelListing (title → item_name, description → product_description,
  // bulletPointsOverride → bullet_point JSON, plus everything in
  // platformAttributes.attributes).
  fastify.get<{
    Params: { id: string; channel: string; marketplace: string }
    Querystring: { refresh?: string; all?: string }
  }>(
    '/products/:id/listings/:channel/:marketplace/schema',
    async (request, reply) => {
      const { id, channel, marketplace } = request.params
      const { refresh, all } = request.query

      const product = await prisma.product.findUnique({
        where: { id },
        select: {
          name: true,
          brand: true,
          description: true,
          productType: true,
        },
      })
      if (!product) {
        return reply.code(404).send({ error: `Product ${id} not found` })
      }

      const listing = await prisma.channelListing.findFirst({
        where: { productId: id, channel, marketplace },
      })

      const productType = product.productType ?? ''
      if (!productType) {
        return reply.code(409).send({
          error:
            'No product type set on the master product. Pick a product type before configuring channel attributes.',
        })
      }

      // Seed baseAttributes from the existing listing so the editor
      // shows what's currently saved.
      const baseAttributes: Record<string, unknown> = {}
      const platformAttrs =
        (listing?.platformAttributes as Record<string, any> | null) ?? null
      const storedAttrs =
        platformAttrs && typeof platformAttrs.attributes === 'object'
          ? (platformAttrs.attributes as Record<string, unknown>)
          : {}
      for (const [k, v] of Object.entries(storedAttrs)) {
        baseAttributes[k] = v
      }
      if (listing?.title && baseAttributes['item_name'] === undefined) {
        baseAttributes['item_name'] = listing.title
      }
      if (listing?.description && baseAttributes['product_description'] === undefined) {
        baseAttributes['product_description'] = listing.description
      }
      if (
        Array.isArray(listing?.bulletPointsOverride) &&
        listing!.bulletPointsOverride.length > 0 &&
        baseAttributes['bullet_point'] === undefined
      ) {
        baseAttributes['bullet_point'] = JSON.stringify(
          listing!.bulletPointsOverride,
        )
      }

      try {
        const manifest = await schemaParserService.getMultiChannelRequiredFields({
          channels: [{ platform: channel, marketplace }],
          productTypeByChannel: {
            [`${channel.toUpperCase()}:${marketplace.toUpperCase()}`]: productType,
          },
          fallbackProductType: productType,
          product: {
            name: product.name,
            brand: product.brand,
            description: product.description,
            productType: product.productType,
          },
          baseAttributes,
          overridesByChannel: {},
          productId: id,
          includeAllOptional: all === '1' || all === 'true',
          forceRefresh: refresh === '1' || refresh === 'true',
        })
        return manifest
      } catch (err) {
        fastify.log.error(
          { err },
          '[products/listings/schema] failed',
        )
        const msg = err instanceof Error ? err.message : String(err)
        const isAuth = /SP-API not configured|credentials|auth/i.test(msg)
        return reply.code(isAuth ? 503 : 500).send({ error: msg })
      }
    },
  )
}

function computeOverallStatus(
  submissions: SubmissionEntry[],
): 'DRAFT' | 'SUBMITTED' | 'LIVE' | 'FAILED' {
  if (submissions.length === 0) return 'DRAFT'
  const allLive = submissions.every((s) => s.status === 'LIVE')
  if (allLive) return 'LIVE'
  const anyFailed = submissions.some((s) => s.status === 'FAILED')
  if (anyFailed) return 'FAILED'
  return 'SUBMITTED'
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
