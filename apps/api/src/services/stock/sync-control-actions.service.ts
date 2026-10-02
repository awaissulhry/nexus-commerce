/**
 * MCP full control 08 S7 — Sync Control's writes, moved out of `routes/sync-control.routes.ts` UNCHANGED so Claude's tools
 * (`bulk-listing-stock`, `set-stock-policy`) run the very code the page runs:
 *
 *   runSyncControlAction   POST /api/stock/sync-control/actions          follow, pin, zero & pin, pause, resume, buffer,
 *                                                                        exclude, include, close/reopen an Amazon offer
 *   setLocationRoutes      POST /api/stock/sync-control/location-routes  which channels and markets a location feeds
 *   setSyncPolicy          POST /api/stock/sync-control/policies         a channel or market's pause and new-listing default
 *
 * Each returns what the route answered: `{ status, body }` — the route sends `body` with `status` (a 200 as the plain
 * object it returned before), byte for byte the answer it gave when this code lived in the route. The rows the page
 * reads (`computeRows`) and the canonical-master fold (`resolveCanonicalMasters`) moved with them; the route imports them.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { setListingPinEnds, setListingPauseEnds, setMembershipExclusionEnds, setMembershipFixedNumber } from '../sync-control-overrides.service.js'
import { logger } from '../../utils/logger.js'
import { resolveIntendedQuantity, resolveMembershipIntended, validateServesTokens } from '../sync-control-core.js'
import { loadChannelPolicies, policyFor, validatePolicyInput, enforceNewListingDefaults, writeChannelPolicy } from '../sync-control-policy.service.js'
import { ledgerInputs, loadSyncLedgers, type ProductLedger } from '../stock-pool/sync-ledgers.js'
import { setFollowMasterQuantity, setStockBuffer } from '../follow-master.service.js'
import { recascadeAfterSyncControlChange } from '../stock-movement.service.js'
import { enqueueOutboundRowsInstant } from '../outbound-enqueue.js'
import { resolveCanonicalMap, canonicalStem, rowMatchesScope, type SyncScope } from '../sync-control-product-view.js'
import { projectActionAndDetect, projectBufferAndDetect, AMAZON_EU_SHARED_MARKETS } from '../amazon-eu-quantity-guard.js'
import { whereCoordinate, type ListingCoordinate } from '../../lib/listing-coordinate.js'
import { closeMarketOffers, reopenMarketOffers, isFbaCoordinate } from '../amazon-market-offer.service.js'
import { NoConnectionError, resolveConnection } from '../connection-resolver.service.js'
import { EBAY_ZERO_REFUSAL } from '@nexus/shared/matrix-preview'

/** What the route answers: its status, and the body it sends (a 200 is the plain object the route returned). */
export interface SyncControlAnswer<T = unknown> {
  status: number
  body: T
}
const answer = <T,>(status: number, body: T): SyncControlAnswer<T> => ({ status, body })

/** Where a failed action is logged: the route passes its request logger, a tool the app logger. */
export interface SyncControlLog {
  error: (details: Record<string, unknown>, message: string) => void
}
const appLog: SyncControlLog = { error: (details, message) => logger.error(message, details) }

export type Mode = 'FOLLOW' | 'PINNED' | 'PAUSED' | 'PAUSED_POLICY' | 'UNCOUNTED' | 'FBA' | 'EXCLUDED' | 'CLOSED'

export interface SyncControlRow {
  lane: 'LISTING' | 'SHARED'
  sku: string
  productId: string | null
  channel: string
  marketplace: string
  mode: Mode
  intendedQty: number | null
  liveQty: number | null
  buffer: number
  routedLocations: string[]
  itemId?: string
  /** Shared stock step 3 — when the current Fixed number / Paused / Excluded ends by itself (ISO), or null. */
  endsAt?: string | null
  /** A listing row's full address (lib/listing-coordinate.ts): the account and the alias, so an action on
   *  it names exactly this listing. Without them every Listings-view action failed (found 2026-09-19). */
  channelConnectionId?: string | null
  aliasKey?: string
}

/** Shared stock — the same ledgers the cascade uses: a pooled product shows the pool's numbers. */
export async function buildLedgers(productIds: string[]): Promise<Map<string, ProductLedger>> {
  return loadSyncLedgers(prisma, productIds)
}

/** Shared stock step 3 — when the listing's current override ends by itself (null = until changed). */
function endOf(r: ReturnType<typeof resolveIntendedQuantity>, pinnedUntil: Date | null, pausedUntil: Date | null): string | null {
  const at = r.kind === 'PINNED' ? pinnedUntil : r.kind === 'PAUSED' && r.via === 'LISTING' ? pausedUntil : null
  return at ? at.toISOString() : null
}

function modeOf(r: ReturnType<typeof resolveIntendedQuantity>, isShared: boolean): Mode {
  switch (r.kind) {
    case 'FBA_EXCLUDED': return 'FBA'
    case 'CLOSED': return 'CLOSED'
    case 'PAUSED': return r.via === 'POLICY' ? 'PAUSED_POLICY' : isShared ? 'EXCLUDED' : 'PAUSED'
    case 'PINNED': return 'PINNED'
    case 'UNCOUNTED': return 'UNCOUNTED'
    case 'FOLLOW': return 'FOLLOW'
  }
}

