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
 *   - `queue`: the newest non-cancelled `OutboundSyncQueue` row per (listing, QUANTITY_UPDATE | PRICE_UPDATE), folded
 *     (the MCP read and the Retry verb read it; the page draws no Sync column since 2026-10-08).
 *   - `sync.pushFailed` / `price.pushFailed` (2026-10-08, the Qty and Price cells' ✗): the newest push of EACH lane of the
 *     listing, read on its own — the same queue rows, plus eBay's shared-stock pushes, which are saved without a listing
 *     id (`ebay-shared-fanout.service.ts`) and matched by what they carry: product, item id and market. The listing's own
 *     `lastSyncStatus` is not per lane (any row and Publish write it) and the shared lane never writes it.
 *   - `sync.euConflict`: the Amazon EU guard's verdict on the region cell (`detectEuIntentConflict`), whole.
 *   - `price`: `ChannelListing.price` (the number the push reads); `sale`: `salePrice` + the two window columns.
 *   - `listing.selling` (build shape v2, P7): THE engine's selling state per coordinate (`destinationSellingStates`,
 *     the reader the sheet's Status column and the listing-action engine use) — from the rows already read, no query.
 *   - `pack` (Step 3, the Case column): the member's own case sizes (`ProductCaseSize`, biggest first; sizes and weight
 *     as numbers) and FBA prep/label owner (`ProductPackage`) — `casePackOf`.
 *   - `fbaInbound` / `fbaPlans` (Step 4, "Inbound +N"): Amazon's inbound per seller SKU as the FBA sweep stored it
 *     (`FbaInventoryDetail` INBOUND, fulfilment centre 'ALL') and the family's open Send-to-FBA plan lines. Read only:
 *     the FBA number (`fba`) stays Amazon's fulfillable units; inbound is never added to it.
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
  type MatrixCasePack,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixFbaInbound,
  type MatrixFbaPlan,
  type MatrixFbaStock,
  type MatrixRead,
  type MatrixRowRead,
  type QueueCell,
  type SaleCell,
  type SyncCell,
} from '@nexus/shared/matrix-contract'
import type { SellingStateRead } from '@nexus/shared/listing-actions'
import { FBA_CLOSED_STATUSES, isFbaPlanOpen, isFbaPlanUnderWay, type FbaPlanStatus } from '@nexus/shared/fba-send'
import { isCaseOwner } from '@nexus/shared/stock-cases'
import { destinationSellingStates, oldClosePauses } from '../listings/listing-action.service.js'
import { ledgerInputs, loadMarketSources, loadSyncLedgers } from '../stock-pool/sync-ledgers.js'
import { marketSourceKey, sellsFrom } from '../sync-control-core.js'
import { loadChannelPolicies, parsePolicyKey, policyFor } from '../sync-control-policy.service.js'
import { isOwnConnection } from '../connection-resolver.service.js'
import { detectEuIntentConflict } from '../amazon-eu-quantity-guard.js'
import { readAmazonOfferDraft } from '../amazon/offer-draft.js'
import { listingQuantityVerdict } from './listing-quantity-verdict.js'
import { MARKETPLACE_ID_TO_CODE } from '../../utils/marketplace-code.js'
import { axisSynonymKey } from '../ebay-theme-axes.js'
import { familyAccountId } from './family-account.js'
import { completeAxisValueOrder } from './shared-variation-values.js'
import { decimalToNumber } from './sheet-rows.service.js'
import { conversionStatusOf, loadConversionRecords } from './fulfilment-conversion.service.js'
import { readSaleWindows } from './sale-window.js'
import { FBA_ALL_CENTRES } from '../fba-pan-eu.service.js'
import { axisValuesOf, buildFamilyAxes, FAMILY_MEMBER_SELECT, readExcludedListingIds, resolveFamilyRoot, type FamilyAxis } from './family-projection.service.js'
import {
  businessAbsence, channelLabel, channelRank, channelShape, circled, compareMarkets, deriveFulfilment, flattenAudience, foldQueue, isAmazonEuMarket,
  effectiveFulfilment, inSourceOrder, lanePushFailure, listingStateOf, priceCellOf, reportedFulfilment, sourceCellOf, withoutInventory, writableFor, type QueueRowFacts, type SourceLocation,
} from './matrix-cells.js'

export interface MatrixReadInput {
  productId: string
  accountId?: string | null
  locale?: string | null
  /** `products.price.edit` for the caller — the price cells are held with the reason without it (Add 4(d)). */
  canEditPrice: boolean
  /** Only these coordinates' cells (the product sheet's stock columns read one or two); every coordinate is still listed. */
  only?: readonly CoordinateKey[]
  /** `inventory.adjust` for the caller — the "Sells from" cell is held with the reason without it (Step 2). Absent = false. */
  canAdjustStock?: boolean
}

