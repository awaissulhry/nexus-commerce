/**
 * MX.1 — the Matrix READ: `GET /api/products/:id/studio/matrix?accountId=&locale=` → `MatrixRead`
 * (`@nexus/shared/matrix-contract`, the wire authority the page parses at ONE boundary).
 *
 * Composes, never re-derives (design §3.1):
 *   - rows: the SAME helpers VP.2's family read uses (`resolveFamilyRoot`, `FAMILY_MEMBER_SELECT`,
 *     `buildFamilyAxes`, `axisValuesOf`, `completeAxisValueOrder`, `readExcludedListingIds`) — parent first, children
 *     in axis-value order — WITHOUT its per-channel projection reads (770 of its 840 ms on GALE, measured), which
 *     the Matrix does not need. The page merges on row id.
 *   - coordinates: every active `Marketplace` × the family's channel account × `ProductListingAlias`; the Amazon EU
 *     markets folded onto ONE `region-inventory` coordinate `AMAZON:EU` (the guard's `AMAZON_EU_SHARED_MARKETS`);
 *     unconnected/unlisted coordinates KEPT with `cells: []` so the absence is visible (`Not listed`).
 *   - `sync`: `resolveIntendedQuantity` with the inputs the Sync Control page builds (WAREHOUSE ledger routed by
 *     `syncRoutes`, `policyFor`, `offerClosedAt`, `isFba` = `isFbaListing`'s fail-closed verdict) — verbatim.
 *   - `queue`: the newest non-cancelled `OutboundSyncQueue` row per (listing, QUANTITY_UPDATE | PRICE_UPDATE), folded.
 *   - `price`: `ChannelListing.price` (the number the push reads); `sale`: `salePrice` + the two window columns.
 *
 * One query per table, joined in memory (two waves: the family's tables, then the tables keyed by listing id).
 * Amazon coordinates never touch the schema cache, so no live SP-API product-type call can be triggered here.
 */
import prisma from '../../db.js'
import type { Prisma } from '@prisma/client'
import {
  INVENTORY_CELL_KINDS,
  MATRIX_COPY,
  type CoordinateKey,
  type FulfilmentCell,
  type FulfilmentMethod,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixRead,
  type MatrixRowRead,
  type QueueCell,
  type SyncCell,
} from '@nexus/shared/matrix-contract'
import { locationServes, resolveIntendedQuantity, type RoutedLedgerRow } from '../sync-control-core.js'
import { loadChannelPolicies, policyFor } from '../sync-control-policy.service.js'
import { isFbaListing } from '../outbound-sync.service.js'
import { computeAvailableToPublish } from '../available-to-publish.service.js'
import { detectEuIntentConflict } from '../amazon-eu-quantity-guard.js'
import { MARKETPLACE_ID_TO_CODE } from '../../utils/marketplace-code.js'
import { axisSynonymKey } from '../ebay-theme-axes.js'
import { familyAccountId } from './family-account.js'
import { completeAxisValueOrder } from './shared-variation-values.js'
import { decimalToNumber } from './sheet-rows.service.js'
import { readSaleWindows } from './sale-window.js'
import { axisValuesOf, buildFamilyAxes, FAMILY_MEMBER_SELECT, readExcludedListingIds, resolveFamilyRoot, type FamilyAxis } from './family-projection.service.js'
import {
  businessAbsence, channelLabel, channelRank, channelShape, circled, compareMarkets, deriveFulfilment, flattenAudience, foldQueue, isAmazonEuMarket,
  listingStateOf, priceCellOf, reportedFulfilment, syncCellOf, withoutInventory, writableFor, type QueueRowFacts,
} from './matrix-cells.js'

export interface MatrixReadInput {
  productId: string
  accountId?: string | null
  locale?: string | null
  /** `products.price.edit` for the caller — the price cells are held with the reason without it (Add 4(d)). */
  canEditPrice: boolean
}

export type MatrixReadWithMeta = MatrixRead & { meta: { tookMs: number; phases: Record<string, number>; queries: number } }

const MEMBER_SELECT = { ...FAMILY_MEMBER_SELECT, fulfillmentMethod: true } as const

