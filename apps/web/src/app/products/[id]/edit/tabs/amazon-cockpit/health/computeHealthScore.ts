// AC.4 — Pre-publish health scoring for Amazon listings.
//
// Pure function. Takes a ComposedAmazonListing and returns a 0–100
// score plus the full list of checks the panel renders. AC.4 keeps
// scoring local to fields the cockpit already sees (composed +
// listing.listingStatus); the manifest-aware "required attribute"
// pass joins in AC.5 once the cross-tab pipe is wired.
//
// Score weighting (sum to 100):
//
//   BLOCKERS         50pts (5 × 10)  → failing any drops status to "blocked"
//   REQUIRED         30pts (6 × 5)
//   RECOMMENDED      15pts (5 × 3)
//   POLISH            5pts (2 × 2.5)
//
// Status thresholds: ready ≥70, warn 50–69, blocked otherwise OR if
// any blocker fails. A SUPPRESSED listing forces blocked regardless
// of score so the panel surfaces the reason immediately (AC.10 wires
// the live SP-API suppression reasons).

import type { ComposedAmazonListing } from '../types'

export type CheckGroup = 'blocker' | 'required' | 'recommended' | 'polish'
export type CheckStatus = 'pass' | 'fail' | 'warn'
export type JumpTarget =
  | 'essentials'      // title / description / bullets
  | 'identifiers'     // ASIN / GTIN / brand
  | 'category'        // productType / browse node
  | 'variations'
  | 'images'
  | 'aplus'
  | 'pricing'
  | 'fulfillment'
  | 'compliance'
  | 'classic'         // catch-all → open the transitional pass-through

export interface HealthCheck {
  id: string
  group: CheckGroup
  label: string
  /** Short rationale when failing. Shows beneath the row. */
  hint?: string
  /** Concrete current value, rendered as a mono pill on the right. */
  value?: string
  weight: number
  status: CheckStatus
  /** Where to jump on click. */
  target: JumpTarget
}

export type HealthStatus = 'ready' | 'warn' | 'blocked' | 'suppressed'

export interface HealthReport {
  score: number          // 0-100 rounded
  status: HealthStatus
  /** Quick-glance numerator counts per group. */
  summary: {
    blocker: { pass: number; total: number }
    required: { pass: number; total: number }
    recommended: { pass: number; total: number }
    polish: { pass: number; total: number }
  }
  checks: HealthCheck[]
}

// Amazon hard limits we treat as ground truth. Some categories tighten
// these (e.g. women's apparel title ≤80) — AC.5 will swap to manifest-
// driven limits.
const TITLE_MAX = 200
const TITLE_MIN = 40         // shorter than 40 is almost always too thin
const BULLET_TARGET = 5      // Amazon expects 5
const BULLET_LEN_MIN = 50    // bullets shorter than ~50 chars look weak
const BULLET_LEN_POLISH = 100
const DESC_MIN = 200         // bare minimum, A+ replaces it on premium PDPs
const IMAGE_MIN = 4          // 1 hero + 3 alt
const IMAGE_TARGET = 8       // Amazon allows 9 (1 + 8 alts)

// Score thresholds.
const READY_AT = 70
const WARN_AT = 50

function pass(): CheckStatus { return 'pass' }
function fail(): CheckStatus { return 'fail' }

