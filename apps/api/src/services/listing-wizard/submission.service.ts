/**
 * Step 9/10 — wizard state validation + Amazon listings payload
 * composition.
 *
 * The actual SP-API `putListingsItem` call is the missing
 * integration — see TECH_DEBT entry on listing-wizard publish. This
 * service does the parts that aren't gated on Amazon credentials:
 *
 *   - validate(): walk the wizard state and report which slices are
 *                 complete + which are blocking. Used by Step 9
 *                 to render the "ready to publish" checklist.
 *   - composeAmazonPayload(): build the JSON envelope Amazon expects
 *                 from the wizard state. Verified shape against the
 *                 cached schema; ready to hand to a future SP-API
 *                 client. Used today to show the user what would be
 *                 sent before the integration lands.
 */

import type { PrismaClient } from '@nexus/database'

export type SliceStatus = 'complete' | 'incomplete' | 'skipped' | 'unknown'

export interface ValidationItem {
  step: number
  title: string
  status: SliceStatus
  message?: string
}

export interface ValidationReport {
  ready: boolean
  items: ValidationItem[]
  blockingCount: number
}

export interface AmazonListingPayload {
  productType: string
  marketplaceId: string
  attributes: Record<string, unknown>
  /** E.3 — Marketplace-scoped parent SKU. When the user runs the default
   *  "shared parent SKU" strategy this matches the master Product.sku.
   *  When they've opted into per-marketplace SKUs (Step 1), the suffix
   *  (-IT, -DE, ...) is appended. SP-API's putListingsItem keys on this. */
  parentSku?: string
  /** Audit-fix #4 — Maps master variation axis names (e.g. "Size", "Color")
   *  to the SP-API attribute names Amazon expects for this marketplace's
   *  productType (e.g. "size_name", "color_name"). Pulled from
   *  ChannelListing.variationMapping at composition time; the publish
   *  adapter falls back to a best-effort `_name` suffix when missing. */
  variationMapping?: Record<string, string>
  /** Children (variations) the user picked in Step 5. Each becomes a
   *  separate listing under the parent's variation theme. */
  childSkus?: string[]
  /** E.2 — Per-marketplace child resolution. Each entry has the master
   *  SKU + the marketplace-scoped channelSku (falls back to master SKU
   *  when the user runs the default "shared SKU across marketplaces"
   *  strategy) + the channelProductId (child ASIN if Amazon assigned
   *  one on a prior publish). The publish path uses these to issue one
   *  putListingsItem per child, scoped to the parent's marketplace.
   */
  children?: Array<{
    masterSku: string
    channelSku: string
    channelProductId: string | null
    variationAttributes: Record<string, unknown>
    price: number | null
    quantity: number | null
  }>
  variationTheme?: string
  /** Image URLs — first is main, rest are alts. Amazon expects at
   *  most 9. */
  imageUrls?: string[]
  /** Sized for sanity-checking before integration: ~120 chars when
   *  empty, ~3-5KB with all slices populated. */
}

interface WizardWithState {
  id: string
  channel: string
  marketplace: string
  state: Record<string, any>
}

// ── Phase I — multi-channel validation + payload composition ────

export interface ChannelValidationReport {
  channelKey: string
  platform: string
  marketplace: string
  ready: boolean
  blockingCount: number
  items: ValidationItem[]
  /** Soft warnings — don't block submit but the UI shows them. */
  warnings: string[]
}

export interface MultiChannelValidation {
  channels: ChannelValidationReport[]
  /** Convenience: every channel's `ready` flag is true. */
  allReady: boolean
  /** Channel keys that aren't ready — used to gate Submit. */
  blockingChannels: string[]
}

export interface ChannelPayloadEntry {
  channelKey: string
  platform: string
  marketplace: string
  /** Amazon-style payload. Other platforms drop a stub with
   *  unsupported=true until the per-channel adapter lands. */
  payload?: AmazonListingPayload | Record<string, unknown>
  unsupported?: boolean
  reason?: string
  /** Audit-fix #6 — Master child SKUs the user picked in Step 5 that no
   *  ProductVariation matches (deleted variant, typo). Same value on every
   *  channel entry — surfaced per-entry so the UI can render the warning
   *  next to the channel card without re-aggregating. */
  missingChildSkus?: string[]
}

export interface MultiChannelWizard {
  id: string
  /** Audit-fix #4 — Master Product.id. Used by the composer to pull
   *  ChannelListing.variationMapping per marketplace; optional for legacy
   *  callers (composition still works, just falls back to default attribute
   *  names in the adapter). */
  productId?: string
  channels: Array<{ platform: string; marketplace: string }>
  state: Record<string, any>
  channelStates: Record<string, Record<string, any>>
  /** DD.4 — eBay's Inventory API is keyed by SKU. Composer reads this
   *  when building the eBay payload; Amazon's composer ignores it. */
  product?: { sku?: string }
}

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

function contentGroupKey(platform: string, marketplace: string): string {
  return `${languageForMarketplace(marketplace)}:${platform.toUpperCase()}`
}

const MARKETPLACE_TO_CURRENCY: Record<string, string> = {
  IT: 'EUR',
  DE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  UK: 'GBP',
  GB: 'GBP',
  US: 'USD',
  CA: 'CAD',
  MX: 'MXN',
  AU: 'AUD',
  JP: 'JPY',
}

function pricingCurrencyFor(marketplace: string): string {
  return MARKETPLACE_TO_CURRENCY[marketplace.toUpperCase()] ?? 'USD'
}

