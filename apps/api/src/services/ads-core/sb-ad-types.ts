/**
 * P4.5f — the Sponsored Brands creative types, read off Amazon's own OpenAPI document.
 *
 * ## 🔴 What the previous version of this file got wrong, and how
 *
 * It recorded an **`adType` wire value** (`'productCollection'`) and said the enum could not be
 * established because *"Amazon's API reference for `POST /sb/v4/ads` renders only with
 * JavaScript"*. That was true of the reference **page**. It was not true of the **document
 * behind it**: the page fetches
 * `d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json`, which is
 * plain JSON and needs no browser at all. Read 2026-09-21 (583 KB, `info.version: 4.0`).
 *
 * And the answer is that the question was wrong:
 *
 * | the old file assumed | Amazon's document says |
 * |---|---|
 * | one endpoint `POST /sb/v4/ads` | ❌ **`/sb/v4/ads` is `PUT` only** (`UpdateSponsoredBrandsAds`) |
 * | a discriminator field `adType` | ❌ **`adType` appears 0 times in the whole spec** |
 * | *"Manual Collection"* is an enum value we could not confirm | ✅ it is an **endpoint**: `POST /sb/v4/ads/manualCollection` |
 *
 * **Creation is one endpoint per creative type.** So a "wire value" was never the thing to find —
 * the creative type chooses the **path**, and each path has its own body shape. Our client was
 * posting to a path that does not accept POST, with a field that does not exist, and **without
 * the required `name`**. It would have failed on three counts. Nobody knew because
 * `/sb/v4/ads` has **0 calls ever** in `OutboundApiCallLog`.
 *
 * Banked, and earned again: *a plan row is usually not the defect*, and **"the docs need
 * JavaScript" is a claim about the renderer, not about the data.** Ask what the page fetches.
 *
 * ## The deprecation still stands
 *
 * P0.8 established from Amazon's own release-notes feed that on **2026-07-06** Amazon deprecated
 * the Sponsored Brands *"Product collection"* entity in favour of **Manual / Auto Collection**,
 * with **no shutdown date**. A January 2027 shut-off is third-party only and is not recorded as
 * fact. Product Collection is still a live endpoint in the 4.0 document, so it is still sent when
 * asked for — with a notice.
 */

/** The creative types this client can create. Each is a distinct Amazon endpoint. */
export type SbAdType = 'productCollection' | 'manualCollection' | 'storeSpotlight' | 'video'

export interface SbAdTypeSpec {
  /** The exact creation path. Never re-derived at a call site. */
  createPath: string
  /** What an operator calls it. */
  label: string
  /**
   * Where the landing destination goes for this type — they genuinely differ:
   * `ad` — a sibling of `creative` (productCollection, storeSpotlight);
   * `creative` — a field INSIDE the creative (manualCollection);
   * `none` — the type has no landing page at all (video).
   */
  landingPageOn: 'ad' | 'creative' | 'none'
  /** What this type calls its headline. manualCollection uses `title`; video has none. */
  headlineField: 'headline' | 'title' | null
  /** Whether Amazon's schema requires `asins` on the creative. */
  asinsRequired: boolean
  /** null when Amazon has not deprecated it. */
  deprecated: null | { on: string; inFavourOf: string; shutdownDate: string | null; source: string }
}

export const SB_AD_TYPES: Record<SbAdType, SbAdTypeSpec> = {
  productCollection: {
    createPath: '/sb/v4/ads/productCollection',
    label: 'Product collection',
    landingPageOn: 'ad',
    headlineField: 'headline',
    asinsRequired: false,
    deprecated: {
      on: '2026-07-06',
      inFavourOf: 'Manual Collection or Auto Collection',
      // Amazon's own note carries no date. A January 2027 shut-off is third-party only.
      shutdownDate: null,
      source: "Amazon Ads release notes 2026-07-06, via build/P0.8.md — 'deprecated', no date given",
    },
  },
  manualCollection: {
    createPath: '/sb/v4/ads/manualCollection',
    label: 'Manual collection',
    // 🔴 Not a sibling of `creative` like the others — `CreateManualCollectionCreative` carries
    // its own `landingPage`. Getting this wrong is a 400 that names a field, not a shape.
    landingPageOn: 'creative',
    headlineField: 'title',
    asinsRequired: true,
    deprecated: null,
  },
  storeSpotlight: {
    createPath: '/sb/v4/ads/storeSpotlight',
    label: 'Store spotlight',
    landingPageOn: 'ad',
    headlineField: 'headline',
    asinsRequired: false,
    deprecated: null,
  },
  video: {
    createPath: '/sb/v4/ads/video',
    label: 'Video',
    // `CreateVideoAd` has no landingPage, and `CreateVideoCreative` has no headline.
    landingPageOn: 'none',
    headlineField: null,
    asinsRequired: false,
    deprecated: null,
  },
}

export const SB_AD_TYPE_KEYS = Object.keys(SB_AD_TYPES) as SbAdType[]

/**
 * CC-11 — the limits Amazon's Sponsored Brands 4.0 document puts on each creative Nexus can send (read 2026-10-05):
 * `CreateManualCollectionCreative` (asins 3–10, required; brandName 1–30, required; title ≤ 32, optional) and
 * `CreateProductCollectionCreative` (asins ≤ 3; headline 1–50). A creative outside them is refused by Amazon, so Nexus
 * refuses it first — before the campaign, ad group or keywords exist on Amazon.
 *
 * Store spotlight and video are not listed: store spotlight needs store pages (`subpages`) and video needs a video
 * asset (`videoAssetIds`), and Nexus has neither, so no builder offers them.
 */
