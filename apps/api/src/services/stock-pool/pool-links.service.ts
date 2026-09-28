/**
 * Shared stock — the product switch: "Use the shared stock" or "Use my own stock", for one product
 * (with its variations) of the BORROWING business. Plan: docs/2026-09-19-shared-stock-plan.md §4;
 * contract docs/2026-09-19-shared-stock-build.md §2.
 *
 * The database decides (stock-pool.sql, the link guard): an OWNER of this business, an active grant,
 * an active catalog link naming the lender's product, no chains, no lot or serial products. This
 * service explains refusals in words first, shows the exact numbers a switch will send (the preview
 * runs the same derivation core the cascade runs, on both ledgers), and records the switch.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { WorkspaceError, requireWorkspace } from '../../lib/workspace-context.js'
import { createWorkspaceService } from '../workspace.service.js'
import { resolveIntendedQuantity, resolveMembershipIntended, type IntendedResolution } from '../sync-control-core.js'
import { loadChannelPolicies, policyFor } from '../sync-control-policy.service.js'
import { resolveCascadePushMethod } from '../stock-movement.service.js'
import { idList } from './grant-rules.js'
import { ledgerInputs, loadLedgerChoices, loadSyncLedgers, type ProductLedger } from './sync-ledgers.js'
import { afterPoolChange } from './pool-tasks.js'

const workspaces = createWorkspaceService(prisma)

export type SwitchTarget = 'pool' | 'own'

export interface PoolProductRow {
  productId: string
  sku: string
  name: string
  parentId: string | null
  /** Where its listings take their number now. */
  source: 'pool' | 'own'
  /** The grant it sells from, when it sells from a pool. */
  grantId: string | null
  /** Units available in this business's own warehouses. */
  ownAvailable: number
  /** Units available in the pool's lent warehouses (null when the grant is not on). */
  poolAvailable: number | null
  /**
   * Shared stock step 4 — cost of goods for a sale from the pool is this business's OWN cost price
   * (cost belongs to each business: a product share never copies it). True when there is none: its
   * sales would count at zero cost in profit reports until someone sets it.
   */
  costPriceMissing: boolean
}

export interface ListingPreview {
  listingId: string | null
  /** Shared eBay variants have no listing of their own: their eBay item id instead. */
  itemId?: string
  channel: string
  marketplace: string
  /** The account the listing is on, and its name; null for a listing no account claims. */
  accountId: string | null
  accountLabel: string | null
  /**
   * Which of the product's listings on this account and market it is: 0 = the main listing, 1… = an alias, in
   * position order. Null when the account and market hold only this one listing (a lone listing needs no mark).
   */
  listingMark: number | null
  /** The alias's own name; null for the main listing. */
  aliasLabel: string | null
  /** What the channel shows now (the last number sent). */
  showsNow: number | null
  /** What Nexus will send after the switch; null when it sends nothing to this listing. */
  willShow: number | null
  /** Why nothing is sent, or what the number follows. */
  rule: 'follows' | 'fixed' | 'paused' | 'excluded' | 'amazon-managed' | 'offer-closed' | 'not-counted'
}

export interface SwitchPreview {
  productId: string
  sku: string
  from: 'pool' | 'own'
  to: SwitchTarget
  /** Why this product cannot switch (then nothing below applies). */
  refusal: string | null
  /** No cost price in this business: its pool sales would count at zero cost (see PoolProductRow). */
  costPriceMissing: boolean
  listings: ListingPreview[]
}

function actingPerson() {
  const context = requireWorkspace()
  if (!context.actorUserId) throw new WorkspaceError('session_required', 'Sign in as an owner of this business profile to switch a product\'s stock.', 403)
  return { workspaceId: context.workspaceId, actorUserId: context.actorUserId }
}

async function borrowedGrant(grantId: unknown, workspaceId: string) {
  if (typeof grantId !== 'string' || !grantId) throw new WorkspaceError('grant_required', 'Choose the shared stock to use.', 400)
  const grant = await prisma.stockPoolGrant.findUnique({ where: { id: grantId }, select: { id: true, ownerWorkspaceId: true, workspaceId: true, status: true, ownerWorkspace: { select: { name: true } } } })
  if (!grant || grant.workspaceId !== workspaceId) throw new WorkspaceError('grant_not_found', 'This shared stock is unavailable in this business profile.', 404)
  return grant
}

