/**
 * Shared stock (plan docs/2026-09-19-shared-stock-plan.md, contract docs/2026-09-19-shared-stock-build.md
 * §2 and §4) — the shapes the stock-pool routes answer with. Routes: apps/api/src/routes/stock-pool.routes.ts.
 * Calls go through `sharingApi` (same session, business and CSRF handling as the product shares).
 */
export type GrantStatus = 'pending' | 'active' | 'paused' | 'revoked' | 'declined'
export type GrantSide = 'lender' | 'borrower'
export type LenderAction = 'pause' | 'resume' | 'end'
export type BorrowerDecision = 'accept' | 'decline' | 'leave'

export interface GrantLocation {
  id: string
  code: string
  name: string
  /** False when the lender closed or removed the warehouse: it lends 0 until it is active again. */
  usable: boolean
}

export interface Grant {
  id: string
  side: GrantSide
  ownerWorkspaceId: string
  ownerWorkspaceName: string
  workspaceId: string
  workspaceName: string
  status: GrantStatus
  version: number
  locations: GrantLocation[]
  /** The borrower's products that sell from this stock now. */
  linkedProducts: number
  createdAt: string
  respondedAt: string | null
  pausedAt: string | null
  endedAt: string | null
  endedBySide: 'owner' | 'borrower' | null
}

/** What pausing, ending or leaving would do to the borrower's listings — counts only. */
export interface GrantImpact {
  grantId: string
  linkedProducts: number
  listings: { toZero: number; toOwn: number; pinned: number; paused: number; closed: number; fba: number }
  sharedVariants: { toZero: number; toOwn: number; excluded: number }
}

export interface LendableWarehouse { id: string; code: string; name: string }

export interface PoolProduct {
  productId: string
  sku: string
  name: string
  parentId: string | null
  source: 'pool' | 'own'
  grantId: string | null
  ownAvailable: number
  /** Null when the shared stock is not on. */
  poolAvailable: number | null
  /** No cost price in this business: its pool sales would count at zero cost in profit reports. */
  costPriceMissing: boolean
}

export type ListingRule = 'follows' | 'fixed' | 'paused' | 'excluded' | 'amazon-managed' | 'offer-closed' | 'not-counted'
export interface ListingPreview {
  listingId: string | null
  itemId?: string
  channel: string
  marketplace: string
  accountId: string | null
  accountLabel: string | null
  /** 0 = the main listing, 1… = an alias; null when the account and market hold only this listing. */
  listingMark: number | null
  aliasLabel: string | null
  showsNow: number | null
  willShow: number | null
  rule: ListingRule
}
export interface SwitchPreview {
  productId: string
  sku: string
  from: 'pool' | 'own'
  to: 'pool' | 'own'
  refusal: string | null
  costPriceMissing: boolean
  listings: ListingPreview[]
}
