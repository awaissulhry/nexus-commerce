/**
 * ATM.6 — Pure per-channel validation engine.
 *
 * Encodes the per-channel-marketplace constraints we need to meet
 * before a publish lands cleanly. Each rule has:
 *
 *   - id            stable string for analytics + i18n key lookups
 *   - severity      'error' blocks publish, 'warn' surfaces but
 *                   doesn't block
 *   - field         which master/effective field the rule checks;
 *                   drives the "Fix this" deep-link target
 *   - message       i18n key for the human label
 *   - check         pure predicate over (master, listing) →
 *                   ValidationIssue | null
 *
 * Rules deliberately stay in client-shareable TS rather than
 * server-only schema validation, because the hub view needs to
 * render the same issues the API would reject on publish. Engine
 * side enforcement (ATM.6b) reuses this module; both surfaces
 * agree on the diagnosis.
 *
 * Constraints sourced from current marketplace docs (Amazon SP-API
 * listings reference, eBay Trading API + Listings policy, Shopify
 * Product schema). Numeric limits err on the strict side — better
 * to flag a 195-char Amazon title than have the operator publish
 * a 201-char title and get a feed reject 24 h later.
 */

export type Severity = 'error' | 'warn'

export interface ValidationIssue {
  ruleId: string
  severity: Severity
  /** Which effective field is at fault — drives the inline "Fix" link. */
  field:
    | 'title'
    | 'description'
    | 'bullets'
    | 'price'
    | 'quantity'
    | 'identifier'
    | 'image'
    | 'category'
    | 'compliance'
  /** i18n key (no params) describing the issue. */
  messageKey: string
  /** Optional structured detail surfaced as a tooltip — current
   *  value, limit, expected, etc. */
  detail?: string
}

export interface MasterForValidation {
  name: string | null
  description: string | null
  bulletPoints: string[] | null
  basePrice: number | null
  totalStock: number | null
  gtin: string | null
  upc: string | null
  ean: string | null
  /** ≥ 1 image registered on the master product. The IM-series
   *  ListingImage publish state is checked separately by the
   *  per-channel rules below. */
  hasAnyImage: boolean
}

export interface ListingForValidation {
  channel: string
  marketplace: string
  title: string | null
  titleOverride: string | null
  followMasterTitle: boolean
  description: string | null
  descriptionOverride: string | null
  followMasterDescription: boolean
  price: number | null
  priceOverride: number | null
  followMasterPrice: boolean
  quantity: number | null
  quantityOverride: number | null
  followMasterQuantity: boolean
  bulletPointsOverride: string[]
  followMasterBulletPoints: boolean
}

/** Resolve the effective value used by the channel for a master
 *  field, honouring the followMaster* flags. Mirrors the publish
 *  service's resolution rules. */
function effectiveTitle(
  master: MasterForValidation,
  listing: ListingForValidation,
): string | null {
  if (listing.followMasterTitle) return master.name
  return listing.titleOverride ?? listing.title
}
function effectiveDescription(
  master: MasterForValidation,
  listing: ListingForValidation,
): string | null {
  if (listing.followMasterDescription) return master.description
  return listing.descriptionOverride ?? listing.description
}
function effectivePrice(
  master: MasterForValidation,
  listing: ListingForValidation,
): number | null {
  if (listing.followMasterPrice) return master.basePrice
  return listing.priceOverride ?? listing.price
}
function effectiveBullets(
  master: MasterForValidation,
  listing: ListingForValidation,
): string[] {
  if (listing.followMasterBulletPoints) return master.bulletPoints ?? []
  return listing.bulletPointsOverride
}

// ── Channel-specific rules ─────────────────────────────────────────

/**
 * Amazon constraints. Sources: SP-API Listings Items reference,
 * Brand Registry style guides, restricted-product policy. Most
 * "soft-warn" thresholds are 5-10 % under the hard cap so the
 * operator can fix typos before the feed actually rejects.
 */