function target(value: unknown): SwitchTarget {
  if (value === 'pool' || value === 'own') return value
  throw new WorkspaceError('invalid_target', 'Choose "pool" (use the shared stock) or "own" (use this business\'s own stock).', 400)
}

/** The given products, plus the variations of any that are parents (a family switches together). */
async function withVariations(productIds: string[], include: boolean): Promise<string[]> {
  if (!include) return productIds
  const children = await prisma.product.findMany({ where: { parentId: { in: productIds }, deletedAt: null }, select: { id: true } })
  return [...new Set([...productIds, ...children.map((c) => c.id)])]
}

/**
 * This business's products linked (by a product share) to products of the lender of `grantId`, with
 * where their listings take their number now. Page by product id.
 */
export async function listPoolProducts(input: { grantId?: unknown; cursor?: unknown; take?: unknown }): Promise<{ products: PoolProductRow[]; nextCursor: string | null }> {
  const { workspaceId } = requireWorkspace()
  const grant = await borrowedGrant(input.grantId, workspaceId)
  const take = Math.min(Math.max(Number(input.take) || 100, 1), 200)
  const cursor = typeof input.cursor === 'string' && input.cursor ? input.cursor : undefined
  const catalog = await prisma.catalogLink.findMany({
    where: { targetWorkspaceId: workspaceId, sourceWorkspaceId: grant.ownerWorkspaceId, status: 'active', ...(cursor ? { targetProductId: { gt: cursor } } : {}) },
    select: { targetProductId: true },
    orderBy: { targetProductId: 'asc' },
    take: take + 1,
  })
  const page = catalog.slice(0, take).map((c) => c.targetProductId)
  const [products, current, choices] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: page }, deletedAt: null }, select: { id: true, sku: true, name: true, parentId: true, costPrice: true } }),
    loadSyncLedgers(prisma, page),
    loadLedgerChoices(prisma, page, grant.status === 'active' ? grant.id : null),
  ])
  const byId = new Map(products.map((p) => [p.id, p]))
  const rows: PoolProductRow[] = []
  for (const productId of page) {
    const product = byId.get(productId)
    if (!product) continue
    const now = current.get(productId)
    const choice = choices.get(productId)
    rows.push({
      productId, sku: product.sku, name: product.name, parentId: product.parentId,
      source: now?.source.kind === 'pool' ? 'pool' : 'own',
      grantId: now?.source.kind === 'pool' ? now.source.grantId : null,
      ownAvailable: choice?.own.available ?? 0,
      poolAvailable: choice?.pool?.available ?? null,
      costPriceMissing: costMissing(product.costPrice),
    })
  }
  return { products: rows, nextCursor: catalog.length > take ? page[page.length - 1] : null }
}

/** No cost price, or zero: profit reports would count the product's sales at no cost. */
function costMissing(costPrice: { toNumber(): number } | number | null): boolean {
  if (costPrice == null) return true
  return Number(costPrice) <= 0
}

function listingRule(r: IntendedResolution): ListingPreview['rule'] {
  switch (r.kind) {
    case 'FOLLOW': return 'follows'
    case 'PINNED': return 'fixed'
    case 'PAUSED': return 'paused'
    case 'FBA_EXCLUDED': return 'amazon-managed'
    case 'CLOSED': return 'offer-closed'
    case 'UNCOUNTED': return 'not-counted'
  }
}