/** The columns the Matrix reads off a listing — one select, reused by the write door's re-read. */
export const MATRIX_LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, region: true, aliasId: true, aliasKey: true, channelConnectionId: true,
  listingStatus: true, isPublished: true, externalListingId: true, version: true,
  price: true, salePrice: true, priceOverride: true, followMasterPrice: true,
  followMasterQuantity: true, quantity: true, quantityOverride: true, stockBuffer: true, syncPaused: true, sourceLocationCodes: true,
  offerClosedAt: true, fulfillmentMethod: true, platformAttributes: true, lastSyncStatus: true, syncStatus: true,
} as const

export type MatrixListing = Prisma.ChannelListingGetPayload<{ select: typeof MATRIX_LISTING_SELECT }>
type Member = Prisma.ProductGetPayload<{ select: typeof MEMBER_SELECT }>

const upper = (s: string | null | undefined) => String(s ?? '').toUpperCase()

/**
 * MX.F (design §3.11, D-MX5): the B2B audience enum of the NEWEST active cached Amazon schema per market for ONE product
 * type — a JSONPath projection inside Postgres, so the read never loads the 150 KB schema bodies (15 ms measured on the
 * local copy for 7 markets). A SELECT on the cache table only: no schema service is called, so no live SP-API
 * product-type fetch can be triggered from here (the header's rule holds).
 */
const AUDIENCE_SQL = `SELECT DISTINCT ON ("marketplace") "marketplace", jsonb_path_query_array("schemaDefinition", '$.properties.purchasable_offer.**.audience.**.enum') AS "audience"
  FROM "CategorySchema" WHERE "channel" = 'AMAZON' AND "productType" = $1 AND "isActive" ORDER BY "marketplace", "fetchedAt" DESC`
const coordKey = (channel: string, market: string, aliasId?: string | null): CoordinateKey => `${upper(channel)}:${upper(market)}${aliasId ? `#${aliasId}` : ''}`

/** VP.2's stored axis order (`platformAttributes._axisValueOrder` on a parent listing), the same lookup `storedAxisOrder` makes. */
function storedAxisOrder(axis: FamilyAxis, parentListings: readonly MatrixListing[]): string[] | null {
  const dim = axisSynonymKey(axis.key)
  const sorted = [...parentListings].sort((a, b) =>
    `${a.channel}:${a.marketplace}:${a.channelConnectionId}`.localeCompare(`${b.channel}:${b.marketplace}:${b.channelConnectionId}`))
  for (const listing of sorted) {
    const bag = (listing.platformAttributes as Record<string, unknown> | null)?._axisValueOrder as Record<string, unknown> | undefined
    const codes = bag?.[dim] ?? bag?.[axis.key]
    if (Array.isArray(codes) && codes.length) return codes.filter((v): v is string => typeof v === 'string')
  }
  return null
}