function validateAmazon(
  master: MasterForValidation,
  listing: ListingForValidation,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const title = effectiveTitle(master, listing)
  const desc = effectiveDescription(master, listing)
  const price = effectivePrice(master, listing)
  const bullets = effectiveBullets(master, listing)

  // Title
  if (!title || title.trim().length === 0) {
    issues.push({
      ruleId: 'amazon.title.required',
      severity: 'error',
      field: 'title',
      messageKey: 'validation.amazon.title.required',
    })
  } else {
    if (title.length > 200) {
      issues.push({
        ruleId: 'amazon.title.tooLong',
        severity: 'error',
        field: 'title',
        messageKey: 'validation.amazon.title.tooLong',
        detail: `${title.length} / 200`,
      })
    } else if (title.length > 180) {
      issues.push({
        ruleId: 'amazon.title.tooLong.warn',
        severity: 'warn',
        field: 'title',
        messageKey: 'validation.amazon.title.approachingLimit',
        detail: `${title.length} / 200`,
      })
    }
  }

  // Bullets
  if (bullets.length === 0) {
    issues.push({
      ruleId: 'amazon.bullets.empty',
      severity: 'warn',
      field: 'bullets',
      messageKey: 'validation.amazon.bullets.empty',
    })
  } else {
    if (bullets.length > 5) {
      issues.push({
        ruleId: 'amazon.bullets.tooMany',
        severity: 'error',
        field: 'bullets',
        messageKey: 'validation.amazon.bullets.tooMany',
        detail: `${bullets.length} / 5`,
      })
    }
    const longBullet = bullets.find((b) => b.length > 500)
    if (longBullet) {
      issues.push({
        ruleId: 'amazon.bullets.tooLong',
        severity: 'error',
        field: 'bullets',
        messageKey: 'validation.amazon.bullets.tooLong',
        detail: `${longBullet.length} / 500`,
      })
    }
  }

  // Description
  if (desc && desc.length > 2000) {
    issues.push({
      ruleId: 'amazon.description.tooLong',
      severity: 'error',
      field: 'description',
      messageKey: 'validation.amazon.description.tooLong',
      detail: `${desc.length} / 2000`,
    })
  }

  // Price
  if (price == null || price <= 0) {
    issues.push({
      ruleId: 'amazon.price.required',
      severity: 'error',
      field: 'price',
      messageKey: 'validation.amazon.price.required',
    })
  }

  // Identifier — Amazon requires GTIN unless the brand has an
  // exemption. We can't see exemptions here (ATM.13 will surface
  // them); flag missing as warn so a brand-registered exempt
  // brand doesn't see a false "error" on every listing.
  if (!master.gtin && !master.upc && !master.ean) {
    issues.push({
      ruleId: 'amazon.identifier.missing',
      severity: 'warn',
      field: 'identifier',
      messageKey: 'validation.amazon.identifier.missing',
    })
  }

  // Image
  if (!master.hasAnyImage) {
    issues.push({
      ruleId: 'amazon.image.missing',
      severity: 'error',
      field: 'image',
      messageKey: 'validation.amazon.image.missing',
    })
  }

  return issues
}

/**
 * eBay constraints. Title cap is the famously-tight 80 chars and
 * traps a lot of operator-imported Amazon-style titles.
 */
function validateEbay(
  master: MasterForValidation,
  listing: ListingForValidation,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const title = effectiveTitle(master, listing)
  const desc = effectiveDescription(master, listing)
  const price = effectivePrice(master, listing)

  if (!title || title.trim().length === 0) {
    issues.push({
      ruleId: 'ebay.title.required',
      severity: 'error',
      field: 'title',
      messageKey: 'validation.ebay.title.required',
    })
  } else if (title.length > 80) {
    issues.push({
      ruleId: 'ebay.title.tooLong',
      severity: 'error',
      field: 'title',
      messageKey: 'validation.ebay.title.tooLong',
      detail: `${title.length} / 80`,
    })
  } else if (title.length > 75) {
    issues.push({
      ruleId: 'ebay.title.approachingLimit',
      severity: 'warn',
      field: 'title',
      messageKey: 'validation.ebay.title.approachingLimit',
      detail: `${title.length} / 80`,
    })
  }

  if (!desc || desc.trim().length === 0) {
    issues.push({
      ruleId: 'ebay.description.required',
      severity: 'warn',
      field: 'description',
      messageKey: 'validation.ebay.description.required',
    })
  }

  if (price == null || price <= 0) {
    issues.push({
      ruleId: 'ebay.price.required',
      severity: 'error',
      field: 'price',
      messageKey: 'validation.ebay.price.required',
    })
  }

  if (!master.hasAnyImage) {
    issues.push({
      ruleId: 'ebay.image.missing',
      severity: 'error',
      field: 'image',
      messageKey: 'validation.ebay.image.missing',
    })
  }

  return issues
}

/**
 * Shopify constraints. Looser than Amazon/eBay; Shopify accepts
 * almost anything but flagging zero-price + zero-image still
 * matters for the operator's "ready to sell" intent.
 */
function validateShopify(
  master: MasterForValidation,
  listing: ListingForValidation,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const title = effectiveTitle(master, listing)
  const price = effectivePrice(master, listing)

  if (!title || title.trim().length === 0) {
    issues.push({
      ruleId: 'shopify.title.required',
      severity: 'error',
      field: 'title',
      messageKey: 'validation.shopify.title.required',
    })
  } else if (title.length > 255) {
    issues.push({
      ruleId: 'shopify.title.tooLong',
      severity: 'error',
      field: 'title',
      messageKey: 'validation.shopify.title.tooLong',
      detail: `${title.length} / 255`,
    })
  }

  if (price == null || price <= 0) {
    issues.push({
      ruleId: 'shopify.price.required',
      severity: 'error',
      field: 'price',
      messageKey: 'validation.shopify.price.required',
    })
  }

  if (!master.hasAnyImage) {
    issues.push({
      ruleId: 'shopify.image.missing',
      severity: 'warn',
      field: 'image',
      messageKey: 'validation.shopify.image.missing',
    })
  }

  return issues
}

/**
 * Top-level dispatch. Returns issues sorted error-first then by
 * ruleId for stable display. Unknown channels return empty (we
 * don't synthesise constraints for surfaces we don't know).
 */
export function validateListing(
  master: MasterForValidation,
  listing: ListingForValidation,
): ValidationIssue[] {
  let issues: ValidationIssue[]
  switch (listing.channel) {
    case 'AMAZON':
      issues = validateAmazon(master, listing)
      break
    case 'EBAY':
      issues = validateEbay(master, listing)
      break
    case 'SHOPIFY':
      issues = validateShopify(master, listing)
      break
    default:
      return []
  }
  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    return a.ruleId.localeCompare(b.ruleId)
  })
}