/** The exact numbers a switch will send: the derivation core on the ledger the product would follow. */
export async function previewSwitch(input: { productIds?: unknown; to?: unknown; grantId?: unknown; withVariations?: unknown }): Promise<{ products: SwitchPreview[] }> {
  const { workspaceId } = requireWorkspace()
  const to = target(input.to)
  const grant = to === 'pool' ? await borrowedGrant(input.grantId, workspaceId) : null
  const ids = await withVariations(idList(input.productIds, 'products', 500), input.withVariations !== false)

  const [products, current, choices, listings, memberships, policies] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, fulfillmentMethod: true, deletedAt: true, costPrice: true } }),
    loadSyncLedgers(prisma, ids),
    loadLedgerChoices(prisma, ids, grant?.status === 'active' ? grant.id : null),
    prisma.channelListing.findMany({
      where: { productId: { in: ids }, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
      select: {
        id: true, productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true, followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, offerClosedAt: true, sourceLocationCodes: true,
        channelConnectionId: true, aliasKey: true, channelConnection: { select: { accountLabel: true } }, alias: { select: { label: true, position: true } },
      },
    }),
    prisma.sharedListingMembership.findMany({
      where: { productId: { in: ids }, status: 'ACTIVE' },
      select: { itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true, pinnedQuantity: true, channelConnectionId: true, channelConnection: { select: { accountLabel: true } } },
    }),
    loadChannelPolicies(),
  ])
  const byId = new Map(products.map((p) => [p.id, p]))
  const out: SwitchPreview[] = []
  for (const productId of ids) {
    const product = byId.get(productId)
    if (!product) continue
    const now = current.get(productId)
    const from = now?.source.kind === 'pool' ? 'pool' : 'own'
    const choice = choices.get(productId)
    const after: ProductLedger | null | undefined = to === 'pool' ? choice?.pool : choice?.own
    let refusal: string | null = null
    if (product.deletedAt) refusal = 'This product is deleted.'
    else if (to === 'pool' && grant && grant.status !== 'active') refusal = 'This shared stock is not on. Products can only switch to shared stock that is on.'
    else if (to === 'pool' && !after) refusal = `This product was not shared with this business by ${grant?.ownerWorkspace.name ?? 'the lending business'}, so it cannot use its stock.`
    else if (to === 'pool' && now?.source.kind === 'pool' && now.source.grantId !== grant?.id) refusal = 'This product already uses shared stock from another business. Switch it to its own stock first.'

    const rows: ListingPreview[] = []
    if (!refusal && after) {
      const own = listings.filter((l) => l.productId === productId)
      // How many of this product's listings share each account and market: a mark only where there is more than one.
      const coordinate = (l: (typeof own)[number]) => `${l.channel}|${l.marketplace}|${l.channelConnectionId ?? ''}`
      const perCoordinate = new Map<string, number>()
      for (const l of own) perCoordinate.set(coordinate(l), (perCoordinate.get(coordinate(l)) ?? 0) + 1)
      for (const listing of own) {
        const method = resolveCascadePushMethod({ listingFulfillmentMethod: listing.fulfillmentMethod, channel: listing.channel, fbaBucket: after.fbaBucket, productFulfillmentMethod: product.fulfillmentMethod })
        const r = resolveIntendedQuantity({
          channel: listing.channel, marketplace: listing.marketplace, isFba: method === 'FBA', offerClosed: !!listing.offerClosedAt,
          followMasterQuantity: listing.followMasterQuantity, syncPaused: listing.syncPaused, pinnedQuantity: listing.quantity,
          stockBuffer: listing.stockBuffer ?? 0, channelPolicy: policyFor(policies, listing.channel, listing.marketplace, listing.channelConnectionId),
          ...ledgerInputs(after, listing.sourceLocationCodes ?? []),
        })
        rows.push({
          listingId: listing.id, channel: listing.channel, marketplace: listing.marketplace,
          accountId: listing.channelConnectionId, accountLabel: listing.channelConnection?.accountLabel ?? null,
          listingMark: (perCoordinate.get(coordinate(listing)) ?? 1) > 1 ? (listing.aliasKey ? listing.alias?.position ?? null : 0) : null,
          aliasLabel: listing.aliasKey ? listing.alias?.label ?? null : null,
          showsNow: listing.quantity, willShow: r.kind === 'FOLLOW' ? r.quantity : null, rule: listingRule(r),
        })
      }
      for (const m of memberships.filter((x) => x.productId === productId)) {
        const inputs = ledgerInputs(after)
        const r = resolveMembershipIntended({
          marketplace: m.marketplace, followPool: m.followPool, pinnedQuantity: m.pinnedQuantity, stockBuffer: m.stockBuffer ?? 0,
          channelPolicy: policyFor(policies, 'EBAY', m.marketplace, m.channelConnectionId), ledger: inputs.ledger, uncountedIsZero: inputs.uncountedIsZero,
        })
        rows.push({
          listingId: null, itemId: m.itemId, channel: 'EBAY', marketplace: m.marketplace,
          accountId: m.channelConnectionId, accountLabel: m.channelConnection?.accountLabel ?? null, listingMark: null, aliasLabel: null,
          showsNow: m.lastQtyPushed,
          willShow: r.kind === 'FOLLOW' ? r.quantity : null, rule: !m.followPool ? 'excluded' : listingRule(r),
        })
      }
    }
    out.push({ productId, sku: product.sku, from, to, refusal, costPriceMissing: costMissing(product.costPrice), listings: rows })
  }
  return { products: out }
}

