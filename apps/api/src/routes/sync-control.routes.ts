/**
 * SC.2 — Sync Control read surface (owner-approved program, read-only phase).
 *
 * Registered under /api/stock/sync-control so reads inherit the stock
 * inventoryView permission (permissions-manifest pfx('/api/stock')).
 *
 * Every quantity/mode shown here derives from resolveIntendedQuantity /
 * resolveMembershipIntended — the SAME core the cascade, dispatch and
 * read-backs consume — so the tab can never disagree with the engine.
 *
 *   GET /api/stock/sync-control/overview   — summary, locations, policies, audit
 *   GET /api/stock/sync-control/listings   — flat rows (listings + shared
 *       memberships), filters channel/market/mode/q, paginated
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  resolveIntendedQuantity,
  resolveMembershipIntended,
  type RoutedLedgerRow,
} from '../services/sync-control-core.js'
import { loadChannelPolicies, policyFor, validatePolicyInput, enforceNewListingDefaults } from '../services/sync-control-policy.service.js'
import { validateServesTokens } from '../services/sync-control-core.js'
import { setFollowMasterQuantity, setStockBuffer } from '../services/follow-master.service.js'
import { recascadeAfterSyncControlChange } from '../services/stock-movement.service.js'
import { enqueueOutboundRowsInstant } from '../services/outbound-enqueue.js'
import { summarizeProductSync, marketMatches, omitChildrenInList, resolveCanonicalMap, canonicalStem, INLINE_PREVIEW_ROWS, summarizeFamilies, familyKeyOf, rowMatchesScope, type SyncScope } from '../services/sync-control-product-view.js'
import { projectActionAndDetect, AMAZON_EU_SHARED_MARKETS, EU_GUARD_REMEDY } from '../services/amazon-eu-quantity-guard.js'
import { closeMarketOffers, reopenMarketOffers } from '../services/amazon-market-offer.service.js'
import { pickFaceImage, FACE_IMAGE_SELECT, FACE_IMAGE_ORDER_BY } from '../services/product-read-cache.service.js'
import { buildSyncControlWorkbook, parseSyncControlWorkbook, normalizeModeCell } from '../services/sync-control-excel.js'

/** SCD.8 — ONE parser for every multi-select filter value. The UI sends
 *  comma-separated selections; each endpoint must apply OR-within-a-dimension.
 *  (A partial rollout of this left /listings and /export on single-value
 *  equality, so any 2-value selection emptied the grid and the workbook.) */
function csvFilter(v?: string): string[] {
  return (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)
}

type Mode = 'FOLLOW' | 'PINNED' | 'PAUSED' | 'PAUSED_POLICY' | 'UNCOUNTED' | 'FBA' | 'EXCLUDED' | 'CLOSED'

interface SyncControlRow {
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
}

