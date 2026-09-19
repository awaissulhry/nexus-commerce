/**
 * SC.0 — Sync Control derivation core (2026-07-21, owner-approved program).
 *
 * ONE pure function decides what quantity a listing/membership is *intended*
 * to advertise — the cascade, dispatch re-reads, both read-backs, the drift
 * self-heal, and the Sync Control tab must all consume THIS and nothing else,
 * so the controls and every verification loop share a single definition of
 * truth.
 *
 * Precedence (each rule beats everything below it):
 *   1. FBA            → FBA_EXCLUDED. Amazon manages FBA stock; no control,
 *                       no routing, no pause state may ever produce a push.
 *   2. Channel policy → PAUSED (operator kill-switch, channel or channel:market)
 *   3. Listing pause  → PAUSED (syncPaused / membership followPool=false)
 *   4. Pinned         → PINNED at the pinned value (no pool derivation;
 *                       memberships: pinnedQuantity, shared stock step 3)
 *   5. Follow         → routed-ledger math:
 *        routed rows = WAREHOUSE rows whose location routes to this
 *        channel+market (StockLocation.syncRoutes; empty list = routes
 *        everywhere) ∩ listing sourceLocationCodes (empty = no override).
 *        ZERO routed rows → UNCOUNTED (never manufacture a zero — the P0
 *        guard applied per-listing to the ROUTED set: stock counted only in
 *        unrouted locations still means "unknown here"), except for a product
 *        that left a shared pool (uncountedIsZero): there it means 0.
 *        Else quantity = max(0, Σ available − stockBuffer).
 *
 * Routing tokens (StockLocation.syncRoutes — SC's OWN column; the shadow
 * diff caught that servesMarketplaces belongs to the ATP layer with bare
 * market-code data, so SC never touches it):
 *   'MARKET'          bare market, any channel        e.g. 'IT'
 *   'CHANNEL'         whole channel                    e.g. 'EBAY'
 *   'CHANNEL:MARKET'  exact                            e.g. 'AMAZON:IT'
 * A bare token equal to a known channel name reads as channel-wide.
 * Matching is case-insensitive; markets normalize by stripping a channel
 * prefix ('EBAY_IT' ≡ 'IT' for channel EBAY). Malformed tokens match nothing
 * (a validation helper is exported for the future UI). Empty list = routes
 * everywhere — which makes ZERO configured rules byte-identical to the
 * pre-SC system.
 */

export const KNOWN_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'] as const

export interface RoutedLedgerRow {
  locationCode: string
  /** StockLevel.available (already reservation-adjusted), WAREHOUSE rows only. */
  available: number
  /** StockLocation.syncRoutes for this row's location (SC's own column). */
  syncRoutes: string[]
}

declare const SYNC_LEDGER: unique symbol
/**
 * Shared stock (plan 2026-09-19) — the ledger a listing follows. A product sells either from this
 * business's own WAREHOUSE rows or from another business's pool; only `loadSyncLedgers`
 * (services/stock-pool/sync-ledgers.ts) knows which. The brand makes every caller of the core get its
 * ledger from there: a ledger built from this business's StockLevel rows by hand would push the
 * business's own (often empty) stock over a pool number. `syncLedgerOf` is the one way to make one;
 * scripts/check-sync-ledger-source.mjs keeps it to the loader, the stock import's own planned rows,
 * and tests.
 */
export type SyncLedger = ReadonlyArray<RoutedLedgerRow> & { readonly [SYNC_LEDGER]: true }
export function syncLedgerOf(rows: ReadonlyArray<RoutedLedgerRow>): SyncLedger {
  return rows as SyncLedger
}

export interface SyncControlInputs {
  channel: string
  marketplace: string
  /** Canonical fail-closed FBA evaluation (isFbaListing-class signals), computed by the caller. */
  isFba: boolean
  /** SCT.6 — this market's offer is CLOSED (purchasable_offer removed): zero pushes. */
  offerClosed?: boolean
  followMasterQuantity: boolean
  syncPaused: boolean
  /** Listing's current pinned value (ChannelListing.quantity when pinned). */
  pinnedQuantity: number | null
  stockBuffer: number
  /** Listing-level routing override; empty = no override (all routed locations). */
  sourceLocationCodes: string[]
  channelPolicy?: { pushesPaused: boolean } | null
  ledger: SyncLedger
  /**
   * Shared stock — the product sold from a pool before and now uses its own stock. Its own stock may
   * never have been counted; that means 0, never "unknown": keeping the pool's last number on the
   * channel is how an oversell happens (plan §4, first safety rule). From loadSyncLedgers.
   */
  uncountedIsZero?: boolean
}

export type IntendedResolution =
  | { kind: 'FBA_EXCLUDED' }
  | { kind: 'CLOSED' }
  | { kind: 'PAUSED'; via: 'POLICY' | 'LISTING' }
  | { kind: 'UNCOUNTED' }
  | { kind: 'PINNED'; quantity: number | null }
  | { kind: 'FOLLOW'; quantity: number; routedAvailable: number; routedLocations: string[] }

const norm = (s: string): string => s.trim().toUpperCase()

/** 'EBAY_IT' → 'IT' for channel EBAY; otherwise verbatim (upper-cased). */
export function normalizeMarket(channel: string, marketplace: string): string {
  const c = norm(channel)
  const m = norm(marketplace)
  return m.startsWith(`${c}_`) ? m.slice(c.length + 1) : m
}

