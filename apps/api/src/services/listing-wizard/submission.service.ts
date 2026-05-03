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
}