export async function computeRows(): Promise<SyncControlRow[]> {
  const [listings, memberships, policies] = await Promise.all([
    prisma.channelListing.findMany({
      // SCD.8 — a DELETED product must never appear in the control tower: it is
      // hidden on /products, so showing it here (75 rows across 21 deleted
      // products, incl. the stray 'TEST') made the two surfaces disagree and
      // offered control over something the operator had already removed.
      where: {
        isPublished: true,
        listingStatus: { notIn: ['ENDED', 'REMOVED'] },
        // ...and not an orphaned child of a deleted master either: the row's
        // own product can be alive while its PARENT was deleted (the 'TEST'
        // case — the listing hangs off TEST-S-Black, whose master TEST is
        // deleted), and grouping would surface it under the deleted master.
        product: { deletedAt: null, OR: [{ parentId: null }, { parent: { deletedAt: null } }] },
      },
      select: {
        productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true,
        followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true, offerClosedAt: true,
        pinnedUntil: true, pausedUntil: true, channelConnectionId: true, aliasKey: true,
        product: { select: { sku: true, fulfillmentMethod: true } },
      },
    }),
    prisma.sharedListingMembership.findMany({
      where: { status: 'ACTIVE' },
      select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true, pinnedQuantity: true, pinnedUntil: true, pausedUntil: true, channelConnectionId: true },
    }),
    loadChannelPolicies(),
  ])
  // SCD.8 — the shared lane has no product relation to filter on, so drop
  // memberships whose product was deleted here (same rule as the listing lane).
  const memPids = [...new Set(memberships.map((m) => m.productId).filter((p): p is string => Boolean(p)))]
  const liveMemPids = new Set(
    (await prisma.product.findMany({
      where: { id: { in: memPids }, deletedAt: null, OR: [{ parentId: null }, { parent: { deletedAt: null } }] },
      select: { id: true },
    })).map((p) => p.id),
  )
  const liveMemberships = memberships.filter((m) => !m.productId || liveMemPids.has(m.productId))

  const productIds = [
    ...new Set([
      ...listings.map((l) => l.productId),
      ...liveMemberships.map((m) => m.productId).filter((p): p is string => Boolean(p)),
    ]),
  ]
  const ledgers = await buildLedgers(productIds)
  const rows: SyncControlRow[] = []

  for (const cl of listings) {
    const isFba =
      cl.fulfillmentMethod === 'FBA' ||
      (cl.fulfillmentMethod == null && cl.product?.fulfillmentMethod === 'FBA') ||
      cl.product?.fulfillmentMethod === 'FBA'
    const r = resolveIntendedQuantity({
      channel: cl.channel,
      marketplace: cl.marketplace,
      isFba,
      offerClosed: !!cl.offerClosedAt,
      followMasterQuantity: cl.followMasterQuantity,
      syncPaused: cl.syncPaused,
      pinnedQuantity: cl.quantity,
      stockBuffer: cl.stockBuffer ?? 0,
      channelPolicy: policyFor(policies, cl.channel, cl.marketplace, cl.channelConnectionId),
      ...ledgerInputs(ledgers.get(cl.productId), cl.sourceLocationCodes ?? []),
    })
    rows.push({
      lane: 'LISTING',
      sku: cl.product?.sku ?? '?',
      productId: cl.productId,
      channel: cl.channel,
      marketplace: cl.marketplace,
      mode: modeOf(r, false),
      intendedQty: r.kind === 'FOLLOW' ? r.quantity : r.kind === 'PINNED' ? r.quantity : null,
      liveQty: cl.quantity,
      buffer: cl.stockBuffer ?? 0,
      routedLocations: r.kind === 'FOLLOW' ? r.routedLocations : [],
      endsAt: endOf(r, cl.pinnedUntil, cl.pausedUntil),
      channelConnectionId: cl.channelConnectionId,
      aliasKey: cl.aliasKey,
    })
  }

  for (const m of liveMemberships) {
    const r = resolveMembershipIntended({
      marketplace: m.marketplace,
      followPool: m.followPool ?? true,
      pinnedQuantity: m.pinnedQuantity,
      stockBuffer: m.stockBuffer ?? 0,
      channelPolicy: policyFor(policies, 'EBAY', m.marketplace, m.channelConnectionId),
      ledger: ledgerInputs(m.productId ? ledgers.get(m.productId) : undefined).ledger,
      uncountedIsZero: ledgerInputs(m.productId ? ledgers.get(m.productId) : undefined).uncountedIsZero,
    })
    rows.push({
      lane: 'SHARED',
      sku: m.sku,
      productId: m.productId,
      channel: 'EBAY',
      marketplace: m.marketplace,
      mode: modeOf(r, true),
      intendedQty: r.kind === 'FOLLOW' ? r.quantity : r.kind === 'PINNED' ? r.quantity : null,
      liveQty: m.lastQtyPushed,
      buffer: m.stockBuffer ?? 0,
      routedLocations: r.kind === 'FOLLOW' ? r.routedLocations : [],
      itemId: m.itemId,
      endsAt: endOf(r, m.pinnedUntil, m.pausedUntil),
    })
  }
  return rows
}

/**
 * SCD.1 — resolve each master to its canonical master via the shared listing
 * pool (owner's shared-child-SKU insight). Childless duplicate masters fold
 * into the canonical whose variants their listings pool. Bounded queries (only
 * childless masters are chased through the pool). Returns Map<masterId, canonicalId>.
 */
export async function resolveCanonicalMasters(masterIds: string[]): Promise<Map<string, string>> {
  if (masterIds.length === 0) return new Map()
  const [withChildren, masterSkus] = await Promise.all([
    prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }),
    prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } }),
  ])
  const mastersWithChildren = new Set(withChildren.map((p) => p.parentId).filter((x): x is string => Boolean(x)))
  const childless = masterIds.filter((id) => !mastersWithChildren.has(id))

  // SCD.1b — stem-fallback data: map each master's stem, and each CHILD-OWNING
  // canonical's stem → its id (so an unpooled childless duplicate can fold in).
  const stemOfMaster = new Map<string, string>()
  const canonicalByStem = new Map<string, string>()
  // Deterministic: prefer the master whose SKU *is* the stem, else the
  // lexicographically-first SKU. (An unordered findMany would otherwise let the
  // winner flip between requests and make groups appear to move.)
  const orderedMasters = [...masterSkus].sort((a, b) => {
    const [sa, sb] = [canonicalStem(a.sku), canonicalStem(b.sku)]
    const [ea, eb] = [a.sku.toUpperCase() === sa ? 0 : 1, b.sku.toUpperCase() === sb ? 0 : 1]
    return ea - eb || a.sku.localeCompare(b.sku)
  })
  for (const m of orderedMasters) {
    const stem = canonicalStem(m.sku)
    stemOfMaster.set(m.id, stem)
    if (mastersWithChildren.has(m.id) && !canonicalByStem.has(stem)) canonicalByStem.set(stem, m.id)
  }

  const itemIdsByMaster = new Map<string, string[]>()
  const canonicalMasterByItemId = new Map<string, string>()

  if (childless.length > 0) {
    const cls = await prisma.channelListing.findMany({
      where: { productId: { in: childless }, externalListingId: { not: null } },
      select: { productId: true, externalListingId: true },
    })
    const allItemIds = new Set<string>()
    for (const c of cls) {
      if (!c.externalListingId) continue
      const arr = itemIdsByMaster.get(c.productId) ?? []
      arr.push(c.externalListingId)
      itemIdsByMaster.set(c.productId, arr)
      allItemIds.add(c.externalListingId)
    }
    if (allItemIds.size > 0) {
      const mems = await prisma.sharedListingMembership.findMany({
        where: { itemId: { in: [...allItemIds] } },
        select: { itemId: true, productId: true },
      })
      const memPids = [...new Set(mems.map((m) => m.productId).filter((x): x is string => Boolean(x)))]
      const memProducts = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } })
      const masterOfProduct = new Map(memProducts.map((p) => [p.id, p.parentId ?? p.id]))
      for (const m of mems) {
        if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue
        const canonical = masterOfProduct.get(m.productId)
        // only fold into a canonical that owns children (a real product family)
        if (canonical && mastersWithChildren.has(canonical)) canonicalMasterByItemId.set(m.itemId, canonical)
      }
    }
  }

  return resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
}

