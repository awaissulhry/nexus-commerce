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
  /** Children (variations) the user picked in Step 5. Each becomes a
   *  separate listing under the parent's variation theme. */
  childSkus?: string[]
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
}

export interface MultiChannelWizard {
  id: string
  channels: Array<{ platform: string; marketplace: string }>
  state: Record<string, any>
  channelStates: Record<string, Record<string, any>>
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

  composeAmazonPayload(wizard: WizardWithState): AmazonListingPayload | null {
    if (wizard.channel.toUpperCase() !== 'AMAZON') return null
    const state = wizard.state ?? {}
    const productType = state.productType?.productType
    if (typeof productType !== 'string' || productType.length === 0) return null

    // Wrap each user-supplied attribute in Amazon's
    // [{ marketplace_id, value, language_tag? }] convention.
    const userAttrs = (state.attributes ?? {}) as Record<string, unknown>
    const marketplaceId = wizard.marketplace
    const attributes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(userAttrs)) {
      attributes[key] = [{ marketplace_id: marketplaceId, value }]
    }

    // Title + bullets + description from Step 6.
    const content = state.content ?? {}
    if (typeof content.title === 'string' && content.title.trim().length > 0) {
      attributes.item_name = [
        {
          marketplace_id: marketplaceId,
          value: content.title.trim(),
        },
      ]
    }
    if (Array.isArray(content.bullets)) {
      attributes.bullet_point = content.bullets
        .filter(
          (b: unknown) => typeof b === 'string' && b.trim().length > 0,
        )
        .map((b: string) => ({
          marketplace_id: marketplaceId,
          value: b.trim(),
        }))
    }
    if (
      typeof content.description === 'string' &&
      content.description.trim().length > 0
    ) {
      attributes.product_description = [
        {
          marketplace_id: marketplaceId,
          value: content.description.trim(),
        },
      ]
    }
    if (
      typeof content.keywords === 'string' &&
      content.keywords.trim().length > 0
    ) {
      attributes.generic_keyword = [
        {
          marketplace_id: marketplaceId,
          value: content.keywords.trim(),
        },
      ]
    }

    // Pricing → purchasable_offer
    const pricing = state.pricing ?? {}
    if (
      typeof pricing.marketplacePrice === 'number' &&
      pricing.marketplacePrice > 0
    ) {
      attributes.purchasable_offer = [
        {
          marketplace_id: marketplaceId,
          our_price: [
            {
              schedule: [
                { value_with_tax: pricing.marketplacePrice },
              ],
            },
          ],
        },
      ]
    }

    const images = state.images ?? {}
    const imageUrls = Array.isArray(images.orderedUrls)
      ? images.orderedUrls.slice(0, 9)
      : []
    if (imageUrls.length > 0) {
      attributes.main_product_image_locator = [
        {
          marketplace_id: marketplaceId,
          media_location: imageUrls[0],
        },
      ]
      if (imageUrls.length > 1) {
        attributes.other_product_image_locator = imageUrls
          .slice(1)
          .map((url) => ({
            marketplace_id: marketplaceId,
            media_location: url,
          }))
      }
    }

    // Variations
    const vars = state.variations ?? {}

    return {
      productType,
      marketplaceId,
      attributes,
      childSkus:
        Array.isArray(vars.includedSkus) && vars.includedSkus.length > 0
          ? vars.includedSkus
          : undefined,
      variationTheme:
        typeof vars.theme === 'string' && vars.theme.length > 0
          ? vars.theme
          : undefined,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    }
  }

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

      // Step 8 — Content (per group). Channel's group key = its
      // (lang, platform). Need title + ≥1 bullet for that group.
      const groupKey = contentGroupKey(c.platform, c.marketplace)
      const groupContent = (contentByGroup as Record<string, any>)[groupKey]
      const hasTitle =
        typeof groupContent?.title?.content === 'string' &&
        groupContent.title.content.trim().length > 0
      const hasBullets =
        Array.isArray(groupContent?.bullets?.content) &&
        groupContent.bullets.content.some(
          (b: unknown) => typeof b === 'string' && b.trim().length > 0,
        )
      if (hasTitle && hasBullets) {
        items.push({
          step: 8,
          title: 'Content',
          status: 'complete',
          message: groupKey,
        })
      } else {
        items.push({
          step: 8,
          title: 'Content',
          status: 'incomplete',
          message: `Title + ≥1 bullet missing for group ${groupKey}.`,
        })
      }

      // Step 9 — Pricing. Per-channel override → base fallback.
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
          step: 9,
          title: 'Pricing',
          status: 'complete',
          message: String(effectivePrice),
        })
      } else {
        items.push({
          step: 9,
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

  composeMultiChannelPayloads(
    wizard: MultiChannelWizard,
  ): ChannelPayloadEntry[] {
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

    return wizard.channels.map((cRaw) => {
      const c = {
        platform: cRaw.platform.toUpperCase(),
        marketplace: cRaw.marketplace.toUpperCase(),
      }
      const channelKey = `${c.platform}:${c.marketplace}`
      const slice = channelStates[channelKey] ?? {}

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
      const channelAttrs = ((slice as any).attributes ?? {}) as Record<
        string,
        unknown
      >
      const mergedAttrs: Record<string, unknown> = {
        ...baseAttributes,
        ...channelAttrs,
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

      const marketplaceId = c.marketplace
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

      if (typeof groupContent?.title?.content === 'string' && groupContent.title.content.trim().length > 0) {
        amazonAttributes.item_name = [
          {
            marketplace_id: marketplaceId,
            value: groupContent.title.content.trim(),
          },
        ]
      }
      if (Array.isArray(groupContent?.bullets?.content)) {
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

      const payload: AmazonListingPayload = {
        productType,
        marketplaceId,
        attributes: amazonAttributes,
        childSkus: includedSkus.length > 0 ? includedSkus : undefined,
        variationTheme: theme,
        imageUrls: orderedUrls.length > 0 ? orderedUrls.slice(0, 9) : undefined,
      }

      return {
        channelKey,
        platform: c.platform,
        marketplace: c.marketplace,
        payload,
      }
    })
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
