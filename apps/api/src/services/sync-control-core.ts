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
 *   5. Follow         → routed-ledger math over the rows `sellsFrom` picks
 *        ("Sells from", Step 2 — the first rule that has a list decides):
 *          a. the listing's own sourceLocationCodes → exactly those rows, in
 *             that order (they REPLACE the routes; before Step 2 they only
 *             narrowed them);
 *          b. the business's list for this channel+market
 *             (SyncChannelPolicy.sourceLocationCodes, carried on the ledger
 *             as `marketSources`) → exactly those rows, in that order;
 *          c. otherwise the WAREHOUSE rows whose location routes here
 *             (StockLocation.syncRoutes; empty list = routes everywhere), in
 *             the ledger's order (the loader's sale order: the default
 *             warehouse first, then by code) — the same rows, so the same
 *             numbers, as before Step 2.
 *        A pooled product's ledger carries no lists and its listings' codes are
 *        blanked (`ledgerInputs`): the lent rows route everywhere.
 *        The order never changes the quantity (sum only); it is the order a
 *        sale takes stock in.
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

export const KNOWN_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'] as const

/**
 * The channels whose listings get a QUANTITY_UPDATE queue row when the quantity they should show moves. They are
 * exactly the channels Sync Control knows: its policies, routes and pauses are what govern those rows.
 *
 * ONE set for every producer — the stock cascade, the stock import, follow / pin / buffer, and listing activation.
 * Each of the four used to keep its own list, and Etsy was missing from all four (2026-10-01): its quantity moved in
 * Nexus, the listing said PENDING, and no row was ever written. A channel cannot now be pushed by one producer and
 * silently skipped by another.
 */
export const QUANTITY_PUSH_CHANNELS: ReadonlySet<string> = new Set<string>(KNOWN_CHANNELS)

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
export type SyncLedger = ReadonlyArray<RoutedLedgerRow> & {
  readonly [SYNC_LEDGER]: true
  /**
   * Step 2 — "Sells from": the business's ordered list of StockLocation codes per channel+market
   * (key `marketSourceKey`), from SyncChannelPolicy.sourceLocationCodes rows that name no account.
   * Only non-empty lists are kept. Absent on a pooled product's ledger (the pool's rows are the lender's).
   */
  readonly marketSources?: MarketSources
}

/** Step 2 — `marketSourceKey(channel, market)` → the ordered StockLocation codes that market sells from. */
export type MarketSources = ReadonlyMap<string, readonly string[]>

export function syncLedgerOf(rows: ReadonlyArray<RoutedLedgerRow>, opts?: { marketSources?: MarketSources }): SyncLedger {
  const marketSources = opts?.marketSources
  if (!marketSources || marketSources.size === 0) return rows as SyncLedger
  // A copy, so the caller's array is never changed; the lists ride along non-enumerable, so a ledger still
  // compares (and serialises) as the plain array of its rows.
  const ledger = [...rows]
  Object.defineProperty(ledger, 'marketSources', { value: marketSources, enumerable: false })
  return ledger as unknown as SyncLedger
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
  /** The listing's own "Sells from" list, in sale order; empty = follows the market's list, else the routes (`sellsFrom`). */
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

/** Step 2 — the key of one market's "Sells from" list: `CHANNEL:MARKET` ('EBAY_IT' → 'EBAY:IT'). */
export function marketSourceKey(channel: string, marketplace: string): string {
  return `${norm(channel)}:${normalizeMarket(channel, marketplace)}`
}

/** Where a listing's rows come from: its own list, its market's list, or the locations' routes. */
export type SellsFromOrigin = 'product' | 'market' | 'routes'

export interface SellsFrom {
  origin: SellsFromOrigin
  /** The chosen StockLocation codes in sale order (a list as stored, without repeats; for 'routes' the routed rows' codes). */
  codes: string[]
  /** The ledger rows those codes pick, in sale order. Empty = nothing routed here (UNCOUNTED). */
  rows: RoutedLedgerRow[]
}

/** A list as the router reads it: trimmed, no blanks, no repeats (the first one keeps its place). */
function listOf(codes: ReadonlyArray<string> | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of codes ?? []) {
    const code = String(raw ?? '').trim()
    if (!code || seen.has(norm(code))) continue
    seen.add(norm(code))
    out.push(code)
  }
  return out
}

/**
 * Step 2 — "Sells from": THE choice of the rows one listing (or shared membership) sells from, and their sale order.
 * The first rule with a list decides: the listing's own codes ('product'), then the business's list for the market
 * ('market'), then each location's syncRoutes ('routes', empty = everywhere — exactly the pre-Step-2 behaviour).
 * A list picks exactly the rows of its codes, in its order, whatever their routes say. The quantity is the sum over
 * `rows`; the order is the order a sale takes stock in.
 */
export function sellsFrom(i: {
  ledger: SyncLedger
  channel: string
  marketplace: string
  sourceLocationCodes: string[]
}): SellsFrom {
  const pick = (origin: SellsFromOrigin, codes: string[]): SellsFrom => ({
    origin,
    codes,
    rows: codes.flatMap((code) => i.ledger.filter((row) => norm(row.locationCode) === norm(code))),
  })
  const own = listOf(i.sourceLocationCodes)
  if (own.length > 0) return pick('product', own)
  const market = listOf(i.ledger.marketSources?.get(marketSourceKey(i.channel, i.marketplace)))
  if (market.length > 0) return pick('market', market)
  const rows = i.ledger.filter((row) => locationServes(row.syncRoutes, i.channel, i.marketplace))
  return { origin: 'routes', codes: listOf(rows.map((row) => row.locationCode)), rows }
}

/**
 * P4.3d — the ledger rows routed to one channel+market: `sellsFrom(i).rows`.
 *
 * 🔴 This is THE routing filter, and it has two readers on purpose.
 * `resolveIntendedQuantity` derives the quantity a listing may promise from it,
 * and the send-time oversell clamp derives its CEILING from it. Before P4.3d the
 * clamp summed every warehouse row the product held, routed or not, so the
 * number a listing was allowed to promise and the number it was capped to were
 * computed two different ways in two different files — and the cap was the wider
 * of the two, which is the direction that does not catch anything.
 */
export function routedLedgerRows(i: {
  ledger: SyncLedger
  channel: string
  marketplace: string
  sourceLocationCodes: string[]
}): ReadonlyArray<RoutedLedgerRow> {
  return sellsFrom(i).rows
}

/**
 * P4.3d — the units routed to this channel+market, before the listing's own
 * hold-back, and whether ANY row routed there at all.
 *
 * `routed: false` is not "zero units". It is "no location is routed here", which
 * for a pooled product means we do not know — the resolver answers `UNCOUNTED`
 * and pushes nothing. A clamp cannot decline, so its caller must: capping to 0
 * and sending it is the scoped-Zero incident, not a safe default.
 */
export function routedAvailable(i: {
  ledger: SyncLedger
  channel: string
  marketplace: string
  sourceLocationCodes: string[]
}): { available: number; routed: boolean; locationCodes: string[] } {
  const rows = routedLedgerRows(i)
  return {
    available: rows.reduce((sum, row) => sum + row.available, 0),
    routed: rows.length > 0,
    locationCodes: rows.map((row) => row.locationCode),
  }
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
  const routed = routedLedgerRows(i)
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
