import { workspaceKey } from '@nexus/database/workspace-context'
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
 *   GET /api/stock/sync-control/overview   — summary, the markets the rows are on, locations, policies, audit
 *   GET /api/stock/sync-control/listings   — flat rows (listings + shared
 *       memberships), filters channel/market/mode/q, paginated
 *   POST /api/stock/sync-control/market-sources — Step 2 "Sells from": a market's warehouses, in sale order
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { setMembershipModeByCoordinate } from '../services/sync-control-overrides.service.js'
import { logger } from '../utils/logger.js'
import { validateServesTokens } from '../services/sync-control-core.js'
import { amazonManagedListingIds, setFollowMasterQuantity, setStockBuffer } from '../services/follow-master.service.js'
import { recascadeAfterSyncControlChange } from '../services/stock-movement.service.js'
import { summarizeProductSync, marketMatches, rowMarkets, omitChildrenInList, INLINE_PREVIEW_ROWS, summarizeFamilies, familyKeyOf, rowMatchesScope, type SyncScope } from '../services/sync-control-product-view.js'
import { projectBufferAndDetect, detectEuIntentConflict, AMAZON_EU_SHARED_MARKETS, EU_GUARD_REMEDY, type EuIntentRow } from '../services/amazon-eu-quantity-guard.js'
import { isFbaCoordinate } from '../services/amazon-market-offer.service.js'
import { SELLING_PAUSED_SENTENCE, sellingPaused } from '@nexus/shared/push-lock'
import { pickFaceImage, FACE_IMAGE_SELECT, FACE_IMAGE_ORDER_BY } from '../services/product-read-cache.service.js'
import { buildSyncControlWorkbook, parseSyncControlWorkbook, normalizeModeCell } from '../services/sync-control-excel.js'
// MCP full control 08 S7 — the writes (and the rows they act on) live in the service, shared with Claude's tools.
import {
  audit, buildLedgers, computeRows, resolveCanonicalMasters, runSyncControlAction, setLocationRoutes, setMarketSources, setSyncPolicy,
  type MarketSourcesBody, type Mode, type SyncControlActionBody, type SyncControlRow, type SyncPolicyBody,
} from '../services/stock/sync-control-actions.service.js'

/** SCD.8 — ONE parser for every multi-select filter value. The UI sends
 *  comma-separated selections; each endpoint must apply OR-within-a-dimension.
 *  (A partial rollout of this left /listings and /export on single-value
 *  equality, so any 2-value selection emptied the grid and the workbook.) */