export async function getMatrixRead(input: MatrixReadInput): Promise<MatrixReadWithMeta> {
  const t0 = Date.now()
  const phases: Record<string, number> = {}
  let queries = 0
  const mark = (name: string, from: number) => { phases[name] = Date.now() - from }

  // ── 1. the family ──────────────────────────────────────────────────────────────────────────
  const tFamily = Date.now()
  const root = await resolveFamilyRoot(input.productId); queries += 2
  const [children, parentRow] = await Promise.all([
    prisma.product.findMany({ where: { parentId: root.id, deletedAt: null }, select: MEMBER_SELECT, orderBy: { sku: 'asc' } }),
    prisma.product.findUniqueOrThrow({ where: { id: root.id }, select: MEMBER_SELECT }),
  ]); queries += 2
  const members: Member[] = [parentRow, ...children]
  const memberIds = members.map((m) => m.id)
  const skus = members.map((m) => m.sku)
  mark('family', tFamily)

  // ── 2. wave 1 — one query per table keyed by the family ────────────────────────────────────
  const tWave1 = Date.now()
  const [listings, marketplaces, connections, aliases, stockRows, fbaDetail, policies, formulas, snapshots] = await Promise.all([
    prisma.channelListing.findMany({ where: { productId: { in: memberIds } }, select: MATRIX_LISTING_SELECT }),
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, currency: true, region: true } }),
    prisma.channelConnection.findMany({ where: { isActive: true }, select: { id: true, channelType: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.productListingAlias.findMany({ where: { productId: root.id, status: 'ACTIVE' }, select: { id: true, channel: true, marketplace: true, channelConnectionId: true, label: true, position: true }, orderBy: { position: 'asc' } }),
    prisma.stockLevel.findMany({ where: { productId: { in: memberIds } }, select: { productId: true, available: true, quantity: true, location: { select: { code: true, type: true, syncRoutes: true } } } }),
    prisma.fbaInventoryDetail.findMany({ where: { sku: { in: skus }, condition: 'SELLABLE' }, select: { sku: true, marketplaceId: true, quantity: true } }),
    loadChannelPolicies(),
    prisma.cellFormula.findMany({ where: { productId: { in: memberIds }, scope: 'channel', fieldKey: 'price' }, select: { productId: true, channel: true, marketplace: true, aliasKey: true, expr: true } }),
    prisma.pricingSnapshot.findMany({ where: { sku: { in: skus }, fulfillmentMethod: null }, select: { sku: true, channel: true, marketplace: true, isClamped: true, clampedFrom: true, computedPrice: true } }),
  ]); queries += 9
  const audienceRows = parentRow.productType
    ? await prisma.$queryRawUnsafe<Array<{ marketplace: string | null; audience: unknown }>>(AUDIENCE_SQL, parentRow.productType)
    : []
  if (parentRow.productType) queries += 1
  const audienceByMarket = new Map(audienceRows.map((r) => [upper(r.marketplace), flattenAudience(r.audience)]))
  mark('wave1', tWave1)

  // ── 3. wave 2 — the tables keyed by listing id ─────────────────────────────────────────────
  const tWave2 = Date.now()
  const listingIds = listings.map((l) => l.id)
  const [openSuppressions, queueRows, fbaOffers, saleWindows, excluded] = await Promise.all([
    prisma.amazonSuppression.findMany({ where: { listingId: { in: listingIds }, resolvedAt: null }, select: { listingId: true } }),
    prisma.outboundSyncQueue.findMany({
      where: { channelListingId: { in: listingIds }, syncType: { in: ['QUANTITY_UPDATE', 'PRICE_UPDATE'] }, syncStatus: { not: 'CANCELLED' } },
      orderBy: [{ createdAt: 'desc' }],
      distinct: ['channelListingId', 'syncType'],
      select: { channelListingId: true, syncType: true, syncStatus: true, isDead: true, errorMessage: true, syncedAt: true, updatedAt: true, createdAt: true },
    }),
    prisma.offer.findMany({ where: { channelListingId: { in: listingIds }, fulfillmentMethod: 'FBA', isActive: true }, select: { channelListingId: true } }),
    readSaleWindows(prisma as never, listingIds),
    readExcludedListingIds(listingIds),
  ]); queries += 5
  mark('wave2', tWave2)

  // ── 4. indexes ─────────────────────────────────────────────────────────────────────────────
  const tShape = Date.now()
  const memberById = new Map(members.map((m) => [m.id, m]))
  const ledgers = new Map<string, RoutedLedgerRow[]>()
  const poolLocations = new Map<string, Array<{ code: string; available: number }>>()
  const fbaBucket = new Map<string, number>()
  for (const s of stockRows) {
    if (s.location?.type === 'WAREHOUSE') {
      ledgers.set(s.productId, [...(ledgers.get(s.productId) ?? []), { locationCode: s.location.code, available: s.available, syncRoutes: s.location.syncRoutes ?? [] }])
      poolLocations.set(s.productId, [...(poolLocations.get(s.productId) ?? []), { code: s.location.code, available: s.available }])
    } else if (s.location?.type === 'AMAZON_FBA') {
      fbaBucket.set(s.productId, (fbaBucket.get(s.productId) ?? 0) + s.quantity)
    }
  }
  const fbaSellable = new Map<string, number>()
  for (const d of fbaDetail) {
    const code = MARKETPLACE_ID_TO_CODE[d.marketplaceId] ?? d.marketplaceId
    const k = `${d.sku}|${code}`
    fbaSellable.set(k, (fbaSellable.get(k) ?? 0) + d.quantity)
  }
  const suppressed = new Set(openSuppressions.map((s) => s.listingId))
  const fbaOfferOn = new Set(fbaOffers.map((o) => o.channelListingId))
  const queueByListing = new Map<string, QueueRowFacts[]>()
  for (const q of queueRows) {
    if (!q.channelListingId) continue
    const at = (q.syncedAt ?? q.updatedAt ?? q.createdAt)?.toISOString() ?? null
    queueByListing.set(q.channelListingId, [...(queueByListing.get(q.channelListingId) ?? []), { syncType: q.syncType, syncStatus: q.syncStatus, isDead: q.isDead, errorMessage: q.errorMessage, at }])
  }
  const formulaByCell = new Map(formulas.map((f) => [`${f.productId}|${upper(f.channel)}|${upper(f.marketplace)}|${f.aliasKey ?? ''}`, f.expr]))
  const snapshotByCell = new Map(snapshots.map((s) => [`${s.sku}|${upper(s.channel)}|${upper(s.marketplace)}`, s]))
  const connectionsByChannel = new Map<string, Array<{ id: string; isPrimary: boolean }>>()
  for (const c of connections) connectionsByChannel.set(upper(c.channelType), [...(connectionsByChannel.get(upper(c.channelType)) ?? []), { id: c.id, isPrimary: c.isPrimary }])
  const listingsByCoord = new Map<string, MatrixListing[]>()
  for (const l of listings) { const k = coordKey(l.channel, l.marketplace); listingsByCoord.set(k, [...(listingsByCoord.get(k) ?? []), l]) }

  // ── 5. rows: parent first, children in axis-value order (VP.2's rule, its helpers) ─────────
  const declared = (root.variationAxes ?? []) as string[]
  const axes = buildFamilyAxes(declared, members)
  const childValues = new Map(children.map((c) => [c.id, axisValuesOf(c, undefined, axes).values]))
  const parentListings = listings.filter((l) => l.productId === root.id && !l.aliasKey)
  const ranks = axes.map((axis) => {
    const counted = new Set<string>()
    for (const c of children) { const v = childValues.get(c.id)?.[axis.key]; if (v) counted.add(v) }
    const codes = completeAxisValueOrder(axis.key, storedAxisOrder(axis, parentListings) ?? [], [...counted])
    return new Map(codes.map((code, i) => [code, i]))
  })
  const rankOf = (child: Member, i: number): number => ranks[i]?.get(childValues.get(child.id)?.[axes[i]!.key] ?? '') ?? Number.MAX_SAFE_INTEGER
  const orderedChildren = [...children].sort((a, b) => {
    for (let i = 0; i < axes.length; i++) { const d = rankOf(a, i) - rankOf(b, i); if (d !== 0) return d }
    return a.sku.localeCompare(b.sku)
  })
  const needsValue = (member: Member): boolean =>
    member.id !== root.id && axes.length > 0 && axes.some((axis) => !childValues.get(member.id)?.[axis.key])

  // ── 6. coordinates ─────────────────────────────────────────────────────────────────────────
  interface Coord extends MatrixCoordinate { rowsOf: (memberId: string) => MatrixListing[]; euMarkets: string[] | null }
  const accountFor = (channel: string, attributed: ReadonlyArray<string | null>): string | null => {
    const accounts = connectionsByChannel.get(channel) ?? []
    return familyAccountId(accounts.map((a) => a.id), attributed)
      ?? (input.accountId && accounts.some((a) => a.id === input.accountId) ? input.accountId : null)
      ?? accounts.find((a) => a.isPrimary)?.id ?? accounts[0]?.id ?? null
  }
  const listed: Coord[] = []
  const unlisted: Coord[] = []
  const euCandidates: Array<{ market: string; currency: string }> = []
  const amazonEuRows = new Map<string, MatrixListing[]>() // memberId → its EU rows, in market order

  for (const m of marketplaces) {
    const ch = upper(m.channel), mk = upper(m.code)
    const key = coordKey(ch, mk)
    const rowsHere = listingsByCoord.get(key) ?? []
    const connected = (connectionsByChannel.get(ch) ?? []).length > 0
    const accountId = accountFor(ch, rowsHere.map((l) => l.channelConnectionId))
    const primaryRows = rowsHere.filter((l) => l.aliasKey === '' && (accountId == null || l.channelConnectionId === accountId || l.channelConnectionId == null))
    const shape = channelShape(ch)
    const isListed = connected && primaryRows.length > 0
    const inEu = isListed && isAmazonEuMarket(ch, mk)
    if (inEu) {
      euCandidates.push({ market: mk, currency: m.currency })
      for (const l of primaryRows) amazonEuRows.set(l.productId, [...(amazonEuRows.get(l.productId) ?? []), l])
    }
    const global = mk === 'GLOBAL'
    const byMember = new Map<string, MatrixListing[]>()
    for (const l of primaryRows) byMember.set(l.productId, [...(byMember.get(l.productId) ?? []), l])
    const coord: Coord = {
      key, kind: global ? 'global' : 'market', channel: ch, market: mk,
      label: global ? channelLabel(ch) : `${channelLabel(ch)} · ${mk}`,
      region: ch === 'AMAZON' ? (isAmazonEuMarket(ch, mk) ? 'EU' : mk === 'UK' ? 'UK' : m.region || null) : null,
      alias: null, accountId, currency: m.currency, connected, listed: null, draft: null,
      cells: isListed ? (inEu ? withoutInventory(shape.cells) : shape.cells) : [],
      /* A LISTED Amazon market also declares the reserved business cells absent, with the sentence derived from ITS cached schema. */
      absent: ch === 'AMAZON' && isListed && !global
        ? [...shape.absent, ...businessAbsence({ productType: parentRow.productType ?? null, market: mk, audience: audienceByMarket.get(mk) ?? null })]
        : shape.absent,
      sharedInventoryWith: null, inventoryOn: inEu ? 'AMAZON:EU' : null,
      vocabulary: { fulfilment: shape.fulfilment },
      rowsOf: (id) => byMember.get(id) ?? [], euMarkets: null,
    }
    ;(isListed ? listed : unlisted).push(coord)

    // Aliases on this coordinate — each is its own group (design §3.10); quantity is per alias, never summed.
    for (const alias of aliases.filter((a) => upper(a.channel) === ch && upper(a.marketplace) === mk)) {
      const aliasRows = rowsHere.filter((l) => l.aliasKey === alias.id)
      const byMemberA = new Map<string, MatrixListing[]>()
      for (const l of aliasRows) byMemberA.set(l.productId, [...(byMemberA.get(l.productId) ?? []), l])
      listed.push({
        ...coord, key: coordKey(ch, mk, alias.id), label: `${coord.label} ${circled(alias.position + 1)}`,
        alias: { id: alias.id, label: alias.label, position: alias.position }, accountId: alias.channelConnectionId ?? accountId,
        cells: connected && aliasRows.length > 0 ? shape.cells : [], inventoryOn: null,
        rowsOf: (id) => byMemberA.get(id) ?? [], euMarkets: null,
      })
    }
  }
  const euMarkets = euCandidates.map((c) => c.market).sort(compareMarkets)
  for (const rows of amazonEuRows.values()) rows.sort((a, b) => compareMarkets(a.marketplace, b.marketplace))
  const region: Coord | null = euMarkets.length > 0 ? {
    key: 'AMAZON:EU', kind: 'region-inventory', channel: 'AMAZON', market: 'EU',
    label: `Amazon EU · Inventory · ${euMarkets.join(' ')}`, region: 'EU', alias: null,
    accountId: listed.find((c) => c.channel === 'AMAZON' && c.inventoryOn === 'AMAZON:EU')?.accountId ?? null,
    currency: euCandidates[0]?.currency ?? 'EUR', connected: true, listed: null, draft: null,
    cells: [...INVENTORY_CELL_KINDS], absent: [], sharedInventoryWith: euMarkets, inventoryOn: null,
    vocabulary: { fulfilment: ['FBA', 'FBM'] },
    rowsOf: (id) => amazonEuRows.get(id) ?? [], euMarkets,
  } : null
  const order = (a: Coord, b: Coord) => channelRank(a.channel) - channelRank(b.channel) || compareMarkets(a.market, b.market) || (a.alias?.position ?? 0) - (b.alias?.position ?? 0)
  listed.sort(order); unlisted.sort(order)
  const coordinates: Coord[] = region ? [region, ...listed] : listed
  coordinates.push(...unlisted)

  // ── 7. cells ───────────────────────────────────────────────────────────────────────────────
  const resolveListing = (l: MatrixListing, member: Member) => {
    const ch = upper(l.channel), mk = upper(l.marketplace)
    const isFba = ch === 'AMAZON' && isFbaListing(
      { fulfillmentMethod: l.fulfillmentMethod, platformAttributes: l.platformAttributes },
      { fulfillmentMethod: member.fulfillmentMethod },
      { fbaStockQty: fbaBucket.get(member.id) ?? 0, hasActiveFbaOffer: fbaOfferOn.has(l.id) },
    )
    const ledger = ledgers.get(member.id) ?? []
    const res = resolveIntendedQuantity({
      channel: ch, marketplace: mk, isFba, offerClosed: !!l.offerClosedAt,
      followMasterQuantity: l.followMasterQuantity !== false, syncPaused: l.syncPaused,
      pinnedQuantity: l.quantity, stockBuffer: l.stockBuffer ?? 0, sourceLocationCodes: l.sourceLocationCodes ?? [],
      channelPolicy: policyFor(policies, ch, mk), ledger,
    })
    const routed = ledger.filter((r) => locationServes(r.syncRoutes, ch, mk)).map((r) => ({ locationCode: r.locationCode, available: r.available }))
    const warehouseAvailable = routed.reduce((s, r) => s + r.available, 0)
    const publishable = isFba ? null : computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable, fbaSellable: 0, stockBuffer: l.stockBuffer ?? 0 }).available
    const fbaAtAmazon = ch === 'AMAZON' ? (fbaSellable.get(`${member.sku}|${mk}`) ?? fbaBucket.get(member.id) ?? null) : null
    const sync = syncCellOf(res, { followMasterQuantity: l.followMasterQuantity, held: l.quantity, buffer: l.stockBuffer ?? 0, routed, fbaAtAmazon, publishable })
    const pa = (l.platformAttributes ?? {}) as Record<string, unknown>
    const typed = l.fulfillmentMethod as FulfilmentMethod | null
    const method: FulfilmentMethod = ch === 'EBAY' ? (typed === 'FBA' ? 'MCF' : 'FBM') : typed ?? deriveFulfilment(ch, pa.fulfillmentChannel, member.fulfillmentMethod)
    const fulfilment: FulfilmentCell = {
      method, source: typed ? 'set' : 'derived',
      guard: ch === 'AMAZON' ? (isFba ? 'FBA' : 'FBM') : 'FBM',
      reported: ch === 'AMAZON' ? reportedFulfilment(pa) : null,
    }
    return { isFba, sync, fulfilment }
  }

  const cellsFor = (member: Member, coord: Coord): MatrixCells | null => {
    const rows = coord.rowsOf(member.id)
    const primary = rows[0]
    if (!primary) return null
    const isParent = member.id === root.id
    const serves = (k: keyof typeof INVENTORY_CELL_KINDS extends never ? never : string) => coord.cells.includes(k as never)
    const inventory = coord.cells.some((k) => INVENTORY_CELL_KINDS.includes(k))
    let sync: SyncCell | null = null
    let fulfilment: FulfilmentCell | null = null
    let queue: QueueCell | null = null
    const extra: MatrixCells['writeBlockedReason'] = {}
    /* The PARENT has no listing of its own (MX.P's live reading): no inventory facts, no price — only the listing word
       with its `n listing(s)` detail, and every cell held with the reason. */
    if (inventory && !isParent) {
      const r = resolveListing(primary, member)
      sync = serves('syncMode') || serves('syncQty') ? r.sync : null
      fulfilment = serves('fulfilment') ? r.fulfilment : null
      if (serves('syncState')) {
        /* The region folds every EU row's queue (one quantity per SKU); a market folds its own listing's. */
        queue = foldQueue(rows.flatMap((l) => queueByListing.get(l.id) ?? []), r.sync)
      }
      if (coord.euMarkets && rows.length > 1) {
        /* The push belt's own inputs (the STORED method), so the sentence matches what dispatch will refuse. */
        const verdict = detectEuIntentConflict(rows.map((l) => ({ marketplace: l.marketplace, followMasterQuantity: l.followMasterQuantity, quantityOverride: l.quantityOverride, quantity: l.quantity, syncPaused: l.syncPaused, isFba: l.fulfillmentMethod === 'FBA', offerClosed: !!l.offerClosedAt })))
        if (verdict.conflict) extra.syncState = verdict.detail
      }
    }
    const listing = serves('listing') ? {
      ...listingStateOf({ listingStatus: primary.listingStatus, isPublished: primary.isPublished, externalListingId: primary.externalListingId, offerClosedAt: primary.offerClosedAt, suppressed: suppressed.has(primary.id), excluded: excluded.has(primary.id), needsValue: needsValue(member) }),
      ...(isParent ? { detail: `${rows.length} listing${rows.length === 1 ? '' : 's'}` } : {}),
    } : null
    const snapshot = snapshotByCell.get(`${member.sku}|${coord.channel}|${coord.market}`)
    const price = serves('price') ? priceCellOf({
      price: isParent ? null : decimalToNumber(primary.price), priceOverride: decimalToNumber(primary.priceOverride), followMasterPrice: primary.followMasterPrice,
      basePrice: isParent ? null : decimalToNumber(member.basePrice), currency: coord.currency,
      formula: formulaByCell.get(`${member.id}|${coord.channel}|${coord.market}|${primary.aliasKey ?? ''}`) != null ? `= ${formulaByCell.get(`${member.id}|${coord.channel}|${coord.market}|${primary.aliasKey ?? ''}`)}` : null,
      clamped: snapshot?.isClamped ? (decimalToNumber(snapshot.clampedFrom) ?? 0) > (decimalToNumber(snapshot.computedPrice) ?? 0) ? 'ceiling' : 'floor' : null,
    }) : null
    const window = saleWindows.get(primary.id)
    const sale = serves('salePrice') ? (isParent ? { value: null, start: null, end: null } : { value: decimalToNumber(primary.salePrice), start: window?.start ?? null, end: window?.end ?? null }) : null
    const gate = writableFor({ role: isParent ? 'parent' : 'variant', cells: coord.cells, sync, fulfilment: fulfilment ? { method: fulfilment.method, guard: fulfilment.guard } : null, price, canEditPrice: input.canEditPrice })
    return {
      listingId: primary.id, version: primary.version, listing, fulfilment, sync, queue, price, sale,
      writable: gate.writable, writeBlockedReason: { ...gate.writeBlockedReason, ...extra },
    }
  }

  const rowOf = (member: Member): MatrixRowRead => {
    const isParent = member.id === root.id
    const cells: Record<CoordinateKey, MatrixCells> = {}
    for (const c of coordinates) { if (c.cells.length === 0) continue; const hit = cellsFor(member, c); if (hit) cells[c.key] = hit }
    const locations = isParent
      ? [...children.reduce((m, c) => { for (const l of poolLocations.get(c.id) ?? []) m.set(l.code, (m.get(l.code) ?? 0) + l.available); return m }, new Map<string, number>()).entries()].map(([code, available]) => ({ code, available }))
      : poolLocations.get(member.id) ?? []
    const available = locations.length === 0 ? null : locations.reduce((s, l) => s + l.available, 0)
    return {
      id: member.id, sku: member.sku, role: isParent ? 'parent' : 'variant',
      stock: { available, uncounted: locations.length === 0, locations },
      basePrice: decimalToNumber(member.basePrice), status: member.status, cells,
    }
  }
  const rows = [rowOf(parentRow), ...orderedChildren.map(rowOf)]

  // ── 8. strip roll-ups (variants only, as the preview counts them) ──────────────────────────
  for (const c of coordinates) {
    if (c.cells.length === 0 || !c.cells.includes('listing')) continue
    const states = rows.filter((r) => r.role === 'variant').map((r) => r.cells[c.key]?.listing?.state)
    c.listed = states.filter((s) => s === 'listed').length
    c.draft = states.filter((s) => s === 'draft').length
  }
  mark('shape', tShape)

  return {
    version: root.version,
    productId: root.id,
    source: 'live',
    generatedAt: new Date().toISOString(),
    coordinates: coordinates.map(({ rowsOf: _r, euMarkets: _e, ...c }) => c),
    rows,
    policies: [...policies.entries()].map(([k, v]) => ({ channel: k.split(':')[0]!, market: k.split(':')[1] ?? '*', pushesPaused: v.pushesPaused })),
    meta: { tookMs: Date.now() - t0, phases, queries },
  }
}

/** The one sentence the page shows for a coordinate the family has never been listed on. */
export const NOT_LISTED = MATRIX_COPY.notListed