/**
 * Shared stock step 3 — the optional end of a Fixed number, a Paused listing or an Excluded variant.
 * undefined = not given (keep what is there); null = no end; otherwise a moment between one minute and
 * one year from now. Stored in UTC; the page shows it in the person's own time zone.
 */
export const parseUntil = (value: unknown): { ok: true; until: Date | null | undefined } | { ok: false; error: string } => {
  if (value === undefined) return { ok: true, until: undefined }
  if (value === null || value === '') return { ok: true, until: null }
  const at = typeof value === 'string' ? new Date(value) : null
  if (!at || Number.isNaN(at.getTime())) return { ok: false, error: 'The end time is not a valid date and time.' }
  const now = Date.now()
  if (at.getTime() < now + 60_000) return { ok: false, error: 'The end time must be at least one minute from now.' }
  if (at.getTime() > now + 366 * 24 * 3600_000) return { ok: false, error: 'The end time must be within one year.' }
  return { ok: true, until: at }
}

export const audit = async (
  entries: Array<{ scopeType: string; scopeId: string; scopeName?: string; field: string; before?: unknown; after?: unknown }>,
  actor: string,
) => {
  if (entries.length === 0) return
  try {
    await prisma.syncControlAudit.createMany({
      data: entries.map((e) => ({
        actor,
        scopeType: e.scopeType,
        scopeId: e.scopeId,
        scopeName: e.scopeName ?? null,
        field: e.field,
        before: e.before === undefined ? undefined : (e.before as object),
        after: e.after === undefined ? undefined : (e.after as object),
      })),
    })
  } catch (err) {
    logger.warn('[sync-control] audit write failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

export interface ListingTarget extends ListingCoordinate {}
export interface MembershipTarget { itemId: string; marketplace: string; sku: string }

/** The body of POST /api/stock/sync-control/actions. */
export interface SyncControlActionBody {
  action: 'FOLLOW' | 'PIN' | 'PAUSE' | 'RESUME' | 'ZERO_PIN' | 'EXCLUDE' | 'INCLUDE' | 'BUFFER' | 'CLOSE_OFFER' | 'REOPEN_OFFER'
  buffer?: number
  /** Shared stock step 3 — optional end for PIN, ZERO_PIN, PAUSE (listings) and PIN, EXCLUDE (shared variants). */
  until?: string | null
  /** Shared stock step 3 — the fixed number for a shared variant on PIN (default: what eBay shows now). */
  quantity?: number
  listings?: ListingTarget[]
  memberships?: MembershipTarget[]
  // SCV.2 — product-first bulk: expand each master to ALL its listings +
  // shared memberships server-side (the client may not hold a big family's
  // children). FBA still excluded downstream by the write primitives.
  masterIds?: string[]
  // SCT.3 — the products view's active filters. The expansion is narrowed
  // to rows matching them (act-on-what-you-see): without this, "filter
  // Market=IT → Set Follow" flipped the family's DE/ES listings too.
  scope?: SyncScope
  // SCT.5b — informed consent for Amazon EU: when a quantity action covers
  // only SOME EU markets of a SKU, the server answers 409 with the TRUE
  // scope (Amazon holds one EU quantity per SKU); the client confirms and
  // resends with this flag, and the action is EXPANDED to all EU rows so
  // platform state ≡ Amazon state. No refusals — one honest confirm.
  expandEuAligned?: boolean
}

/** POST /api/stock/sync-control/actions, as the route ran it. `actor` is the person (their e-mail, else their id). */
export async function runSyncControlAction(body: SyncControlActionBody, actor: string, log: SyncControlLog = appLog): Promise<SyncControlAnswer> {
  const listings = [...(body.listings ?? [])]
  const memberships = body.memberships ?? []
  if (!body.action) return answer(400, { error: 'action required' })
  const untilParsed = parseUntil(body.until)
  if ('error' in untilParsed) return answer(400, { error: untilParsed.error })
  const until = untilParsed.until
  if (until !== undefined && !['PIN', 'ZERO_PIN', 'PAUSE', 'EXCLUDE'].includes(body.action)) {
    return answer(400, { error: 'An end time can be set with Fixed number, Zero & Pin, Pause or Exclude only.' })
  }
  if (body.quantity !== undefined && (body.action !== 'PIN' || !Number.isSafeInteger(body.quantity) || body.quantity < 0)) {
    return answer(400, { error: 'A fixed number is a whole number of 0 or more, given with Fixed number (PIN).' })
  }
  const result: {
    updated: number; skippedFba: number; unchanged: number; recascadeQueued: number
    skippedShared: number; scopedOut: number; error?: string; partial?: boolean
  } = { updated: 0, skippedFba: 0, unchanged: 0, recascadeQueued: 0, skippedShared: 0, scopedOut: 0 }
  const recascadeProducts = new Set<string>()
  // SCT.3 — no more bare 500s: any throw below is caught, logged, and
  // reported with the REAL message. If rows were already written, the
  // response says exactly how far it got instead of pretending total
  // failure (the old handler returned Fastify's naked 'Internal Server
  // Error' — the P2028 incident shipped zero information to the operator).
  try {
    listings.forEach(whereCoordinate)
    if (body.masterIds?.length) {
      // SCD.4 — expand each selected group SERVER-side to every master folded
      // into it. Previously this trusted the client to send memberMasterIds,
      // so a stale selection (list refreshed under the operator) silently
      // skipped the duplicate copies' listings.
      const allMasters = await prisma.product.findMany({ where: { parentId: null }, select: { id: true } })
      const canonAll = await resolveCanonicalMasters(allMasters.map((m) => m.id))
      const groupSet = new Set(body.masterIds)
      for (const [mid, cid] of canonAll) if (groupSet.has(cid)) groupSet.add(mid)
      const variants = await prisma.product.findMany({
        where: {
          OR: [{ id: { in: [...groupSet] } }, { parentId: { in: [...groupSet] } }],
          // SCD.8/8b parity — an action must never expand into DELETED
          // products (or live children of a deleted master): the view hides
          // them, so acting on them would write outside what any view shows.
          deletedAt: null,
          AND: [{ OR: [{ parentId: null }, { parent: { deletedAt: null } }] }],
        },
        select: { id: true },
      })
      const pids = variants.map((v) => v.id)
      const [cls, mems] = await Promise.all([
        prisma.channelListing.findMany({
          where: { productId: { in: pids }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
          select: { productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true },
        }),
        prisma.sharedListingMembership.findMany({
          where: { productId: { in: pids }, status: 'ACTIVE' },
          select: { itemId: true, marketplace: true, sku: true },
        }),
      ])
      // SCT.3 — act-on-what-you-see: narrow the expansion to the rows the
      // active products-view filters show, with the SAME predicate the
      // /products endpoint uses to display them.
      let clsT = cls
      let memsT = mems
      const sc = body.scope
      const hasScope = !!sc && ((sc.channels?.length ?? 0) > 0 || (sc.markets?.length ?? 0) > 0 || (sc.modes?.length ?? 0) > 0 || !!sc.drift)
      if (hasScope) {
        const norm: SyncScope = {
          channels: sc!.channels?.map((x) => x.toUpperCase()),
          markets: sc!.markets,
          modes: sc!.modes?.map((x) => x.toUpperCase()),
          drift: sc!.drift,
        }
        const scopeRows = await computeRows()
        const allowedListing = new Set(
          scopeRows.filter((r) => r.lane === 'LISTING' && rowMatchesScope(r, norm)).map((r) => `${r.productId}|${r.channel}|${r.marketplace}`),
        )
        const allowedShared = new Set(
          scopeRows.filter((r) => r.lane === 'SHARED' && rowMatchesScope(r, norm)).map((r) => `${r.itemId}|${r.sku}|${r.marketplace}`),
        )
        clsT = cls.filter((c) => allowedListing.has(`${c.productId}|${c.channel}|${c.marketplace}`))
        memsT = mems.filter((m) => allowedShared.has(`${m.itemId}|${m.sku}|${m.marketplace}`))
        // Count scoped-out rows only for the lane(s) this action writes —
        // EXCLUDE narrowing 200 listing rows it would never touch anyway
        // must not inflate the "outside filters untouched" toast.
        const LANE_L = ['FOLLOW', 'PIN', 'PAUSE', 'RESUME', 'ZERO_PIN', 'BUFFER'].includes(body.action)
        const LANE_S = ['EXCLUDE', 'INCLUDE', 'BUFFER', 'PIN', 'FOLLOW'].includes(body.action)
        result.scopedOut = (LANE_L ? cls.length - clsT.length : 0) + (LANE_S ? mems.length - memsT.length : 0)
      }

      // SCD.4 — expand ONLY the lanes this action can actually write. Pushing
      // both lanes unconditionally made a listing-lane action (PAUSE/RESUME/
      // FOLLOW/PIN/ZERO_PIN) commit its writes and THEN hit the shared-lane
      // "not valid" branch, returning 400 after the fact: the operator was told
      // it failed while it had already happened (and RESUME skipped its
      // recascade, ZERO_PIN had already pushed qty 0 live).
      const LISTING_LANE = ['FOLLOW', 'PIN', 'PAUSE', 'RESUME', 'ZERO_PIN', 'BUFFER', 'CLOSE_OFFER', 'REOPEN_OFFER']
      // Shared stock step 3 — Fixed number (PIN) and FOLLOW apply to shared eBay variants too.
      const SHARED_LANE = ['EXCLUDE', 'INCLUDE', 'BUFFER', 'PIN', 'FOLLOW']
      if (LISTING_LANE.includes(body.action)) {
        for (const c of clsT) listings.push(c)
      }
      if (SHARED_LANE.includes(body.action)) {
        for (const m of memsT) memberships.push({ itemId: m.itemId, marketplace: m.marketplace, sku: m.sku })
      }
    }

    if (listings.length === 0 && memberships.length === 0) {
      return answer(400, {
        error: result.scopedOut > 0
          ? `0 rows match your filters right now (${result.scopedOut} filtered out — drift may have converged since the page rendered). Nothing was written.`
          : 'no targets',
      })
    }
    // Shared stock step 3 — a chosen number is for shared eBay variants only. A listing's Fixed number
    // keeps the number it shows now (setFollowMasterQuantity), so a number sent with listings would be
    // applied to some rows and silently ignored on others. Refused before anything is written.
    if (body.quantity !== undefined && listings.length > 0) {
      return answer(400, { error: 'A chosen fixed number applies to shared eBay variants only. For a listing, Fixed number keeps the number it shows now.' })
    }
    // Master-bulk legitimately expands large (a 49-variant family ≈ 300 rows).
    // SCT.4/5b — Amazon EU shared-quantity gate. Amazon keeps ONE merchant
    // quantity per SKU across EU marketplaces (proved 2026-07-26: 302
    // market-scoped Zero&Pins blanked the whole IT storefront). A partial-
    // market quantity action is never refused any more — but it can't be
    // half-done either. Without expandEuAligned we answer 409 + the TRUE
    // scope (nothing written); with it, the action expands to every EU row
    // of the affected SKUs so platform state ≡ Amazon state.
    // BUFFER too: a following listing publishes pool − buffer, so different buffers on two EU markets send Amazon
    // two numbers for one quantity (the Studio matrix already writes a buffer to the whole EU group).
    if (['FOLLOW', 'PIN', 'ZERO_PIN', 'BUFFER'].includes(body.action)) {
      const euTargets = listings.filter(
        (t) => t.channel === 'AMAZON' && AMAZON_EU_SHARED_MARKETS.has(t.marketplace.toUpperCase()),
      )
      if (euTargets.length > 0) {
        const pids = [...new Set(euTargets.map((t) => t.productId))]
        const euRows = await prisma.channelListing.findMany({
          where: { productId: { in: pids }, channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
          select: {
            productId: true, channel: true, channelConnectionId: true, aliasKey: true, marketplace: true, followMasterQuantity: true, quantityOverride: true,
            quantity: true, syncPaused: true, fulfillmentMethod: true, offerClosedAt: true, stockBuffer: true,
            product: { select: { sku: true } },
          },
        })
        const euKey = (r: { productId: string; channelConnectionId: string | null; aliasKey: string }) => JSON.stringify([r.productId, r.channelConnectionId, r.aliasKey])
        const targetsByPid = new Map<string, Set<string>>()
        for (const t of euTargets) {
          const set = targetsByPid.get(euKey(t)) ?? new Set<string>()
          set.add(t.marketplace.toUpperCase())
          targetsByPid.set(euKey(t), set)
        }
        const conflictedPids: string[] = []
        for (const [pid, mkts] of targetsByPid) {
          const prodRows = euRows
            .filter((r) => euKey(r) === pid)
            .map((r) => ({
              marketplace: r.marketplace,
              followMasterQuantity: r.followMasterQuantity,
              quantityOverride: r.quantityOverride,
              quantity: r.quantity,
              syncPaused: r.syncPaused,
              isFba: r.fulfillmentMethod === 'FBA',
              offerClosed: !!r.offerClosedAt,
              stockBuffer: r.stockBuffer,
            }))
          const v = body.action === 'BUFFER'
            ? projectBufferAndDetect(prodRows, mkts, Math.max(0, Math.trunc(body.buffer ?? 0)))
            : projectActionAndDetect(prodRows, mkts, body.action as 'FOLLOW' | 'PIN' | 'ZERO_PIN')
          if (v.conflict) conflictedPids.push(pid)
        }
        if (conflictedPids.length > 0) {
          // The extra rows the TRUE (EU-wide) action covers.
          const additions: ListingTarget[] = []
          const previews: Array<{ sku: string; addedMarkets: string[] }> = []
          for (const pid of conflictedPids) {
            const targeted = targetsByPid.get(pid) ?? new Set<string>()
            const extra = euRows.filter(
              (r) => euKey(r) === pid && r.fulfillmentMethod !== 'FBA' &&
                // SCT.6 — NEVER expand into a CLOSED market: consenting to an
                // EU-wide quantity action must not reopen a closed offer.
                !r.offerClosedAt &&
                AMAZON_EU_SHARED_MARKETS.has(r.marketplace.toUpperCase()) &&
                !targeted.has(r.marketplace.toUpperCase()),
            )
            for (const r of extra) additions.push({ productId: r.productId, channel: 'AMAZON', marketplace: r.marketplace, channelConnectionId: r.channelConnectionId, aliasKey: r.aliasKey })
            previews.push({
              sku: euRows.find((r) => euKey(r) === pid)?.product?.sku ?? pid,
              addedMarkets: [...new Set(extra.map((r) => r.marketplace.toUpperCase()))],
            })
          }
          if (!body.expandEuAligned) {
            // NOTHING written — tell the operator the true scope and let
            // them proceed with one confirm (409 preview, not a refusal).
            return answer(409, {
              euExpandRequired: true,
              error:
                `Amazon keeps ONE quantity per SKU across EU markets, so this ${body.action} really covers ` +
                `${additions.length} more row(s) on ${[...new Set(additions.map((a) => a.marketplace))].sort().join('/')} ` +
                `for ${conflictedPids.length} SKU(s).`,
              preview: previews.slice(0, 30),
              addedRowCount: additions.length,
            })
          }
          // Informed consent given — expand so the platform state matches
          // what Amazon will actually hold. Audited like any other target.
          listings.push(...additions)
          ;(result as { euExpanded?: number }).euExpanded = additions.length
        }
      }
    }

    // SCT.2 — 500/page is selectable, and the selection survives paging, so a
    // direct (non-master) selection can legitimately exceed one page.
    const cap = body.masterIds?.length ? 3000 : 2000
    if (listings.length + memberships.length > cap) return answer(400, { error: `max ${cap} targets per call` })

    // eBay ENDS a listing pinned at 0 unless the account's out-of-stock option is ON: refused before anything is written
    // (the Matrix's own check, L8 — `ebayZeroAllowedFor`, read once per account and market).
    if (body.action === 'ZERO_PIN' || body.action === 'PIN') {
      const refused = await ebayZeroRefusal(body, listings, memberships)
      if (refused) return answer(409, refused)
    }

    // ── LISTING lane ──
    if (listings.length > 0) {
      // SCT.3-CRITICAL — group by (channel, MARKET), not just channel. The
      // old channel-only grouping collapsed targets into productIds × markets
      // and the service wrote every EXISTING pair in that Cartesian product:
      // acting on (P1,IT)+(P2,DE) also flipped (P1,DE)+(P2,IT). A market-
      // scoped drift selection would silently widen to unselected markets.
      const byChannel = new Map<string, ListingTarget[]>()
      for (const t of listings) {
        const k = `${t.channel}|${t.marketplace}`
        const arr = byChannel.get(k) ?? []
        arr.push(t)
        byChannel.set(k, arr)
      }

      for (const [groupKey, targets] of byChannel) {
        const channel = groupKey.split('|')[0]
        const productIds = [...new Set(targets.map((t) => t.productId))]
        const markets = [...new Set(targets.map((t) => t.marketplace))]

        // SCT.6 — per-market offer CLOSE/REOPEN (Amazon only; eBay has real
        // per-listing quantities and never needs this).
        if (body.action === 'CLOSE_OFFER' || body.action === 'REOPEN_OFFER') {
          if (channel !== 'AMAZON') {
            result.unchanged += targets.length
            continue
          }
          const svcTargets = targets
          const r = body.action === 'CLOSE_OFFER'
            ? await closeMarketOffers({ targets: svcTargets, actor })
            : await reopenMarketOffers({ targets: svcTargets, actor })
          result.updated += r.updated
          result.skippedFba += r.skippedFba
          result.unchanged += r.unchanged
          if (r.failed > 0) {
            result.partial = true
            const failures = r.results.filter((x) => x.action === 'FAILED').slice(0, 3)
              .map((x) => `${x.sku ?? x.productId}@${x.marketplace}: ${x.detail ?? 'failed'}`)
            const msg = `${body.action}: ${r.failed} row(s) failed — ${failures.join(' · ')}${r.failed > 3 ? ` · +${r.failed - 3} more` : ''}`
            result.error = result.error ? `${result.error} · ${msg}` : msg
          }
          if (r.error) {
            result.partial = true
            const msg = `${body.action} stopped after ${r.updated} update(s): ${r.error}${r.remaining ? ` — ${r.remaining} row(s) not attempted; re-run to continue` : ''}`
            result.error = result.error ? `${result.error} · ${msg}` : msg
          }
          await audit(
            r.results
              .filter((x) => x.action === 'CLOSED' || x.action === 'REOPENED')
              .map((x) => ({
                scopeType: 'LISTING', scopeId: `${x.productId}:AMAZON:${x.marketplace}`,
                scopeName: `${x.sku ?? '?'}@AMAZON:${x.marketplace}`, field: 'offerClosed',
                after: { closed: x.action === 'CLOSED' },
              })), actor)
          continue
        }

        if (body.action === 'FOLLOW' || body.action === 'PIN') {
          const r = await setFollowMasterQuantity({
            productIds, channel: channel as never, markets, follow: body.action === 'FOLLOW', actor, coordinates: targets,
          })
          result.updated += r.updated
          result.skippedFba += r.skippedFba
          result.unchanged += r.unchanged
          if (r.error) {
            // Mid-bulk chunk failure AFTER commits — report it, never pretend.
            result.partial = true
            const msg = `${body.action} stopped after ${r.updated} update(s) in ${groupKey}: ${r.error}` +
              (r.remaining ? ` — ${r.remaining} row(s) not attempted; re-run the same action to continue (committed rows are no-ops)` : '')
            result.error = result.error ? `${result.error} · ${msg}` : msg
          }
          // Audit what actually COMMITTED (r.results), not the requested
          // targets — a mid-bulk failure must not log never-attempted rows.
          await audit(
            r.results
              .filter((x) => x.action === 'FOLLOW' || x.action === 'PIN')
              .map((x) => ({
                scopeType: 'LISTING', scopeId: `${x.listingId}`,
                scopeName: `${x.sku ?? '?'}@${x.channel}:${x.marketplace}`, field: 'followMasterQuantity',
                after: { follow: body.action === 'FOLLOW', quantity: x.quantity },
              })), actor)
          // Shared stock step 3 — the end of the fixed number, on every listing now pinned by this
          // action (newly, or already: a PIN with an end time sets the end of an existing pin).
          if (body.action === 'PIN' && until !== undefined) {
            const pinned = r.results.filter((x) => x.action === 'PIN' || x.action === 'UNCHANGED')
            if (pinned.length) {
              // The end it replaces goes in the history too (an existing pin can already have one).
              const endBefore = await setListingPinEnds(pinned.map((x) => x.listingId), until)
              await audit(pinned.map((x) => ({
                scopeType: 'LISTING', scopeId: `${x.listingId}`, scopeName: `${x.sku ?? '?'}@${x.channel}:${x.marketplace}`,
                field: 'pinnedUntil', before: { pinnedUntil: endBefore.get(x.listingId) ?? null }, after: { pinnedUntil: until?.toISOString() ?? null },
              })), actor)
            }
          }
          continue
        }

        if (body.action === 'BUFFER') {
          const buffer = Math.max(0, Math.trunc(body.buffer ?? 0))
          const r = await setStockBuffer({ productIds, channel: channel as never, markets, buffer, actor, coordinates: targets })
          result.updated += r.updated
          result.skippedFba += r.skippedFba
          if (r.error) {
            result.partial = true
            const msg = `BUFFER stopped after ${r.updated} update(s) in ${groupKey}: ${r.error}` +
              (r.remaining ? ` — ${r.remaining} row(s) not attempted; re-run to continue` : '')
            result.error = result.error ? `${result.error} · ${msg}` : msg
          }
          await audit(
            r.results
              .filter((x) => x.action === 'BUFFER')
              .map((x) => ({
                scopeType: 'LISTING', scopeId: `${x.listingId}`,
                scopeName: `${x.sku ?? '?'}@${x.channel}:${x.marketplace}`, field: 'stockBuffer', after: { buffer },
              })), actor)
          continue
        }

        // PAUSE / RESUME / ZERO_PIN — resolve rows, fail-closed FBA exclusion.
        const rows = await prisma.channelListing.findMany({
          where: {
            OR: targets.map(whereCoordinate),
          },
          select: {
            id: true, productId: true, channel: true, marketplace: true, region: true, channelConnectionId: true, aliasKey: true,
            externalListingId: true, syncPaused: true, fulfillmentMethod: true, quantity: true, platformAttributes: true,
            pinnedUntil: true, pausedUntil: true,
            product: { select: { fulfillmentMethod: true, sku: true } },
          },
        })
        const eligible = rows.filter((r) => {
          const fba = isFbaCoordinate(r)
          if (fba) result.skippedFba++
          return !fba
        })

        if (body.action === 'PAUSE') {
          const ids = eligible.filter((r) => !r.syncPaused).map((r) => r.id)
          result.unchanged += eligible.length - ids.length
          if (ids.length) {
            const u = await prisma.channelListing.updateMany({ where: { id: { in: ids }, OR: eligible.map(whereCoordinate) }, data: { syncPaused: true } })
            result.updated += u.count
          }
          await audit(eligible.map((r) => ({
            scopeType: 'LISTING', scopeId: r.id, scopeName: `${r.product?.sku}@${r.channel}:${r.marketplace}`,
            field: 'syncPaused', before: { syncPaused: r.syncPaused }, after: { syncPaused: true },
          })), actor)
          // Shared stock step 3 — the end of the pause (also on a listing that was already paused).
          if (until !== undefined && eligible.length) {
            await setListingPauseEnds(eligible.map((r) => r.id), until)
            await audit(eligible.map((r) => ({
              scopeType: 'LISTING', scopeId: r.id, scopeName: `${r.product?.sku}@${r.channel}:${r.marketplace}`,
              field: 'pausedUntil', before: { pausedUntil: r.pausedUntil?.toISOString() ?? null }, after: { pausedUntil: until?.toISOString() ?? null },
            })), actor)
          }
        } else if (body.action === 'RESUME') {
          const ids = eligible.filter((r) => r.syncPaused).map((r) => r.id)
          result.unchanged += eligible.length - ids.length
          if (ids.length) {
            const u = await prisma.channelListing.updateMany({ where: { id: { in: ids }, OR: eligible.map(whereCoordinate) }, data: { syncPaused: false } })
            result.updated += u.count
            for (const r of eligible) if (r.syncPaused) recascadeProducts.add(r.productId)
          }
          await audit(eligible.map((r) => ({
            scopeType: 'LISTING', scopeId: r.id, scopeName: `${r.product?.sku}@${r.channel}:${r.marketplace}`,
            field: 'syncPaused', before: { syncPaused: r.syncPaused }, after: { syncPaused: false },
          })), actor)
        } else if (body.action === 'ZERO_PIN') {
          // Safe-stop: pin at 0 and push the 0 — the listing stops selling
          // NOW and stays stopped (visible as Pinned@0; resume via Set Follow).
          // One updateMany — the write is identical for every row, and N
          // sequential round-trips made a 500-row Zero & Pin needlessly slow.
          if (eligible.length) {
            const u = await prisma.channelListing.updateMany({
              where: { OR: eligible.map(r => ({ id: r.id, ...whereCoordinate(r) })) },
              data: { quantity: 0, quantityOverride: 0, followMasterQuantity: false, syncPaused: false, lastSyncStatus: 'PENDING', ...(until !== undefined ? { pinnedUntil: until } : {}) },
            })
            result.updated += u.count
          }
          const queueRows: Array<Record<string, unknown>> = eligible.map((r) => ({
            productId: r.productId,
            channelListingId: r.id,
            targetChannel: r.channel,
            targetRegion: r.region ?? undefined,
            syncType: 'QUANTITY_UPDATE',
            syncStatus: 'PENDING',
            payload: { quantity: 0, source: 'SYNC_CONTROL_ZERO_PIN' },
            externalListingId: r.externalListingId ?? undefined,
            maxRetries: 3,
            holdUntil: new Date(),
          }))
          if (queueRows.length) {
            await enqueueOutboundRowsInstant(prisma as never, queueRows as never, { source: 'SYNC_CONTROL_ZERO_PIN' })
          }
          await audit(eligible.map((r) => ({
            scopeType: 'LISTING', scopeId: r.id, scopeName: `${r.product?.sku}@${r.channel}:${r.marketplace}`,
            field: 'zeroPin', before: { quantity: r.quantity, ...(until !== undefined ? { pinnedUntil: r.pinnedUntil?.toISOString() ?? null } : {}) }, after: { quantity: 0, follow: false, ...(until !== undefined ? { pinnedUntil: until?.toISOString() ?? null } : {}) },
          })), actor)
        }
      }
    }

    // ── SHARED lane (memberships) ──
    if (memberships.length > 0) {
      const or = memberships.map((t) => ({ itemId: t.itemId, marketplace: t.marketplace, sku: t.sku }))
      const rows = await prisma.sharedListingMembership.findMany({
        where: { OR: or },
        select: { id: true, itemId: true, marketplace: true, sku: true, productId: true, followPool: true, pinnedQuantity: true, lastQtyPushed: true, pinnedUntil: true, pausedUntil: true },
      })
      if (body.action === 'EXCLUDE' || body.action === 'INCLUDE') {
        const want = body.action === 'INCLUDE'
        const ids = rows.filter((r) => r.followPool !== want).map((r) => r.id)
        result.unchanged += rows.length - ids.length
        if (ids.length) {
          const u = await prisma.sharedListingMembership.updateMany({ where: { id: { in: ids } }, data: { followPool: want } })
          result.updated += u.count
          if (want) for (const r of rows) if (r.productId) recascadeProducts.add(r.productId)
        }
        await audit(rows.map((r) => ({
          scopeType: 'MEMBERSHIP', scopeId: r.id, scopeName: `${r.sku}@${r.itemId}`,
          field: 'followPool', before: { followPool: r.followPool }, after: { followPool: want },
        })), actor)
        // Shared stock step 3 — the end of the exclusion.
        if (!want && until !== undefined && rows.length) {
          await setMembershipExclusionEnds(rows.map((r) => r.id), until)
          await audit(rows.map((r) => ({
            scopeType: 'MEMBERSHIP', scopeId: r.id, scopeName: `${r.sku}@${r.itemId}`,
            field: 'pausedUntil', before: { pausedUntil: r.pausedUntil?.toISOString() ?? null }, after: { pausedUntil: until?.toISOString() ?? null },
          })), actor)
        }
      } else if (body.action === 'PIN' || body.action === 'FOLLOW') {
        // Shared stock step 3 — Fixed number for a shared variant: exactly this number on this eBay
        // listing, whatever the pool (default: what eBay shows now). FOLLOW returns it to the pool.
        for (const r of rows) {
          const next = body.action === 'PIN' ? (body.quantity ?? r.lastQtyPushed ?? 0) : null
          const changes = next !== r.pinnedQuantity || (body.action === 'PIN' && until !== undefined)
          if (!changes) { result.unchanged++; continue }
          await setMembershipFixedNumber(r.id, next, body.action === 'PIN' ? until : undefined)
          result.updated++
          if (r.productId) recascadeProducts.add(r.productId)
          await audit([{
            scopeType: 'MEMBERSHIP', scopeId: r.id, scopeName: `${r.sku}@${r.itemId}`, field: 'pinnedQuantity',
            before: { pinnedQuantity: r.pinnedQuantity, ...(body.action === 'PIN' && until !== undefined ? { pinnedUntil: r.pinnedUntil?.toISOString() ?? null } : {}) }, after: { pinnedQuantity: next, ...(body.action === 'PIN' && until !== undefined ? { pinnedUntil: until?.toISOString() ?? null } : {}) },
          }], actor)
        }
      } else if (body.action === 'BUFFER') {
        const buffer = Math.max(0, Math.trunc(body.buffer ?? 0))
        const u = await prisma.sharedListingMembership.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { stockBuffer: buffer } })
        result.updated += u.count
        for (const r of rows) if (r.productId) recascadeProducts.add(r.productId)
        await audit(rows.map((r) => ({
          scopeType: 'MEMBERSHIP', scopeId: r.id, scopeName: `${r.sku}@${r.itemId}`,
          field: 'stockBuffer', after: { buffer },
        })), actor)
      } else {
        // SCD.4 — NEVER fail after the listing lane has already written. An
        // action that can't touch shared variants just reports them as skipped
        // so the response stays truthful and the recascade below still runs.
        result.skippedShared += memberships.length
      }
    }

    // Control change → marketplace truth, immediately (background; sequential
    // per the P2028 lesson).
    if (recascadeProducts.size > 0) {
      result.recascadeQueued = recascadeProducts.size
      void recascadeAfterSyncControlChange([...recascadeProducts], actor).then((r) =>
        logger.info('[sync-control] recascade after action complete', { ...r, actor }),
      )
    }
    return answer(200, result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error({ err: e, action: body.action }, 'sync-control action failed')
    if (result.updated > 0) {
      // Writes already committed — never report them as a total failure, and
      // still reconverge them: a RESUME that committed its updateMany but
      // failed later must not strand its products un-recascaded (re-running
      // would see them !syncPaused → unchanged → the recascade never fires).
      if (recascadeProducts.size > 0) {
        result.recascadeQueued = recascadeProducts.size
        void recascadeAfterSyncControlChange([...recascadeProducts], actor).then((r) =>
          logger.info('[sync-control] recascade after PARTIAL action', { ...r, actor }),
        )
      }
      return answer(200, {
        ...result,
        partial: true,
        error: `${body.action} stopped after ${result.updated} update(s): ${msg} — re-run the same action to continue (already-written rows are no-ops)`,
      })
    }
    return answer(500, { error: `${body.action} failed: ${msg}` })
  }
}

/**
 * The rows a ZERO_PIN or PIN would put at 0 on eBay whose account's out-of-stock option is not ON (OFF, or it could not
 * be read): eBay ends such a listing. A listing the action skips (FBA) is not counted; a PIN keeps the number a listing
 * shows, so only one that shows 0 and is not pinned yet is a pin to 0; a shared variant's fixed number is the one given,
 * else what eBay shows. Null when nothing would be pinned to 0 there.
 */
async function ebayZeroRefusal(body: SyncControlActionBody, listings: ListingTarget[], memberships: MembershipTarget[]) {
  const zeroes: Array<{ sku: string; accountId: string | null; market: string }> = []
  const ebay = listings.filter((t) => t.channel === 'EBAY')
  if (ebay.length) {
    const rows = await prisma.channelListing.findMany({
      where: { OR: ebay.map(whereCoordinate) },
      select: { channelConnectionId: true, marketplace: true, quantity: true, quantityOverride: true, followMasterQuantity: true, fulfillmentMethod: true, platformAttributes: true, product: { select: { sku: true, fulfillmentMethod: true } } },
    })
    for (const r of rows) {
      if (isFbaCoordinate(r)) continue
      const toZero = body.action === 'ZERO_PIN' || (r.followMasterQuantity !== false && (r.quantity ?? r.quantityOverride) === 0)
      if (toZero) zeroes.push({ sku: r.product?.sku ?? '?', accountId: r.channelConnectionId, market: r.marketplace })
    }
  }
  if (body.action === 'PIN' && memberships.length) {
    const rows = await prisma.sharedListingMembership.findMany({
      where: { OR: memberships.map((t) => ({ itemId: t.itemId, marketplace: t.marketplace, sku: t.sku })) },
      select: { sku: true, marketplace: true, channelConnectionId: true, pinnedQuantity: true, lastQtyPushed: true },
    })
    for (const r of rows) {
      const next = body.quantity ?? r.lastQtyPushed ?? 0
      if (next === 0 && r.pinnedQuantity !== 0) zeroes.push({ sku: r.sku, accountId: r.channelConnectionId, market: r.marketplace })
    }
  }
  if (!zeroes.length) return null
  const { ebayZeroAllowedFor } = await import('../pim/matrix-write.service.js')
  const allowed = await ebayZeroAllowedFor(zeroes)
  const stopped = zeroes.filter((z) => allowed(z.accountId, z.market) !== true)
  if (!stopped.length) return null
  const names = [...new Set(stopped.map((z) => `${z.sku} on eBay ${z.market}`))]
  return {
    error: `${names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ')}: ${EBAY_ZERO_REFUSAL} Nothing was changed.`,
    code: 'EBAY_ZERO_REFUSED',
    refused: stopped.slice(0, 50).map((z) => ({ sku: z.sku, marketplace: z.market })),
  }
}

/** POST /api/stock/sync-control/location-routes, as the route ran it. */
export async function setLocationRoutes(body: { code?: string; syncRoutes?: string[] }, actor: string): Promise<SyncControlAnswer> {
  if (!body.code || !Array.isArray(body.syncRoutes)) {
    return answer(400, { error: 'code and syncRoutes[] required' })
  }
  const tokens = body.syncRoutes.map((t) => String(t).trim().toUpperCase()).filter(Boolean)
  const problems = validateServesTokens(tokens)
  if (problems.length > 0) return answer(400, { error: 'invalid tokens', problems })

  const loc = await prisma.stockLocation.findUnique({ where: { workspace_code: workspaceKey({ code: body.code }) }, select: { id: true, code: true, type: true, syncRoutes: true } })
  if (!loc) return answer(404, { error: `location ${body.code} not found` })

  await prisma.stockLocation.update({ where: { id: loc.id }, data: { syncRoutes: tokens } })
  await audit([{ scopeType: 'LOCATION', scopeId: loc.id, scopeName: loc.code, field: 'syncRoutes', before: { syncRoutes: loc.syncRoutes }, after: { syncRoutes: tokens } }], actor)

  // Every product with stock in this location may change effective qty
  // somewhere — recascade them all (background, sequential).
  const affected = await prisma.stockLevel.findMany({ where: { locationId: loc.id }, select: { productId: true }, distinct: ['productId'] })
  const productIds = affected.map((a) => a.productId)
  void recascadeAfterSyncControlChange(productIds, actor).then((r) =>
    logger.info('[sync-control] recascade after routing change complete', { ...r, location: loc.code, actor }),
  )
  return answer(200, { ok: true, location: loc.code, syncRoutes: tokens, recascadeQueued: productIds.length })
}

/** The body of POST /api/stock/sync-control/policies. */
export interface SyncPolicyBody {
  channel?: string
  marketplace?: string
  /** One account of the channel; absent or null = every account. */
  channelConnectionId?: string | null
  pushesPaused?: boolean
  newListingDefaultMode?: 'FOLLOW' | 'PAUSED'
}

/** POST /api/stock/sync-control/policies, as the route ran it. */
export async function setSyncPolicy(body: SyncPolicyBody, actor: string): Promise<SyncControlAnswer> {
  const problem = validatePolicyInput(body ?? {})
  if (problem) return answer(400, { error: problem })

  const channel = body.channel!.trim().toUpperCase()
  const marketplace = body.marketplace!.trim().toUpperCase()
  // MAP.2b — a policy names one account, or none (every account). The row is found by the SAME
  // account it is written with: a lookup by one account and a write with another left a pause
  // that Resume could never find (it said "ok" and the channel stayed paused).
  let policyConn: string | null = null
  if (body.channelConnectionId) {
    try {
      const account = await resolveConnection({ accountId: body.channelConnectionId })
      if (account.channelType !== channel) throw new NoConnectionError('The selected account does not belong to this channel.')
      policyConn = account.id
    } catch (error) {
      if (error instanceof NoConnectionError) return answer(400, { error: error.message })
      throw error
    }
  }
  const { before: existing, saved, nextPaused, nextMode, pausedChanged, modeChanged } = await writeChannelPolicy({
    channel, marketplace, channelConnectionId: policyConn, pushesPaused: body.pushesPaused, newListingDefaultMode: body.newListingDefaultMode,
  })
  const scopeName = `${channel}:${marketplace}${policyConn ? `@${policyConn}` : ''}`

  if (!saved) {
    // All-default result: the policy's rows were removed.
    if (existing) {
      await audit([{
        scopeType: 'POLICY', scopeId: existing.id, scopeName, field: 'policy',
        before: { pushesPaused: existing.pushesPaused, newListingDefaultMode: existing.newListingDefaultMode },
        after: { removed: true },
      }], actor)
    }
  } else {
    const entries: Array<{ scopeType: string; scopeId: string; scopeName?: string; field: string; before?: unknown; after?: unknown }> = []
    if (pausedChanged) entries.push({
      scopeType: 'POLICY', scopeId: saved.id, scopeName, field: 'pushesPaused',
      before: { pushesPaused: existing?.pushesPaused ?? false }, after: { pushesPaused: nextPaused },
    })
    if (modeChanged) entries.push({
      scopeType: 'POLICY', scopeId: saved.id, scopeName, field: 'newListingDefaultMode',
      before: { newListingDefaultMode: existing?.newListingDefaultMode ?? 'FOLLOW' }, after: { newListingDefaultMode: nextMode },
    })
    await audit(entries, actor)
  }

  // PAUSED default takes effect immediately (no watchdog-interval gap).
  if (modeChanged && nextMode === 'PAUSED') {
    const swept = await enforceNewListingDefaults().catch((err) => {
      logger.warn('[sync-control] new-listing sweep failed', { error: err instanceof Error ? err.message : String(err) })
      return { paused: 0 }
    })
    if (swept.paused > 0) logger.info('[sync-control] new-listing sweep', { ...swept, scope: scopeName })
  }

  // Kill-switch RESUME → recascade everything in scope back to pool truth.
  let recascadeQueued = 0
  if (pausedChanged && !nextPaused) {
    const listings = await prisma.channelListing.findMany({
      where: { channel, listingStatus: { not: 'ENDED' }, ...(policyConn ? { channelConnectionId: policyConn } : {}) },
      select: { productId: true, marketplace: true },
    })
    const inScope = marketplace === '*'
      ? listings
      : listings.filter((l) => {
          const m = (l.marketplace ?? '').toUpperCase().replace(/^EBAY_/, '')
          return m === marketplace
        })
    const productIds = [...new Set(inScope.map((l) => l.productId).filter((v): v is string => !!v))]
    recascadeQueued = productIds.length
    void recascadeAfterSyncControlChange(productIds, actor).then((r) =>
      logger.info('[sync-control] recascade after policy resume complete', { ...r, scope: scopeName, actor }),
    )
  }

  const policies = await prisma.syncChannelPolicy.findMany({ orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }] })
  return answer(200, { ok: true, policies, recascadeQueued })
}