export function computeHealthScore(c: ComposedAmazonListing): HealthReport {
  const checks: HealthCheck[] = []

  const isSuppressed =
    c.status.listingStatus?.toUpperCase().includes('SUPPRESSED') ?? false

  // ── BLOCKERS — 5 × 10pts ────────────────────────────────────────
  checks.push({
    id: 'title-present',
    group: 'blocker',
    label: 'Title is set',
    hint: 'Required — Amazon rejects listings with no title.',
    value: c.healthHints.titleLength ? `${c.healthHints.titleLength} chars` : 'empty',
    weight: 10,
    status: c.healthHints.titleLength > 0 ? pass() : fail(),
    target: 'essentials',
  })
  checks.push({
    id: 'price-present',
    group: 'blocker',
    label: 'Price is set',
    hint: 'Required — Amazon will suppress listings with no price.',
    value: c.price.value != null ? `${c.currency} ${c.price.value.toFixed(2)}` : 'empty',
    weight: 10,
    status: c.price.value != null && c.price.value > 0 ? pass() : fail(),
    target: 'pricing',
  })
  checks.push({
    id: 'main-image-present',
    group: 'blocker',
    label: 'Main image is set',
    hint: 'Required — Amazon needs a primary product image on a white background.',
    value: c.primaryImageUrl.value ? 'set' : 'empty',
    weight: 10,
    status: c.primaryImageUrl.value ? pass() : fail(),
    target: 'images',
  })
  checks.push({
    id: 'gtin-or-exempt',
    group: 'blocker',
    label: 'GTIN / UPC / EAN present (or brand GTIN-exempt)',
    hint: 'Amazon requires a product identifier unless the brand is GTIN-exempt.',
    value: c.healthHints.hasGtin ? 'present' : 'missing',
    weight: 10,
    status: c.healthHints.hasGtin ? pass() : fail(),
    target: 'identifiers',
  })
  checks.push({
    id: 'brand-present',
    group: 'blocker',
    label: 'Brand is set',
    hint: 'Amazon rejects listings without a brand (or unbranded must be declared).',
    value: c.brand.value ?? 'empty',
    weight: 10,
    status: c.healthHints.hasBrand ? pass() : fail(),
    target: 'identifiers',
  })

  // ── REQUIRED — 6 × 5pts ─────────────────────────────────────────
  checks.push({
    id: 'title-length',
    group: 'required',
    label: `Title within sensible range (${TITLE_MIN}–${TITLE_MAX})`,
    hint: 'Titles shorter than 40 chars rank poorly; longer than 200 are truncated on mobile.',
    value: `${c.healthHints.titleLength}/${TITLE_MAX}`,
    weight: 5,
    status:
      c.healthHints.titleLength >= TITLE_MIN &&
      c.healthHints.titleLength <= TITLE_MAX
        ? pass()
        : fail(),
    target: 'essentials',
  })
  checks.push({
    id: 'description-length',
    group: 'required',
    label: `Description ≥ ${DESC_MIN} chars`,
    hint: 'Buyers without A+ Content fall back to the description; sparse text hurts conversion.',
    value: `${c.healthHints.descriptionLength}`,
    weight: 5,
    status: c.healthHints.descriptionLength >= DESC_MIN ? pass() : fail(),
    target: 'essentials',
  })
  checks.push({
    id: 'bullets-count',
    group: 'required',
    label: `${BULLET_TARGET} bullet points`,
    hint: 'Amazon shows up to 5 bullets above the fold; under-filled blocks look unfinished.',
    value: `${c.healthHints.bulletCount}/${BULLET_TARGET}`,
    weight: 5,
    status: c.healthHints.bulletCount >= BULLET_TARGET ? pass() : fail(),
    target: 'essentials',
  })
  checks.push({
    id: 'images-min',
    group: 'required',
    label: `${IMAGE_MIN}+ images`,
    hint: 'PDPs with fewer than 4 images convert noticeably worse on apparel/gear.',
    value: `${c.healthHints.imageCount}/${IMAGE_TARGET}`,
    weight: 5,
    status: c.healthHints.imageCount >= IMAGE_MIN ? pass() : fail(),
    target: 'images',
  })
  checks.push({
    id: 'product-type',
    group: 'required',
    label: 'Product type assigned',
    hint: 'Drives the manifest schema; without it Amazon falls back to generic fields.',
    value: c.productType.value ?? 'missing',
    weight: 5,
    status: c.healthHints.hasProductType ? pass() : fail(),
    target: 'category',
  })
  checks.push({
    id: 'browse-node',
    group: 'required',
    label: 'Browse node assigned',
    hint: 'Without a node the product is invisible in category filters.',
    value: c.browseNodeId.value ?? 'missing',
    weight: 5,
    status: !!c.browseNodeId.value ? pass() : fail(),
    target: 'category',
  })

  // ── RECOMMENDED — 5 × 3pts ──────────────────────────────────────
  // Variation completeness — only checked when the product HAS
  // variations; otherwise the slot is dropped (weight 0).
  const hasVariations = c.variationSummary.variantCount > 0
  if (hasVariations) {
    checks.push({
      id: 'variations-published',
      group: 'recommended',
      label: `All variants published (${c.variationSummary.publishedVariantCount}/${c.variationSummary.variantCount})`,
      hint: 'Unpublished children show on Seller Central but never on the PDP.',
      value: `${c.variationSummary.publishedVariantCount}/${c.variationSummary.variantCount}`,
      weight: 3,
      status:
        c.variationSummary.publishedVariantCount ===
        c.variationSummary.variantCount
          ? pass()
          : fail(),
      target: 'variations',
    })
  } else {
    checks.push({
      id: 'consider-variations',
      group: 'recommended',
      label: 'Variations modelled (if applicable)',
      hint: 'Apparel/gear with sizes or colors should be variation-themed.',
      weight: 3,
      status: pass(),  // not having variations isn't a fail, just a hint
      target: 'variations',
    })
  }

  checks.push({
    id: 'bullets-length',
    group: 'recommended',
    label: `Bullets average ≥ ${BULLET_LEN_MIN} chars`,
    hint: 'Short bullets read like specs; aim for 50–250 chars per line.',
    weight: 3,
    status: avgBulletLength(c) >= BULLET_LEN_MIN ? pass() : fail(),
    value: `~${Math.round(avgBulletLength(c))} chars`,
    target: 'essentials',
  })

  checks.push({
    id: 'images-many',
    group: 'recommended',
    label: `${IMAGE_TARGET}+ images for full gallery`,
    hint: 'Amazon allows 9 images (1 main + 8 alts) — fill them.',
    value: `${c.healthHints.imageCount}/${IMAGE_TARGET}`,
    weight: 3,
    status: c.healthHints.imageCount >= IMAGE_TARGET ? pass() : fail(),
    target: 'images',
  })

  checks.push({
    id: 'aplus-content',
    group: 'recommended',
    label: 'A+ Content attached',
    hint: 'Brand-registered sellers see ~5–15% lift on PDPs with A+ modules.',
    value:
      c.aplusSummary.moduleCount > 0
        ? `${c.aplusSummary.moduleCount} modules`
        : 'none',
    weight: 3,
    status: c.aplusSummary.moduleCount > 0 ? pass() : fail(),
    target: 'aplus',
  })

  checks.push({
    id: 'fulfillment-set',
    group: 'recommended',
    label: 'Fulfillment channel chosen (FBA / FBM)',
    hint: 'Listings without a fulfillment channel can\'t accept orders.',
    value: c.fulfillmentChannel.value ?? 'unset',
    weight: 3,
    status: !!c.fulfillmentChannel.value ? pass() : fail(),
    target: 'fulfillment',
  })

  // ── POLISH — 2 × 2.5pts ─────────────────────────────────────────
  checks.push({
    id: 'bullets-long',
    group: 'polish',
    label: `All bullets ≥ ${BULLET_LEN_POLISH} chars`,
    hint: 'Long bullets read like feature paragraphs; converts better on apparel.',
    weight: 2.5,
    status:
      c.bullets.value.length >= BULLET_TARGET &&
      c.bullets.value.every((b) => b.length >= BULLET_LEN_POLISH)
        ? pass()
        : fail(),
    target: 'essentials',
  })

  // GPSR / compliance — placeholder. AC.4 surfaces this as a polish-
  // tier "set country of origin" stub so operators see the row; the
  // real GPSR responsible-person + hazmat plumbing lands in AC.10
  // alongside the manifest's compliance group.
  checks.push({
    id: 'compliance-stub',
    group: 'polish',
    label: 'GPSR / compliance fields complete',
    hint: 'EU markets require GPSR responsible-person, country of origin, hazmat — AC.10 wires the live check.',
    weight: 2.5,
    status: 'warn',
    target: 'compliance',
  })

  // ── Tally + status ──────────────────────────────────────────────
  const summary = {
    blocker: tally(checks, 'blocker'),
    required: tally(checks, 'required'),
    recommended: tally(checks, 'recommended'),
    polish: tally(checks, 'polish'),
  }

  // Weighted score. "Warn" status (used by the compliance stub) counts
  // as half-credit so the bar still moves when the operator can't
  // resolve the row yet.
  let earned = 0
  let possible = 0
  for (const c2 of checks) {
    possible += c2.weight
    if (c2.status === 'pass') earned += c2.weight
    else if (c2.status === 'warn') earned += c2.weight * 0.5
  }
  const score = Math.round((earned / possible) * 100)

  const blockerFailed = summary.blocker.pass < summary.blocker.total
  let status: HealthStatus
  if (isSuppressed) status = 'suppressed'
  else if (blockerFailed) status = 'blocked'
  else if (score >= READY_AT) status = 'ready'
  else if (score >= WARN_AT) status = 'warn'
  else status = 'blocked'

  return { score, status, summary, checks }
}

function avgBulletLength(c: ComposedAmazonListing): number {
  if (c.bullets.value.length === 0) return 0
  const total = c.bullets.value.reduce((acc, b) => acc + b.length, 0)
  return total / c.bullets.value.length
}

function tally(checks: HealthCheck[], group: CheckGroup) {
  const inGroup = checks.filter((c) => c.group === group)
  const passed = inGroup.filter((c) => c.status === 'pass').length
  return { pass: passed, total: inGroup.length }
}