/**
 * Switch products (with their variations) to the shared stock of `grantId`, or back to this business's
 * own stock. All or nothing: if one product cannot switch, none does, and the refusal names it.
 */
export async function switchProducts(input: { productIds?: unknown; to?: unknown; grantId?: unknown; withVariations?: unknown }): Promise<{ switched: number; unchanged: number }> {
  const { workspaceId, actorUserId } = actingPerson()
  const to = target(input.to)
  await workspaces.requireOwner(actorUserId, workspaceId)
  const grant = to === 'pool' ? await borrowedGrant(input.grantId, workspaceId) : null
  if (grant && grant.status !== 'active') throw new WorkspaceError('grant_state', 'Products can only switch to shared stock that is on.', 409)
  const ids = await withVariations(idList(input.productIds, 'products', 500), input.withVariations !== false)

  const result = await prisma.$transaction(async (tx) => {
    const active = await tx.stockPoolLink.findMany({ where: { productId: { in: ids }, status: 'active' }, select: { id: true, productId: true, grantId: true } })
    const activeByProduct = new Map(active.map((l) => [l.productId, l]))
    let switched = 0
    let unchanged = 0
    if (to === 'own') {
      const now = new Date()
      for (const productId of ids) {
        const link = activeByProduct.get(productId)
        if (!link) { unchanged++; continue }
        await tx.stockPoolLink.update({ where: { id: link.id }, data: { status: 'ended', endedAt: now, endedByUserId: actorUserId, endedReason: 'Switched to this business\'s own stock.' } })
        switched++
      }
    } else {
      const products = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true } })
      const skuOf = new Map(products.map((p) => [p.id, p.sku]))
      const catalog = await tx.catalogLink.findMany({
        where: { targetWorkspaceId: workspaceId, targetProductId: { in: ids }, sourceWorkspaceId: grant!.ownerWorkspaceId, status: 'active' },
        select: { id: true, targetProductId: true, sourceProductId: true },
      })
      const catalogByProduct = new Map(catalog.map((c) => [c.targetProductId, c]))
      for (const productId of ids) {
        const existing = activeByProduct.get(productId)
        if (existing?.grantId === grant!.id) { unchanged++; continue }
        const sku = skuOf.get(productId) ?? productId
        if (existing) throw new WorkspaceError('product_already_pooled', `${sku} already uses shared stock from another business. Switch it to its own stock first.`, 409)
        const link = catalogByProduct.get(productId)
        if (!link) throw new WorkspaceError('product_not_shared', `${sku} was not shared with this business by ${grant!.ownerWorkspace.name}, so it cannot use its stock.`, 409)
        try {
          await tx.stockPoolLink.create({ data: { grantId: grant!.id, catalogLinkId: link.id, productId, sourceProductId: link.sourceProductId, createdByUserId: actorUserId } })
        } catch (error) {
          throw new WorkspaceError('product_refused', `${sku}: ${databaseReason(error)}`, 409)
        }
        switched++
      }
    }
    await tx.workspaceAudit.create({
      data: {
        workspaceId, actorUserId, action: to === 'pool' ? 'stock_pool.products_to_pool' : 'stock_pool.products_to_own', targetId: grant?.id ?? null,
        metadata: { productIds: ids, switched, unchanged } as Prisma.InputJsonValue,
      },
    })
    return { switched, unchanged }
  })
  if (result.switched > 0) afterPoolChange()
  return result
}

/** The guard's sentence, without Prisma's wrapping. */
function databaseReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const match = /message: "([^"]+)"/.exec(text) ?? /ERROR:\s+(.+)$/m.exec(text)
  return (match?.[1] ?? text).replace(/\.$/, '') + '.'
}