/** Does a location's syncRoutes list route to this channel+market?
 *  Empty list = routes EVERYWHERE (default = today's behavior). */
export function locationServes(
  syncRoutes: string[],
  channel: string,
  marketplace: string,
): boolean {
  if (!syncRoutes || syncRoutes.length === 0) return true
  const c = norm(channel)
  const m = normalizeMarket(channel, marketplace)
  const channels = new Set<string>(KNOWN_CHANNELS)
  for (const raw of syncRoutes) {
    const token = norm(raw)
    if (!token) continue
    const parts = token.split(':')
    if (parts.length > 2) continue // malformed — matches nothing
    if (parts.length === 1) {
      // bare token: a known channel name = channel-wide; anything else = a
      // market code valid on ANY channel (ATP-style semantics).
      if (channels.has(parts[0])) {
        if (parts[0] === c) return true
      } else if (parts[0] === m) {
        return true
      }
      continue
    }
    const [tc, tm] = parts
    if (tc !== c) continue
    if (tm === '' || tm === '*' || tm === m) return true
  }
  return false
}

/** Token validation for the future UI (SC.2+): returns per-token problems. */
export function validateServesTokens(
  tokens: string[],
  knownChannels: string[] = [...KNOWN_CHANNELS],
): Array<{ token: string; problem: string }> {
  const out: Array<{ token: string; problem: string }> = []
  for (const raw of tokens) {
    const token = norm(raw)
    if (!token) {
      out.push({ token: raw, problem: 'empty token' })
      continue
    }
    const parts = token.split(':')
    if (parts.length > 2) {
      out.push({ token: raw, problem: 'expected MARKET, CHANNEL or CHANNEL:MARKET' })
      continue
    }
    // Two-part tokens must name a known channel; bare tokens are either a
    // known channel (channel-wide) or read as a market code — flag only
    // suspicious shapes (too long to be a market code).
    if (parts.length === 2 && !knownChannels.includes(parts[0])) {
      out.push({ token: raw, problem: `unknown channel '${parts[0]}'` })
    } else if (parts.length === 1 && !knownChannels.includes(parts[0]) && parts[0].length > 8) {
      out.push({ token: raw, problem: `'${parts[0]}' looks like neither a channel nor a market code` })
    }
  }
  return out
}

export function resolveIntendedQuantity(i: SyncControlInputs): IntendedResolution {
  // 1 — FBA beats everything. No pause, pin, routing, or policy may ever
  //     turn an FBA listing into a quantity push.
  if (i.isFba) return { kind: 'FBA_EXCLUDED' }

  // 1b — SCT.6: a CLOSED market offer gets ZERO pushes of any kind. Sibling
  //      markets keep following the pool; Reopen is the only way back.
  if (i.offerClosed) return { kind: 'CLOSED' }

  // 2 — channel/market kill-switch.
  if (i.channelPolicy?.pushesPaused) return { kind: 'PAUSED', via: 'POLICY' }

  // 3 — listing-level pause (memberships map followPool=false here).
  if (i.syncPaused) return { kind: 'PAUSED', via: 'LISTING' }

  // 4 — pinned: frozen at the operator's value, no pool derivation.
  if (!i.followMasterQuantity) return { kind: 'PINNED', quantity: i.pinnedQuantity }

  // 5 — follow: routed-ledger math.
  const override = new Set(i.sourceLocationCodes.map(norm).filter(Boolean))
  const routed = i.ledger.filter((row) => {
    if (!locationServes(row.syncRoutes, i.channel, i.marketplace)) return false
    if (override.size > 0 && !override.has(norm(row.locationCode))) return false
    return true
  })
  if (routed.length === 0) {
    return i.uncountedIsZero ? { kind: 'FOLLOW', quantity: 0, routedAvailable: 0, routedLocations: [] } : { kind: 'UNCOUNTED' }
  }
  const routedAvailable = routed.reduce((s, r) => s + r.available, 0)
  const buffer = Math.max(0, i.stockBuffer || 0)
  return {
    kind: 'FOLLOW',
    quantity: Math.max(0, routedAvailable - buffer),
    routedAvailable,
    routedLocations: routed.map((r) => r.locationCode),
  }
}

/** Shared-membership wrapper: followPool=false = excluded from fan-out
 *  (PAUSED via LISTING); a pinned quantity (shared stock plan step 3: "Fixed
 *  number" for a shared variant) is PINNED; otherwise the same follow math. The
 *  precedence is the listing's: policy → Excluded → Fixed number → follow. */
export function resolveMembershipIntended(args: {
  marketplace: string
  followPool: boolean
  /** null or absent = follows the pool. */
  pinnedQuantity?: number | null
  stockBuffer: number
  channelPolicy?: { pushesPaused: boolean } | null
  ledger: SyncLedger
  uncountedIsZero?: boolean
}): IntendedResolution {
  const pinned = args.pinnedQuantity != null
  return resolveIntendedQuantity({
    channel: 'EBAY',
    marketplace: args.marketplace,
    isFba: false,
    followMasterQuantity: !pinned,
    syncPaused: !args.followPool,
    pinnedQuantity: pinned ? args.pinnedQuantity! : null,
    stockBuffer: args.stockBuffer,
    sourceLocationCodes: [],
    channelPolicy: args.channelPolicy,
    ledger: args.ledger,
    uncountedIsZero: args.uncountedIsZero,
  })
}
