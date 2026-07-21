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
import { summarizeProductSync, marketMatches } from '../services/sync-control-product-view.js'
import { pickFaceImage, FACE_IMAGE_SELECT, FACE_IMAGE_ORDER_BY } from '../services/product-read-cache.service.js'

type Mode = 'FOLLOW' | 'PINNED' | 'PAUSED' | 'PAUSED_POLICY' | 'UNCOUNTED' | 'FBA' | 'EXCLUDED'

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
    case 'PAUSED': return r.via === 'POLICY' ? 'PAUSED_POLICY' : isShared ? 'EXCLUDED' : 'PAUSED'
    case 'PINNED': return 'PINNED'
    case 'UNCOUNTED': return 'UNCOUNTED'
    case 'FOLLOW': return 'FOLLOW'
  }
}

async function computeRows(): Promise<SyncControlRow[]> {
  const [listings, memberships, policies] = await Promise.all([
    prisma.channelListing.findMany({
      where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
      select: {
        productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true,
        followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true,
        product: { select: { sku: true, fulfillmentMethod: true } },
      },
    }),
    prisma.sharedListingMembership.findMany({
      where: { status: 'ACTIVE' },
      select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true },
    }),
    loadChannelPolicies(),
  ])
  const productIds = [
    ...new Set([
      ...listings.map((l) => l.productId),
      ...memberships.map((m) => m.productId).filter((p): p is string => Boolean(p)),
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

  for (const m of memberships) {
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
    const q = request.query as { channel?: string; market?: string; mode?: string; q?: string; page?: string; pageSize?: string }
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1)
    const pageSize = Math.min(200, Math.max(10, Number.parseInt(q.pageSize ?? '50', 10) || 50))
    let rows = await computeRows()
    if (q.channel) rows = rows.filter((r) => r.channel === q.channel!.toUpperCase())
    if (q.market) rows = rows.filter((r) => r.marketplace.toUpperCase().replace(/^EBAY_/, '') === q.market!.toUpperCase())
    if (q.mode) rows = rows.filter((r) => r.mode === q.mode!.toUpperCase())
    if (q.q) {
      const needle = q.q.toLowerCase()
      rows = rows.filter((r) => r.sku.toLowerCase().includes(needle))
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
      page?: string; pageSize?: string
    }
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1)
    const pageSize = Math.min(200, Math.max(10, Number.parseInt(q.pageSize ?? '50', 10) || 50))

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

    const byMaster = new Map<string, SyncControlRow[]>()
    for (const r of rows) {
      if (!r.productId) continue
      const mid = masterOf.get(r.productId) ?? r.productId
      const arr = byMaster.get(mid) ?? []
      arr.push(r)
      byMaster.set(mid, arr)
    }

    const all = masterIds.map((mid) => {
      const children = byMaster.get(mid) ?? []
      const variantPids = [...new Set(children.map((c) => c.productId).filter((p): p is string => Boolean(p)))]
      const poolTotal = variantPids.reduce((s, pid) => s + poolOf(pid), 0)
      const variantsInStock = variantPids.filter((pid) => poolOf(pid) > 0).length
      const m = metaById.get(mid)
      const rollup = summarizeProductSync(children)
      const imageUrl = pickFaceImage(m?.images ?? []) ?? pickFaceImage(m?.parent?.images ?? []) ?? null
      return {
        masterId: mid,
        sku: m?.sku ?? children[0]?.sku ?? '?',
        name: m?.name ?? '(unknown product)',
        family: m?.family ?? null,
        imageUrl,
        poolTotal,
        variantsInStock,
        variantCount: variantPids.length,
        rollup,
        children,
      }
    })

    const chan = q.channel?.toUpperCase()
    const mode = q.mode?.toUpperCase()
    const mkt = q.market
    const needle = q.q?.trim().toLowerCase()
    const driftOnly = q.drift === '1' || q.drift === 'true'

    const filtered = all.filter((p) => {
      if (chan && !p.children.some((c) => c.channel === chan)) return false
      if (mkt && !p.children.some((c) => marketMatches(c.marketplace, mkt))) return false
      if (mode && !p.children.some((c) => c.mode === mode)) return false
      if (needle && !(
        p.name.toLowerCase().includes(needle) ||
        p.sku.toLowerCase().includes(needle) ||
        p.children.some((c) => c.sku.toLowerCase().includes(needle))
      )) return false
      if (driftOnly && p.rollup.driftCount === 0) return false
      return true
    })
    filtered.sort((a, b) => a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku))

    return {
      total: filtered.length,
      page,
      pageSize,
      products: filtered.slice((page - 1) * pageSize, page * pageSize),
    }
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
      action: 'FOLLOW' | 'PIN' | 'PAUSE' | 'RESUME' | 'ZERO_PIN' | 'EXCLUDE' | 'INCLUDE' | 'BUFFER'
      buffer?: number
      listings?: ListingTarget[]
      memberships?: MembershipTarget[]
    }
    const actor = actorOf(request as never)
    const listings = body.listings ?? []
    const memberships = body.memberships ?? []
    if (!body.action) return reply.code(400).send({ error: 'action required' })
    if (listings.length === 0 && memberships.length === 0) return reply.code(400).send({ error: 'no targets' })
    if (listings.length + memberships.length > 500) return reply.code(400).send({ error: 'max 500 targets per call' })

    const result = { updated: 0, skippedFba: 0, unchanged: 0, recascadeQueued: 0 }
    const recascadeProducts = new Set<string>()

    // ── LISTING lane ──
    if (listings.length > 0) {
      const byChannel = new Map<string, ListingTarget[]>()
      for (const t of listings) {
        const arr = byChannel.get(t.channel) ?? []
        arr.push(t)
        byChannel.set(t.channel, arr)
      }

      for (const [channel, targets] of byChannel) {
        const productIds = [...new Set(targets.map((t) => t.productId))]
        const markets = [...new Set(targets.map((t) => t.marketplace))]

        if (body.action === 'FOLLOW' || body.action === 'PIN') {
          const r = await setFollowMasterQuantity({
            productIds, channel: channel as never, markets, follow: body.action === 'FOLLOW', actor,
          })
          result.updated += r.updated
          result.skippedFba += r.skippedFba
          result.unchanged += r.unchanged
          await audit(
            targets.map((t) => ({
              scopeType: 'LISTING', scopeId: `${t.productId}:${t.channel}:${t.marketplace}`,
              scopeName: `${t.channel}:${t.marketplace}`, field: 'followMasterQuantity',
              after: { follow: body.action === 'FOLLOW' },
            })), actor)
          continue
        }

        if (body.action === 'BUFFER') {
          const buffer = Math.max(0, Math.trunc(body.buffer ?? 0))
          const r = await setStockBuffer({ productIds, channel: channel as never, markets, buffer, actor })
          result.updated += (r as { updated?: number }).updated ?? 0
          result.skippedFba += (r as { skippedFba?: number }).skippedFba ?? 0
          await audit(
            targets.map((t) => ({
              scopeType: 'LISTING', scopeId: `${t.productId}:${t.channel}:${t.marketplace}`,
              scopeName: `${t.channel}:${t.marketplace}`, field: 'stockBuffer', after: { buffer },
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
          const queueRows: Array<Record<string, unknown>> = []
          for (const r of eligible) {
            await prisma.channelListing.update({
              where: { id: r.id },
              data: { quantity: 0, quantityOverride: 0, followMasterQuantity: false, syncPaused: false, lastSyncStatus: 'PENDING' },
            })
            result.updated++
            queueRows.push({
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
            })
          }
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
        return reply.code(400).send({ error: `action ${body.action} is not valid for shared memberships (use EXCLUDE / INCLUDE / BUFFER)` })
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
    const pageSize = Math.min(200, Math.max(10, Number.parseInt(q.pageSize ?? '50', 10) || 50))
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
}