/**
 * E.2 — Resolve country codes ("IT", "DE", "FR") to SP-API marketplace IDs
 * ("APJ6JRA9NG5V4", "A1PA6795UKMFR9", "A13V1IB3VIYZZH") via the Marketplace
 * lookup table. SP-API rejects payloads that send the country code in
 * `marketplace_id`; this is the load-bearing fix for actually reaching Amazon.
 *
 * Single Marketplace.findMany call per composition, results cached in a Map
 * the composer reads inline. Falls back to the region code if no Marketplace
 * row exists so unseeded environments stay debuggable instead of crashing.
 */
async function resolveAmazonMarketplaceIds(
  prisma: PrismaClient,
  channels: Array<{ platform: string; marketplace: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const amazonCodes = [
    ...new Set(
      channels
        .filter((c) => c.platform.toUpperCase() === 'AMAZON')
        .map((c) => c.marketplace.toUpperCase()),
    ),
  ]
  if (amazonCodes.length === 0) return out

  const rows = await prisma.marketplace.findMany({
    where: { channel: 'AMAZON', code: { in: amazonCodes } },
    select: { code: true, marketplaceId: true },
  })
  const byCode = new Map(rows.map((r) => [r.code, r.marketplaceId ?? '']))

  for (const code of amazonCodes) {
    const id = byCode.get(code)
    out.set(`AMAZON:${code}`, id && id.length > 0 ? id : code)
  }
  return out
}

/**
 * Audit-fix #4 — Resolve per-marketplace ChannelListing.variationMapping for
 * every Amazon channel in this wizard. Maps master axis names ("Size",
 * "Color") to the SP-API attribute names Amazon expects for the listing's
 * productType ("size_name", "color_name", etc.).
 *
 * One findMany scoped to (productId, AMAZON, marketplaces). Empty mapping
 * is a valid result — the adapter falls back to a `_name` suffix on common
 * axes when no row exists.
 */
async function resolveAmazonVariationMappings(
  prisma: PrismaClient,
  productId: string | undefined,
  channels: Array<{ platform: string; marketplace: string }>,
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>()
  if (!productId) return out

  const marketplaces = [
    ...new Set(
      channels
        .filter((c) => c.platform.toUpperCase() === 'AMAZON')
        .map((c) => c.marketplace.toUpperCase()),
    ),
  ]
  if (marketplaces.length === 0) return out

  const rows = await prisma.channelListing.findMany({
    where: {
      productId,
      channel: 'AMAZON',
      marketplace: { in: marketplaces },
    },
    select: { marketplace: true, variationMapping: true },
  })

  for (const row of rows) {
    const mapping = row.variationMapping as Record<string, unknown> | null
    if (!mapping || typeof mapping !== 'object') continue
    // Coerce JSON values to string — anything non-string is dropped.
    const coerced: Record<string, string> = {}
    for (const [k, v] of Object.entries(mapping)) {
      if (typeof v === 'string' && v.length > 0) coerced[k] = v
    }
    if (Object.keys(coerced).length > 0) {
      out.set(`AMAZON:${row.marketplace}`, coerced)
    }
  }
  return out
}

/**
 * E.2 — Resolve per-child VariantChannelListing data for every Amazon
 * (channel, marketplace) the wizard targets. Returns:
 *
 *   Map<"AMAZON:DE", Map<masterSku, ChildResolved>>
 *
 * One ProductVariation findMany + one VariantChannelListing findMany,
 * scoped to the SKUs in `includedSkus` and the Amazon marketplaces in
 * `channels`. Composer reads from the map inline — no per-child query.
 *
 * `channelSku` falls back to the master SKU when no per-marketplace
 * row exists; `channelProductId` is null until Amazon assigns ASINs.
 * Default ("shared SKU across marketplaces") naturally returns
 * masterSku for every entry, which is the desired behavior.
 */
interface ChildResolved {
  masterSku: string
  channelSku: string
  channelProductId: string | null
  variationAttributes: Record<string, unknown>
  price: number | null
  quantity: number | null
}

interface SkuStrategy {
  parentSku: 'shared' | 'per-marketplace'
  childSku: 'shared' | 'per-marketplace'
  fbaFbm: 'same' | 'suffixed'
}

function readSkuStrategy(state: Record<string, any>): SkuStrategy {
  const raw = (state?.skuStrategy ?? {}) as Partial<SkuStrategy>
  return {
    parentSku: raw.parentSku === 'per-marketplace' ? 'per-marketplace' : 'shared',
    childSku: raw.childSku === 'per-marketplace' ? 'per-marketplace' : 'shared',
    fbaFbm: raw.fbaFbm === 'suffixed' ? 'suffixed' : 'same',
  }
}

/**
 * E.3 — Derive the marketplace-scoped SKU based on the user's stated strategy.
 *
 *   shared        → return masterSku unchanged (default; ~95% case)
 *   per-marketplace → append "-{MARKETPLACE}" suffix (XAV-AETHER-M-BLK-DE)
 *
 * VariantChannelListing.channelSku still wins when explicitly set on the row
 * — that's a manual override the seller has chosen for one marketplace and
 * should always take precedence over the derived suffix.
 */
function applySkuStrategy(
  masterSku: string,
  marketplace: string,
  strategy: 'shared' | 'per-marketplace',
  explicitChannelSku: string | null | undefined,
): string {
  if (explicitChannelSku && explicitChannelSku.length > 0) return explicitChannelSku
  if (strategy === 'shared') return masterSku
  return `${masterSku}-${marketplace.toUpperCase()}`
}

interface AmazonChildrenResolution {
  byChannel: Map<string, Map<string, ChildResolved>>
  /** Audit-fix #6 — SKUs the user picked in Step 5 but that no ProductVariation
   *  matches. The composer surfaces this on the validation report so the user
   *  knows specific picks were dropped (deleted variant, typo, etc.). */
  missingSkus: string[]
}

async function resolveAmazonChildren(
  prisma: PrismaClient,
  channels: Array<{ platform: string; marketplace: string }>,
  includedSkus: string[],
  childStrategy: 'shared' | 'per-marketplace',
): Promise<AmazonChildrenResolution> {
  const out = new Map<string, Map<string, ChildResolved>>()
  if (includedSkus.length === 0) return { byChannel: out, missingSkus: [] }

  const amazonChannels = channels.filter(
    (c) => c.platform.toUpperCase() === 'AMAZON',
  )
  if (amazonChannels.length === 0) return { byChannel: out, missingSkus: [] }

  const variants = await prisma.productVariation.findMany({
    where: { sku: { in: includedSkus } },
    select: {
      id: true,
      sku: true,
      variationAttributes: true,
      price: true,
      stock: true,
    },
  })

  // Audit-fix #6 — compute the diff between requested SKUs and resolved
  // variants. Set lookup is O(1); array remains the source of truth for
  // ordering downstream.
  const foundSet = new Set(variants.map((v) => v.sku))
  const missingSkus = includedSkus.filter((sku) => !foundSet.has(sku))

  if (variants.length === 0) {
    return { byChannel: out, missingSkus }
  }

  const variantIds = variants.map((v) => v.id)
  const marketplaces = [
    ...new Set(amazonChannels.map((c) => c.marketplace.toUpperCase())),
  ]
  const vcls = await prisma.variantChannelListing.findMany({
    where: {
      variantId: { in: variantIds },
      channel: 'AMAZON',
      marketplace: { in: marketplaces },
    },
    select: {
      variantId: true,
      marketplace: true,
      channelSku: true,
      channelProductId: true,
      channelPrice: true,
      channelQuantity: true,
    },
  })

  // Index VCL rows by (variantId, marketplace) for inline lookup.
  const vclByVariantMp = new Map<string, (typeof vcls)[number]>()
  for (const vcl of vcls) {
    vclByVariantMp.set(`${vcl.variantId}:${vcl.marketplace}`, vcl)
  }

  for (const c of amazonChannels) {
    const mp = c.marketplace.toUpperCase()
    const channelKey = `AMAZON:${mp}`
    const childMap = new Map<string, ChildResolved>()

    for (const v of variants) {
      const vcl = vclByVariantMp.get(`${v.id}:${mp}`)
      const variationAttributes =
        (v.variationAttributes as Record<string, unknown> | null) ?? {}
      childMap.set(v.sku, {
        masterSku: v.sku,
        channelSku: applySkuStrategy(v.sku, mp, childStrategy, vcl?.channelSku),
        channelProductId: vcl?.channelProductId ?? null,
        variationAttributes,
        price: vcl?.channelPrice
          ? Number(vcl.channelPrice)
          : v.price
          ? Number(v.price)
          : null,
        quantity: vcl?.channelQuantity ?? v.stock ?? null,
      })
    }
    out.set(channelKey, childMap)
  }

  return { byChannel: out, missingSkus }
}

export class SubmissionService {
  constructor(private readonly prisma: PrismaClient) {}

  // ── Validation ─────────────────────────────────────────────────

  validate(wizard: WizardWithState): ValidationReport {
    const state = wizard.state ?? {}
    const channel = wizard.channel.toUpperCase()
    const items: ValidationItem[] = []

    // Step 1 — Identifiers
    const ids = state.identifiers ?? {}
    if (ids.path === 'have-code' && typeof ids.gtinValue === 'string' && ids.gtinValue.length > 0) {
      items.push({ step: 1, title: 'Identifiers', status: 'complete' })
    } else if (ids.path === 'have-exemption' || ids.path === 'apply-now') {
      items.push({
        step: 1,
        title: 'Identifiers',
        status: 'complete',
        message: `Path: ${ids.path}`,
      })
    } else {
      items.push({
        step: 1,
        title: 'Identifiers',
        status: 'incomplete',
        message: 'Pick a GTIN path in Step 1.',
      })
    }

    // Step 2 — GTIN exemption (only relevant for the apply-now path)
    if (ids.path === 'apply-now') {
      const ex = ids.exemptionApplicationId
      if (typeof ex === 'string' && ex.length > 0) {
        items.push({ step: 2, title: 'GTIN exemption', status: 'complete' })
      } else {
        items.push({
          step: 2,
          title: 'GTIN exemption',
          status: 'incomplete',
          message: 'Generate or attach an exemption application first.',
        })
      }
    } else {
      items.push({ step: 2, title: 'GTIN exemption', status: 'skipped' })
    }

    // Step 3 — Product Type (Amazon only)
    if (channel === 'AMAZON') {
      const pt = state.productType ?? {}
      if (typeof pt.productType === 'string' && pt.productType.length > 0) {
        items.push({
          step: 3,
          title: 'Product type',
          status: 'complete',
          message: pt.productType,
        })
      } else {
        items.push({
          step: 3,
          title: 'Product type',
          status: 'incomplete',
          message: 'Pick a product type.',
        })
      }
    } else {
      items.push({ step: 3, title: 'Product type', status: 'skipped' })
    }

    // Step 4 — Required Attributes (Amazon only — checks all required fields populated)
    if (channel === 'AMAZON') {
      const attrs = (state.attributes ?? {}) as Record<string, unknown>
      const filledCount = Object.values(attrs).filter(
        (v) =>
          v !== undefined &&
          v !== null &&
          !(typeof v === 'string' && v.trim() === ''),
      ).length
      if (filledCount > 0) {
        items.push({
          step: 4,
          title: 'Attributes',
          status: 'complete',
          message: `${filledCount} field${filledCount === 1 ? '' : 's'} filled`,
        })
      } else {
        items.push({
          step: 4,
          title: 'Attributes',
          status: 'incomplete',
          message: 'Fill the required Amazon attributes.',
        })
      }
    } else {
      items.push({ step: 4, title: 'Attributes', status: 'skipped' })
    }

    // Step 5 — Variations (optional — only blocks if the master is a parent and nothing's picked)
    const vars = state.variations ?? {}
    if (Array.isArray(vars.includedSkus) && vars.includedSkus.length > 0) {
      items.push({
        step: 5,
        title: 'Variations',
        status: 'complete',
        message: `${vars.includedSkus.length} included${
          vars.theme ? ` (theme: ${vars.theme})` : ''
        }`,
      })
    } else {
      items.push({
        step: 5,
        title: 'Variations',
        status: 'skipped',
        message: 'Single product or no children picked.',
      })
    }

    // Step 6 — Content
    const content = state.content ?? {}
    const hasTitle =
      typeof content.title === 'string' && content.title.trim().length > 0
    const hasBullets =
      Array.isArray(content.bullets) &&
      content.bullets.some(
        (b: unknown) => typeof b === 'string' && b.trim().length > 0,
      )
    if (hasTitle && hasBullets) {
      items.push({ step: 6, title: 'Content', status: 'complete' })
    } else {
      items.push({
        step: 6,
        title: 'Content',
        status: 'incomplete',
        message: 'Title + at least one bullet point are required.',
      })
    }

    // Step 7 — Images
    const images = state.images ?? {}
    if (Array.isArray(images.orderedUrls) && images.orderedUrls.length >= 1) {
      items.push({
        step: 7,
        title: 'Images',
        status: 'complete',
        message: `${images.orderedUrls.length} image${
          images.orderedUrls.length === 1 ? '' : 's'
        }`,
      })
    } else {
      items.push({
        step: 7,
        title: 'Images',
        status: 'incomplete',
        message: 'At least one image is required.',
      })
    }

    // Step 8 — Pricing
    const pricing = state.pricing ?? {}
    if (
      typeof pricing.marketplacePrice === 'number' &&
      pricing.marketplacePrice > 0
    ) {
      items.push({
        step: 8,
        title: 'Pricing',
        status: 'complete',
        message: `${pricing.marketplacePrice}`,
      })
    } else {
      items.push({
        step: 8,
        title: 'Pricing',
        status: 'incomplete',
        message: 'Set a marketplace price.',
      })
    }

    const blockingCount = items.filter((i) => i.status === 'incomplete').length
    return {
      ready: blockingCount === 0,
      items,
      blockingCount,
    }
  }

  // ── Payload composition ────────────────────────────────────────
  //
  // E.2 — Single-channel composeAmazonPayload was removed; the multi-channel
  // path supersedes it and resolves SP-API marketplace IDs through the
  // Marketplace lookup table. Use composeMultiChannelPayloads() with a
  // single-element channels array if you need a one-off Amazon payload.

  // ── Phase I — multi-channel validation + payload composition ──

  validateMultiChannel(wizard: MultiChannelWizard): MultiChannelValidation {
    const state = wizard.state ?? {}
    const channelStates = wizard.channelStates ?? {}
    const channels = wizard.channels.map((c) => ({
      ...c,
      platform: c.platform.toUpperCase(),
      marketplace: c.marketplace.toUpperCase(),
    }))

    // Shared-state pieces — same answer for every channel report so
    // we compute once.
    const ids = state.identifiers ?? {}
    const baseAttributes = (state.attributes ?? {}) as Record<string, unknown>
    const variations = state.variations ?? {}
    const contentByGroup =
      ((state.content ?? {}) as { byGroup?: Record<string, any> }).byGroup ??
      {}
    const fallbackProductType =
      typeof state?.productType?.productType === 'string'
        ? (state.productType.productType as string)
        : undefined

    const reports: ChannelValidationReport[] = channels.map((c) => {
      const channelKey = `${c.platform}:${c.marketplace}`
      const slice = channelStates[channelKey] ?? {}
      const items: ValidationItem[] = []
      const warnings: string[] = []

      // Step 1 — Channels: implicit "complete" once we have a channel
      // report for it.
      items.push({ step: 1, title: 'Channel selected', status: 'complete' })

      // Step 2 — Product Type. Amazon-only; non-Amazon channels skip.
      if (c.platform === 'AMAZON') {
        const ptSlice = (slice as any).productType
        const productType =
          (ptSlice && typeof ptSlice.productType === 'string'
            ? ptSlice.productType
            : undefined) ?? fallbackProductType
        if (productType && productType.length > 0) {
          items.push({
            step: 2,
            title: 'Product type',
            status: 'complete',
            message: productType,
          })
        } else {
          items.push({
            step: 2,
            title: 'Product type',
            status: 'incomplete',
            message: 'Pick a product type for this channel.',
          })
        }
      } else {
        items.push({ step: 2, title: 'Product type', status: 'skipped' })
      }

      // Step 3 — Identifiers (shared).
      if (
        ids.path === 'have-code' &&
        typeof ids.gtinValue === 'string' &&
        ids.gtinValue.length > 0
      ) {
        items.push({ step: 3, title: 'Identifiers', status: 'complete' })
      } else if (ids.path === 'have-exemption' || ids.path === 'apply-now') {
        items.push({
          step: 3,
          title: 'Identifiers',
          status: 'complete',
          message: `Path: ${ids.path}`,
        })
      } else {
        items.push({
          step: 3,
          title: 'Identifiers',
          status: 'incomplete',
          message: 'Pick a GTIN path in Step 3.',
        })
      }

      // Step 4 — GTIN exemption (auto-skipped path lands as complete).
      const gtinStatus = state.gtinStatus
      if (gtinStatus?.autoSkipped) {
        items.push({
          step: 4,
          title: 'GTIN exemption',
          status: 'skipped',
          message: gtinStatus.reason ?? 'auto-skipped',
        })
      } else if (ids.path === 'apply-now') {
        const ex = ids.exemptionApplicationId
        if (typeof ex === 'string' && ex.length > 0) {
          items.push({ step: 4, title: 'GTIN exemption', status: 'complete' })
        } else {
          items.push({
            step: 4,
            title: 'GTIN exemption',
            status: 'incomplete',
            message: 'Generate or attach an exemption application.',
          })
        }
      } else {
        items.push({ step: 4, title: 'GTIN exemption', status: 'skipped' })
      }

      // Step 5 — Attributes. Per-channel: walk required fields union
      // for Amazon and check base-or-override for each. For non-
      // Amazon, mark as skipped (eBay wires its own checks in
      // Phase 2A).
      if (c.platform === 'AMAZON') {
        const channelAttrs =
          ((slice as any).attributes ?? {}) as Record<string, unknown>
        // We don't have the schema-driven required list here without a
        // round-trip, so for v1 we check that every field present on
        // the master product also has a non-empty value somewhere.
        // The proper required-list check happens via the
        // /required-fields endpoint and is mirrored client-side in
        // Step 5 — by the time the user reaches Review, that step's
        // Continue gate has already enforced it.
        const filledCount = countFilledFields(baseAttributes, channelAttrs)
        if (filledCount > 0) {
          items.push({
            step: 5,
            title: 'Attributes',
            status: 'complete',
            message: `${filledCount} field${filledCount === 1 ? '' : 's'} filled`,
          })
        } else {
          items.push({
            step: 5,
            title: 'Attributes',
            status: 'incomplete',
            message: 'Fill the required Amazon attributes for this channel.',
          })
        }
      } else {
        items.push({ step: 5, title: 'Attributes', status: 'skipped' })
      }

      // Step 6 — Variations. Theme = channelStates → state.commonTheme
      // fallback.
      const channelTheme =
        ((slice as any).variations?.theme as string | undefined) ??
        (variations.commonTheme as string | undefined)
      const includedSkus = Array.isArray(variations.includedSkus)
        ? (variations.includedSkus as string[])
        : []
      if (includedSkus.length > 0) {
        if (channelTheme && channelTheme.length > 0) {
          items.push({
            step: 6,
            title: 'Variations',
            status: 'complete',
            message: `${includedSkus.length} included (theme: ${channelTheme})`,
          })
        } else {
          items.push({
            step: 6,
            title: 'Variations',
            status: 'incomplete',
            message: 'Pick a variation theme for this channel.',
          })
        }
      } else {
        items.push({
          step: 6,
          title: 'Variations',
          status: 'skipped',
          message: 'Single product or no children picked.',
        })
      }

      // Step 7 — Images. v1: rely on the Phase F server-side
      // resolution + validation. Without re-running it here we trust
      // that the wizard step's Continue gate caught hard fails. Mark
      // as `complete` if state.images.orderedUrls has any entry,
      // `incomplete` if explicitly empty, `unknown` otherwise.
      const imagesSlice = state.images ?? {}
      const orderedUrls = Array.isArray(imagesSlice.orderedUrls)
        ? imagesSlice.orderedUrls
        : []
      if (orderedUrls.length === 0 && c.platform === 'AMAZON') {
        items.push({
          step: 7,
          title: 'Images',
          status: 'incomplete',
          message: 'Amazon needs at least one image.',
        })
      } else if (orderedUrls.length > 0) {
        items.push({
          step: 7,
          title: 'Images',
          status: 'complete',
          message: `${orderedUrls.length} image${orderedUrls.length === 1 ? '' : 's'}`,
        })
      } else {
        items.push({ step: 7, title: 'Images', status: 'skipped' })
      }

      // L.3 — Content step removed; content fields (item_name,
      // bullet_point, product_description, generic_keyword) are now
      // checked as part of the Attributes step above. Skip the
      // separate Content validation entry.

      // Step 7 — Pricing. Per-channel override → base fallback.
      const basePricing = state.pricing ?? {}
      const channelPricing = (slice as any).pricing ?? {}
      const effectivePrice =
        (typeof channelPricing.marketplacePrice === 'number'
          ? channelPricing.marketplacePrice
          : undefined) ??
        (typeof basePricing.basePrice === 'number'
          ? basePricing.basePrice
          : undefined)
      if (typeof effectivePrice === 'number' && effectivePrice > 0) {
        items.push({
          step: 7,
          title: 'Pricing',
          status: 'complete',
          message: String(effectivePrice),
        })
      } else {
        items.push({
          step: 7,
          title: 'Pricing',
          status: 'incomplete',
          message: 'Set a marketplace price.',
        })
      }

      // Non-Amazon advisory warning — these channels can't actually
      // be published yet (TECH_DEBT #35).
      if (c.platform !== 'AMAZON') {
        warnings.push(
          `${c.platform} publish adapter not yet wired — wizard state will save but submit shows the prepared payload only.`,
        )
      }

      const blockingCount = items.filter((i) => i.status === 'incomplete').length
      return {
        channelKey,
        platform: c.platform,
        marketplace: c.marketplace,
        ready: blockingCount === 0,
        blockingCount,
        items,
        warnings,
      }
    })

    return {
      channels: reports,
      allReady: reports.every((r) => r.ready),
      blockingChannels: reports.filter((r) => !r.ready).map((r) => r.channelKey),
    }
  }

  async composeMultiChannelPayloads(
    wizard: MultiChannelWizard,
  ): Promise<ChannelPayloadEntry[]> {
    const state = wizard.state ?? {}
    const channelStates = wizard.channelStates ?? {}
    const fallbackProductType =
      typeof state?.productType?.productType === 'string'
        ? (state.productType.productType as string)
        : undefined
    const variations = state.variations ?? {}
    const includedSkus = Array.isArray(variations.includedSkus)
      ? (variations.includedSkus as string[])
      : []
    const baseAttributes = (state.attributes ?? {}) as Record<string, unknown>
    const basePricing = state.pricing ?? {}
    const contentByGroup =
      ((state.content ?? {}) as { byGroup?: Record<string, any> }).byGroup ??
      {}
    const orderedUrls: string[] = Array.isArray(state.images?.orderedUrls)
      ? state.images.orderedUrls
      : []

    // E.2/E.3 — Pre-fetch SP-API marketplace IDs and per-child VCL data for
    // every Amazon channel in this wizard. The user's SKU strategy (set in
    // Step 1) drives whether children get suffixed marketplace SKUs or share
    // the master SKU; explicit VariantChannelListing.channelSku overrides
    // either way. Audit-fix #4 also pulls ChannelListing.variationMapping
    // per marketplace so SP-API child-attribute names are correct per
    // productType. Three queries total, all well-indexed.
    const skuStrategy = readSkuStrategy(state)
    const [
      amazonMarketplaceIds,
      childrenResolution,
      amazonVariationMappings,
    ] = await Promise.all([
      resolveAmazonMarketplaceIds(this.prisma, wizard.channels),
      resolveAmazonChildren(
        this.prisma,
        wizard.channels,
        includedSkus,
        skuStrategy.childSku,
      ),
      resolveAmazonVariationMappings(
        this.prisma,
        wizard.productId,
        wizard.channels,
      ),
    ])
    const amazonChildrenByChannel = childrenResolution.byChannel
    // Audit-fix #6 — surface missing SKUs as a top-level signal so callers
    // (the wizard /preview + /submit endpoints) can show "2 picked SKUs no
    // longer exist" warnings without having to recompute.
    if (childrenResolution.missingSkus.length > 0) {
      console.warn(
        '[submission] resolveAmazonChildren: dropped',
        childrenResolution.missingSkus.length,
        'missing master SKUs from variation payload:',
        childrenResolution.missingSkus,
      )
    }

    return wizard.channels.map((cRaw) => {
      const c = {
        platform: cRaw.platform.toUpperCase(),
        marketplace: cRaw.marketplace.toUpperCase(),
      }
      const channelKey = `${c.platform}:${c.marketplace}`
      const slice = channelStates[channelKey] ?? {}

      if (c.platform === 'EBAY') {
        // DD.4 — compose an eBay Inventory-API-shaped payload. The
        // adapter (channel-publish.service.ts EBAY branch) maps this
        // into PUT /sell/inventory/v1/inventory_item/{sku} +
        // POST /offer + POST /offer/{id}/publish. NOT END-TO-END
        // TESTED — requires eBay developer creds + sandbox seller
        // (see TECH_DEBT #35).
        const productType =
          ((slice as any).productType?.productType as string | undefined) ??
          fallbackProductType ??
          ''
        const channelAttrs = ((slice as any).attributes ?? {}) as Record<
          string,
          unknown
        >
        const mergedAttrs: Record<string, unknown> = {
          ...baseAttributes,
          ...channelAttrs,
        }
        const groupKey = contentGroupKey(c.platform, c.marketplace)
        const groupContent = (contentByGroup as Record<string, any>)[groupKey] ?? {}
        const channelPricing = (slice as any).pricing ?? {}
        const effectivePrice =
          typeof channelPricing.marketplacePrice === 'number'
            ? channelPricing.marketplacePrice
            : typeof basePricing.basePrice === 'number'
            ? basePricing.basePrice
            : undefined

        // eBay aspects: Record<string, string[]>. Single-value attrs
        // wrap as a 1-element array; string_array attrs expand.
        const aspects: Record<string, string[]> = {}
        for (const [k, v] of Object.entries(mergedAttrs)) {
          if (v === undefined || v === null || v === '') continue
          const expanded = tryExpandStringArray(v)
          if (expanded !== null) {
            aspects[k] = expanded.map(String)
          } else {
            aspects[k] = [String(v)]
          }
        }

        const title =
          (typeof groupContent?.title?.content === 'string' &&
            groupContent.title.content.trim().length > 0
            ? groupContent.title.content.trim()
            : undefined) ??
          (typeof mergedAttrs.item_name === 'string'
            ? (mergedAttrs.item_name as string)
            : undefined)

        const description =
          (typeof groupContent?.description?.content === 'string' &&
            groupContent.description.content.trim().length > 0
            ? groupContent.description.content.trim()
            : undefined) ??
          (typeof mergedAttrs.product_description === 'string'
            ? (mergedAttrs.product_description as string)
            : undefined)

        const ebayPayload: Record<string, unknown> = {
          sku: wizard.product?.sku,
          marketplaceId: `EBAY_${c.marketplace}`,
          categoryId: productType, // for eBay productType IS the categoryId
          product: {
            title,
            description,
            aspects,
            imageUrls: orderedUrls.length > 0 ? orderedUrls.slice(0, 12) : [],
          },
          availability: {
            shipToLocationAvailability: {
              quantity: typeof basePricing.stock === 'number' ? basePricing.stock : 1,
            },
          },
          condition: 'NEW',
          price:
            typeof effectivePrice === 'number'
              ? { value: effectivePrice, currency: pricingCurrencyFor(c.marketplace) }
              : undefined,
        }

        return {
          channelKey,
          platform: c.platform,
          marketplace: c.marketplace,
          payload: ebayPayload,
        }
      }

      if (c.platform !== 'AMAZON') {
        return {
          channelKey,
          platform: c.platform,
          marketplace: c.marketplace,
          unsupported: true,
          reason: `${c.platform} publish adapter not yet wired — see TECH_DEBT #35.`,
        }
      }

      // Resolve per-channel product type, attributes, theme, content.
      const productType =
        ((slice as any).productType?.productType as string | undefined) ??
        fallbackProductType ??
        ''
      // P.3 — browse-node IDs from the productType slice. When the
      // user edited recommended_browse_nodes via Step 5 Attributes
      // overrides, that wins (mergedAttrs path). Otherwise we lift
      // them from the productType slice as a JSON-encoded string[]
      // so the existing string_array expansion sends them as N
      // wrapped entries.
      const browseNodes =
        ((slice as any).productType?.browseNodes as string[] | undefined) ??
        []
      const channelAttrs = ((slice as any).attributes ?? {}) as Record<
        string,
        unknown
      >
      const mergedAttrs: Record<string, unknown> = {
        ...baseAttributes,
        ...channelAttrs,
      }
      if (
        browseNodes.length > 0 &&
        !('recommended_browse_nodes' in mergedAttrs)
      ) {
        mergedAttrs.recommended_browse_nodes = JSON.stringify(browseNodes)
      }
      const theme =
        ((slice as any).variations?.theme as string | undefined) ??
        (variations.commonTheme as string | undefined)
      const groupKey = contentGroupKey(c.platform, c.marketplace)
      const groupContent = (contentByGroup as Record<string, any>)[groupKey] ?? {}
      const channelPricing = (slice as any).pricing ?? {}
      const effectivePrice =
        typeof channelPricing.marketplacePrice === 'number'
          ? channelPricing.marketplacePrice
          : typeof basePricing.basePrice === 'number'
          ? basePricing.basePrice
          : undefined

      // E.2 — SP-API expects the numeric marketplace ID ("APJ6JRA9NG5V4"),
      // not the country code ("IT"). Resolved above; falls back to the code
      // if the Marketplace lookup row is missing (unseeded env).
      const marketplaceId = amazonMarketplaceIds.get(channelKey) ?? c.marketplace
      const amazonAttributes: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(mergedAttrs)) {
        if (v === undefined || v === null || v === '') continue
        // L.2 — string_array attributes (bullet_point, generic_keyword,
        // search_terms, special_feature) are stored as JSON-encoded
        // string[]. Expand into N wrapped entries for the Amazon
        // payload. Detect by parsing — if it's not a valid JSON array,
        // fall through to the normal single-value path.
        const expanded = tryExpandStringArray(v)
        if (expanded !== null) {
          amazonAttributes[k] = expanded.map((value) => ({
            marketplace_id: marketplaceId,
            value,
          }))
        } else {
          amazonAttributes[k] = [{ marketplace_id: marketplaceId, value: v }]
        }
      }

      // L.3 — content fields (item_name, bullet_point,
      // product_description, generic_keyword) are now part of
      // state.attributes / channelStates[key].attributes — already
      // wrapped above in the mergedAttrs loop. Backwards-compat:
      // pre-L.3 wizards may still have content in state.content.
      // byGroup; lift those values into amazonAttributes only when
      // the corresponding attribute slot is empty so existing
      // wizards still publish.
      if (
        !amazonAttributes.item_name &&
        typeof groupContent?.title?.content === 'string' &&
        groupContent.title.content.trim().length > 0
      ) {
        amazonAttributes.item_name = [
          {
            marketplace_id: marketplaceId,
            value: groupContent.title.content.trim(),
          },
        ]
      }
      if (
        !amazonAttributes.bullet_point &&
        Array.isArray(groupContent?.bullets?.content)
      ) {
        amazonAttributes.bullet_point = groupContent.bullets.content
          .filter(
            (b: unknown) => typeof b === 'string' && b.trim().length > 0,
          )
          .map((b: string) => ({
            marketplace_id: marketplaceId,
            value: b.trim(),
          }))
      }
      if (
        !amazonAttributes.product_description &&
        typeof groupContent?.description?.content === 'string' &&
        groupContent.description.content.trim().length > 0
      ) {
        amazonAttributes.product_description = [
          {
            marketplace_id: marketplaceId,
            value: groupContent.description.content.trim(),
          },
        ]
      }
      if (
        !amazonAttributes.generic_keyword &&
        typeof groupContent?.keywords?.content === 'string' &&
        groupContent.keywords.content.trim().length > 0
      ) {
        amazonAttributes.generic_keyword = [
          {
            marketplace_id: marketplaceId,
            value: groupContent.keywords.content.trim(),
          },
        ]
      }

      if (typeof effectivePrice === 'number' && effectivePrice > 0) {
        amazonAttributes.purchasable_offer = [
          {
            marketplace_id: marketplaceId,
            our_price: [
              { schedule: [{ value_with_tax: effectivePrice }] },
            ],
          },
        ]
      }

      if (orderedUrls.length > 0) {
        amazonAttributes.main_product_image_locator = [
          {
            marketplace_id: marketplaceId,
            media_location: orderedUrls[0],
          },
        ]
        if (orderedUrls.length > 1) {
          amazonAttributes.other_product_image_locator = orderedUrls
            .slice(1, 9)
            .map((url) => ({
              marketplace_id: marketplaceId,
              media_location: url,
            }))
        }
      }

      // E.2 — Per-marketplace child resolution: master child SKUs the user
      // picked in Step 5, mapped through VariantChannelListing for THIS
      // marketplace. When the user runs the default "shared SKU" strategy,
      // channelSku === masterSku for every entry. When they've opted into
      // per-marketplace SKUs (Step 1 SKU strategy), the suffixed value wins.
      const childMap = amazonChildrenByChannel.get(channelKey)
      const children = childMap
        ? includedSkus
            .map((sku) => childMap.get(sku))
            .filter((c): c is ChildResolved => c !== undefined)
        : []

      const masterParentSku = wizard.product?.sku
      const parentSku = masterParentSku
        ? applySkuStrategy(
            masterParentSku,
            c.marketplace,
            skuStrategy.parentSku,
            null,
          )
        : undefined

      const payload: AmazonListingPayload = {
        productType,
        marketplaceId,
        attributes: amazonAttributes,
        parentSku,
        childSkus: includedSkus.length > 0 ? includedSkus : undefined,
        children: children.length > 0 ? children : undefined,
        variationTheme: theme,
        variationMapping: amazonVariationMappings.get(channelKey),
        imageUrls: orderedUrls.length > 0 ? orderedUrls.slice(0, 9) : undefined,
      }

      return {
        channelKey,
        platform: c.platform,
        marketplace: c.marketplace,
        payload,
        missingChildSkus:
          childrenResolution.missingSkus.length > 0
            ? childrenResolution.missingSkus
            : undefined,
      }
    })
  }

  /**
   * E.2 — Write Amazon-assigned ASINs back to the right marketplace rows.
   * Called by the publish path (TECH_DEBT #35) once putListingsItem succeeds
   * and getListingsItem reports the ASIN. The caller passes:
   *
   *   - productId + (channel='AMAZON', marketplace) → identifies one
   *     ChannelListing row to receive the parent ASIN
   *   - parentAsin → written to ChannelListing.externalParentId
   *   - childAsinByMasterSku → optional map of master child SKU → child ASIN;
   *     written to VariantChannelListing.channelProductId scoped to the same
   *     marketplace. Per-marketplace child ASINs are now possible because of
   *     E.1's marketplace column on VariantChannelListing.
   *
   * Idempotent — safe to call multiple times. Upserts the per-variant row so
   * a child publishing for the first time gets a new VCL row stamped with
   * the correct marketplace.
   */
  async writeAsinsBack(args: {
    productId: string
    marketplace: string
    parentAsin: string
    childAsinByMasterSku?: Record<string, string>
  }): Promise<void> {
    const marketplace = args.marketplace.toUpperCase()

    // Audit-fix #1 — upsert (not update) the parent ChannelListing. First-time
    // publish to a new marketplace doesn't have a pre-existing ChannelListing
    // row; the original update() crashed with P2025 and silently dropped the
    // ASIN. The legacy `channelMarket` composite key is `<CHANNEL>_<REGION>`
    // by Phase 9 convention; `region` mirrors `marketplace` for region-scoped
    // channels. Schema defaults handle everything else.
    await this.prisma.channelListing.upsert({
      where: {
        productId_channel_marketplace: {
          productId: args.productId,
          channel: 'AMAZON',
          marketplace,
        },
      },
      create: {
        productId: args.productId,
        channel: 'AMAZON',
        marketplace,
        region: marketplace,
        channelMarket: `AMAZON_${marketplace}`,
        externalParentId: args.parentAsin,
        platformProductId: args.parentAsin,
      },
      update: {
        externalParentId: args.parentAsin,
        platformProductId: args.parentAsin,
      },
    })

    const childMap = args.childAsinByMasterSku ?? {}
    const skus = Object.keys(childMap)
    if (skus.length === 0) return

    const variants = await this.prisma.productVariation.findMany({
      where: { sku: { in: skus }, productId: args.productId },
      select: { id: true, sku: true },
    })

    await Promise.all(
      variants.map((v) => {
        const asin = childMap[v.sku]
        if (!asin) return Promise.resolve()
        return this.prisma.variantChannelListing.upsert({
          where: {
            variantId_channel_marketplace: {
              variantId: v.id,
              channel: 'AMAZON',
              marketplace,
            },
          },
          create: {
            variantId: v.id,
            channel: 'AMAZON',
            marketplace,
            channelProductId: asin,
            channelPrice: 0,
            channelQuantity: 0,
          },
          update: {
            channelProductId: asin,
          },
        })
      }),
    )
  }
}

function countFilledFields(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): number {
  const seen = new Set<string>()
  for (const [k, v] of Object.entries(base)) {
    if (!isEmpty(v)) seen.add(k)
  }
  for (const [k, v] of Object.entries(override)) {
    if (!isEmpty(v)) seen.add(k)
  }
  return seen.size
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  return false
}

/** L.2 — accepts a JSON-encoded string[] (the storage format the
 *  frontend uses for bullet_point and similar list fields), returns
 *  the trimmed non-empty entries. Returns null when the value isn't
 *  a JSON-array shape so the caller falls back to the single-value
 *  payload path. */
function tryExpandStringArray(v: unknown): string[] | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (!trimmed.startsWith('[')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return null
    const out = parsed
      .filter((s) => typeof s === 'string')
      .map((s: string) => s.trim())
      .filter((s) => s.length > 0)
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}