async function buildLedgers(productIds: string[]): Promise<Map<string, RoutedLedgerRow[]>> {
  const levels = await prisma.stockLevel.findMany({
    where: { productId: { in: productIds }, location: { type: 'WAREHOUSE' } },
    select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
  })
  const map = new Map<string, RoutedLedgerRow[]>()
  for (const l of levels) {
    const arr = map.get(l.productId) ?? []
    arr.push({ locationCode: l.location?.code ?? '?', available: l.available, syncRoutes: l.location?.syncRoutes ?? [] })
    map.set(l.productId, arr)
  }
  return map
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

async function computeRows(): Promise<SyncControlRow[]> {
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
        product: { select: { sku: true, fulfillmentMethod: true } },
      },
    }),
    prisma.sharedListingMembership.findMany({
      where: { status: 'ACTIVE' },
      select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true },
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
      sourceLocationCodes: cl.sourceLocationCodes ?? [],
      channelPolicy: policyFor(policies, cl.channel, cl.marketplace),
      ledger: ledgers.get(cl.productId) ?? [],
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
    })
  }

  for (const m of liveMemberships) {
    const r = resolveMembershipIntended({
      marketplace: m.marketplace,
      followPool: m.followPool ?? true,
      stockBuffer: m.stockBuffer ?? 0,
      channelPolicy: policyFor(policies, 'EBAY', m.marketplace),
      ledger: m.productId ? (ledgers.get(m.productId) ?? []) : [],
    })
    rows.push({
      lane: 'SHARED',
      sku: m.sku,
      productId: m.productId,
      channel: 'EBAY',
      marketplace: m.marketplace,
      mode: modeOf(r, true),
      intendedQty: r.kind === 'FOLLOW' ? r.quantity : null,
      liveQty: m.lastQtyPushed,
      buffer: m.stockBuffer ?? 0,
      routedLocations: r.kind === 'FOLLOW' ? r.routedLocations : [],
      itemId: m.itemId,
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
async function resolveCanonicalMasters(masterIds: string[]): Promise<Map<string, string>> {
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

export default async function syncControlRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stock/sync-control/overview', async () => {
    try {
      const [rows, locations, policies, audit, uploadVsPool] = await Promise.all([
        computeRows(),
        prisma.stockLocation.findMany({
          select: {
            code: true, name: true, type: true, isActive: true,
            syncRoutes: true, servesMarketplaces: true,
            stockLevels: { select: { quantity: true } },
          },
          orderBy: { code: 'asc' },
        }),
        prisma.syncChannelPolicy.findMany({ orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }] }),
        prisma.syncControlAudit.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
        // SC.4 — "your upload vs pool": read-back mismatches are exactly the
        // moments a Seller-Central/native upload diverged from pool truth.
        prisma.syncHealthLog.findMany({
          where: { conflictType: 'CHANNEL_QTY_READBACK', createdAt: { gte: new Date(Date.now() - 24 * 3600e3) } },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { id: true, createdAt: true, channel: true, errorMessage: true, resolutionStatus: true },
        }),
      ])
      const byMode: Record<string, number> = {}
      for (const r of rows) byMode[r.mode] = (byMode[r.mode] ?? 0) + 1
      return {
        summary: {
          rows: rows.length,
          listings: rows.filter((r) => r.lane === 'LISTING').length,
          shared: rows.filter((r) => r.lane === 'SHARED').length,
          products: new Set(rows.map((r) => r.productId).filter(Boolean)).size,
          byMode,
          routedLocations: locations.filter((l) => (l.syncRoutes ?? []).length > 0).length,
          policies: policies.length,
        },
        locations: locations.map((l) => ({
          code: l.code, name: l.name, type: l.type, isActive: l.isActive,
          syncRoutes: l.syncRoutes ?? [],
          servesMarketplaces: l.servesMarketplaces ?? [],
          stockUnits: l.stockLevels.reduce((s, x) => s + x.quantity, 0),
        })),
        policies,
        audit,
        uploadVsPool,
      }
    } catch (err) {
      logger.error('[sync-control] overview failed', { error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  })

  app.get('/stock/sync-control/listings', async (request) => {
    const q = request.query as { channel?: string; market?: string; mode?: string; q?: string; page?: string; pageSize?: string; drift?: string }
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1)
    const pageSize = Math.min(500, Math.max(10, Number.parseInt(q.pageSize ?? '50', 10) || 50))
    let rows = await computeRows()
    const lChans = csvFilter(q.channel).map((x) => x.toUpperCase())
    const lMkts = csvFilter(q.market).map((x) => x.toUpperCase())
    const lModes = csvFilter(q.mode).map((x) => x.toUpperCase())
    if (lChans.length) rows = rows.filter((r) => lChans.includes(r.channel))
    if (lMkts.length) rows = rows.filter((r) => lMkts.includes(r.marketplace.toUpperCase().replace(/^EBAY_/, '')))
    if (lModes.length) rows = rows.filter((r) => lModes.includes(r.mode))
    if (q.q) {
      const needle = q.q.toLowerCase()
      rows = rows.filter((r) => r.sku.toLowerCase().includes(needle))
    }
    // SCD.4 — the shared FilterBar offers "Drift only" and counted it as an
    // active filter, but this endpoint ignored it: the Listings view showed
    // every row while claiming to be filtered.
    if (q.drift === '1' || q.drift === 'true') {
      rows = rows.filter((r) => r.intendedQty != null && r.liveQty != null && r.intendedQty !== r.liveQty)
    }
    rows.sort((a, b) => a.sku.localeCompare(b.sku) || a.channel.localeCompare(b.channel) || a.marketplace.localeCompare(b.marketplace))
    const total = rows.length
    return { total, page, pageSize, rows: rows.slice((page - 1) * pageSize, page * pageSize) }
  })

  // ── SCV.1 — product-first view: the SAME derived rows, grouped by product ──
  //
  // One row per product (image · family · pool · sync rollup · drift) with its
  // per-listing children in the payload (no lazy fetch). Filters select which
  // PRODUCTS appear (a product qualifies if any of its rows match), but each
  // product always carries its FULL child set + rollup so the view never lies
  // about a product's real state. Read-only; inherits inventoryView.
  app.get('/stock/sync-control/products', async (request) => {
    const q = request.query as {
      channel?: string; market?: string; mode?: string; q?: string; drift?: string
      page?: string; pageSize?: string; masterId?: string; family?: string
    }
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1)
    const pageSize = Math.min(500, Math.max(10, Number.parseInt(q.pageSize ?? '50', 10) || 50))
    // SCV.1b — the dedicated per-product page requests one master's FULL tree
    // (no filters, no child cap).
    const singleMasterId = q.masterId?.trim() || null

    const rows = await computeRows()
    const rowPids = [...new Set(rows.map((r) => r.productId).filter((p): p is string => Boolean(p)))]

    // Roll each row up to its MASTER (parentId ?? id): a jacket's 40 variant
    // rows collapse into ONE master row. Stock lives on variants, so the
    // master's pool is the SUM across its listed variants (and how many are
    // in stock) — a single master-level number would always read 0.
    const rowProducts = await prisma.product.findMany({
      where: { id: { in: rowPids } },
      select: { id: true, parentId: true },
    })
    const masterOf = new Map(rowProducts.map((p) => [p.id, p.parentId ?? p.id]))
    const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]

    // SCD.1 — pool-derived canonical grouping. A duplicate copy (a childless
    // master whose eBay listing pools the canonical's child SKUs) folds into
    // the canonical. Derived from the shared listing pool, not a SKU regex.
    const canonicalOf = await resolveCanonicalMasters(masterIds)
    const groupIdOf = (pid: string): string => {
      const mid = masterOf.get(pid) ?? pid
      return canonicalOf.get(mid) ?? mid
    }
    const groupIds = [...new Set(masterIds.map((mid) => canonicalOf.get(mid) ?? mid))]
    // members folded into each group (the duplicate masters, excluding the canonical)
    const membersByGroup = new Map<string, string[]>()
    for (const mid of masterIds) {
      const gid = canonicalOf.get(mid) ?? mid
      if (gid !== mid) {
        const arr = membersByGroup.get(gid) ?? []
        arr.push(mid)
        membersByGroup.set(gid, arr)
      }
    }

    const [masterMeta, ledgers] = await Promise.all([
      prisma.product.findMany({
        where: { id: { in: masterIds } },
        select: {
          id: true, sku: true, name: true,
          family: { select: { code: true, label: true } },
          images: { select: FACE_IMAGE_SELECT, orderBy: FACE_IMAGE_ORDER_BY },
          parent: { select: { images: { select: FACE_IMAGE_SELECT, orderBy: FACE_IMAGE_ORDER_BY } } },
        },
      }),
      buildLedgers(rowPids),
    ])
    const metaById = new Map(masterMeta.map((m) => [m.id, m]))
    const poolOf = (pid: string) => (ledgers.get(pid) ?? []).reduce((s, l) => s + l.available, 0)

    // SCD.3 — which PARENT listing owns each eBay itemId, so a family can be
    // labelled by the parent SKU the owner recognises (GALE-JACKET-ALT1).
    const allItemIds = [...new Set(rows.map((r) => r.itemId).filter((x): x is string => Boolean(x)))]
    const ownerSkuByItemId = new Map<string, string>()
    if (allItemIds.length > 0) {
      const owners = await prisma.channelListing.findMany({
        where: { externalListingId: { in: allItemIds } },
        select: { externalListingId: true, product: { select: { sku: true, parentId: true, parent: { select: { sku: true } } } } },
      })
      for (const o of owners) {
        if (!o.externalListingId || ownerSkuByItemId.has(o.externalListingId)) continue
        // a listing hung off a variant is labelled by its parent family sku
        ownerSkuByItemId.set(o.externalListingId, o.product?.parent?.sku ?? o.product?.sku ?? '')
      }
    }

    const byMaster = new Map<string, SyncControlRow[]>()
    for (const r of rows) {
      if (!r.productId) continue
      const gid = groupIdOf(r.productId)
      const arr = byMaster.get(gid) ?? []
      arr.push(r)
      byMaster.set(gid, arr)
    }

    const all = groupIds.map((mid) => {
      // SCD.4 — deterministic order. computeRows emits ALL ChannelListing rows
      // before ANY membership row (both unordered heap scans), so an unsorted
      // preview slice showed a scrambled set that never included a single
      // Shared row and could reshuffle between polls. Sort exactly like the
      // per-product page so both surfaces agree.
      const children = (byMaster.get(mid) ?? []).slice().sort(
        (a, b) => a.sku.localeCompare(b.sku) || a.channel.localeCompare(b.channel) || a.marketplace.localeCompare(b.marketplace) || (a.itemId ?? '').localeCompare(b.itemId ?? ''),
      )
      const allPids = [...new Set(children.map((c) => c.productId).filter((p): p is string => Boolean(p)))]
      // SCD.1c — a folded duplicate MASTER's own listing row carries that
      // master's id, but a duplicate parent is NOT a variant. Count only real
      // variants so "N var" matches reality (GALE = 41, not 45).
      const foldedMasters = new Set(membersByGroup.get(mid) ?? [])
      const variantPids = allPids.filter((pid) => !foldedMasters.has(pid))
      const poolTotal = variantPids.reduce((s, pid) => s + poolOf(pid), 0)
      const variantsInStock = variantPids.filter((pid) => poolOf(pid) > 0).length
      const m = metaById.get(mid)
      const rollup = summarizeProductSync(children)
      const imageUrl = pickFaceImage(m?.images ?? []) ?? pickFaceImage(m?.parent?.images ?? []) ?? null
      return {
        // masterId = the canonical master id (a real product) → editor/detail
        // links and the ?masterId= single-fetch all still work unchanged.
        masterId: mid,
        // SCD.1 — the duplicate masters folded into this group (for group-level
        // bulk/export expansion in SCD.2).
        memberMasterIds: membersByGroup.get(mid) ?? [],
        sku: m?.sku ?? children[0]?.sku ?? '?',
        name: m?.name ?? '(unknown product)',
        family: m?.family ?? null,
        imageUrl,
        poolTotal,
        variantsInStock,
        variantCount: variantPids.length,
        rollup,
        // SCD.3 — the parent listings ("families") sharing these child SKUs,
        // so each can be opened and controlled on its own.
        families: summarizeFamilies(children, ownerSkuByItemId),
        children,
      }
    })

    const chans = csvFilter(q.channel).map((x) => x.toUpperCase())
    const modes = csvFilter(q.mode).map((x) => x.toUpperCase())
    const mkts = csvFilter(q.market)
    const needle = q.q?.trim().toLowerCase()
    const driftOnly = q.drift === '1' || q.drift === 'true'

    // SCV.1b — single-master fetch (per-product page): full tree, no cap.
    // SCD.3 — optional ?family= narrows to ONE parent listing, so the owner can
    // control just that family's child SKUs without touching the other copies.
    if (singleMasterId) {
      // SCD.4 — a FOLDED duplicate's id is a legitimate link target (old
      // bookmarks, links built elsewhere): resolve it to the group it now
      // belongs to instead of rendering "product not found" (22 of 37 master
      // ids are folded members).
      const one = all.find((p) => p.masterId === singleMasterId)
        ?? all.find((p) => (p.memberMasterIds ?? []).includes(singleMasterId))
      if (!one) return { total: 0, page: 1, pageSize, products: [] }
      const familyKey = (q as { family?: string }).family?.trim() || null
      const children = familyKey ? one.children.filter((c) => familyKeyOf(c) === familyKey) : one.children
      return {
        total: 1, page: 1, pageSize,
        products: [{ ...one, children, listingCount: children.length, childrenOmitted: false, familyKey }],
      }
    }

    // SCT.3 — ONE row-level predicate (rowMatchesScope) decides both which
    // families show AND which of their children display, and POST /actions
    // narrows a bulk expansion with the SAME function. The old per-dimension
    // .some() checks could match DIFFERENT children (channel via child A,
    // market via child B) and the displayed family then shipped ALL children —
    // so "filter Market=IT → act" touched DE/ES rows the filter implied were
    // out of scope.
    const scopeNorm: SyncScope = { channels: chans, markets: mkts, modes, drift: driftOnly }
    const hasScope = chans.length > 0 || mkts.length > 0 || modes.length > 0 || driftOnly
    const filtered = all.filter((p) => {
      if (hasScope && !p.children.some((c) => rowMatchesScope(c, scopeNorm))) return false
      if (needle && !(
        p.name.toLowerCase().includes(needle) ||
        p.sku.toLowerCase().includes(needle) ||
        p.children.some((c) => c.sku.toLowerCase().includes(needle))
      )) return false
      return true
    })
    filtered.sort((a, b) => a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku))

    // SCV.1b — omit child rows for big families (client shows "Open ↗"); the
    // rollup/pool/drift on the master row stay intact so the overview is whole.
    const products = filtered.slice((page - 1) * pageSize, page * pageSize).map((p) => {
      // SCT.3 — with filters active, the family row shows/counts ONLY the
      // matching listings (and its Sync/Drift rollup re-derives from them), so
      // the grid displays exactly what a bulk action will touch. Pool/stock
      // stay family-wide — stock is per-product, not per-listing.
      const kids = hasScope ? p.children.filter((c) => rowMatchesScope(c, scopeNorm)) : p.children
      // SCD.2 — big families still expand inline, but ship only a PREVIEW of
      // their listings; the row footer links to the full per-product page.
      // childrenOmitted stays HONEST under scope: if the narrowed set fits the
      // preview, nothing is omitted and the footer must not claim it is.
      const truncated = omitChildrenInList(p.variantCount) && kids.length > INLINE_PREVIEW_ROWS
      // families chips mirror the scope too — a family whose every row is
      // filtered out must not render as an actionable chip.
      const fams = hasScope && p.families
        ? p.families.filter((f) => rowMatchesScope({ channel: f.channel, marketplace: f.marketplace, mode: 'FOLLOW' }, { channels: scopeNorm.channels, markets: scopeNorm.markets }))
        : p.families
      return {
        ...p,
        families: fams,
        rollup: hasScope ? summarizeProductSync(kids) : p.rollup,
        listingCount: kids.length,
        childrenOmitted: truncated,
        children: truncated ? kids.slice(0, INLINE_PREVIEW_ROWS) : kids,
      }
    })

    return { total: filtered.length, page, pageSize, products }
  })

  // ── SC.3 — mutations (writes require inventoryAdjust via the manifest) ──

  const actorOf = (request: { user?: { email?: string } }): string =>
    request.user?.email ?? 'sync-control'

  const audit = async (
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

  interface ListingTarget { productId: string; channel: string; marketplace: string }
  interface MembershipTarget { itemId: string; marketplace: string; sku: string }

  app.post('/stock/sync-control/actions', async (request, reply) => {
    const body = request.body as {
      action: 'FOLLOW' | 'PIN' | 'PAUSE' | 'RESUME' | 'ZERO_PIN' | 'EXCLUDE' | 'INCLUDE' | 'BUFFER' | 'CLOSE_OFFER' | 'REOPEN_OFFER'
      buffer?: number
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
    const actor = actorOf(request as never)
    const listings = body.listings ?? []
    const memberships = body.memberships ?? []
    if (!body.action) return reply.code(400).send({ error: 'action required' })
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
            select: { productId: true, channel: true, marketplace: true },
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
          const LANE_S = ['EXCLUDE', 'INCLUDE', 'BUFFER'].includes(body.action)
          result.scopedOut = (LANE_L ? cls.length - clsT.length : 0) + (LANE_S ? mems.length - memsT.length : 0)
        }

        // SCD.4 — expand ONLY the lanes this action can actually write. Pushing
        // both lanes unconditionally made a listing-lane action (PAUSE/RESUME/
        // FOLLOW/PIN/ZERO_PIN) commit its writes and THEN hit the shared-lane
        // "not valid" branch, returning 400 after the fact: the operator was told
        // it failed while it had already happened (and RESUME skipped its
        // recascade, ZERO_PIN had already pushed qty 0 live).
        const LISTING_LANE = ['FOLLOW', 'PIN', 'PAUSE', 'RESUME', 'ZERO_PIN', 'BUFFER', 'CLOSE_OFFER', 'REOPEN_OFFER']
        const SHARED_LANE = ['EXCLUDE', 'INCLUDE', 'BUFFER']
        if (LISTING_LANE.includes(body.action)) {
          for (const c of clsT) listings.push({ productId: c.productId, channel: c.channel, marketplace: c.marketplace })
        }
        if (SHARED_LANE.includes(body.action)) {
          for (const m of memsT) memberships.push({ itemId: m.itemId, marketplace: m.marketplace, sku: m.sku })
        }
      }

      if (listings.length === 0 && memberships.length === 0) {
        return reply.code(400).send({
          error: result.scopedOut > 0
            ? `0 rows match your filters right now (${result.scopedOut} filtered out — drift may have converged since the page rendered). Nothing was written.`
            : 'no targets',
        })
      }
      // Master-bulk legitimately expands large (a 49-variant family ≈ 300 rows).
      // SCT.4/5b — Amazon EU shared-quantity gate. Amazon keeps ONE merchant
      // quantity per SKU across EU marketplaces (proved 2026-07-26: 302
      // market-scoped Zero&Pins blanked the whole IT storefront). A partial-
      // market quantity action is never refused any more — but it can't be
      // half-done either. Without expandEuAligned we answer 409 + the TRUE
      // scope (nothing written); with it, the action expands to every EU row
      // of the affected SKUs so platform state ≡ Amazon state.
      if (['FOLLOW', 'PIN', 'ZERO_PIN'].includes(body.action)) {
        const euTargets = listings.filter(
          (t) => t.channel === 'AMAZON' && AMAZON_EU_SHARED_MARKETS.has(t.marketplace.toUpperCase()),
        )
        if (euTargets.length > 0) {
          const pids = [...new Set(euTargets.map((t) => t.productId))]
          const euRows = await prisma.channelListing.findMany({
            where: { productId: { in: pids }, channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
            select: {
              productId: true, marketplace: true, followMasterQuantity: true, quantityOverride: true,
              quantity: true, syncPaused: true, fulfillmentMethod: true, offerClosedAt: true,
              product: { select: { sku: true } },
            },
          })
          const targetsByPid = new Map<string, Set<string>>()
          for (const t of euTargets) {
            const set = targetsByPid.get(t.productId) ?? new Set<string>()
            set.add(t.marketplace.toUpperCase())
            targetsByPid.set(t.productId, set)
          }
          const conflictedPids: string[] = []
          for (const [pid, mkts] of targetsByPid) {
            const prodRows = euRows
              .filter((r) => r.productId === pid)
              .map((r) => ({
                marketplace: r.marketplace,
                followMasterQuantity: r.followMasterQuantity,
                quantityOverride: r.quantityOverride,
                quantity: r.quantity,
                syncPaused: r.syncPaused,
                isFba: r.fulfillmentMethod === 'FBA',
                offerClosed: !!r.offerClosedAt,
              }))
            const v = projectActionAndDetect(prodRows, mkts, body.action as 'FOLLOW' | 'PIN' | 'ZERO_PIN')
            if (v.conflict) conflictedPids.push(pid)
          }
          if (conflictedPids.length > 0) {
            // The extra rows the TRUE (EU-wide) action covers.
            const additions: Array<{ productId: string; channel: string; marketplace: string }> = []
            const previews: Array<{ sku: string; addedMarkets: string[] }> = []
            for (const pid of conflictedPids) {
              const targeted = targetsByPid.get(pid) ?? new Set<string>()
              const extra = euRows.filter(
                (r) => r.productId === pid && r.fulfillmentMethod !== 'FBA' &&
                  // SCT.6 — NEVER expand into a CLOSED market: consenting to an
                  // EU-wide quantity action must not reopen a closed offer.
                  !r.offerClosedAt &&
                  AMAZON_EU_SHARED_MARKETS.has(r.marketplace.toUpperCase()) &&
                  !targeted.has(r.marketplace.toUpperCase()),
              )
              for (const r of extra) additions.push({ productId: pid, channel: 'AMAZON', marketplace: r.marketplace })
              previews.push({
                sku: euRows.find((r) => r.productId === pid)?.product?.sku ?? pid,
                addedMarkets: [...new Set(extra.map((r) => r.marketplace.toUpperCase()))],
              })
            }
            if (!body.expandEuAligned) {
              // NOTHING written — tell the operator the true scope and let
              // them proceed with one confirm (409 preview, not a refusal).
              return reply.code(409).send({
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
      if (listings.length + memberships.length > cap) return reply.code(400).send({ error: `max ${cap} targets per call` })


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
            const svcTargets = targets.map((t) => ({ productId: t.productId, marketplace: t.marketplace }))
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
              productIds, channel: channel as never, markets, follow: body.action === 'FOLLOW', actor,
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
            continue
          }

          if (body.action === 'BUFFER') {
            const buffer = Math.max(0, Math.trunc(body.buffer ?? 0))
            const r = await setStockBuffer({ productIds, channel: channel as never, markets, buffer, actor })
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
              OR: targets.map((t) => ({ productId: t.productId, channel: t.channel, marketplace: t.marketplace })),
            },
            select: {
              id: true, productId: true, channel: true, marketplace: true, region: true,
              externalListingId: true, syncPaused: true, fulfillmentMethod: true, quantity: true,
              product: { select: { fulfillmentMethod: true, sku: true } },
            },
          })
          const eligible = rows.filter((r) => {
            const fba = r.fulfillmentMethod === 'FBA' || (r.fulfillmentMethod == null && r.product?.fulfillmentMethod === 'FBA') || r.product?.fulfillmentMethod === 'FBA'
            if (fba) result.skippedFba++
            return !fba
          })

          if (body.action === 'PAUSE') {
            const ids = eligible.filter((r) => !r.syncPaused).map((r) => r.id)
            result.unchanged += eligible.length - ids.length
            if (ids.length) {
              const u = await prisma.channelListing.updateMany({ where: { id: { in: ids } }, data: { syncPaused: true } })
              result.updated += u.count
            }
            await audit(eligible.map((r) => ({
              scopeType: 'LISTING', scopeId: r.id, scopeName: `${r.product?.sku}@${r.channel}:${r.marketplace}`,
              field: 'syncPaused', before: { syncPaused: r.syncPaused }, after: { syncPaused: true },
            })), actor)
          } else if (body.action === 'RESUME') {
            const ids = eligible.filter((r) => r.syncPaused).map((r) => r.id)
            result.unchanged += eligible.length - ids.length
            if (ids.length) {
              const u = await prisma.channelListing.updateMany({ where: { id: { in: ids } }, data: { syncPaused: false } })
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
                where: { id: { in: eligible.map((r) => r.id) } },
                data: { quantity: 0, quantityOverride: 0, followMasterQuantity: false, syncPaused: false, lastSyncStatus: 'PENDING' },
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
              field: 'zeroPin', before: { quantity: r.quantity }, after: { quantity: 0, follow: false },
            })), actor)
          }
        }
      }

      // ── SHARED lane (memberships) ──
      if (memberships.length > 0) {
        const or = memberships.map((t) => ({ itemId: t.itemId, marketplace: t.marketplace, sku: t.sku }))
        const rows = await prisma.sharedListingMembership.findMany({
          where: { OR: or },
          select: { id: true, itemId: true, marketplace: true, sku: true, productId: true, followPool: true },
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
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      request.log.error({ err: e, action: body.action }, 'sync-control action failed')
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
        return {
          ...result,
          partial: true,
          error: `${body.action} stopped after ${result.updated} update(s): ${msg} — re-run the same action to continue (already-written rows are no-ops)`,
        }
      }
      return reply.code(500).send({ error: `${body.action} failed: ${msg}` })
    }
  })

  app.post('/stock/sync-control/location-routes', async (request, reply) => {
    const body = request.body as { code?: string; syncRoutes?: string[] }
    const actor = actorOf(request as never)
    if (!body.code || !Array.isArray(body.syncRoutes)) {
      return reply.code(400).send({ error: 'code and syncRoutes[] required' })
    }
    const tokens = body.syncRoutes.map((t) => String(t).trim().toUpperCase()).filter(Boolean)
    const problems = validateServesTokens(tokens)
    if (problems.length > 0) return reply.code(400).send({ error: 'invalid tokens', problems })

    const loc = await prisma.stockLocation.findUnique({ where: { code: body.code }, select: { id: true, code: true, type: true, syncRoutes: true } })
    if (!loc) return reply.code(404).send({ error: `location ${body.code} not found` })

    await prisma.stockLocation.update({ where: { id: loc.id }, data: { syncRoutes: tokens } })
    await audit([{ scopeType: 'LOCATION', scopeId: loc.id, scopeName: loc.code, field: 'syncRoutes', before: { syncRoutes: loc.syncRoutes }, after: { syncRoutes: tokens } }], actor)

    // Every product with stock in this location may change effective qty
    // somewhere — recascade them all (background, sequential).
    const affected = await prisma.stockLevel.findMany({ where: { locationId: loc.id }, select: { productId: true }, distinct: ['productId'] })
    const productIds = affected.map((a) => a.productId)
    void recascadeAfterSyncControlChange(productIds, actor).then((r) =>
      logger.info('[sync-control] recascade after routing change complete', { ...r, location: loc.code, actor }),
    )
    return { ok: true, location: loc.code, syncRoutes: tokens, recascadeQueued: productIds.length }
  })

  // ── SCG.2 — full audit history (server-paginated; the History card links
  //    here in a new tab). Read-only; inherits inventoryView via the manifest.
  app.get('/stock/sync-control/audit', async (request) => {
    const q = request.query as { page?: string; pageSize?: string; scope?: string; field?: string }
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1)
    const pageSize = Math.min(500, Math.max(10, Number.parseInt(q.pageSize ?? '50', 10) || 50))
    const where = {
      ...(q.scope ? { scopeType: q.scope.toUpperCase() } : {}),
      ...(q.field ? { field: q.field } : {}),
    }
    const [total, rows] = await Promise.all([
      prisma.syncControlAudit.count({ where }),
      prisma.syncControlAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])
    return { total, page, pageSize, rows }
  })

  // ── SC.5 — channel/market policies (kill-switch + new-listing default) ──
  //
  // Upsert on (channel, marketplace); '*' = channel-wide. A row that ends up
  // all-default is deleted (an all-default row and no row derive identically).
  // Resume (pushesPaused true→false) recascades every product with listings
  // in scope so marketplace truth reconverges without waiting for an order.
  app.post('/stock/sync-control/policies', async (request, reply) => {
    const body = request.body as {
      channel?: string
      marketplace?: string
      pushesPaused?: boolean
      newListingDefaultMode?: 'FOLLOW' | 'PAUSED'
    }
    const actor = actorOf(request as never)
    const problem = validatePolicyInput(body ?? {})
    if (problem) return reply.code(400).send({ error: problem })

    const channel = body.channel!.trim().toUpperCase()
    const marketplace = body.marketplace!.trim().toUpperCase()
    const existing = await prisma.syncChannelPolicy.findUnique({
      where: { channel_marketplace: { channel, marketplace } },
    })

    const nextPaused = body.pushesPaused ?? existing?.pushesPaused ?? false
    const nextMode = body.newListingDefaultMode ?? existing?.newListingDefaultMode ?? 'FOLLOW'
    const modeChanged = nextMode !== (existing?.newListingDefaultMode ?? 'FOLLOW')
    const pausedChanged = nextPaused !== (existing?.pushesPaused ?? false)
    const scopeName = `${channel}:${marketplace}`

    // All-default result → drop the row entirely.
    if (!nextPaused && nextMode === 'FOLLOW') {
      if (existing) {
        await prisma.syncChannelPolicy.delete({ where: { id: existing.id } })
        await audit([{
          scopeType: 'POLICY', scopeId: existing.id, scopeName, field: 'policy',
          before: { pushesPaused: existing.pushesPaused, newListingDefaultMode: existing.newListingDefaultMode },
          after: { removed: true },
        }], actor)
      }
    } else {
      const saved = await prisma.syncChannelPolicy.upsert({
        where: { channel_marketplace: { channel, marketplace } },
        create: {
          channel, marketplace, pushesPaused: nextPaused, newListingDefaultMode: nextMode,
          newListingModeSetAt: nextMode === 'PAUSED' ? new Date() : null,
        },
        update: {
          pushesPaused: nextPaused,
          newListingDefaultMode: nextMode,
          // Cutoff moves ONLY when the default-mode itself changes.
          ...(modeChanged ? { newListingModeSetAt: nextMode === 'PAUSED' ? new Date() : null } : {}),
        },
      })
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
        where: { channel, listingStatus: { not: 'ENDED' } },
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
    return { ok: true, policies, recascadeQueued }
  })

  // ── SCV.3 — dedicated Excel round-trip (export + import preview/apply) ──

  const rowKeyOf = (r: SyncControlRow) => `${r.lane}|${r.sku}|${r.channel}|${r.marketplace}|${r.itemId ?? ''}`
  const logicalMode = (m: Mode): 'FOLLOW' | 'PINNED' | 'PAUSED' | 'EXCLUDED' | 'FBA' | 'UNCOUNTED' => {
    if (m === 'PAUSED_POLICY') return 'PAUSED'
    return m as never
  }

  // Resolve which productIds a set of filters selects (mirrors the products view).
  async function filterExportRows(rows: SyncControlRow[], q: { channel?: string; market?: string; mode?: string; q?: string; drift?: string; masterId?: string; family?: string; lane?: string }): Promise<SyncControlRow[]> {
    let masterVariantIds: Set<string> | null = null
    if (q.masterId) {
      // SCD.1c — scope to the WHOLE GROUP, using the same canonical resolution
      // as the products view: the canonical's variants AND every folded
      // duplicate copy's listing. (The old OR:[{id},{parentId}] missed the
      // folded copies, so a per-product export silently omitted those listings
      // and a re-import could never manage them.)
      const rowPids = [...new Set(rows.map((r) => r.productId).filter((p): p is string => Boolean(p)))]
      const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
      const masterOf = new Map(rp.map((p) => [p.id, p.parentId ?? p.id]))
      const canon = await resolveCanonicalMasters([...new Set(rowPids.map((id) => masterOf.get(id) ?? id))])
      masterVariantIds = new Set(
        rowPids.filter((pid) => {
          const mid = masterOf.get(pid) ?? pid
          return (canon.get(mid) ?? mid) === q.masterId
        }),
      )
    }
    const xChans = csvFilter(q.channel).map((x) => x.toUpperCase())
    const xModes = csvFilter(q.mode).map((x) => x.toUpperCase())
    const xMkts = csvFilter(q.market)
    const xLanes = csvFilter(q.lane).map((x) => x.toUpperCase())
    const xFams = csvFilter(q.family)
    const needle = q.q?.trim().toLowerCase()
    const driftOnly = q.drift === '1' || q.drift === 'true'
    // SCD.4 — the Products grid searches product NAME or SKU; the export only
    // matched a row's own sku, so searching by name exported the wrong set (an
    // empty workbook for a name-only match). Resolve name matches to their
    // products so "export what you see" really does.
    let nameMatchPids: Set<string> | null = null
    if (needle) {
      const hits = await prisma.product.findMany({
        where: { OR: [{ name: { contains: needle, mode: 'insensitive' } }, { sku: { contains: needle, mode: 'insensitive' } }] },
        select: { id: true },
      })
      const ids = hits.map((h) => h.id)
      const kids = ids.length ? await prisma.product.findMany({ where: { parentId: { in: ids } }, select: { id: true } }) : []
      nameMatchPids = new Set([...ids, ...kids.map((k) => k.id)])
    }
    return rows.filter((r) => {
      if (masterVariantIds && !(r.productId && masterVariantIds.has(r.productId))) return false
      // SCD.3/5/8 — every dimension is multi-value: OR within, AND across.
      if (xFams.length && !xFams.includes(familyKeyOf(r))) return false
      if (xLanes.length && !xLanes.includes(r.lane)) return false
      if (xChans.length && !xChans.includes(r.channel)) return false
      if (xMkts.length && !xMkts.some((m) => marketMatches(r.marketplace, m) || r.marketplace === m)) return false
      if (xModes.length && !xModes.includes(r.mode)) return false
      if (needle && !(r.sku.toLowerCase().includes(needle) || (r.productId && nameMatchPids?.has(r.productId)))) return false
      if (driftOnly && !(r.intendedQty != null && r.liveQty != null && r.intendedQty !== r.liveQty)) return false
      return true
    })
  }

  app.get('/stock/sync-control/export', async (request, reply) => {
    const q = request.query as { channel?: string; market?: string; mode?: string; q?: string; drift?: string; masterId?: string; family?: string; lane?: string }
    const rows = await filterExportRows(await computeRows(), q)
    const pids = [...new Set(rows.map((r) => r.productId).filter((p): p is string => Boolean(p)))]
    const [names, ledgers, locations] = await Promise.all([
      prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, name: true } }),
      buildLedgers(pids),
      prisma.stockLocation.findMany({ where: { type: 'WAREHOUSE' }, select: { code: true, type: true, syncRoutes: true }, orderBy: { code: 'asc' } }),
    ])
    const nameById = new Map(names.map((n) => [n.id, n.name]))
    const poolOf = (pid: string | null): number | '' => pid ? (ledgers.get(pid) ?? []).reduce((s, l) => s + l.available, 0) : ''
    const listingRows = rows.map((r) => {
      const lm = logicalMode(r.mode)
      const drift = r.mode !== 'FBA' && r.intendedQty != null && r.liveQty != null && r.intendedQty !== r.liveQty
      return {
        product: (r.productId ? nameById.get(r.productId) : '') ?? '',
        sku: r.sku, channel: r.channel, market: r.marketplace, itemId: r.itemId ?? '', lane: r.lane,
        mode: lm === 'FBA' ? 'Amazon-managed' : lm === 'UNCOUNTED' ? 'Follow' : `${lm.charAt(0)}${lm.slice(1).toLowerCase()}`,
        pinnedQty: r.mode === 'PINNED' ? (r.intendedQty ?? '') : '' as number | '',
        buffer: r.buffer,
        pool: poolOf(r.productId), intended: r.mode === 'FBA' ? '' : (r.intendedQty ?? '') as number | '',
        live: r.mode === 'FBA' ? '' : (r.liveQty ?? '') as number | '',
        drift: drift ? 'DRIFT' : '', locked: r.mode === 'FBA' ? 'FBA' : '',
      }
    })
    const routeRows = locations.map((l) => ({ location: l.code, type: l.type, feeds: (l.syncRoutes ?? []).join(', ') }))
    const buf = await buildSyncControlWorkbook(listingRows, routeRows)
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="sync-control-export.xlsx"`)
    return reply.send(buf)
  })

  // Shared: parse a workbook and diff it against current state → changes.
  async function computeSheetChanges(buf: Buffer) {
    const { listings: edits, routes: routeEdits } = await parseSyncControlWorkbook(buf)
    const rows = await computeRows()
    const byKey = new Map(rows.map((r) => [rowKeyOf(r), r]))
    const changes: Array<{
      lane: 'LISTING' | 'SHARED' | 'ROUTE'; key: string; field: string; from: string; to: string
      productId?: string | null; channel?: string; marketplace?: string; itemId?: string; sku?: string
      target?: 'FOLLOW' | 'PINNED' | 'PAUSED' | 'EXCLUDED'; buffer?: number; pinnedQty?: number | null
      locationCode?: string; feeds?: string[]
    }> = []
    const skipped: Array<{ key: string; reason: string }> = []

    for (const e of edits) {
      const key = `${e.channel === 'EBAY' && e.itemId ? 'SHARED' : 'LISTING'}|${e.sku}|${e.channel}|${e.market}|${e.itemId}`
      // Prefer exact lane match; fall back to either lane by (sku,channel,market).
      const cur = byKey.get(key) ?? rows.find((r) => r.sku === e.sku && r.channel === e.channel && r.marketplace === e.market && (e.itemId ? r.itemId === e.itemId : true))
      if (!cur) { skipped.push({ key: `${e.sku}@${e.channel}:${e.market}`, reason: 'no matching listing' }); continue }
      // SCT.6 — a CLOSED market offer is never modified via Excel: reopening
      // is a deliberate action, not an import side effect.
      if (cur.mode === 'CLOSED') { skipped.push({ key: `${e.sku}@${e.channel}:${e.market}`, reason: 'market offer CLOSED — use Reopen offer' }); continue }
      if (cur.mode === 'FBA' || e.locked) { skipped.push({ key: `${e.sku}@${e.channel}:${e.market}`, reason: 'FBA (Amazon-managed)' }); continue }

      const want = normalizeModeCell(e.mode)
      if (want === undefined) { skipped.push({ key: `${e.sku}@${e.channel}:${e.market}`, reason: `unrecognized mode "${e.mode}"` }); continue }
      const curLogical = logicalMode(cur.mode) === 'UNCOUNTED' ? 'FOLLOW' : logicalMode(cur.mode)
      const label = `${e.sku}@${e.channel}:${e.market}`

      if (want && want !== curLogical) {
        if (cur.lane === 'SHARED' && (want === 'PINNED' || want === 'PAUSED')) {
          skipped.push({ key: label, reason: `shared variant can't be ${want} (use Excluded)` }); continue
        }
        changes.push({
          lane: cur.lane, key: label, field: 'mode', from: curLogical, to: want,
          productId: cur.productId, channel: cur.channel, marketplace: cur.marketplace, itemId: cur.itemId, sku: cur.sku,
          target: want, pinnedQty: want === 'PINNED' ? e.pinnedQty : undefined,
        })
      } else if (want === 'PINNED' && e.pinnedQty != null && e.pinnedQty !== cur.intendedQty) {
        changes.push({ lane: cur.lane, key: label, field: 'pinnedQty', from: String(cur.intendedQty ?? ''), to: String(e.pinnedQty), productId: cur.productId, channel: cur.channel, marketplace: cur.marketplace, itemId: cur.itemId, sku: cur.sku, target: 'PINNED', pinnedQty: e.pinnedQty })
      }

      if (e.buffer != null && e.buffer >= 0 && e.buffer !== cur.buffer) {
        changes.push({ lane: cur.lane, key: label, field: 'buffer', from: String(cur.buffer), to: String(e.buffer), productId: cur.productId, channel: cur.channel, marketplace: cur.marketplace, itemId: cur.itemId, sku: cur.sku, buffer: e.buffer })
      }
    }

    if (routeEdits.length > 0) {
      const locs = await prisma.stockLocation.findMany({ where: { code: { in: routeEdits.map((r) => r.location) } }, select: { code: true, syncRoutes: true } })
      const locByCode = new Map(locs.map((l) => [l.code, l]))
      for (const re of routeEdits) {
        const loc = locByCode.get(re.location)
        if (!loc) { skipped.push({ key: re.location, reason: 'unknown location' }); continue }
        const problems = validateServesTokens(re.feeds)
        if (problems.length > 0) { skipped.push({ key: re.location, reason: `invalid routes: ${problems.map((p) => p.token).join(', ')}` }); continue }
        const cur = [...(loc.syncRoutes ?? [])].sort().join(',')
        const next = [...re.feeds].sort().join(',')
        if (cur !== next) changes.push({ lane: 'ROUTE', key: re.location, field: 'routes', from: cur || '(everywhere)', to: next || '(everywhere)', locationCode: re.location, feeds: re.feeds })
      }
    }
    return { changes, skipped }
  }

  app.post('/stock/sync-control/import/preview', async (request, reply) => {
    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'No file attached' })
    try {
      const buf = await data.toBuffer()
      const { changes, skipped } = await computeSheetChanges(buf)
      return { changes, skipped, changeCount: changes.length, skipCount: skipped.length }
    } catch (err) {
      logger.error('[sync-control] import preview failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/stock/sync-control/import/apply', async (request, reply) => {
    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'No file attached' })
    const actor = `excel:${actorOf(request as never)}`
    try {
      const buf = await data.toBuffer()
      const { changes, skipped } = await computeSheetChanges(buf)
      const recascade = new Set<string>()
      let applied = 0
      // SCT.3 — row failures must reach the operator, not just the server log:
      // "42 applied" while 3 silently failed reads as everything-worked.
      const failed: Array<{ key: string; error: string }> = []

      for (const c of changes) {
        try {
          if (c.lane === 'ROUTE' && c.locationCode && c.feeds) {
            const loc = await prisma.stockLocation.findUnique({ where: { code: c.locationCode }, select: { id: true, syncRoutes: true } })
            if (!loc) continue
            await prisma.stockLocation.update({ where: { id: loc.id }, data: { syncRoutes: c.feeds } })
            await audit([{ scopeType: 'LOCATION', scopeId: loc.id, scopeName: c.locationCode, field: 'syncRoutes', before: { syncRoutes: loc.syncRoutes }, after: { syncRoutes: c.feeds } }], actor)
            const affected = await prisma.stockLevel.findMany({ where: { locationId: loc.id }, select: { productId: true }, distinct: ['productId'] })
            for (const a of affected) recascade.add(a.productId)
            applied++
            continue
          }
          if (!c.productId || !c.channel || !c.marketplace) continue

          if (c.field === 'buffer' && c.buffer != null) {
            if (c.lane === 'SHARED' && c.itemId) {
              await prisma.sharedListingMembership.updateMany({ where: { itemId: c.itemId, marketplace: c.marketplace, sku: c.sku }, data: { stockBuffer: c.buffer } })
            } else {
              await setStockBuffer({ productIds: [c.productId], channel: c.channel as never, markets: [c.marketplace], buffer: c.buffer, actor })
            }
            recascade.add(c.productId); applied++
            await audit([{ scopeType: c.lane === 'SHARED' ? 'MEMBERSHIP' : 'LISTING', scopeId: `${c.productId}:${c.channel}:${c.marketplace}`, scopeName: c.key, field: 'stockBuffer', after: { buffer: c.buffer } }], actor)
            continue
          }

          // mode / pinnedQty
          if (c.target === 'FOLLOW') {
            if (c.lane === 'SHARED' && c.itemId) {
              await prisma.sharedListingMembership.updateMany({ where: { itemId: c.itemId, marketplace: c.marketplace, sku: c.sku }, data: { followPool: true } })
            } else {
              await prisma.channelListing.updateMany({ where: { productId: c.productId, channel: c.channel, marketplace: c.marketplace, OR: [{ fulfillmentMethod: null }, { fulfillmentMethod: { not: 'FBA' } }] }, data: { syncPaused: false } })
              await setFollowMasterQuantity({ productIds: [c.productId], channel: c.channel as never, markets: [c.marketplace], follow: true, actor })
            }
          } else if (c.target === 'PINNED') {
            await setFollowMasterQuantity({ productIds: [c.productId], channel: c.channel as never, markets: [c.marketplace], follow: false, actor })
            if (c.pinnedQty != null) {
              await prisma.channelListing.updateMany({ where: { productId: c.productId, channel: c.channel, marketplace: c.marketplace, OR: [{ fulfillmentMethod: null }, { fulfillmentMethod: { not: 'FBA' } }] }, data: { quantity: c.pinnedQty, quantityOverride: c.pinnedQty, followMasterQuantity: false } })
            }
          } else if (c.target === 'PAUSED') {
            await prisma.channelListing.updateMany({ where: { productId: c.productId, channel: c.channel, marketplace: c.marketplace, OR: [{ fulfillmentMethod: null }, { fulfillmentMethod: { not: 'FBA' } }] }, data: { syncPaused: true } })
          } else if (c.target === 'EXCLUDED' && c.itemId) {
            await prisma.sharedListingMembership.updateMany({ where: { itemId: c.itemId, marketplace: c.marketplace, sku: c.sku }, data: { followPool: false } })
          }
          await audit([{ scopeType: c.lane === 'SHARED' ? 'MEMBERSHIP' : 'LISTING', scopeId: `${c.productId}:${c.channel}:${c.marketplace}`, scopeName: c.key, field: 'mode', before: { mode: c.from }, after: { mode: c.to, pinnedQty: c.pinnedQty } }], actor)
          recascade.add(c.productId); applied++
        } catch (rowErr) {
          const msg = rowErr instanceof Error ? rowErr.message : String(rowErr)
          failed.push({ key: c.key, error: msg })
          logger.warn('[sync-control] import apply row failed', { key: c.key, error: msg })
        }
      }

      if (recascade.size > 0) {
        void recascadeAfterSyncControlChange([...recascade], actor).then((r) =>
          logger.info('[sync-control] recascade after Excel import complete', { ...r, actor }))
      }
      return { applied, skipped, recascadeQueued: recascade.size, failed }
    } catch (err) {
      logger.error('[sync-control] import apply failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