function csvFilter(v?: string): string[] {
  return (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)
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
        // The Market filter's options: every market the rows are on (GLOBAL for Shopify and Etsy included).
        markets: rowMarkets(rows),
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
    const poolOf = (pid: string) => ledgers.get(pid)?.available ?? 0

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

  // The signed-in person (auth sets `authUser`). This read `request.user`, which nothing sets, so every
  // Sync Control history row said "sync-control" instead of who did it (found 2026-09-19).
  const actorOf = (request: { authUser?: { email?: string | null; id?: string } }): string =>
    request.authUser?.email ?? request.authUser?.id ?? 'sync-control'

  // MCP full control 08 S7 — the action runs in services/stock/sync-control-actions.service.ts (Claude's tools run it too).
  app.post('/stock/sync-control/actions', async (request, reply) => {
    const out = await runSyncControlAction(request.body as SyncControlActionBody, actorOf(request as never), request.log)
    return out.status === 200 ? out.body : reply.code(out.status).send(out.body)
  })

  app.post('/stock/sync-control/location-routes', async (request, reply) => {
    const out = await setLocationRoutes(request.body as { code?: string; syncRoutes?: string[] }, actorOf(request as never))
    return out.status === 200 ? out.body : reply.code(out.status).send(out.body)
  })

  // Step 2 "Sells from" — which warehouses one market sells from, in sale order, for every product (Amazon EU: one list
  // for the whole group). Body { channel, marketplace, codes[], dryRun? }; the service holds every read and write.
  app.post('/stock/sync-control/market-sources', async (request, reply) => {
    const out = await setMarketSources((request.body ?? {}) as MarketSourcesBody, actorOf(request as never))
    return out.status === 200 ? out.body : reply.code(out.status).send(out.body)
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
  // Upsert on (channel, marketplace, account); '*' = channel-wide, no account = every
  // account of the channel. A row that ends up all-default is deleted (an all-default
  // row and no row derive identically).
  // Resume (pushesPaused true→false) recascades every product with listings
  // in scope so marketplace truth reconverges without waiting for an order.
  app.post('/stock/sync-control/policies', async (request, reply) => {
    const out = await setSyncPolicy(request.body as SyncPolicyBody, actorOf(request as never))
    return out.status === 200 ? out.body : reply.code(out.status).send(out.body)
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
    const poolOf = (pid: string | null): number | '' => pid ? (ledgers.get(pid)?.available ?? 0) : ''
    const listingRows = rows.map((r) => {
      const lm = logicalMode(r.mode)
      const drift = r.mode !== 'FBA' && r.intendedQty != null && r.liveQty != null && r.intendedQty !== r.liveQty
      return {
        product: (r.productId ? nameById.get(r.productId) : '') ?? '',
        sku: r.sku, channel: r.channel, market: r.marketplace, itemId: r.itemId ?? '', lane: r.lane,
        // The page's own words: an Inactive listing (CLOSED) reads Inactive — the import skips it whatever it says — and a
        // held stock sync reads Sync held (the import reads "Sync held" back as a hold; "Paused" is still accepted).
        mode: lm === 'FBA' ? 'Amazon-managed' : lm === 'UNCOUNTED' ? 'Follow' : (lm as string) === 'CLOSED' ? 'Inactive' : lm === 'PAUSED' ? 'Sync held' : `${lm.charAt(0)}${lm.slice(1).toLowerCase()}`,
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

  // 08 S2 (F9) — the import writes a listing only when the fail-closed FBA test says Nexus owns its quantity:
  // `isFbaCoordinate` (the listing's method, Amazon's fulfilment channel code, the product's method) and, for Amazon,
  // the same evidence the follow / pin primitives use (FBA stock). Returns the writable listing ids per
  // (product, channel, market) of the given changes.
  async function writableListingIds(keys: Array<{ productId: string; channel: string; marketplace: string }>): Promise<Map<string, string[]>> {
    const byKey = new Map<string, string[]>()
    if (keys.length === 0) return byKey
    const keyOf = (k: { productId: string; channel: string; marketplace: string }) => `${k.productId}|${k.channel}|${k.marketplace}`
    const rows = await prisma.channelListing.findMany({
      where: { OR: keys.map((k) => ({ productId: k.productId, channel: k.channel as never, marketplace: k.marketplace })) },
      select: { id: true, productId: true, channel: true, marketplace: true, fulfillmentMethod: true, platformAttributes: true, offerClosedAt: true, product: { select: { fulfillmentMethod: true } } },
    })
    const managed = await amazonManagedListingIds(rows.map((r) => r.id))
    for (const k of keys) byKey.set(keyOf(k), [])
    for (const r of rows) {
      // Build shape v2 — a listing of another account or alias on the same market whose selling is paused is not written.
      if (managed.has(r.id) || isFbaCoordinate(r) || sellingPaused(r)) continue
      byKey.get(keyOf(r))?.push(r.id)
    }
    return byKey
  }

  type SheetChange = {
    lane: 'LISTING' | 'SHARED' | 'ROUTE'; key: string; field: string; from: string; to: string
    productId?: string | null; channel?: string; marketplace?: string; itemId?: string; sku?: string
    target?: 'FOLLOW' | 'PINNED' | 'PAUSED' | 'EXCLUDED'; buffer?: number; pinnedQty?: number | null
    locationCode?: string; feeds?: string[]
  }

  // 08 S2 (F9) — the Amazon EU gate of the Sync Control actions (SCT.4), for a sheet: Amazon keeps ONE merchant
  // quantity per SKU across the EU markets, so the sheet's changes to a product's Amazon EU listings are projected
  // onto all of its EU rows (per account and alias), and when the rows that express a quantity would then disagree
  // (on the number or on the buffer) every Amazon EU change of that product is skipped with the reason. Nothing
  // for that product is written; a sheet that sets every EU market the same way passes.
  async function euRefusedKeys(changes: SheetChange[]): Promise<Map<string, string>> {
    const refused = new Map<string, string>()
    const eu = changes.filter((c) => c.lane === 'LISTING' && c.channel === 'AMAZON' && c.productId && c.marketplace && AMAZON_EU_SHARED_MARKETS.has(c.marketplace.toUpperCase()))
    if (eu.length === 0) return refused
    const productIds = [...new Set(eu.map((c) => c.productId!))]
    const rows = await prisma.channelListing.findMany({
      where: { productId: { in: productIds }, channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
      select: {
        id: true, productId: true, channelConnectionId: true, aliasKey: true, marketplace: true, followMasterQuantity: true, quantityOverride: true,
        quantity: true, syncPaused: true, fulfillmentMethod: true, platformAttributes: true, offerClosedAt: true, stockBuffer: true,
        product: { select: { fulfillmentMethod: true } },
      },
    })
    const managed = await amazonManagedListingIds(rows.map((r) => r.id))
    for (const productId of productIds) {
      const mine = eu.filter((c) => c.productId === productId)
      const groups = new Map<string, typeof rows>()
      for (const r of rows.filter((x) => x.productId === productId && AMAZON_EU_SHARED_MARKETS.has(x.marketplace.toUpperCase()))) {
        const k = JSON.stringify([r.channelConnectionId, r.aliasKey])
        groups.set(k, [...(groups.get(k) ?? []), r])
      }
      let detail = ''
      for (const group of groups.values()) {
        const projected = group.map((r) => {
          const row: EuIntentRow & { stockBuffer: number | null } = {
            marketplace: r.marketplace, followMasterQuantity: r.followMasterQuantity, quantityOverride: r.quantityOverride,
            quantity: r.quantity, syncPaused: r.syncPaused, isFba: managed.has(r.id) || isFbaCoordinate(r),
            offerClosed: !!r.offerClosedAt, stockBuffer: r.stockBuffer,
          }
          for (const c of mine.filter((x) => x.marketplace!.toUpperCase() === r.marketplace.toUpperCase())) {
            if (c.field === 'buffer' && c.buffer != null) row.stockBuffer = c.buffer
            else if (c.target === 'FOLLOW') Object.assign(row, { followMasterQuantity: true, quantityOverride: null, syncPaused: false })
            else if (c.target === 'PAUSED') row.syncPaused = true
            else if (c.target === 'PINNED') {
              Object.assign(row, { followMasterQuantity: false, quantityOverride: c.pinnedQty ?? row.quantityOverride ?? row.quantity ?? 0 })
            }
          }
          return row
        })
        const quantity = detectEuIntentConflict(projected)
        const buffers = projectBufferAndDetect(projected, new Set(), 0)
        if (quantity.conflict || buffers.conflict) { detail = quantity.conflict ? quantity.detail : buffers.detail; break }
      }
      if (!detail) continue
      for (const c of mine) refused.set(c.key, `Amazon EU: ${detail}. Set every Amazon EU market of this SKU the same way in the sheet, or close the offer in one market in Seller Central.`)
    }
    return refused
  }

  // Shared: parse a workbook and diff it against current state → changes.
  async function computeSheetChanges(buf: Buffer) {
    const { listings: edits, routes: routeEdits } = await parseSyncControlWorkbook(buf)
    const rows = await computeRows()
    const byKey = new Map(rows.map((r) => [rowKeyOf(r), r]))
    let changes: SheetChange[] = []
    const skipped: Array<{ key: string; reason: string }> = []

    for (const e of edits) {
      const key = `${e.channel === 'EBAY' && e.itemId ? 'SHARED' : 'LISTING'}|${e.sku}|${e.channel}|${e.market}|${e.itemId}`
      // Prefer exact lane match; fall back to either lane by (sku,channel,market).
      const cur = byKey.get(key) ?? rows.find((r) => r.sku === e.sku && r.channel === e.channel && r.marketplace === e.market && (e.itemId ? r.itemId === e.itemId : true))
      if (!cur) { skipped.push({ key: `${e.sku}@${e.channel}:${e.market}`, reason: 'no matching listing' }); continue }
      // SCT.6 / build shape v2 — a listing whose selling is paused (Inactive: the product sheet's Pause offer, or
      // Amazon's market close) is never changed via Excel and gets no quantity from it: resuming is a deliberate
      // action in the product sheet's Status column, not an import side effect.
      if (cur.mode === 'CLOSED') { skipped.push({ key: `${e.sku}@${e.channel}:${e.market}`, reason: SELLING_PAUSED_SENTENCE }); continue }
      if (cur.mode === 'FBA' || e.locked) { skipped.push({ key: `${e.sku}@${e.channel}:${e.market}`, reason: 'FBA (Amazon-managed)' }); continue }

      const want = normalizeModeCell(e.mode)
      if (want === undefined) { skipped.push({ key: `${e.sku}@${e.channel}:${e.market}`, reason: `unrecognized mode "${e.mode}"` }); continue }
      const curLogical = logicalMode(cur.mode) === 'UNCOUNTED' ? 'FOLLOW' : logicalMode(cur.mode)
      const label = `${e.sku}@${e.channel}:${e.market}`

      if (want && want !== curLogical) {
        if (cur.lane === 'SHARED' && want === 'PAUSED') {
          skipped.push({ key: label, reason: 'a shared variant has no stock-sync hold; use Excluded' }); continue
        }
        // Shared stock step 3 — a shared variant can hold a fixed number; the sheet must say which.
        if (cur.lane === 'SHARED' && want === 'PINNED' && e.pinnedQty == null) {
          skipped.push({ key: label, reason: 'a Fixed number for a shared variant needs the number in the pinned column' }); continue
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

    // 08 S2 (F9) — a listing change only where the fail-closed FBA test leaves a listing to write, and never one that
    // splits the shared Amazon EU quantity. One reason per sheet row, in the preview and the apply alike.
    const listingKeys = changes.filter((c) => c.lane === 'LISTING' && c.productId && c.channel && c.marketplace)
      .map((c) => ({ productId: c.productId!, channel: c.channel!, marketplace: c.marketplace! }))
    const writable = await writableListingIds(listingKeys)
    const euRefused = await euRefusedKeys(changes.filter((c) => c.lane !== 'LISTING' || (writable.get(`${c.productId}|${c.channel}|${c.marketplace}`)?.length ?? 0) > 0))
    const reasons = new Map<string, string>()
    changes = changes.filter((c) => {
      if (c.lane !== 'LISTING') return true
      const reason = (writable.get(`${c.productId}|${c.channel}|${c.marketplace}`)?.length ?? 0) === 0 ? 'FBA (Amazon-managed)' : euRefused.get(c.key)
      if (!reason) return true
      reasons.set(c.key, reason)
      return false
    })
    for (const [key, reason] of reasons) skipped.push({ key, reason })

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
      // 08 S2 (F9) — re-read at write time: only the listings the fail-closed FBA test leaves to Nexus.
      const writableIds = async (c: { productId?: string | null; channel?: string; marketplace?: string }) =>
        (await writableListingIds([{ productId: c.productId!, channel: c.channel!, marketplace: c.marketplace! }])).get(`${c.productId}|${c.channel}|${c.marketplace}`) ?? []
      // Build shape v2 — the follow / pin / buffer primitives write exactly these listings (account and alias included):
      // never one whose selling is paused, even on another account of the same market.
      const writableCoordinates = async (c: { productId?: string | null; channel?: string; marketplace?: string }) => {
        const ids = await writableIds(c)
        return ids.length ? prisma.channelListing.findMany({ where: { id: { in: ids } }, select: { productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true } }) : []
      }

      for (const c of changes) {
        try {
          if (c.lane === 'ROUTE' && c.locationCode && c.feeds) {
            const loc = await prisma.stockLocation.findUnique({ where: { workspace_code: workspaceKey({ code: c.locationCode }) }, select: { id: true, syncRoutes: true } })
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
              await setStockBuffer({ productIds: [c.productId], channel: c.channel as never, markets: [c.marketplace], buffer: c.buffer, actor, coordinates: await writableCoordinates(c) })
            }
            recascade.add(c.productId); applied++
            await audit([{ scopeType: c.lane === 'SHARED' ? 'MEMBERSHIP' : 'LISTING', scopeId: `${c.productId}:${c.channel}:${c.marketplace}`, scopeName: c.key, field: 'stockBuffer', after: { buffer: c.buffer } }], actor)
            continue
          }

          // mode / pinnedQty
          if (c.target === 'FOLLOW') {
            if (c.lane === 'SHARED' && c.itemId) {
              await setMembershipModeByCoordinate({ itemId: c.itemId, marketplace: c.marketplace, sku: c.sku }, null)
            } else {
              await prisma.channelListing.updateMany({ where: { id: { in: await writableIds(c) } }, data: { syncPaused: false } })
              await setFollowMasterQuantity({ productIds: [c.productId], channel: c.channel as never, markets: [c.marketplace], follow: true, actor, coordinates: await writableCoordinates(c) })
            }
          } else if (c.target === 'PINNED' && c.lane === 'SHARED' && c.itemId) {
            // Shared stock step 3 — a fixed number for a shared variant (the preview required the number).
            await setMembershipModeByCoordinate({ itemId: c.itemId, marketplace: c.marketplace, sku: c.sku }, c.pinnedQty ?? 0)
          } else if (c.target === 'PINNED') {
            await setFollowMasterQuantity({ productIds: [c.productId], channel: c.channel as never, markets: [c.marketplace], follow: false, actor, coordinates: await writableCoordinates(c) })
            if (c.pinnedQty != null) {
              await prisma.channelListing.updateMany({ where: { id: { in: await writableIds(c) } }, data: { quantity: c.pinnedQty, quantityOverride: c.pinnedQty, followMasterQuantity: false } })
            }
          } else if (c.target === 'PAUSED') {
            await prisma.channelListing.updateMany({ where: { id: { in: await writableIds(c) } }, data: { syncPaused: true } })
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