export type MatrixReadWithMeta = MatrixRead & { meta: { tookMs: number; phases: Record<string, number>; queries: number } }

const MEMBER_SELECT = { ...FAMILY_MEMBER_SELECT, fulfillmentMethod: true } as const

/** The columns the Matrix reads off a listing — one select, reused by the write door's re-read. */
export const MATRIX_LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, region: true, aliasId: true, aliasKey: true, channelConnectionId: true,
  listingStatus: true, isPublished: true, externalListingId: true, version: true,
  price: true, salePrice: true, priceOverride: true, followMasterPrice: true,
  followMasterQuantity: true, quantity: true, quantityOverride: true, stockBuffer: true, syncPaused: true, sourceLocationCodes: true,
  offerClosedAt: true, offerCloseReason: true, offerActive: true, fulfillmentMethod: true, platformAttributes: true, lastSyncStatus: true, syncStatus: true,
} as const

export type MatrixListing = Prisma.ChannelListingGetPayload<{ select: typeof MATRIX_LISTING_SELECT }>
type Member = Prisma.ProductGetPayload<{ select: typeof MEMBER_SELECT }>

/** The `ProductCaseSize` columns the Case column reads. */
const CASE_SIZE_SELECT = {
  productId: true, unitsPerCase: true, caseLengthCm: true, caseWidthCm: true, caseHeightCm: true, caseWeightKg: true,
} as const
type CaseSizeRow = Prisma.ProductCaseSizeGetPayload<{ select: typeof CASE_SIZE_SELECT }>
/** The `ProductPackage` columns the Case column reads (the FBA prep / label owner). */
const CASE_OWNER_SELECT = { productId: true, fbaPrepOwner: true, fbaLabelOwner: true } as const
type CaseOwnerRow = Prisma.ProductPackageGetPayload<{ select: typeof CASE_OWNER_SELECT }>

/**
 * One SKU's case pack on the wire: its sizes biggest first (Prisma's `Decimal` sizes and weight as numbers) and its
 * owners (an unknown owner string as not set). null = no size and no owners row.
 */