export const SB_CREATIVE_LIMITS: Partial<Record<SbAdType, { asinsMin: number; asinsMax: number; headlineMax: number; headlineRequired: boolean }>> = {
  manualCollection: { asinsMin: 3, asinsMax: 10, headlineMax: 32, headlineRequired: false },
  // Amazon's schema allows 0 ASINs here; Nexus has always required one (`createSbAdLocal`).
  productCollection: { asinsMin: 1, asinsMax: 3, headlineMax: 50, headlineRequired: true },
}

/** BRAND_NAME max length, both creatives (`brandName.maxLength`). */
const SB_BRAND_NAME_MAX = 30

/**
 * Why Amazon would refuse this Sponsored Brands creative, as plain sentences — empty when it can be sent. Pure: the
 * builder's preview, the pre-launch check and the create itself all ask this one function.
 */
export function sbCreativeProblems(c: { creativeType?: string | null; headline?: string | null; asins: readonly string[]; brandName?: string | null }): string[] {
  const out: string[] = []
  if (!c.creativeType) {
    out.push(`Choose a creative type (${(Object.keys(SB_CREATIVE_LIMITS) as SbAdType[]).map((k) => SB_AD_TYPES[k].label).join(' or ')}).`)
    return out
  }
  const spec = SB_AD_TYPES[c.creativeType as SbAdType]
  if (!spec) {
    out.push(`"${c.creativeType}" is not a Sponsored Brands creative type (${SB_AD_TYPE_KEYS.join(', ')}).`)
    return out
  }
  const limits = SB_CREATIVE_LIMITS[c.creativeType as SbAdType]
  if (!limits) {
    out.push(`A ${spec.label} creative cannot be made in Nexus yet: it needs ${c.creativeType === 'video' ? 'a video' : 'store pages'}, which Nexus cannot send.`)
    return out
  }
  const asins = c.asins.map((a) => a.trim()).filter(Boolean)
  if (asins.length < limits.asinsMin) out.push(`A ${spec.label} creative needs at least ${limits.asinsMin} product${limits.asinsMin === 1 ? '' : 's'}; it has ${asins.length}.`)
  if (asins.length > limits.asinsMax) out.push(`A ${spec.label} creative takes at most ${limits.asinsMax} products; it has ${asins.length}.`)
  const headline = (c.headline ?? '').trim()
  const field = spec.headlineField === 'title' ? 'title' : 'headline'
  if (limits.headlineRequired && !headline) out.push(`A ${spec.label} creative needs a ${field}.`)
  if (headline.length > limits.headlineMax) out.push(`Amazon allows ${limits.headlineMax} characters in a ${spec.label} ${field}; it has ${headline.length}.`)
  const brand = (c.brandName ?? '').trim()
  if (!brand) out.push('A Sponsored Brands creative needs a brand name.')
  else if (brand.length > SB_BRAND_NAME_MAX) out.push(`Amazon allows ${SB_BRAND_NAME_MAX} characters in a brand name; "${brand}" has ${brand.length}.`)
  return out
}

/** The ad types an operator should be offered for a NEW creative: the undeprecated ones. */
export const SB_AD_TYPES_CURRENT = SB_AD_TYPE_KEYS.filter((k) => SB_AD_TYPES[k].deprecated === null)

/** Amazon's `CreateOrUpdateEntityState` enum — the only two values the create endpoints accept. */
export const SB_AD_STATES = ['ENABLED', 'PAUSED'] as const

/** Amazon's `LandingPageType` enum. */
export const SB_LANDING_PAGE_TYPES = ['PRODUCT_LIST', 'STORE', 'CUSTOM_URL', 'DETAIL_PAGE'] as const

/** The full spec for a type, refusing anything this file does not name. */
export function sbAdTypeSpec(type: string): SbAdTypeSpec {
  const spec = SB_AD_TYPES[type as SbAdType]
  if (!spec) {
    throw new Error(
      `[ads] "${type}" is not a Sponsored Brands creative type (${SB_AD_TYPE_KEYS.join(', ')}) — nothing was sent`,
    )
  }
  return spec
}

/**
 * The creation endpoint for an ad type, refusing anything this file does not name.
 *
 * Replaces `sbAdTypeWire`, which returned a value for a field (`adType`) that does not exist in
 * Amazon's Sponsored Brands 4.0 document.
 *
 * A deprecated type is still SENT — Amazon deprecated it, it did not remove it, and its endpoint
 * is still in the document — so a refusal here would break an operator deliberately matching an
 * existing campaign's format. The caller logs the deprecation; see `sbAdTypeNotice`.
 */
export function sbAdCreatePath(type: string): string {
  return sbAdTypeSpec(type).createPath
}

/** A sentence for the log when a deprecated type is used, or null. */
export function sbAdTypeNotice(type: string): string | null {
  const d = SB_AD_TYPES[type as SbAdType]?.deprecated
  if (!d) return null
  return (
    `Sponsored Brands "${SB_AD_TYPES[type as SbAdType].label}" was deprecated on ${d.on} ` +
    `in favour of ${d.inFavourOf}` +
    (d.shutdownDate ? `, and shuts off on ${d.shutdownDate}` : ' (Amazon has announced no shutdown date)') +
    `. Source: ${d.source}`
  )
}
