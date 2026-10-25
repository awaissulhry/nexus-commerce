/** Local preparation checks. These results never authorize or confirm a live submission. */
export interface ListingReadinessIssue {
  field: string
  label: string
  kind: 'missing' | 'invalid' | 'translation' | 'schema' | 'account' | 'check' | 'warning'
  message: string
}
export interface ListingReadinessRow {
  id: string
  productId: string
  sku: string
  name: string | null
  channel: string
  marketplace: string
  accountId: string | null
  accountName: string
  aliasKey: string
  locale: string
  // LX.F F2 / R-LX-9 — the fifth member: a coordinate with no ReadinessIndex row
  // reads `notComputed`, which the service can now return (its allowlist derives
  // from `SCOPE_STATES`).
  state: 'ready' | 'warn' | 'blocked' | 'absent' | 'notComputed'
  pct: number | null
  computedAt: string | null
  /**
   * P2 (docs/attributes/PLAN.md §4.7) — set while this row waits for its rebuild after a bulk edit. `state` and `pct`
   * are then the PREVIOUS answer: show "checking…", never the old state as current. Absent = the row is current.
   */
  pendingSince?: string
  familyId: string | null
  issues: ListingReadinessIssue[]
  editorHref: string
}
export interface ListingReadinessPage {
  computedAt: string | null
  page: number
  pageSize: number
  total: number
  productCount: number
  rows: ListingReadinessRow[]
}

/*
 * ── Family view (rebuild, 23 October 2026 — docs/listings/READINESS-REBUILD-2026-10-23.md, layout A) ──────────────
 * One top-level row per product family (the root: `parentId ?? id`), like the Products page. A row carries one chip per
 * destination. A "listing" here is one product on one destination; its languages fold into one verdict, the worst wins
 * (the order of `SCOPE_STATES`: blocked → warn → notComputed → absent → ready).
 */

/** A readiness state, the scope vocabulary (`readinessMeta(state, 'scope')` owns its label and tone). */
export type ReadinessScopeState = ListingReadinessRow['state']

/** The tile filter: one scope state, or `notChecked` (= `absent` + `notComputed`). */
export type ReadinessStateFilter = ReadinessScopeState | 'notChecked'

/** Listings by folded state. */
export interface ReadinessStateCounts { blocked: number; warn: number; notComputed: number; absent: number; ready: number }

/** One destination. Shared (the master content) is channel `SHARED`, marketplace ''. */
export interface ReadinessDestination {
  /** The index coordinate key, `JSON.stringify([channel, market, accountId, aliasId])` (`readinessCoordinateKey`). */
  key: string
  channel: string
  marketplace: string
  accountId: string | null
  aliasKey: string
  /** Short words for the chip: "Shared", "Amazon IT", "eBay IT", "Shopify"; plus the store or alias when one market has more than one. */
  label: string
}

/** One chip: the verdict of a row (family or product) on one destination. */
export interface ReadinessChip {
  destinationKey: string
  state: ReadinessScopeState
  /** Listings of this row on this destination by state (a product row: one listing). */
  counts: ReadinessStateCounts
  /** Distinct problems (field) on this destination, over the row's listings and languages. */
  issueCount: number
  /** A rebuild is waiting: `state` is the previous answer. */
  pending: boolean
  /** The oldest check on this destination. */
  computedAt: string | null
}

/** Why a problem is a problem, in the page's words. */
export type ReadinessProblemKind = 'required' | 'translation' | 'setup' | 'rule' | 'check'

/** The most urgent problem of a row. */
export interface ReadinessNextStep {
  destinationKey: string
  field: string | null
  label: string
  message: string
  kind: ReadinessProblemKind
  /** Listings of the row this problem touches on that destination. */
  affected: number
  /** The product and language the link opens. */
  productId: string
  locale: string
  /** Bare studio path to the exact field (the web adds the business prefix). */
  href: string
}

/** Fields both row kinds share. */
export interface ReadinessRowBase {
  id: string
  sku: string
  name: string | null
  imageUrl: string | null
  photoCount: number
  state: ReadinessScopeState
  chips: ReadinessChip[]
  nextStep: ReadinessNextStep | null
  /** The oldest check in the row. */
  computedAt: string | null
  pending: boolean
  /** Bare studio path for the product. */
  editorHref: string
}

/** A top-level row: a family root (parent) or a single product. */
export interface ReadinessFamilyRow extends ReadinessRowBase {
  isParent: boolean
  /** Variants in the whole family (0 for a single product). */
  variantCount: number
  /** Members (the parent's own listing counts) that match the current search and filters. */
  matchingCount: number
}