export function casePackOf(owners: Omit<CaseOwnerRow, 'productId'> | null | undefined, sizes: ReadonlyArray<Omit<CaseSizeRow, 'productId'>>): MatrixCasePack | null {
  if (!owners && sizes.length === 0) return null
  return {
    sizes: [...sizes].sort((a, b) => b.unitsPerCase - a.unitsPerCase).map((row) => ({
      unitsPerCase: row.unitsPerCase,
      caseLengthCm: decimalToNumber(row.caseLengthCm),
      caseWidthCm: decimalToNumber(row.caseWidthCm),
      caseHeightCm: decimalToNumber(row.caseHeightCm),
      caseWeightKg: decimalToNumber(row.caseWeightKg),
    })),
    fbaPrepOwner: isCaseOwner(owners?.fbaPrepOwner) ? owners!.fbaPrepOwner as MatrixCasePack['fbaPrepOwner'] : null,
    fbaLabelOwner: isCaseOwner(owners?.fbaLabelOwner) ? owners!.fbaLabelOwner as MatrixCasePack['fbaLabelOwner'] : null,
  }
}

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
  const [listings, marketplaces, connections, aliases, syncLedgers, fbaDetail, fbaLevels, policies, formulas, snapshots, warehouses, marketSources, caseOwners, caseSizes, fbaInboundRows, fbaPlanLines] = await Promise.all([
    prisma.channelListing.findMany({ where: { productId: { in: memberIds } }, select: MATRIX_LISTING_SELECT }),
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, currency: true, region: true } }),
    prisma.channelConnection.findMany({ where: { isActive: true }, select: { id: true, channelType: true, isPrimary: true, workspaceId: true }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.productListingAlias.findMany({ where: { productId: root.id, status: 'ACTIVE' }, select: { id: true, channel: true, marketplace: true, channelConnectionId: true, label: true, position: true }, orderBy: { position: 'asc' } }),
    // Shared stock — the same ledgers the cascade uses (3 queries): a pooled member shows the pool.
    loadSyncLedgers(prisma, memberIds),
    prisma.fbaInventoryDetail.findMany({ where: { sku: { in: skus }, condition: 'SELLABLE' }, select: { sku: true, marketplaceId: true, quantity: true } }),
    // The FBA qty column (Owner 2026-10-06): the AMAZON_FBA rows the guard sums (`fbaBucket`), read with their codes and times.
    prisma.stockLevel.findMany({ where: { productId: { in: memberIds }, location: { type: 'AMAZON_FBA' } }, select: { productId: true, quantity: true, lastUpdatedAt: true, location: { select: { code: true } } } }),
    loadChannelPolicies(),
    prisma.cellFormula.findMany({ where: { productId: { in: memberIds }, scope: 'channel', fieldKey: 'price' }, select: { productId: true, channel: true, marketplace: true, aliasKey: true, expr: true } }),
    prisma.pricingSnapshot.findMany({ where: { sku: { in: skus }, fulfillmentMethod: null }, select: { sku: true, channel: true, marketplace: true, isClamped: true, clampedFrom: true, computedPrice: true } }),
    // "Sells from" (Step 2): this business's warehouses (the From cell's choices and its routes default) and the market lists.
    prisma.stockLocation.findMany({ where: { type: 'WAREHOUSE' }, select: { code: true, name: true, isActive: true, syncRoutes: true, warehouse: { select: { isDefault: true, isActive: true } } } }),
    loadMarketSources(prisma),
    // The Case column (Step 3): each member's FBA prep/label owner and its case sizes (units per case, size, weight).
    prisma.productPackage.findMany({ where: { productId: { in: memberIds } }, select: CASE_OWNER_SELECT }),
    prisma.productCaseSize.findMany({ where: { productId: { in: memberIds } }, select: CASE_SIZE_SELECT }),
    // "Inbound +N" (Step 4): Amazon's inbound per seller SKU (the FBA sweep's rows; a row names its product when the sweep
    // matched one, else only its SKU) and the members' lines in Send-to-FBA plans not closed or cancelled.
    prisma.fbaInventoryDetail.findMany({
      where: { condition: 'INBOUND', fulfillmentCenterId: FBA_ALL_CENTRES, OR: [{ productId: { in: memberIds } }, { productId: null, sku: { in: skus } }] },
      select: { productId: true, sku: true, marketplaceId: true, quantity: true, rawData: true, lastSyncedAt: true },
    }),
    prisma.fbaInboundPlanLine.findMany({
      where: { productId: { in: memberIds }, plan: { source: { not: null }, status: { notIn: [...FBA_CLOSED_STATUSES] } } },
      select: { productId: true, quantity: true, shippedQuantity: true, plan: { select: { id: true, name: true, status: true, createdAt: true } } },
    }),
  ]); queries += 18
  const audienceRows = parentRow.productType
    ? await prisma.$queryRawUnsafe<Array<{ marketplace: string | null; audience: unknown }>>(AUDIENCE_SQL, parentRow.productType)
    : []
  if (parentRow.productType) queries += 1
  const audienceByMarket = new Map(audienceRows.map((r) => [upper(r.marketplace), flattenAudience(r.audience)]))
  mark('wave1', tWave1)

  // ── 3. wave 2 — the tables keyed by listing id ─────────────────────────────────────────────
  const tWave2 = Date.now()
  const listingIds = listings.map((l) => l.id)
  /* eBay's shared-stock pushes (the Trading fan-out) carry no listing id: the item ids of this family's eBay listings. */
  const ebayItemIds = [...new Set(listings.flatMap((l) => (upper(l.channel) === 'EBAY' && l.externalListingId?.trim() ? [l.externalListingId.trim()] : [])))]
  const [openSuppressions, queueRows, fbaOffers, saleWindows, excluded, conversions, sharedPushRows] = await Promise.all([
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
    // Amazon fulfilment conversions (2026-10-07): the newest runs sent for these listings (the Fulfilment cell's status).
    loadConversionRecords(listings.filter((l) => l.channel === 'AMAZON').map((l) => l.id)),
    /* 2026-10-08 — the newest eBay shared-stock push per (product, item, market): saved without a listing id, so the
       listing rows above never see it (the eBay stock lane's real-time pushes). */
    ebayItemIds.length
      ? prisma.outboundSyncQueue.findMany({
        where: { channelListingId: null, targetChannel: 'EBAY', syncType: 'QUANTITY_UPDATE', productId: { in: memberIds }, externalListingId: { in: ebayItemIds }, syncStatus: { not: 'CANCELLED' } },
        orderBy: [{ createdAt: 'desc' }],
        distinct: ['productId', 'externalListingId', 'targetRegion'],
        select: { productId: true, externalListingId: true, targetRegion: true, syncType: true, syncStatus: true, isDead: true, errorMessage: true, syncedAt: true, updatedAt: true, createdAt: true },
      })
      : Promise.resolve([]),
  ]); queries += ebayItemIds.length ? 7 : 6
  mark('wave2', tWave2)

  // ── 4. indexes ─────────────────────────────────────────────────────────────────────────────
  const tShape = Date.now()
  const memberById = new Map(members.map((m) => [m.id, m]))
  // Shared stock by SKU — which business lends the stock a pooled member sells from (one query, only when one does).
  const poolGrantIds = [...new Set([...syncLedgers.values()].flatMap((l) => (l.source.kind === 'pool' ? [l.source.grantId] : [])))]
  const lenderOf = new Map(poolGrantIds.length
    ? (await prisma.stockPoolGrant.findMany({ where: { id: { in: poolGrantIds } }, select: { id: true, ownerWorkspace: { select: { name: true } } } })).map((g) => [g.id, g.ownerWorkspace.name])
    : [])
  if (poolGrantIds.length) queries += 1
  const sourceOf = (productId: string): MatrixRowRead['stock']['source'] => {
    const ledger = syncLedgers.get(productId)
    return ledger?.source.kind === 'pool' ? { kind: 'pool', grantId: ledger.source.grantId, lenderName: lenderOf.get(ledger.source.grantId) ?? 'another business' } : null
  }
  const poolLocations = new Map<string, Array<{ code: string; available: number }>>()
  const fbaBucket = new Map<string, number>()
  for (const [productId, product] of syncLedgers) {
    poolLocations.set(productId, product.ledger.map((r) => ({ code: r.locationCode, available: r.available })))
    if (product.fbaBucket > 0) fbaBucket.set(productId, product.fbaBucket)
  }
  const fbaSellable = new Map<string, number>()
  for (const d of fbaDetail) {
    const code = MARKETPLACE_ID_TO_CODE[d.marketplaceId] ?? d.marketplaceId
    const k = `${d.sku}|${code}`
    fbaSellable.set(k, (fbaSellable.get(k) ?? 0) + d.quantity)
  }
  /* The FBA qty column: a member's AMAZON_FBA rows; a parent reads its variations' (as the Stock column does). No row → null,
     never 0 — "Nexus holds no FBA stock for this SKU" is a different fact from "Amazon holds 0". */
  const fbaRowsOf = new Map<string, Array<{ code: string; units: number; at: Date | null }>>()
  for (const l of fbaLevels) fbaRowsOf.set(l.productId, [...(fbaRowsOf.get(l.productId) ?? []), { code: l.location?.code ?? 'AMAZON_FBA', units: l.quantity, at: l.lastUpdatedAt }])
  const fbaStockOf = (ids: readonly string[]): MatrixFbaStock | null => {
    const rows = ids.flatMap((id) => fbaRowsOf.get(id) ?? [])
    if (rows.length === 0) return null
    const byCode = new Map<string, number>()
    for (const r of rows) byCode.set(r.code, (byCode.get(r.code) ?? 0) + r.units)
    const newest = rows.reduce<Date | null>((m, r) => (r.at && (!m || r.at > m) ? r.at : m), null)
    return { units: rows.reduce((n, r) => n + r.units, 0), locations: [...byCode].map(([code, units]) => ({ code, units })), updatedAt: newest?.toISOString() ?? null }
  }
  /* The Case column (Step 3): a member's own case pack; null = none set. A parent carries its own (normally none). */
  const ownersOf = new Map(caseOwners.map((p) => [p.productId, p]))
  const packOf = new Map(memberIds.map((id) => [id, casePackOf(ownersOf.get(id), caseSizes.filter((s) => s.productId === id))]))
  /* "Inbound +N" (Step 4). Amazon's side: a member's INBOUND rows (its seller SKUs) from ONE marketplace — the one read
     last — so a Pan-EU pool reported under two marketplaces is never counted twice. Nexus's side: units in open plans
     not marked Shipped yet, and units marked Shipped in plans Amazon is not receiving yet — READY_TO_SHIP (a plan with
     several shipments, some marked) or SHIPPED — (`sent`). A parent: its variations' sum (as
     `fba`). Nothing inbound, nothing planned and nothing sent → null. */
  const memberIdBySku = new Map(members.map((m) => [m.sku, m.id]))
  const inboundRowsOf = new Map<string, typeof fbaInboundRows>()
  for (const r of fbaInboundRows) {
    const id = r.productId ?? memberIdBySku.get(r.sku)
    if (id && memberById.has(id)) inboundRowsOf.set(id, [...(inboundRowsOf.get(id) ?? []), r])
  }
  const bucket = (raw: unknown, key: 'working' | 'shipped' | 'receiving'): number => {
    const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : null
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
  }
  const amazonInboundOf = (id: string) => {
    const all = inboundRowsOf.get(id) ?? []
    if (all.length === 0) return null
    const lastRead = all.reduce((a, b) => (b.lastSyncedAt > a.lastSyncedAt ? b : a)).marketplaceId
    const rows = all.filter((r) => r.marketplaceId === lastRead)
    return {
      units: rows.reduce((n, r) => n + Math.max(0, r.quantity), 0),
      working: rows.reduce((n, r) => n + bucket(r.rawData, 'working'), 0),
      shipped: rows.reduce((n, r) => n + bucket(r.rawData, 'shipped'), 0),
      receiving: rows.reduce((n, r) => n + bucket(r.rawData, 'receiving'), 0),
      // The oldest contributing read: a fresh row must not make a stale one look fresh.
      readAt: rows.reduce((m, r) => (r.lastSyncedAt < m ? r.lastSyncedAt : m), rows[0]!.lastSyncedAt),
    }
  }
  const openLines = fbaPlanLines.filter((l) => isFbaPlanOpen(l.plan.status))
  /* "Planned": units of plans UNDER WAY (sent to Amazon's steps, holds standing). A DRAFT (Owner 2026-10-08) holds
     nothing: it shows only as a plan of the family (`fbaPlans`, status DRAFT) — the footer's "FBA draft · N units". */
  const plannedOf = new Map<string, number>()
  for (const l of openLines) if (isFbaPlanUnderWay(l.plan.status)) plannedOf.set(l.productId, (plannedOf.get(l.productId) ?? 0) + Math.max(0, l.quantity - l.shippedQuantity))
  /* "Sent" (Owner 2026-10-07): units Nexus marked Shipped in plans still SHIPPED — Amazon has not started receiving all
     of them, so its next read may not count them yet. The cell shows the bigger of this and Amazon's `units`
     (`fbaInboundShown`), never the sum. AT_AMAZON and later plans are Amazon's number only. */
  const sentOf = new Map<string, number>()
  for (const l of openLines) if (l.plan.status === 'SHIPPED' || l.plan.status === 'READY_TO_SHIP') sentOf.set(l.productId, (sentOf.get(l.productId) ?? 0) + Math.max(0, l.shippedQuantity))
  const fbaInboundOf = (ids: readonly string[]): MatrixFbaInbound | null => {
    const out = { units: 0, working: 0, shipped: 0, receiving: 0, planned: 0, sent: 0 }
    let readAt: Date | null = null
    for (const id of ids) {
      const amazon = amazonInboundOf(id)
      if (amazon) {
        out.units += amazon.units; out.working += amazon.working; out.shipped += amazon.shipped; out.receiving += amazon.receiving
        if (!readAt || amazon.readAt < readAt) readAt = amazon.readAt
      }
      out.planned += plannedOf.get(id) ?? 0
      out.sent += sentOf.get(id) ?? 0
    }
    return out.units === 0 && out.planned === 0 && out.sent === 0 ? null : { ...out, readAt: readAt?.toISOString() ?? null }
  }
  /* The family's open plans (its DRAFT included), newest first; `units` = this family's units in each. */
  const plansById = new Map<string, MatrixFbaPlan & { createdAt: Date }>()
  for (const l of openLines) {
    const plan = plansById.get(l.plan.id) ?? { id: l.plan.id, name: l.plan.name || `#${l.plan.id.slice(-6)}`, status: l.plan.status as FbaPlanStatus, units: 0, createdAt: l.plan.createdAt }
    plan.units += Math.max(0, l.quantity)
    plansById.set(l.plan.id, plan)
  }
  const fbaPlans: MatrixFbaPlan[] = [...plansById.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .map(({ createdAt: _c, ...plan }) => plan)
  /* "Sells from": the warehouses in sale order (the default first, then by code — the loader's order). */
  const sourceLocations: Array<SourceLocation & { name: string }> = inSourceOrder(warehouses.map((w) => ({
    code: w.code, name: w.name, active: w.isActive !== false, syncRoutes: w.syncRoutes ?? [],
    isDefault: !!w.warehouse?.isDefault && w.warehouse.isActive !== false,
  })))
  const suppressed = new Set(openSuppressions.map((s) => s.listingId))
  const fbaOfferOn = new Set(fbaOffers.map((o) => o.channelListingId))
  const queueByListing = new Map<string, QueueRowFacts[]>()
  const rowFacts = (q: { syncType: string; syncStatus: string; isDead: boolean; errorMessage: string | null; syncedAt: Date | null; updatedAt: Date; createdAt: Date }): QueueRowFacts => ({
    syncType: q.syncType, syncStatus: q.syncStatus, isDead: q.isDead, errorMessage: q.errorMessage,
    at: (q.syncedAt ?? q.updatedAt ?? q.createdAt)?.toISOString() ?? null, createdAt: q.createdAt?.toISOString() ?? null,
  })
  for (const q of queueRows) {
    if (!q.channelListingId) continue
    queueByListing.set(q.channelListingId, [...(queueByListing.get(q.channelListingId) ?? []), rowFacts(q)])
  }
  /* eBay shared-stock pushes by what they carry: the product, the item id and the market (a listing's own row has the
     same three: `productId`, `externalListingId`, `marketplace`). */
  const sharedKey = (productId: string | null, itemId: string | null, market: string | null) => `${productId ?? ''}|${(itemId ?? '').trim()}|${upper(market)}`
  const sharedPushOf = new Map<string, QueueRowFacts>()
  for (const q of sharedPushRows) sharedPushOf.set(sharedKey(q.productId, q.externalListingId, q.targetRegion), rowFacts(q))
  /** Every push row a listing's lanes read: its own rows, and (eBay) the shared-stock push for its item. */
  const laneRowsOf = (l: MatrixListing): QueueRowFacts[] => {
    const own = queueByListing.get(l.id) ?? []
    const shared = upper(l.channel) === 'EBAY' && l.externalListingId ? sharedPushOf.get(sharedKey(l.productId, l.externalListingId, l.marketplace)) : undefined
    return shared ? [...own, shared] : own
  }
  const formulaByCell = new Map(formulas.map((f) => [`${f.productId}|${upper(f.channel)}|${upper(f.marketplace)}|${f.aliasKey ?? ''}`, f.expr]))
  const snapshotByCell = new Map(snapshots.map((s) => [`${s.sku}|${upper(s.channel)}|${upper(s.marketplace)}`, s]))
  const connectionsByChannel = new Map<string, Array<{ id: string; isPrimary: boolean }>>()
  // An account another business shares with this one is never this business's primary, and comes after its own.
  for (const c of [...connections.filter(isOwnConnection), ...connections.filter((c) => !isOwnConnection(c))]) connectionsByChannel.set(upper(c.channelType), [...(connectionsByChannel.get(upper(c.channelType)) ?? []), { id: c.id, isPrimary: c.isPrimary && isOwnConnection(c) }])
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
  /* The family PARENT has no offer of its own. A standalone product (no variations, not flagged a parent) is its own
     buyable listing: its row is a variant row, so its cells are read and written like any variation's — the product
     sheet's stock columns show them on every product, not only on families. */
  const isFamilyParent = (memberId: string): boolean => memberId === root.id && (children.length > 0 || root.isParent === true)
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
    label: `Amazon · EU inventory · ${euMarkets.join(' ')}`, region: 'EU', alias: null,
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
  /* The selling word per coordinate: the engine's reader over this coordinate's rows (one per member), once. */
  const sellingMembers = members.map((m) => ({ id: m.id, sku: m.sku, isParent: m.id === root.id && children.length > 0, fulfillmentMethod: m.fulfillmentMethod }))
  // P13 — an eBay listing an older Claude close-listing paused (pinned at 0, no hold) reads Inactive, as in the engine.
  const oldPauses = await oldClosePauses(listings.filter((l) => l.channel === 'EBAY'))
  const sellingByCoord = new Map<CoordinateKey, Map<string, SellingStateRead>>()
  const sellingOf = (coord: Coord, memberId: string): SellingStateRead => {
    let states = sellingByCoord.get(coord.key)
    if (!states) {
      const rows = members.flatMap((m) => coord.rowsOf(m.id).slice(0, 1))
      states = destinationSellingStates({ familyId: root.id, channel: coord.channel, products: sellingMembers, listings: rows, oldClosePauses: oldPauses }).states
      sellingByCoord.set(coord.key, states)
    }
    return states.get(memberId) ?? { state: 'not_listed', reason: null }
  }
  const resolveListing = (l: MatrixListing, member: Member) => {
    const ch = upper(l.channel), mk = upper(l.marketplace)
    /* The one quantity verdict (fail-closed FBA, `resolveIntendedQuantity` over the routed ledger), shared with the
       product sheet's stock columns so the two never read a listing two ways. */
    const { isFba, sync } = listingQuantityVerdict({
      listing: l, productFulfillmentMethod: member.fulfillmentMethod, ledger: syncLedgers.get(member.id),
      fbaStockQty: fbaBucket.get(member.id) ?? 0, hasActiveFbaOffer: fbaOfferOn.has(l.id),
      channelPolicy: policyFor(policies, ch, mk, l.channelConnectionId),
      fbaAtAmazon: ch === 'AMAZON' ? (fbaSellable.get(`${member.sku}|${mk}`) ?? fbaBucket.get(member.id) ?? null) : null,
    })
    const pa = (l.platformAttributes ?? {}) as Record<string, unknown>
    const typed = l.fulfillmentMethod as FulfilmentMethod | null
    // 2026-09-27 — Amazon reads the ONE rule the sheet and the publish step read (`effectiveFulfilment`).
    const method: FulfilmentMethod = ch === 'EBAY' ? (typed === 'FBA' ? 'MCF' : 'FBM')
      : ch === 'AMAZON' ? effectiveFulfilment({ activeOfferMethod: fbaOfferOn.has(l.id) ? 'FBA' : null, typed, platformAttributes: pa, productMethod: member.fulfillmentMethod })?.method ?? 'FBM'
      : typed ?? deriveFulfilment(ch, pa.fulfillmentChannel, member.fulfillmentMethod)
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
    const isParent = isFamilyParent(member.id)
    const serves = (k: keyof typeof INVENTORY_CELL_KINDS extends never ? never : string) => coord.cells.includes(k as never)
    const inventory = coord.cells.some((k) => INVENTORY_CELL_KINDS.includes(k))
    let sync: SyncCell | null = null
    let fulfilment: FulfilmentCell | null = null
    let queue: QueueCell | null = null
    /* The PARENT has no listing of its own (MX.P's live reading): no inventory facts, no price — only the listing word
       with its `n listing(s)` detail, and every cell held with the reason. */
    if (inventory && !isParent) {
      const r = resolveListing(primary, member)
      sync = serves('syncMode') || serves('syncQty') ? r.sync : null
      fulfilment = serves('fulfilment') ? r.fulfilment : null
      /* The newest FBA ⇄ FBM conversion sent for this coordinate's rows (the EU group's, or the listing's own). */
      const conversion = fulfilment && coord.channel === 'AMAZON' ? conversionStatusOf(rows.flatMap((l) => conversions.get(l.id) ?? [])) : null
      if (fulfilment && conversion) fulfilment = { ...fulfilment, conversion }
      if (serves('syncState')) {
        /* The region folds every EU row's queue (one quantity per SKU); a market folds its own listing's. */
        queue = foldQueue(rows.flatMap((l) => queueByListing.get(l.id) ?? []), r.sync)
      }
      /* 2026-10-08 — the Qty cell's ✗: this listing's newest stock push failed. Only where the stock lane runs: an
         Amazon-managed listing never pushes a quantity, a held or Inactive one says so itself (⏸ / Inactive), and a
         listing not on the channel (a draft) is sent nothing — an old failure there says nothing about the channel. The
         region cell reads the EU markets that sell (published, offer open), and names the ones that failed. */
      if (sync && serves('syncQty') && sync.kind !== 'FBA_EXCLUDED' && sync.kind !== 'PAUSED' && sync.kind !== 'CLOSED') {
        const selling = (coord.euMarkets ? rows : [primary]).filter((l) => l.isPublished && !l.offerClosedAt)
        const pushFailed = lanePushFailure(selling.map((l) => ({ market: l.marketplace, rows: laneRowsOf(l) })), 'QUANTITY_UPDATE', !!coord.euMarkets)
        if (pushFailed) sync = { ...sync, pushFailed }
      }
      if (coord.euMarkets && rows.length > 1) {
        /* The push belt's own inputs (the STORED method), so the sentence matches what dispatch will refuse. Step 2: each
           row's "Sells from" warehouses (`sellsFrom`) — two Follow rows from different warehouses send different sums. */
        const product = syncLedgers.get(member.id)
        const sourcesOf = (l: MatrixListing) => {
          const { ledger, sourceLocationCodes } = ledgerInputs(product, l.sourceLocationCodes ?? [])
          return sellsFrom({ ledger, channel: 'AMAZON', marketplace: l.marketplace, sourceLocationCodes }).codes
        }
        const verdict = detectEuIntentConflict(rows.map((l) => ({ marketplace: l.marketplace, followMasterQuantity: l.followMasterQuantity, quantityOverride: l.quantityOverride, quantity: l.quantity, syncPaused: l.syncPaused, isFba: l.fulfillmentMethod === 'FBA', offerClosed: !!l.offerClosedAt, sourceLocationCodes: l.sourceLocationCodes ?? [], sources: sourcesOf(l) })))
        /* The stock cell carries it (the Qty cell's ⚠) — the guard refuses the push until the markets agree. */
        if (verdict.conflict && sync) sync = { ...sync, euConflict: MATRIX_COPY.euConflict(verdict.detail) }
      }
    }
    const listing = serves('listing') ? {
      ...listingStateOf({ listingStatus: primary.listingStatus, isPublished: primary.isPublished, externalListingId: primary.externalListingId, suppressed: suppressed.has(primary.id), excluded: excluded.has(primary.id), needsValue: needsValue(member), selling: sellingOf(coord, member.id) }),
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
    const sale: SaleCell | null = serves('salePrice') ? (isParent ? { value: null, start: null, end: null } : { value: decimalToNumber(primary.salePrice), start: window?.start ?? null, end: window?.end ?? null }) : null
    /* D4=B: a product sheet price or sale saved on a live Amazon listing waits for Publish. The cells keep the live value
       (what the push reads); `waiting` is the tooltip line only (`MATRIX_COPY.waitingForPublish`). */
    const draft = coord.channel === 'AMAZON' && !isParent ? readAmazonOfferDraft(primary.platformAttributes)?.leaves : undefined
    const ourPrice = draft?.our_price?.value as { pin?: number; follow?: true } | null | undefined
    if (price && ourPrice) price.waiting = { value: typeof ourPrice.pin === 'number' ? ourPrice.pin : null }
    /* 2026-10-08 — the Price cell's ✗: this listing's newest price push failed (a held price is a skip, not a failure). A
       listing not on the channel (a draft) is sent nothing, so it carries none. */
    const pricePushFailed = price && !isParent && primary.isPublished ? lanePushFailure([{ market: primary.marketplace, rows: laneRowsOf(primary) }], 'PRICE_UPDATE') : null
    if (price && pricePushFailed) price.pushFailed = pricePushFailed
    if (sale && draft?.sale) {
      const s = draft.sale.value as { price: number; start: string; end: string } | null
      sale.waiting = s ? { value: s.price, start: s.start, end: s.end } : { value: null, start: null, end: null }
    }
    const sharedFrom = sourceOf(member.id)?.lenderName ?? null
    const gate = writableFor({ role: isParent ? 'parent' : 'variant', cells: coord.cells, sync, fulfilment: fulfilment ? { method: fulfilment.method, guard: fulfilment.guard } : null, price, canEditPrice: input.canEditPrice, sharedFrom })
    /* "Sells from" (Step 2): one per group that carries the quantity — once on Amazon EU (its primary row's list; the door
       writes the same list on every EU row). */
    const source = serves('syncQty') ? sourceCellOf({
      role: isParent ? 'parent' : 'variant', channel: coord.channel, market: upper(primary.marketplace), own: primary.sourceLocationCodes ?? [],
      ledger: syncLedgers.get(member.id)?.ledger, marketSources, locations: sourceLocations,
      isFba: sync?.kind === 'FBA_EXCLUDED', sharedFrom, canAdjustStock: input.canAdjustStock === true,
    }) : null
    return {
      listingId: primary.id, version: primary.version, listing, fulfilment, sync, queue, price, sale,
      writable: gate.writable, writeBlockedReason: gate.writeBlockedReason,
      ...(source ? { source } : {}),
    }
  }

  const rowOf = (member: Member): MatrixRowRead => {
    const isParent = isFamilyParent(member.id)
    const cells: Record<CoordinateKey, MatrixCells> = {}
    for (const c of coordinates) { if (c.cells.length === 0 || (input.only && !input.only.includes(c.key))) continue; const hit = cellsFor(member, c); if (hit) cells[c.key] = hit }
    const locations = isParent
      ? [...children.reduce((m, c) => { for (const l of poolLocations.get(c.id) ?? []) m.set(l.code, (m.get(l.code) ?? 0) + l.available); return m }, new Map<string, number>()).entries()].map(([code, available]) => ({ code, available }))
      : poolLocations.get(member.id) ?? []
    // A SKU whose own stock is counted as 0 (it left a pool and holds no row here) pushes 0: say 0, not "Uncounted".
    const countedZero = (id: string) => (poolLocations.get(id)?.length ?? 0) === 0 && syncLedgers.get(id)?.uncountedIsZero === true
    const uncounted = locations.length === 0 && !(isParent ? children.length > 0 && children.every((c) => countedZero(c.id)) : countedZero(member.id))
    const available = locations.length === 0 ? (uncounted ? null : 0) : locations.reduce((s, l) => s + l.available, 0)
    const childSources = isParent ? children.map((c) => sourceOf(c.id)) : []
    const source = isParent
      ? (childSources.length > 0 && childSources.every((s) => s && s.grantId === childSources[0]!.grantId) ? childSources[0]! : null)
      : sourceOf(member.id)
    return {
      id: member.id, sku: member.sku, role: isParent ? 'parent' : 'variant',
      stock: { available, uncounted, locations, source },
      fba: fbaStockOf(isParent ? children.map((c) => c.id) : [member.id]),
      pack: packOf.get(member.id) ?? null,
      fbaInbound: fbaInboundOf(isParent ? children.map((c) => c.id) : [member.id]),
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
    policies: [...policies.entries()].map(([k, v]) => {
      const key = parsePolicyKey(k)
      /* "Sells from": the market's list rides on the rows that name no account (`loadMarketSources`). */
      const list = key.accountId == null && key.market !== '*' ? marketSources.get(marketSourceKey(key.channel, key.market)) : undefined
      return { ...key, pushesPaused: v.pushesPaused, ...(list?.length ? { sourceLocationCodes: [...list] } : {}) }
    }),
    locations: sourceLocations.map((l) => ({ code: l.code, name: l.name, active: l.active, isDefault: l.isDefault })),
    fbaPlans,
    meta: { tookMs: Date.now() - t0, phases, queries },
  }
}

/** The one sentence the page shows for a coordinate the family has never been listed on. */
export const NOT_LISTED = MATRIX_COPY.notListed
