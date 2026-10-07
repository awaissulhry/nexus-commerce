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
 *   - `listing.selling` (build shape v2, P7): THE engine's selling state per coordinate (`destinationSellingStates`,
 *     the reader the sheet's Status column and the listing-action engine use) — from the rows already read, no query.
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
  type MatrixFbaStock,
  type MatrixRead,
  type MatrixRowRead,
  type QueueCell,
  type SaleCell,
  type SyncCell,
} from '@nexus/shared/matrix-contract'
import type { SellingStateRead } from '@nexus/shared/listing-actions'
import { destinationSellingStates, oldClosePauses } from '../listings/listing-action.service.js'
import { loadSyncLedgers } from '../stock-pool/sync-ledgers.js'
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
import { axisValuesOf, buildFamilyAxes, FAMILY_MEMBER_SELECT, readExcludedListingIds, resolveFamilyRoot, type FamilyAxis } from './family-projection.service.js'
import {
  businessAbsence, channelLabel, channelRank, channelShape, circled, compareMarkets, deriveFulfilment, flattenAudience, foldQueue, isAmazonEuMarket,
  effectiveFulfilment, listingStateOf, priceCellOf, reportedFulfilment, withoutInventory, writableFor, type QueueRowFacts,
} from './matrix-cells.js'

export interface MatrixReadInput {
  productId: string
  accountId?: string | null
  locale?: string | null
  /** `products.price.edit` for the caller — the price cells are held with the reason without it (Add 4(d)). */
  canEditPrice: boolean
  /** Only these coordinates' cells (the product sheet's stock columns read one or two); every coordinate is still listed. */
  only?: readonly CoordinateKey[]
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
  const [listings, marketplaces, connections, aliases, syncLedgers, fbaDetail, fbaLevels, policies, formulas, snapshots] = await Promise.all([
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
  ]); queries += 12
  const audienceRows = parentRow.productType
    ? await prisma.$queryRawUnsafe<Array<{ marketplace: string | null; audience: unknown }>>(AUDIENCE_SQL, parentRow.productType)
    : []
  if (parentRow.productType) queries += 1
  const audienceByMarket = new Map(audienceRows.map((r) => [upper(r.marketplace), flattenAudience(r.audience)]))
  mark('wave1', tWave1)

  // ── 3. wave 2 — the tables keyed by listing id ─────────────────────────────────────────────
  const tWave2 = Date.now()
  const listingIds = listings.map((l) => l.id)
  const [openSuppressions, queueRows, fbaOffers, saleWindows, excluded, conversions] = await Promise.all([
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
  ]); queries += 6
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
    const extra: MatrixCells['writeBlockedReason'] = {}
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
      if (coord.euMarkets && rows.length > 1) {
        /* The push belt's own inputs (the STORED method), so the sentence matches what dispatch will refuse. */
        const verdict = detectEuIntentConflict(rows.map((l) => ({ marketplace: l.marketplace, followMasterQuantity: l.followMasterQuantity, quantityOverride: l.quantityOverride, quantity: l.quantity, syncPaused: l.syncPaused, isFba: l.fulfillmentMethod === 'FBA', offerClosed: !!l.offerClosedAt })))
        if (verdict.conflict) extra.syncState = verdict.detail
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
    if (sale && draft?.sale) {
      const s = draft.sale.value as { price: number; start: string; end: string } | null
      sale.waiting = s ? { value: s.price, start: s.start, end: s.end } : { value: null, start: null, end: null }
    }
    const gate = writableFor({ role: isParent ? 'parent' : 'variant', cells: coord.cells, sync, fulfilment: fulfilment ? { method: fulfilment.method, guard: fulfilment.guard } : null, price, canEditPrice: input.canEditPrice, sharedFrom: sourceOf(member.id)?.lenderName ?? null })
    return {
      listingId: primary.id, version: primary.version, listing, fulfilment, sync, queue, price, sale,
      writable: gate.writable, writeBlockedReason: { ...gate.writeBlockedReason, ...extra },
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
    policies: [...policies.entries()].map(([k, v]) => ({ ...parsePolicyKey(k), pushesPaused: v.pushesPaused })),
    meta: { tookMs: Date.now() - t0, phases, queries },
  }
}

/** The one sentence the page shows for a coordinate the family has never been listed on. */
export const NOT_LISTED = MATRIX_COPY.notListed