/** A row inside an open family. */
export interface ReadinessMemberRow extends ReadinessRowBase {
  parentId: string | null
  /** The parent product's own listing ("Parent listing"), shown first. */
  isParentListing: boolean
}

/** GET /api/catalog-transfer/readiness/families */
export interface ReadinessFamiliesPage {
  page: number
  /** 50, 100 or 200. */
  pageSize: number
  /** Top-level rows after search, filters and the state filter. The pager counts these. */
  total: number
  /** Listings after search and filters, before the state filter. */
  listingCount: number
  /** Products (parents and variants) with at least one listing after search and filters, before the state filter. */
  productCount: number
  /** The tiles: listings by state after search and filters, before the state filter. `all` is their sum. */
  stats: ReadinessStateCounts & { all: number }
  /** Every destination in the result, in chip order: Shared, then channel, market, store, alias. */
  destinations: ReadinessDestination[]
  /** The oldest check in the result. */
  computedAt: string | null
  /** Families waiting for a rebuild. */
  pendingCount: number
  rows: ReadinessFamilyRow[]
}

/** GET /api/catalog-transfer/readiness/families/:rootId/members — the open family, at most `limit` (default 10) rows. */
export interface ReadinessMembersPage {
  rootId: string
  shown: number
  /** Members that match the current search and filters. */
  total: number
  /** Variants in the whole family. */
  variantCount: number
  rows: ReadinessMemberRow[]
}

/** One problem in the Fix window. */
export interface ReadinessProblem {
  field: string | null
  label: string
  kind: ReadinessProblemKind
  message: string
  /** Who requires the field here (a channel rule, a category schema…), when known. */
  requiredBy: string[]
  languages: string[]
  /** The listings it touches, at most 50; `productCount` is the full number. */
  products: Array<{ id: string; sku: string; name: string | null }>
  productCount: number
  /** Bare studio path to the field on the first product; null when no field is named. */
  href: string | null
}

/** GET /api/catalog-transfer/readiness/detail?productId=&family=1|0&destination= — the Fix window. */
export interface ReadinessDetail {
  productId: string
  family: boolean
  destination: ReadinessDestination
  state: ReadinessScopeState
  counts: ReadinessStateCounts
  computedAt: string | null
  pending: boolean
  /** The verdict per language (worst over the listings). */
  languages: Array<{ locale: string; state: ReadinessScopeState }>
  /** Required-and-empty first, then translations, setup, rules, other checks; then by listings touched. */
  problems: ReadinessProblem[]
  /** Notes of rows that could not be checked ("Not set up" reasons), distinct. */
  notes: string[]
  editorHref: string
}

/** The live event: one family's readiness changed. */
export interface ReadinessUpdatedPayload { rootProductId: string }

/*
 * ── Old eBay listing shells (25 October 2026 — docs/listings/READINESS-LISTING-SHELLS-2026-10-25.md) ─────────────────
 * The old eBay flat-file import made a product of its own for each extra eBay listing (`AIREON-ALT1`, …): a placeholder
 * that holds one eBay listing of another product. It is not a product to sell anywhere else. So it is checked, and may
 * get a listing, only on Shared and where it holds its own listing. Every other product: every destination.
 * The readiness rebuild, the index's minute check and draft listings all ask `readinessDestinationAllowed`.
 */

/** The product type of an old eBay listing shell. */
export const LISTING_SHELL_TYPE = 'EBAY_LISTING_SHELL'

export function isListingShell(productType: string | null | undefined): boolean {
  return productType === LISTING_SHELL_TYPE
}

/** A destination, or one of the product's own listings. Shared (the master content) has no channel. */
export interface ListingPlace { channel: string | null; market: string | null; accountId: string | null }

// The readiness index says UK where a listing may say GB.
const marketCode = (code: string | null) => {
  const upper = (code ?? '').toUpperCase()
  return upper === 'GB' ? 'UK' : upper
}

/**
 * May this product be checked on (or get a listing on) this destination? Shared: yes. A product that is not a shell:
 * yes. A shell: only where it holds one of its own listings: same channel, same market, and the same account when both
 * name one.
 */
export function readinessDestinationAllowed(
  product: { productType: string | null | undefined; ownListings: readonly ListingPlace[] },
  destination: ListingPlace,
): boolean {
  if (!destination.channel || !isListingShell(product.productType)) return true
  return product.ownListings.some(listing => listing.channel === destination.channel
    && marketCode(listing.market) === marketCode(destination.market)
    && (!listing.accountId || !destination.accountId || listing.accountId === destination.accountId))
}
