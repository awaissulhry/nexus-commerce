/** Inputs the bidding formula needs for one target (all money = integer minor units). */
export interface BidContext {
  bridgeId: string          // internal entity link id (for ack/audit)
  externalId: string        // Amazon keywordId / targetId
  accountRef: string        // Amazon profileId (rate-limit + scope key)
  currentBidMinor: number
  aovMinor: number          // average order value (price proxy)
  cr7d: number              // conversion rate, trailing 7d (0..1)
  cr30d: number             // conversion rate, trailing 30d (0..1)
  acosTargetBps: number     // 3000 = 30.00%
  acos1hBps: number | null  // live hour ACoS in bps, null if no traffic
  daysOfSupply: number | null
  bidMinMinor: number
  bidMaxMinor: number
}

/** The unit of work placed on the queue. */
export interface SetBidJob {
  bridgeId: string
  externalId: string
  accountRef: string
  bidMinor: number          // the computed target bid
  prevBidMinor: number
}

export interface OptimizeResult {
  evaluated: number
  queued: number
  skippedDeadband: number
}
