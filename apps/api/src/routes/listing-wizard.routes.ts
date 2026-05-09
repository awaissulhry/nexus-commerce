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
import { listEtag, matches } from '../utils/list-etag.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { CategorySchemaService } from '../services/categories/schema-sync.service.js'
import {
  ProductTypesService,
  type ProductTypeListItem,
} from '../services/listing-wizard/product-types.service.js'
import { SchemaParserService } from '../services/listing-wizard/schema-parser.service.js'
import {
  WIZARD_EVENT_TYPES,
  writeStepTransition,
  writeWizardEvent,
  type WizardEventType,
} from '../services/listing-wizard/telemetry.service.js'
import {
  EbayCategoryService,
  type EbayAspectRich,
} from '../services/ebay-category.service.js'
import { VariationsService } from '../services/listing-wizard/variations.service.js'
import { SubmissionService } from '../services/listing-wizard/submission.service.js'
import {
  ChannelPublishService,
  type SubmissionEntry,
} from '../services/listing-wizard/channel-publish.service.js'
import { ImageResolutionService } from '../services/listing-images/image-resolution.service.js'
import { validateForPlatform } from '../services/listing-images/validation.service.js'
import {
  ListingContentService,
  type ContentField,
} from '../services/ai/listing-content.service.js'
import { logUsage } from '../services/ai/usage-logger.service.js'
import {
  channelsHash,
  legacyFirstChannel,
  normalizeChannels,
} from '../services/listing-wizard/channels.js'
import { idempotencyService } from '../services/idempotency.service.js'
import { publishListingEvent } from '../services/listing-events.service.js'

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
const listingContentService = new ListingContentService()
const channelPublishService = new ChannelPublishService()
const ebayCategoryService = new EbayCategoryService()

/** Z.2 — convert eBay's per-category aspect schema into the same
 *  UnionField shape the bulk grid + per-product editor render Amazon
 *  fields with. Mode/dataType/cardinality map to FieldKind:
 *    SELECTION_ONLY        → 'enum'
 *    NUMBER + FREE_TEXT    → 'number'
 *    STRING + FREE_TEXT    → 'text' (or 'longtext' when maxLength > 80)
 *    cardinality MULTI     → 'string_array' (eBay supports multi-value
 *                            aspects for things like Material, Pattern)
 *  Required → required for the active channelKey (we only ever pass a
 *  single channel into this endpoint, so requiredFor has at most one
 *  entry). currentValue seeds from baseAttributes for edit-page
 *  inheritance.
 */
function ebayAspectsToUnionFields(
  aspects: EbayAspectRich[],
  baseAttributes: Record<string, unknown>,
  channelKey: string,
): Array<{
  id: string
  label: string
  description?: string
  kind: string
  required: boolean
  wrapped: boolean
  options?: Array<{ value: string; label: string }>
  defaultValue?: string | number | boolean
  examples?: string[]
  maxLength?: number
  minLength?: number
  unsupportedReason?: string
  maxItems?: number
  requiredFor: string[]
  optionalFor: string[]
  notUsedIn: string[]
  currentValue?: string | number | boolean
  overrides: Record<string, string | number | boolean>
  divergent?: boolean
  variantEligible: boolean
}> {
  return aspects.map((a) => {
    const id = aspectIdFromName(a.name)
    let kind: string
    if (a.cardinality === 'MULTI' && a.dataType === 'STRING') {
      kind = 'string_array'
    } else if (a.mode === 'SELECTION_ONLY' && a.values.length > 0) {
      kind = 'enum'
    } else if (a.dataType === 'NUMBER') {
      kind = 'number'
    } else if (typeof a.maxLength === 'number' && a.maxLength > 80) {
      kind = 'longtext'
    } else {
      kind = 'text'
    }
    const cur = baseAttributes[id]
    return {
      id,
      label: a.name,
      kind,
      required: a.required,
      wrapped: false,
      options:
        a.values.length > 0
          ? a.values.map((v) => ({ value: v, label: v }))
          : undefined,
      maxLength: a.maxLength,
      maxItems: a.cardinality === 'MULTI' ? 20 : undefined,
      requiredFor: a.required ? [channelKey] : [],
      optionalFor: a.required ? [] : [channelKey],
      notUsedIn: [],
      currentValue:
        typeof cur === 'string' ||
        typeof cur === 'number' ||
        typeof cur === 'boolean'
          ? cur
          : undefined,
      overrides: {},
      variantEligible: a.variantEligible,
    }
  })
}

/** Convert "Brand Name" → "brand_name" so eBay aspects use the same
 *  shape (snake_case ids) as Amazon attributes. The user-facing label
 *  stays as the localised aspect name. */
function aspectIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

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

  /**
   * GET /api/listing-wizard/drafts
   *
   * Surfaces in-progress wizards (status='DRAFT') for the /products/drafts
   * page. Without this endpoint the drafts are invisible — there's no
   * navigable list, only the per-product /products/:id/list-wizard URL,
   * which assumes the user remembers which products they started.
   *
   * Filters:
   *   ?search=  matches Product.sku or Product.name (case-insensitive)
   *   ?stale=1  only wizards updated > 7 days ago
   *   ?limit=   1..200, default 50
   *   ?offset=  default 0
   *
   * Returns a flat list shape (productSku/productName lifted out of the
   * product relation) so the client doesn't have to walk a nested object.
   */
  // ── DR-S.1 — GET /api/listing-wizard/drafts/summary ───────────
  // Lightweight aggregation for the /products/drafts KPI strip.
  // Cheap (4 count() queries + 1 groupBy); not paginated. Distinct
  // from the /drafts list endpoint so the KPI strip can refresh on
  // its own cadence without invalidating the ETag-cached list.
  //
  // DR-B.2 — `ready` count surfaces wizards at the Submit step
  // whose underlying product is data-complete. Computed by
  // re-running the same scoring pass the list endpoint uses but
  // only counting wizards at currentStep === 9. Cheap because
  // the candidate set is small (typically 0–5 rows).
  fastify.get('/listing-wizard/drafts/summary', async (_request, reply) => {
    try {
      const now = new Date()
      const staleCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const expiringCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

      const [
        wizardsTotal,
        wizardsStale,
        wizardsExpiring,
        productDraftsTotal,
        wizardStepDist,
        wizardOldest,
        readyCandidates,
      ] = await Promise.all([
        prisma.listingWizard.count({ where: { status: 'DRAFT' } }),
        prisma.listingWizard.count({
          where: { status: 'DRAFT', updatedAt: { lt: staleCutoff } },
        }),
        prisma.listingWizard.count({
          where: {
            status: 'DRAFT',
            expiresAt: { gte: now, lt: expiringCutoff },
          },
        }),
        prisma.product.count({ where: { status: 'DRAFT' } }),
        prisma.listingWizard.groupBy({
          by: ['currentStep'],
          where: { status: 'DRAFT' },
          _count: { _all: true },
          orderBy: { currentStep: 'asc' },
        }),
        prisma.listingWizard.findFirst({
          where: { status: 'DRAFT' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        prisma.listingWizard.findMany({
          where: { status: 'DRAFT', currentStep: 9 },
          select: {
            productId: true,
            product: {
              select: {
                id: true,
                name: true,
                basePrice: true,
                brand: true,
                productType: true,
                description: true,
                gtin: true,
                upc: true,
                ean: true,
              },
            },
          },
        }),
      ])

      // DR-B.2 — count readyCandidates with image presence + the
      // 6 product-data factors. Mirrors scoreCompleteness() in the
      // /drafts list endpoint; kept inline to stay independent.
      let ready = 0
      if (readyCandidates.length > 0) {
        const ids = readyCandidates
          .map((w) => w.product?.id)
          .filter((x): x is string => !!x)
        const imageCounts = new Map(
          (
            await prisma.productImage.groupBy({
              by: ['productId'],
              where: { productId: { in: ids } },
              _count: { _all: true },
            })
          ).map((r) => [r.productId, r._count._all] as const),
        )
        for (const w of readyCandidates) {
          const p = w.product
          if (!p) continue
          const passes = [
            !!p.name &&
              !p.name.toUpperCase().startsWith('NEW-') &&
              p.name !== 'Untitled product',
            p.basePrice !== null && Number(p.basePrice) > 0,
            !!p.brand,
            !!p.productType,
            !!p.description && p.description.length >= 50,
            !!(p.gtin || p.upc || p.ean),
            (imageCounts.get(p.id) ?? 0) > 0,
          ].filter(Boolean).length
          if (passes === 7) ready++
        }
      }

      const byStep: Record<string, number> = {}
      for (const row of wizardStepDist) {
        byStep[String(row.currentStep)] = row._count._all
      }

      return {
        total: wizardsTotal + productDraftsTotal,
        wizards: wizardsTotal,
        productDrafts: productDraftsTotal,
        stale: wizardsStale,
        expiring: wizardsExpiring,
        ready,
        byStep,
        oldestCreatedAt: wizardOldest?.createdAt ?? null,
      }
    } catch (err) {
      fastify.log.error({ err }, '[listing-wizard] drafts/summary failed')
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  fastify.get<{
    Querystring: {
      search?: string
      stale?: string
      limit?: string
      offset?: string
      include?: string
      sort?: string
    }
  }>('/listing-wizard/drafts', async (request, reply) => {
    try {
      const q = request.query
      const limit = Math.min(
        Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
        200,
      )
      const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0)
      const onlyStale = q.stale === '1' || q.stale === 'true'
      const search = (q.search ?? '').trim()
      // C.3 — opt-in to merge Product DRAFT rows alongside wizard
      // drafts. Comma-list of source kinds: 'wizards', 'products',
      // or both. Default 'wizards' for back-compat with existing
      // callers that don't pass include.
      const includes = (q.include ?? 'wizards').split(',').map((s) => s.trim())
      const includeWizards = includes.includes('wizards') || includes.includes('all')
      const includeProducts =
        includes.includes('products') || includes.includes('all')
      // C.3 — sort options (recency / age-asc / name / completion).
      // Default 'recency' (newest updatedAt first).
      const sort = (q.sort ?? 'recency').toLowerCase()

      const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const wizardWhere: any = { status: 'DRAFT' }
      if (onlyStale) wizardWhere.updatedAt = { lt: staleCutoff }
      if (search) {
        wizardWhere.product = {
          OR: [
            { sku: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
          ],
        }
      }

      // Phase 10b — short-circuit with 304 Not Modified when nothing
      // has changed since the client's last fetch. ETag is keyed on
      // ListingWizard only; when products are included, skip the
      // 304 path because we'd need a combined etag (deferred —
      // analytics-light surface, polling every 30s is fine).
      let etag: string | undefined
      let etagCount = 0
      if (!includeProducts) {
        const e = await listEtag(prisma, {
          model: 'listingWizard',
          where: wizardWhere,
          filterContext: { limit, offset, onlyStale, search, sort },
        })
        etag = e.etag
        etagCount = e.count
        reply.header('ETag', etag)
        reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
        if (matches(request, etag)) {
          return reply.code(304).send()
        }
      }

      // Wizard rows.
      const wizardRows = includeWizards
        ? await prisma.listingWizard.findMany({
            where: wizardWhere,
            orderBy: { updatedAt: 'desc' },
            // When products are included, fetch all matching wizards
            // (capped at 200 by the limit clamp) and let the merge
            // step apply the final pagination + sort. For wizard-only
            // requests the take/skip applies directly.
            take: includeProducts ? 200 : limit,
            skip: includeProducts ? 0 : offset,
            select: {
              id: true,
              productId: true,
              currentStep: true,
              channels: true,
              createdAt: true,
              updatedAt: true,
              // DR-S.2 — Product fields needed for completeness scoring,
              // pulled inline so we don't need a second round-trip per
              // wizard row.
              product: {
                select: {
                  id: true,
                  sku: true,
                  name: true,
                  isParent: true,
                  basePrice: true,
                  brand: true,
                  productType: true,
                  description: true,
                  gtin: true,
                  upc: true,
                  ean: true,
                },
              },
            },
          })
        : []

      type DraftRow = {
        kind: 'wizard' | 'product'
        id: string
        productId: string
        productSku: string | null
        productName: string | null
        productIsParent: boolean
        currentStep: number | null
        channels: unknown[]
        createdAt: Date
        updatedAt: Date
        isStale: boolean
        // DR-S.2 — 0..100 product-data completeness, separate from
        // wizard step progress (currentStep / 9). 7 factors weighted
        // equally; see scoreCompleteness().
        completenessPct: number
        missingFactors: string[]
      }
      const wizardDrafts: DraftRow[] = wizardRows.map((r) => ({
        kind: 'wizard',
        id: r.id,
        productId: r.productId,
        productSku: r.product?.sku ?? null,
        productName: r.product?.name ?? null,
        productIsParent: r.product?.isParent ?? false,
        currentStep: r.currentStep,
        channels: Array.isArray(r.channels) ? (r.channels as unknown[]) : [],
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        isStale: r.updatedAt < staleCutoff,
        // Filled in below after image-presence batch fetch.
        completenessPct: 0,
        missingFactors: [],
      }))

      // Product DRAFT rows. Excludes products that already have a
      // DRAFT wizard pointing at them — those would render as
      // duplicate entries (one for the product itself, one for the
      // wizard). Wizard rows take precedence since they carry richer
      // step state.
      let productDrafts: DraftRow[] = []
      // DR-S.2 — keep raw productRows in scope so the scoring loop
      // below can read price/brand/etc. Mapping to DraftRow drops
      // those fields on purpose (wire format stays lean).
      let productRowsForScoring: Array<{
        id: string
        name: string | null
        basePrice: any
        brand: string | null
        productType: string | null
        description: string | null
        gtin: string | null
        upc: string | null
        ean: string | null
      }> = []
      if (includeProducts) {
        const wizardProductIds = new Set(wizardRows.map((r) => r.productId))
        const productWhere: any = {
          status: 'DRAFT',
          id: { notIn: Array.from(wizardProductIds) },
        }
        if (onlyStale) productWhere.updatedAt = { lt: staleCutoff }
        if (search) {
          productWhere.OR = [
            { sku: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
          ]
        }
        const productRows = await prisma.product.findMany({
          where: productWhere,
          orderBy: { updatedAt: 'desc' },
          take: 200,
          select: {
            id: true,
            sku: true,
            name: true,
            isParent: true,
            createdAt: true,
            updatedAt: true,
            // DR-S.2 — same scoring fields as the wizard branch.
            basePrice: true,
            brand: true,
            productType: true,
            description: true,
            gtin: true,
            upc: true,
            ean: true,
          },
        })
        productRowsForScoring = productRows.map((p) => ({
          id: p.id,
          name: p.name,
          basePrice: p.basePrice,
          brand: p.brand,
          productType: p.productType,
          description: p.description,
          gtin: p.gtin,
          upc: p.upc,
          ean: p.ean,
        }))
        productDrafts = productRows.map<DraftRow>((p) => ({
          kind: 'product',
          // For product DRAFTs we use the productId as the row id so
          // the client can dedupe + use it directly for delete.
          id: p.id,
          productId: p.id,
          productSku: p.sku,
          productName: p.name,
          productIsParent: p.isParent,
          currentStep: null,
          channels: [],
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          isStale: p.updatedAt < staleCutoff,
          completenessPct: 0,
          missingFactors: [],
        }))
      }

      // DR-S.2 — completeness scoring. Single batch fetch tells us
      // which productIds have ≥1 image; pair that with the inlined
      // product fields and compute a 7-factor 0..100 score per row.
      // Same factors used by /products/drafts/summary's distribution
      // bucket and the audit script — kept in one place here.
      const allProductIds = Array.from(
        new Set([
          ...wizardRows.map((r) => r.productId),
          ...(includeProducts ? productDrafts.map((p) => p.productId) : []),
        ]),
      )
      const productImageCounts =
        allProductIds.length === 0
          ? new Map<string, number>()
          : new Map(
              (
                await prisma.productImage.groupBy({
                  by: ['productId'],
                  where: { productId: { in: allProductIds } },
                  _count: { _all: true },
                })
              ).map((row) => [row.productId, row._count._all] as const),
            )

      type ProductLike = {
        name: string | null
        basePrice: any
        brand: string | null
        productType: string | null
        description: string | null
        gtin: string | null
        upc: string | null
        ean: string | null
      }
      function scoreCompleteness(
        p: ProductLike | null | undefined,
        productId: string,
      ): { pct: number; missing: string[] } {
        if (!p) return { pct: 0, missing: ['name', 'price', 'brand', 'type', 'description', 'gtin', 'image'] }
        const missing: string[] = []
        const checks: Array<[string, boolean]> = [
          [
            'name',
            !!p.name &&
              !p.name.toUpperCase().startsWith('NEW-') &&
              p.name !== 'Untitled product',
          ],
          [
            'price',
            p.basePrice !== null &&
              p.basePrice !== undefined &&
              Number(p.basePrice) > 0,
          ],
          ['brand', !!p.brand],
          ['type', !!p.productType],
          ['description', !!p.description && p.description.length >= 50],
          ['gtin', !!(p.gtin || p.upc || p.ean)],
          ['image', (productImageCounts.get(productId) ?? 0) > 0],
        ]
        let passed = 0
        for (const [key, ok] of checks) {
          if (ok) passed++
          else missing.push(key)
        }
        return { pct: Math.round((passed / checks.length) * 100), missing }
      }

      const wizardProductByWizardId = new Map(
        wizardRows.map((r) => [r.id, r.product] as const),
      )
      for (const w of wizardDrafts) {
        const score = scoreCompleteness(
          wizardProductByWizardId.get(w.id) ?? null,
          w.productId,
        )
        w.completenessPct = score.pct
        w.missingFactors = score.missing
      }
      const productScoringById = new Map(
        productRowsForScoring.map((p) => [p.id, p] as const),
      )
      for (const p of productDrafts) {
        const score = scoreCompleteness(
          productScoringById.get(p.productId) ?? null,
          p.productId,
        )
        p.completenessPct = score.pct
        p.missingFactors = score.missing
      }

      // Merge + sort + paginate. For wizard-only the rows already
      // reflect take/skip; we still re-sort to apply the requested
      // order, then re-slice if offset != 0 (no-op for take/skip
      // single-source). For combined sources we apply final order +
      // pagination here.
      let combined: DraftRow[] = [...wizardDrafts, ...productDrafts]
      const compareName = (a: DraftRow, b: DraftRow) =>
        (a.productName ?? '').localeCompare(b.productName ?? '')
      combined.sort((a, b) => {
        switch (sort) {
          case 'age-asc':
            return a.createdAt.getTime() - b.createdAt.getTime()
          case 'age-desc':
            return b.createdAt.getTime() - a.createdAt.getTime()
          case 'name':
            return compareName(a, b)
          case 'completion':
            // DR-S.2 — real product-data completeness as primary, then
            // wizard step (so a 100%-product wizard at step 9 beats a
            // 100%-product wizard at step 4), then recency. Was step
            // only — gave operators no signal on data quality.
            return (
              b.completenessPct - a.completenessPct ||
              (b.currentStep ?? 0) - (a.currentStep ?? 0) ||
              b.updatedAt.getTime() - a.updatedAt.getTime()
            )
          case 'recency':
          default:
            return b.updatedAt.getTime() - a.updatedAt.getTime()
        }
      })
      const total = includeProducts
        ? combined.length
        : etagCount
      // Slice for the merged path; wizard-only path already
      // pre-sliced. Re-slice combined here.
      if (includeProducts) {
        combined = combined.slice(offset, offset + limit)
      }

      return { success: true, total, drafts: combined }
    } catch (err) {
      fastify.log.error({ err }, '[listing-wizard] drafts list failed')
      return reply.code(500).send({
        success: false,
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
      const isNew = !wizard
      if (!wizard) {
        wizard = await prisma.listingWizard.create({
          data: {
            productId: body.productId,
            channels: channels as any,
            channelsHash: hash,
            currentStep: 1,
            state: {},
            status: 'DRAFT',
            // NN.14 — DRAFT wizards expire after 30 days. The cleanup
            // cron deletes anything past expiresAt that's still DRAFT;
            // SUBMITTED/LIVE/FAILED rows ignore the column. PATCH on
            // currentStep can extend expiresAt to keep active wizards
            // alive (separate effect; not done here so an abandoned
            // wizard reaches expiry naturally).
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        })
      }

      // C.0 — funnel-completeness telemetry. wizard_started fires on
      // every fresh create (regardless of step 1 advancement);
      // wizard_resumed fires when /start hits an existing DRAFT so
      // analytics can answer "do resumed wizards complete more often
      // than cold starts?". Both fire-and-forget so /start latency is
      // unaffected.
      void writeWizardEvent({
        wizardId: wizard.id,
        productId: wizard.productId,
        type: isNew ? 'wizard_started' : 'wizard_resumed',
        step: wizard.currentStep,
        errorContext: {
          channelsSucceeded: channels.length,
          fromStep: wizard.currentStep,
        },
      })

      // C.7 — surface the find-or-create discriminator so the client
      // can fire a one-shot wizard.created broadcast on fresh mounts.
      // BroadcastChannel is browser-only, so the emission has to come
      // from the client; isNew is the cleanest hint.
      return { wizard, product, isNew }
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

      const nextStep =
        typeof body.currentStep === 'number'
          ? Math.min(Math.max(body.currentStep, 1), 9)
          : wizard.currentStep

      const next = await prisma.listingWizard.update({
        where: { id: wizard.id },
        data: {
          currentStep: nextStep,
          state: merged as any,
          channelStates: mergedChannelStates as any,
          ...(channelsUpdate ?? {}),
        },
      })

      // C.0 — fire-and-forget step-transition telemetry. Telemetry
      // failures must never break the PATCH (writeStepTransition
      // swallows errors internally), so we don't await.
      if (nextStep !== wizard.currentStep) {
        void writeStepTransition({
          wizardId: wizard.id,
          productId: wizard.productId,
          fromStep: wizard.currentStep,
          toStep: nextStep,
          prevUpdatedAt: wizard.updatedAt,
        })
      }

      return { wizard: next }
    },
  )

  // ── C.0 — POST /api/listing-wizard/:id/events ─────────────────
  // Client-emitted telemetry: validation_failed, validation_passed,
  // error_shown, jumped_to_step. Fire-and-forget from the client; the
  // handler returns 204 even if the sanitizer drops the body, so the
  // wizard UX never depends on telemetry round-trip success.
  fastify.post<{
    Params: { id: string }
    Body: {
      type?: string
      step?: number
      durationMs?: number
      errorCode?: string
      errorContext?: unknown
    }
  }>('/listing-wizard/:id/events', async (request, reply) => {
    const wizard = await prisma.listingWizard.findUnique({
      where: { id: request.params.id },
      select: { id: true, productId: true },
    })
    if (!wizard) {
      return reply.code(404).send({ error: 'Wizard not found' })
    }
    const body = request.body ?? {}
    const type = body.type as WizardEventType | undefined
    if (!type || !WIZARD_EVENT_TYPES.includes(type)) {
      return reply.code(400).send({ error: 'Invalid event type' })
    }
    if (
      typeof body.step !== 'number' ||
      !Number.isInteger(body.step) ||
      body.step < 1 ||
      body.step > 9
    ) {
      return reply.code(400).send({ error: 'Invalid step' })
    }
    void writeWizardEvent({
      wizardId: wizard.id,
      productId: wizard.productId,
      type,
      step: body.step,
      durationMs:
        typeof body.durationMs === 'number' ? body.durationMs : null,
      errorCode:
        typeof body.errorCode === 'string' ? body.errorCode : null,
      errorContext: body.errorContext,
    })
    return reply.code(204).send()
  })

  // ── C.1 — GET /api/listing-wizard/:id/history ─────────────────
  // Submission history: prior submit_completed / submit_failed events
  // for this wizard. Sourced from WizardStepEvent so the trail
  // survives across retries and adapter wiring changes. Ordered
  // newest-first; UI renders the most recent N inline + "show all"
  // expand. Capped at 50 to keep response size bounded.
  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id/history',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const events = await prisma.wizardStepEvent.findMany({
        where: {
          wizardId: wizard.id,
          type: { in: ['submit_completed', 'submit_failed'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          type: true,
          step: true,
          durationMs: true,
          errorCode: true,
          errorContext: true,
          createdAt: true,
        },
      })
      return { events }
    },
  )

  // ── C.3 — POST /api/listing-wizard/drafts/bulk-delete ─────────
  // Bulk-deletes a mixed batch of drafts. Wizards are soft-deleted
  // (status='DISCARDED' + wizard_discarded telemetry) so the event
  // trail survives. Products are hard-deleted only when their
  // status is 'DRAFT' — anything ACTIVE/INACTIVE is silently
  // skipped to defend against client-side bugs that pass the wrong
  // ids. Returns counts so the UI can show "Deleted N drafts".
  fastify.post<{
    Body: { wizardIds?: string[]; productIds?: string[] }
  }>('/listing-wizard/drafts/bulk-delete', async (request, reply) => {
    const wizardIds = Array.isArray(request.body?.wizardIds)
      ? request.body.wizardIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : []
    const productIds = Array.isArray(request.body?.productIds)
      ? request.body.productIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : []
    if (wizardIds.length === 0 && productIds.length === 0) {
      return reply.code(400).send({
        error: 'wizardIds or productIds is required.',
      })
    }
    if (wizardIds.length + productIds.length > 200) {
      return reply.code(400).send({
        error: 'Bulk-delete capped at 200 entries per request.',
      })
    }

    let wizardsDiscarded = 0
    let productsDeleted = 0
    let productsSkipped = 0

    if (wizardIds.length > 0) {
      const wizards = await prisma.listingWizard.findMany({
        where: { id: { in: wizardIds }, status: 'DRAFT' },
        select: {
          id: true,
          productId: true,
          currentStep: true,
          createdAt: true,
        },
      })
      // Telemetry first; cascade-on-delete would erase events, but
      // soft-delete preserves them — write before to keep ordering
      // consistent with the per-wizard DELETE handler.
      for (const w of wizards) {
        void writeWizardEvent({
          wizardId: w.id,
          productId: w.productId,
          type: 'wizard_discarded',
          step: w.currentStep,
          durationMs: Math.max(
            0,
            Date.now() - w.createdAt.getTime(),
          ),
          errorContext: {
            fromStep: w.currentStep,
            reason: 'bulk_discard',
          },
        })
      }
      const u = await prisma.listingWizard.updateMany({
        where: { id: { in: wizards.map((w) => w.id) } },
        data: { status: 'DISCARDED', expiresAt: null },
      })
      wizardsDiscarded = u.count
    }

    if (productIds.length > 0) {
      // Defensive — only delete Products with status='DRAFT'. Anything
      // ACTIVE/INACTIVE is silently skipped (count goes into
      // productsSkipped) so the client can confirm the user-visible
      // outcome without exposing other rows.
      const eligible = await prisma.product.findMany({
        where: { id: { in: productIds }, status: 'DRAFT' },
        select: { id: true },
      })
      const eligibleIds = eligible.map((p) => p.id)
      productsSkipped = productIds.length - eligibleIds.length
      if (eligibleIds.length > 0) {
        const r = await prisma.product.deleteMany({
          where: { id: { in: eligibleIds } },
        })
        productsDeleted = r.count
      }
    }

    return reply.code(200).send({
      success: true,
      wizardsDiscarded,
      productsDeleted,
      productsSkipped,
    })
  })

  // ── C.0 — DELETE /api/listing-wizard/:id ──────────────────────
  // Soft-deletes a DRAFT wizard by flipping status to DISCARDED so
  // the row + its WizardStepEvent trail survive (cascade-on-delete
  // would erase analytics). The drafts endpoint filters status='DRAFT'
  // so DISCARDED rows are naturally hidden in the UI without further
  // changes.
  //
  // SUBMITTED / LIVE / FAILED wizards are terminal and not eligible
  // for discard — submitted listings live on the channel side and the
  // wizard row is the audit trail for them.
  fastify.delete<{ Params: { id: string } }>(
    '/listing-wizard/:id',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          productId: true,
          status: true,
          currentStep: true,
          createdAt: true,
        },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      if (wizard.status !== 'DRAFT') {
        return reply
          .code(409)
          .send({ error: `Cannot discard a ${wizard.status} wizard.` })
      }

      // Telemetry first; if the soft-delete fails the analytics
      // event is still informative (user attempted discard, may retry).
      void writeWizardEvent({
        wizardId: wizard.id,
        productId: wizard.productId,
        type: 'wizard_discarded',
        step: wizard.currentStep,
        durationMs: Math.max(
          0,
          Date.now() - wizard.createdAt.getTime(),
        ),
        errorContext: { fromStep: wizard.currentStep },
      })

      await prisma.listingWizard.update({
        where: { id: wizard.id },
        data: {
          status: 'DISCARDED',
          // Clear expiresAt so the cleanup cron's DRAFT-only sweep
          // doesn't double-process this row.
          expiresAt: null,
        },
      })

      return reply.code(204).send()
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
      refresh?: string
    }
    if (!q.channel) {
      return reply.code(400).send({ error: 'channel is required' })
    }
    try {
      const items = await productTypesService.listProductTypes({
        channel: q.channel,
        marketplace: q.marketplace ?? null,
        search: q.search,
        forceRefresh: q.refresh === '1' || q.refresh === 'true',
      })
      return { items, count: items.length }
    } catch (err) {
      // HH — classify the error so the picker UI can render the
      // right CTA. 'auth_missing' / 'auth_failed' point to Settings;
      // 'upstream' is an eBay outage retry; 'unknown' falls through
      // to a generic message.
      const msg = err instanceof Error ? err.message : String(err)
      let code: 'auth_missing' | 'auth_failed' | 'upstream' | 'unknown' =
        'unknown'
      let httpStatus = 500
      if (
        msg.includes('No eBay credentials') ||
        msg.includes('EBAY_APP_ID')
      ) {
        code = 'auth_missing'
        httpStatus = 502
      } else if (msg.startsWith('auth:') || /\b401\b|\b403\b/.test(msg)) {
        code = 'auth_failed'
        httpStatus = 502
      } else if (
        msg.startsWith('network:') ||
        msg.startsWith('eBay 5') ||
        /\b5\d{2}\b/.test(msg)
      ) {
        code = 'upstream'
        httpStatus = 502
      }
      fastify.log.error({ err, code }, '[listing-wizard] product-types failed')
      return reply.code(httpStatus).send({ error: msg, code })
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
    Body: {
      fields?: string[]
      variant?: number
      /** C.10 — caller-chosen provider (gemini | anthropic). Falls
       *  back to AI_PROVIDER env or first configured provider in the
       *  registry. Validated by getProvider() in the service. */
      provider?: string
    }
  }>(
    '/listing-wizard/:id/generate-content',
    {
      // NN.11 — AI calls cost real money + count against the
      // shared Gemini quota. Stricter per-route cap so a runaway
      // client (or power user spamming Generate on every channel)
      // can't burn the budget. 30 calls/min/IP — generous for
      // normal use, blocks the abuse case.
      config: {
        rateLimit: { max: 200, timeWindow: '1 minute' },
      },
    },
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
            // C.10 — forward caller-chosen provider. Falls back to
            // env-default + first-configured if missing/unsupported;
            // see getProvider() resolution rules.
            provider: request.body?.provider ?? null,
          })
          // H.7 — log per-field cost telemetry. Wizard groups are the
          // most expensive AI surface (one call per channel-language
          // group), so attributing them is high-leverage.
          for (const u of result.usage) {
            logUsage({
              provider: u.provider,
              model: u.model,
              feature: 'listing-wizard',
              entityType: 'Product',
              entityId: product.id,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              costUSD: u.costUSD,
              latencyMs: result.metadata.elapsedMs,
              ok: true,
              metadata: {
                marketplace: representativeMarketplace,
                fields: requested,
                groupKey,
              },
            })
          }
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
      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: { sku: true },
      })
      const channels = normalizeChannels(wizard.channels)
      const w = {
        id: wizard.id,
        productId: wizard.productId,
        channels,
        state: (wizard.state ?? {}) as Record<string, any>,
        channelStates:
          ((wizard.channelStates ?? {}) as Record<
            string,
            Record<string, any>
          >) ?? {},
        product: product ? { sku: product.sku } : undefined,
      }
      // C.1 — pre-flight readiness. AMAZON env-driven; EBAY is
      // ChannelConnection-driven. Passed to validateMultiChannel so
      // missing creds surface as a blocking checklist item rather
      // than a post-submit FAILED entry.
      const readiness: Record<string, boolean> = {
        AMAZON: amazonService.isConfigured(),
        EBAY:
          (await prisma.channelConnection.count({
            where: { channelType: 'EBAY', isActive: true },
          })) > 0,
      }
      const validation = submissionService.validateMultiChannel(w, readiness)
      const payloads = await submissionService.composeMultiChannelPayloads(w)
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
      // C.0 — capture submit start for submit_completed/submit_failed
      // duration telemetry. Read at handler entry so retries from
      // idempotency-cache hits return without polluting the analytics.
      const submitStartedAt = Date.now()

      // NN.2 — idempotency: a double-clicked Submit must not run the
      // publish orchestration twice. We dedup by Idempotency-Key
      // header (RFC 7240–style); when missing, we fall back to the
      // wizardId so accidental retries within the 10-minute window
      // still get the cached result instead of a second publish.
      const idempotencyKey =
        (request.headers['idempotency-key'] as string | undefined) ??
        `wizard:${request.params.id}`
      const cached = idempotencyService.lookup(
        'wizard-submit',
        idempotencyKey,
      )
      if (cached) {
        return cached
      }

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

      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: { sku: true },
      })
      const w = {
        id: wizard.id,
        productId: wizard.productId,
        channels,
        state: (wizard.state ?? {}) as Record<string, any>,
        channelStates:
          ((wizard.channelStates ?? {}) as Record<
            string,
            Record<string, any>
          >) ?? {},
        product: product ? { sku: product.sku } : undefined,
      }
      // C.1 — pre-flight readiness. AMAZON env-driven; EBAY is
      // ChannelConnection-driven. Passed to validateMultiChannel so
      // missing creds surface as a blocking checklist item rather
      // than a post-submit FAILED entry.
      const readiness: Record<string, boolean> = {
        AMAZON: amazonService.isConfigured(),
        EBAY:
          (await prisma.channelConnection.count({
            where: { channelType: 'EBAY', isActive: true },
          })) > 0,
      }
      const validation = submissionService.validateMultiChannel(w, readiness)
      if (!validation.allReady) {
        return reply.code(400).send({
          error: 'Wizard state has incomplete steps for some channels.',
          validation,
        })
      }

      const payloads = await submissionService.composeMultiChannelPayloads(w)
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
            productId: wizard.productId,
          }),
        ),
      )

      // E.8 — Persist any ASINs that landed in the immediate publish call to
      // ChannelListing.externalParentId + VariantChannelListing.channelProductId
      // scoped to the right marketplace. Async ASIN assignments arrive later
      // via /poll; the same write-back path handles both.
      await Promise.all(
        submissions.map(async (entry) => {
          if (entry.platform.toUpperCase() !== 'AMAZON' || !entry.parentAsin) {
            return
          }
          try {
            await submissionService.writeAsinsBack({
              productId: wizard.productId,
              marketplace: entry.marketplace,
              parentAsin: entry.parentAsin,
              childAsinByMasterSku: entry.childAsinsByMasterSku,
            })
          } catch (err) {
            request.log?.warn?.(
              { err, productId: wizard.productId, marketplace: entry.marketplace },
              'writeAsinsBack failed (post-submit)',
            )
          }
        }),
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

      // DR-C.3 — server-side wizard.submitted emit. Step10Submit
      // already broadcasts this on its end so same-browser tabs
      // refresh in <200ms; the SSE path closes the closed-source-tab
      // gap (operator clicks Submit, closes the wizard tab before
      // it polls, no other tab learns about the status flip until
      // its 30s polling tick). Only fires on the DRAFT → terminal
      // transition; idempotent re-submits don't re-flip status.
      if (
        wizard.status === 'DRAFT' &&
        (overallStatus === 'SUBMITTED' ||
          overallStatus === 'LIVE' ||
          overallStatus === 'FAILED')
      ) {
        publishListingEvent({
          type: 'wizard.submitted',
          wizardId: wizard.id,
          productId: wizard.productId,
          status: overallStatus,
          ts: Date.now(),
        })
      }

      // C.1 — emit `listing.created` per submission that produced a
      // real channel listing. Today every adapter returns
      // NOT_IMPLEMENTED so this loop fires zero events; once C.6
      // (Amazon SP-API putListingsItem) and C.7 (eBay AddItem) land,
      // LIVE / SUBMITTED entries with a submissionId will broadcast
      // automatically — no follow-up edit needed in the wizard route.
      // We pick LIVE and SUBMITTED-with-id: a SUBMITTED entry has been
      // accepted by the channel and is just awaiting indexing, so the
      // listing has effectively been "created" from the user's POV.
      for (const sub of submissions) {
        const acknowledged =
          sub.status === 'LIVE' ||
          (sub.status === 'SUBMITTED' && !!sub.submissionId)
        if (!acknowledged) continue
        publishListingEvent({
          type: 'listing.created',
          listingId: sub.submissionId ?? `${wizard.id}:${sub.channelKey}`,
          ts: Date.now(),
        })
      }

      // C.0 — submit funnel telemetry. submit_completed when every
      // entry landed (SUBMITTED or LIVE); submit_failed when one or
      // more terminal-failed. Mid-flight statuses (NOT_IMPLEMENTED
      // adapters in v1) count as completed for the wizard, since the
      // user finished their part — adapter readiness is tracked
      // separately on the submissions array.
      const channelsSucceeded = submissions.filter(
        (s) => s.status !== 'FAILED',
      ).length
      const channelsFailed = submissions.filter(
        (s) => s.status === 'FAILED',
      ).length
      void writeWizardEvent({
        wizardId: wizard.id,
        productId: wizard.productId,
        type: channelsFailed === 0 ? 'submit_completed' : 'submit_failed',
        step: 9,
        durationMs: Date.now() - submitStartedAt,
        errorContext: {
          channelsSucceeded,
          channelsFailed,
          totalDurationMs: Date.now() - submitStartedAt,
        },
      })

      const responseBody = {
        wizard: {
          id: updated.id,
          status: updated.status,
          completedAt: updated.completedAt,
        },
        submissions,
        validation,
        payloads,
      }
      // NN.2 — store the full response under the idempotency key so
      // a duplicate submit within 10 min returns identical bytes.
      idempotencyService.store(
        'wizard-submit',
        idempotencyKey,
        responseBody,
      )
      return responseBody
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

      // E.8 — Poll context: re-compose payloads so the poll path knows the
      // marketplace-scoped parent + child SKUs and the SP-API marketplaceId.
      // One Promise.all per the same wizard so the resolution is one round.
      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: { sku: true },
      })
      const w = {
        id: wizard.id,
        channels: (wizard.channels ?? []) as Array<{
          platform: string
          marketplace: string
        }>,
        state: (wizard.state ?? {}) as Record<string, any>,
        channelStates:
          ((wizard.channelStates ?? {}) as Record<
            string,
            Record<string, any>
          >) ?? {},
        product: product ? { sku: product.sku } : undefined,
      }
      const payloads = await submissionService.composeMultiChannelPayloads(w)
      const payloadByKey = new Map(
        payloads.map((p) => [p.channelKey, p] as const),
      )

      const polled = await Promise.all(
        current.map((entry) => {
          const p = payloadByKey.get(entry.channelKey)
          const amazonPayload = p?.payload as
            | {
                parentSku?: string
                marketplaceId?: string
                children?: Array<{
                  masterSku: string
                  channelSku: string
                }>
              }
            | undefined
          return channelPublishService.pollStatus(
            entry,
            entry.platform.toUpperCase() === 'AMAZON' && amazonPayload
              ? {
                  parentSku: amazonPayload.parentSku,
                  marketplaceId: amazonPayload.marketplaceId,
                  childMasterSkus: amazonPayload.children?.map((c) => ({
                    masterSku: c.masterSku,
                    channelSku: c.channelSku,
                  })),
                }
              : undefined,
          )
        }),
      )

      // E.8 — Persist any new ASINs surfaced by the poll.
      await Promise.all(
        polled.map(async (entry) => {
          if (entry.platform.toUpperCase() !== 'AMAZON' || !entry.parentAsin) {
            return
          }
          try {
            await submissionService.writeAsinsBack({
              productId: wizard.productId,
              marketplace: entry.marketplace,
              parentAsin: entry.parentAsin,
              childAsinByMasterSku: entry.childAsinsByMasterSku,
            })
          } catch (err) {
            request.log?.warn?.(
              { err, productId: wizard.productId, marketplace: entry.marketplace },
              'writeAsinsBack failed (post-poll)',
            )
          }
        }),
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

      // DR-C.3 — same DRAFT → terminal guard as /submit. /poll can
      // legitimately flip a SUBMITTED → LIVE on its own; we only emit
      // when the status leaves DRAFT (covers the case where the
      // initial /submit returned NOT_IMPLEMENTED for every channel,
      // leaving the wizard.status as DRAFT, and a later /poll lifts
      // one channel into SUBMITTED-with-id).
      if (
        wizard.status === 'DRAFT' &&
        (overallStatus === 'SUBMITTED' ||
          overallStatus === 'LIVE' ||
          overallStatus === 'FAILED')
      ) {
        publishListingEvent({
          type: 'wizard.submitted',
          wizardId: wizard.id,
          productId: wizard.productId,
          status: overallStatus,
          ts: Date.now(),
        })
      }

      // C.1 — emit `listing.created` for entries that newly transitioned
      // into an acknowledged state during this poll cycle. Today the
      // pollStatus implementations are no-ops (NOT_IMPLEMENTED), so the
      // diff is empty and no events fire. When real pollers land, every
      // SUBMITTED → LIVE / SUBMITTED-with-id transition will broadcast
      // automatically.
      const previousByKey = new Map(
        current.map((e) => [e.channelKey, e] as const),
      )
      for (const sub of polled) {
        const prev = previousByKey.get(sub.channelKey)
        const wasAcknowledged =
          prev?.status === 'LIVE' ||
          (prev?.status === 'SUBMITTED' && !!prev.submissionId)
        const isAcknowledged =
          sub.status === 'LIVE' ||
          (sub.status === 'SUBMITTED' && !!sub.submissionId)
        if (!wasAcknowledged && isAcknowledged) {
          publishListingEvent({
            type: 'listing.created',
            listingId: sub.submissionId ?? `${wizard.id}:${sub.channelKey}`,
            ts: Date.now(),
          })
        }
      }

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
      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: { sku: true },
      })
      const w = {
        id: wizard.id,
        productId: wizard.productId,
        channels,
        state: (wizard.state ?? {}) as Record<string, any>,
        channelStates:
          ((wizard.channelStates ?? {}) as Record<
            string,
            Record<string, any>
          >) ?? {},
        product: product ? { sku: product.sku } : undefined,
      }
      const payloadByKey = new Map<
        string,
        Awaited<
          ReturnType<typeof submissionService.composeMultiChannelPayloads>
        >[number]
      >()
      for (const p of await submissionService.composeMultiChannelPayloads(w)) {
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
          productId: wizard.productId,
        })
        updatedSubmissions.push(next)

        // Audit-fix #2 — persist any ASIN that landed inline on this retry.
        // Without this the retried channel held a fresh ASIN on the in-memory
        // entry but never got it written to ChannelListing/VariantChannelListing,
        // forcing /poll to re-discover it (or never, if the SP-API GET also
        // failed in the same way). Mirrors the /submit and /poll routes.
        if (next.platform.toUpperCase() === 'AMAZON' && next.parentAsin) {
          try {
            await submissionService.writeAsinsBack({
              productId: wizard.productId,
              marketplace: next.marketplace,
              parentAsin: next.parentAsin,
              childAsinByMasterSku: next.childAsinsByMasterSku,
            })
          } catch (err) {
            request.log?.warn?.(
              { err, productId: wizard.productId, marketplace: next.marketplace },
              'writeAsinsBack failed (post-retry)',
            )
          }
        }
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

      // C.1 — same diff-based emit as /poll: a retry that finally lands
      // a previously-failed channel is also a "listing.created" moment.
      const previousByKey = new Map(
        current.map((e) => [e.channelKey, e] as const),
      )
      for (const sub of updatedSubmissions) {
        if (!wantedKeys.has(sub.channelKey)) continue
        const prev = previousByKey.get(sub.channelKey)
        const wasAcknowledged =
          prev?.status === 'LIVE' ||
          (prev?.status === 'SUBMITTED' && !!prev.submissionId)
        const isAcknowledged =
          sub.status === 'LIVE' ||
          (sub.status === 'SUBMITTED' && !!sub.submissionId)
        if (!wasAcknowledged && isAcknowledged) {
          publishListingEvent({
            type: 'listing.created',
            listingId: sub.submissionId ?? `${wizard.id}:${sub.channelKey}`,
            ts: Date.now(),
          })
        }
      }

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

      // Q.5 — per-listing productType override stored in
      // platformAttributes.productType wins over the master product's
      // productType. Lets sellers list the same product under different
      // Amazon categories per marketplace.
      const platformAttrs =
        (listing?.platformAttributes as Record<string, any> | null) ?? null
      const listingProductType =
        platformAttrs && typeof platformAttrs.productType === 'string'
          ? platformAttrs.productType
          : null
      const productType = listingProductType || product.productType || ''
      if (!productType) {
        return reply.code(409).send({
          error:
            'No product type set on the master product. Pick a product type before configuring channel attributes.',
        })
      }

      // Seed baseAttributes from the existing listing so the editor
      // shows what's currently saved.
      const baseAttributes: Record<string, unknown> = {}
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

      // Z.2 — eBay branch. eBay's per-category aspects are the
      // equivalent of Amazon's CategorySchema; they describe required
      // + recommended fields with data types and enum values, which
      // we adapt into the same UnionField/UnionManifest shape so the
      // frontend renders eBay tabs with the same editor it uses for
      // Amazon.
      const upperChannel = channel.toUpperCase()
      if (upperChannel === 'EBAY') {
        try {
          // GG.1 — fetch aspects + condition policy in parallel; the
          // condition is a synthesized field on top of the per-category
          // aspect schema so the user gets a category-correct dropdown.
          const marketplaceId = `EBAY_${marketplace.toUpperCase()}`
          const [aspects, conditions] = await Promise.all([
            ebayCategoryService.getCategoryAspectsRich(
              productType,
              marketplace,
              {
                forceRefresh: refresh === '1' || refresh === 'true',
                throwOnError: true,
              },
            ),
            ebayCategoryService
              .getItemConditionPolicies(productType, marketplaceId)
              .catch(() => []),
          ])
          const channelKey = `${upperChannel}:${marketplace.toUpperCase()}`
          const aspectFields = ebayAspectsToUnionFields(
            aspects,
            baseAttributes,
            channelKey,
          )
          const conditionField =
            conditions.length > 0
              ? [
                  {
                    id: 'condition',
                    label: 'Condition',
                    kind: 'enum',
                    required: true,
                    wrapped: false,
                    options: conditions.map((c) => ({
                      value: c.conditionId,
                      label: c.conditionDescription,
                    })),
                    requiredFor: [channelKey],
                    optionalFor: [],
                    notUsedIn: [],
                    currentValue:
                      typeof baseAttributes['condition'] === 'string' ||
                      typeof baseAttributes['condition'] === 'number'
                        ? (baseAttributes['condition'] as string | number)
                        : undefined,
                    overrides: {},
                    variantEligible: false,
                  },
                ]
              : []
          const fields = [...conditionField, ...aspectFields]
          return {
            channels: [
              { platform: upperChannel, marketplace, productType },
            ],
            schemaVersionByChannel: {
              [channelKey]: 'ebay-aspects-v1',
            },
            fetchedAtByChannel: {
              [channelKey]: new Date().toISOString(),
            },
            fields,
            channelsMissingSchema: aspects.length === 0
              ? [
                  {
                    channelKey,
                    reason: 'fetch_failed',
                    detail:
                      'eBay returned no aspects for this category. Either link an eBay account in /settings/channels (preferred) or set real EBAY_APP_ID + EBAY_CERT_ID env vars, and confirm the categoryId is a leaf node for this marketplace.',
                  },
                ]
              : [],
            variations: [],
            optionalFieldCount: fields.filter(
              (f) => !f.requiredFor.includes(channelKey),
            ).length,
            includesAllOptional: true,
          }
        } catch (err) {
          // HH — same error classification as the product-types route
          // so the wizard's Step 4 surfaces a Connect-eBay CTA on auth
          // problems instead of a blank manifest.
          const msg = err instanceof Error ? err.message : String(err)
          let code:
            | 'auth_missing'
            | 'auth_failed'
            | 'upstream'
            | 'unknown' = 'unknown'
          let httpStatus = 500
          if (
            msg.includes('No eBay credentials') ||
            msg.includes('EBAY_APP_ID')
          ) {
            code = 'auth_missing'
            httpStatus = 502
          } else if (msg.startsWith('auth:') || /\b401\b|\b403\b/.test(msg)) {
            code = 'auth_failed'
            httpStatus = 502
          } else if (
            msg.startsWith('network:') ||
            msg.startsWith('eBay 5') ||
            /\b5\d{2}\b/.test(msg)
          ) {
            code = 'upstream'
            httpStatus = 502
          }
          fastify.log.error(
            { err, code },
            '[products/listings/schema EBAY] failed',
          )
          return reply.code(httpStatus).send({ error: msg, code })
        }
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

  // Q.9 — product-scoped content generation for the edit page.
  // Mirrors /listing-wizard/:id/generate-content but takes the
  // (productId, channel, marketplace) tuple directly so the
  // ChannelFieldEditor's Translate button has a place to call.
  // Response shape matches the wizard endpoint for frontend reuse:
  //   { groups: [{ result, channelKeys, ... }], byChannel: {...} }
  fastify.post<{
    Params: { id: string }
    Body: {
      fields?: string[]
      channel?: string
      marketplace?: string
      variant?: number
    }
  }>(
    '/products/:id/generate-content',
    {
      // NN.11 — same per-route cap as the wizard's generate-content
      // endpoint. AI calls cost real money; 30/min/IP is generous
      // for legit use and blocks runaway clients.
      config: {
        rateLimit: { max: 200, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      if (!listingContentService.isConfigured()) {
        return reply.code(503).send({
          error:
            'Gemini API not configured — set GEMINI_API_KEY on the API server.',
        })
      }
      const { id } = request.params
      const channel = (request.body?.channel ?? '').toUpperCase()
      const marketplace = (request.body?.marketplace ?? '').toUpperCase()
      if (!channel || !marketplace) {
        return reply.code(400).send({
          error: 'channel and marketplace are required',
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
        where: { id },
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
        return reply.code(404).send({ error: `Product ${id} not found` })
      }
      const channelKey = `${channel}:${marketplace}`
      const language = languageForMarketplace(marketplace)
      const variant =
        typeof request.body?.variant === 'number'
          ? Math.max(0, Math.min(4, request.body.variant))
          : 0
      try {
        const terminology = await prisma.terminologyPreference.findMany({
          where: {
            marketplace,
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
            weightValue: product.weightValue ? Number(product.weightValue) : null,
            weightUnit: product.weightUnit,
            dimLength: product.dimLength ? Number(product.dimLength) : null,
            dimWidth: product.dimWidth ? Number(product.dimWidth) : null,
            dimHeight: product.dimHeight ? Number(product.dimHeight) : null,
            dimUnit: product.dimUnit,
            productType: product.productType,
            variantAttributes: product.variantAttributes,
            categoryAttributes: product.categoryAttributes,
          },
          marketplace,
          fields: requested,
          variant,
          terminology,
        })
        const group = {
          groupKey: `${language}:${channel}`,
          platform: channel,
          language,
          marketplaces: [marketplace],
          channelKeys: [channelKey],
          result,
        }
        return {
          groups: [group],
          byChannel: { [channelKey]: result },
        }
      } catch (err) {
        fastify.log.error(
          { err },
          '[products/generate-content] failed',
        )
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  // Q.7 — single-channel GTIN status for the product-edit page. Same
  // resolution rules as /listing-wizard/:id/gtin-status but scoped to
  // one (productId, channel, marketplace) — non-Amazon channels return
  // needed=false.
  fastify.get<{
    Params: { id: string; channel: string; marketplace: string }
  }>(
    '/products/:id/listings/:channel/:marketplace/gtin-status',
    async (request, reply) => {
      const { id, channel, marketplace } = request.params
      if (channel.toUpperCase() !== 'AMAZON') {
        return { needed: false, reason: 'non_amazon_channel' }
      }
      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true, brand: true, gtin: true, upc: true, ean: true, productType: true },
      })
      if (!product) {
        return reply.code(404).send({ error: `Product ${id} not found` })
      }
      const hasIdentifier = !!(product.gtin || product.upc || product.ean)
      if (hasIdentifier) {
        return {
          needed: false,
          reason: 'has_gtin',
          identifier: product.gtin ?? product.upc ?? product.ean ?? null,
        }
      }
      if (!product.brand) {
        return { needed: true, reason: 'needed' }
      }
      // Per-listing productType override wins — same resolution as the
      // schema endpoint above.
      const listing = await prisma.channelListing.findFirst({
        where: { productId: id, channel, marketplace },
        select: { platformAttributes: true },
      })
      const platformAttrs =
        (listing?.platformAttributes as Record<string, any> | null) ?? null
      const productType =
        (platformAttrs && typeof platformAttrs.productType === 'string'
          ? platformAttrs.productType
          : null) ??
        product.productType ??
        null
      if (!productType) {
        return { needed: true, reason: 'no_product_type' }
      }

      const exemptions = await prisma.gtinExemptionApplication.findMany({
        where: {
          brandName: product.brand,
          marketplace,
        },
        orderBy: { updatedAt: 'desc' },
      })

      const approved = exemptions.find(
        (e) =>
          e.status === 'APPROVED' &&
          (e.productType === null || e.productType === productType),
      )
      if (approved) {
        return {
          needed: false,
          reason: 'existing_exemption',
          applicationId: approved.id,
        }
      }
      const pending = exemptions.find(
        (e) =>
          (e.productType === null || e.productType === productType) &&
          (e.status === 'SUBMITTED' ||
            e.status === 'PACKAGE_READY' ||
            e.status === 'DRAFT'),
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
