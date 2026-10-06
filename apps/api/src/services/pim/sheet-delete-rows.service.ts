/**
 * Delete rows from the product sheet (Owner, 2026-10-06): "I don't have the ability to delete any rows I create by
 * accident, or any products or any rows I actually want to delete for any reason at all … It should be for the whole
 * product information or the whole product sheet instead of just one scope."
 *
 * One rule for every view of the sheet (Shared and each channel · market), read for the confirm and read AGAIN inside
 * the transaction that writes:
 *   - a Shared row, or a row of the Main listing, deletes the PRODUCT: it goes to the recycle bin with everything it
 *     holds on every channel and market. The family's main row takes the whole family with it.
 *   - the main row of an extra listing (alias) removes that listing only: it is archived, and its products stay,
 *     because the Main listing sells the same products. A colour row of an extra listing on its own is refused: it is
 *     the same product as the Main listing's row (Status Not listed leaves it out of that listing).
 *   - a row with a listing still on a channel (a channel id, or an ACTIVE eBay variation membership) is refused, with
 *     the way out (Action Delete, then Publish). Nexus would
 *     stop managing a listing that keeps selling, and the stock sync still pushes to the listings of a binned product
 *     and of an archived alias.
 * Restore (the confirm's Undo) puts back exactly what a delete moved: the products out of the bin, the aliases ACTIVE.
 */
import type { Prisma } from '@prisma/client'
import { channelLabel } from '@nexus/shared/channel-label'
import { identityHeld } from '@nexus/shared/listing-risk'
import prisma from '../../db.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { relationshipTransaction } from './product-relationship.service.js'

export const SHEET_DELETE_MAX_ROWS = 500

export interface SheetDeleteRow { productId: string; aliasId: string | null }

export interface SheetDeleteRefusal { productId: string; aliasId: string | null; sku: string; reason: string }

export interface SheetDeletePlan {
  rootId: string
  rootSku: string
  /** Products the delete moves to the recycle bin; the family's main product first. */
  products: Array<{ id: string; sku: string }>
  /** Extra listings (aliases) the delete archives. */
  aliases: Array<{ id: string; label: string; channel: string; marketplace: string }>
  /** The family's main product is among `products`: the product page closes. */
  familyDeleted: boolean
  refusals: SheetDeleteRefusal[]
}

export class SheetDeleteError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409, readonly code = statusCode === 409 ? 'conflict' : statusCode === 404 ? 'not_found' : 'invalid_request') {
    super(message)
    this.name = 'SheetDeleteError'
  }
}

type Db = Prisma.TransactionClient | typeof prisma

interface ListingFacts {
  productId: string
  channel: string
  marketplace: string
  aliasKey: string
  externalListingId: string | null
  isPublished: boolean | null
  listingStatus: string | null
  offerClosedAt: Date | null
}

const ID_WORD: Record<string, string> = { AMAZON: 'ASIN', EBAY: 'Item ID' }

/**
 * Still on the channel: it holds the channel's id, or it is a published Amazon listing whose ASIN is not read back yet
 * (the shared `identityHeld` rule) — unless the channel ended it, or Amazon's offer is closed for that market.
 * Action Delete + Publish leaves `NOT_LISTED` with no id, so such a row can be deleted. `isPublished` alone is not
 * enough: it defaults to true, and a row with no id is nothing the channel or the stock sync can reach.
 */
export function listingStillOnChannel(listing: Omit<ListingFacts, 'productId' | 'aliasKey' | 'marketplace'>): boolean {
  if (listing.offerClosedAt) return false
  if ((listing.listingStatus ?? '').toUpperCase() === 'ENDED') return false
  return identityHeld(listing)
}

const MAX_PLACES = 4

function stillOnSentence(subject: string, live: ListingFacts[], aliasLabels: Map<string, string>): string {
  const places = [...new Set(live.map((l) => {
    const id = l.externalListingId?.trim()
    const listing = l.aliasKey ? `, ${aliasLabels.get(l.aliasKey) ?? 'an extra listing'}` : ''
    const held = id ? ` (${ID_WORD[l.channel] ?? 'id'} ${id})` : ' (ASIN not read back yet)'
    return `${channelLabel(l.channel)} · ${l.marketplace}${listing}${held}`
  }))].sort()
  const shown = places.slice(0, MAX_PLACES).join('; ')
  const more = places.length > MAX_PLACES ? `; and ${places.length - MAX_PLACES} more` : ''
  return `${subject} is still on ${shown}${more}. Set its Action to Delete and press Publish first, then delete the row.`
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length

/** What deleting these rows would do, from what the database holds now. Reads only. */
export async function planSheetDelete(db: Db, productId: string, rows: readonly SheetDeleteRow[]): Promise<SheetDeletePlan> {
  if (!rows.length) throw new SheetDeleteError('Tick the rows to delete first.', 400)
  if (rows.length > SHEET_DELETE_MAX_ROWS) throw new SheetDeleteError(`Delete at most ${SHEET_DELETE_MAX_ROWS} rows at a time; ${rows.length} are ticked.`, 400)
  const seed = await db.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!seed) throw new SheetDeleteError('This product is not in Nexus any more. Reload the page.', 404)
  const rootId = seed.parentId ?? seed.id
  const family = await db.product.findMany({ where: { OR: [{ id: rootId }, { parentId: rootId }], deletedAt: null }, select: { id: true, sku: true } })
  const root = family.find((p) => p.id === rootId)
  if (!root) throw new SheetDeleteError('This product is not in Nexus any more. Reload the page.', 404)
  const byId = new Map(family.map((p) => [p.id, p]))

  const aliasIds = [...new Set(rows.flatMap((r) => (r.aliasId ? [r.aliasId] : [])))]
  const aliasRows = aliasIds.length
    ? await db.productListingAlias.findMany({ where: { id: { in: aliasIds } }, select: { id: true, productId: true, label: true, channel: true, marketplace: true, status: true } })
    : []
  const aliasById = new Map(aliasRows.map((a) => [a.id, a]))
  const aliasMainRowTicked = new Set(rows.filter((r) => r.aliasId && r.productId === rootId).map((r) => r.aliasId as string))

  const refusals: SheetDeleteRefusal[] = []
  const productTargets = new Set<string>()
  const aliasTargets = new Set<string>()
  for (const row of rows) {
    const product = byId.get(row.productId)
    if (!product) {
      refusals.push({ productId: row.productId, aliasId: row.aliasId, sku: row.productId, reason: 'This row is not in this product family any more. Reload the page.' })
      continue
    }
    if (!row.aliasId) { productTargets.add(product.id); continue }
    const alias = aliasById.get(row.aliasId)
    if (!alias || alias.productId !== rootId) {
      refusals.push({ productId: product.id, aliasId: row.aliasId, sku: product.sku, reason: 'This extra listing is not on this product any more. Reload the page.' })
      continue
    }
    // Already archived: a repeat after a lost answer, nothing left to do.
    if (alias.status !== 'ACTIVE') continue
    if (product.id === rootId) { aliasTargets.add(alias.id); continue }
    // Its listing goes with the extra listing's main row.
    if (aliasMainRowTicked.has(alias.id)) continue
    refusals.push({ productId: product.id, aliasId: alias.id, sku: product.sku,
      reason: `${product.sku} in ${alias.label} is the same product as in the Main listing. To leave it out of this listing, set its Status to Not listed. To delete the product everywhere, tick its row in the Main listing.` })
  }

  // The family's main row takes the whole family, and every listing it holds, aliases included.
  const familyTargeted = productTargets.has(rootId)
  const binIds = familyTargeted ? family.map((p) => p.id) : [...productTargets]
  if (familyTargeted) aliasTargets.clear()
  const aliasTargetIds = [...aliasTargets]

  const listings: ListingFacts[] = binIds.length || aliasTargetIds.length
    ? await db.channelListing.findMany({
        where: { OR: [...(binIds.length ? [{ productId: { in: binIds } }] : []), ...(aliasTargetIds.length ? [{ aliasKey: { in: aliasTargetIds } }] : [])] },
        select: { productId: true, channel: true, marketplace: true, aliasKey: true, externalListingId: true, isPublished: true, listingStatus: true, offerClosedAt: true },
      })
    : []
  // An eBay variation sells through its item's membership (the stock sync pushes to it), whatever the product's own
  // listing row holds.
  const memberships = binIds.length
    ? await db.sharedListingMembership.findMany({ where: { productId: { in: binIds }, status: 'ACTIVE' }, select: { productId: true, marketplace: true, itemId: true } })
    : []
  const live = [...listings.filter(listingStillOnChannel), ...memberships.flatMap((m): ListingFacts[] => m.productId ? [{ productId: m.productId, channel: 'EBAY',
    marketplace: m.marketplace, aliasKey: '', externalListingId: m.itemId, isPublished: true, listingStatus: 'ACTIVE', offerClosedAt: null }] : [])]
  const labelKeys = [...new Set(live.flatMap((l) => (l.aliasKey ? [l.aliasKey] : [])))]
  const aliasLabels = new Map((labelKeys.length
    ? await db.productListingAlias.findMany({ where: { id: { in: labelKeys } }, select: { id: true, label: true } })
    : []).map((a) => [a.id, a.label]))

  const products: SheetDeletePlan['products'] = []
  if (familyTargeted) {
    const held = live.filter((l) => binIds.includes(l.productId))
    if (held.length) {
      refusals.push({ productId: rootId, aliasId: null, sku: root.sku, reason: stillOnSentence(`The family ${root.sku}`, held, aliasLabels) })
    } else {
      products.push(root, ...family.filter((p) => p.id !== rootId).sort((a, b) => a.sku.localeCompare(b.sku)))
    }
  } else {
    for (const id of binIds) {
      const product = byId.get(id)!
      const held = live.filter((l) => l.productId === id)
      if (held.length) refusals.push({ productId: id, aliasId: null, sku: product.sku, reason: stillOnSentence(product.sku, held, aliasLabels) })
      else products.push(product)
    }
    products.sort((a, b) => a.sku.localeCompare(b.sku))
  }

  const aliases: SheetDeletePlan['aliases'] = []
  for (const id of aliasTargetIds) {
    const alias = aliasById.get(id)!
    const held = live.filter((l) => l.aliasKey === id)
    if (held.length) refusals.push({ productId: rootId, aliasId: id, sku: alias.label, reason: stillOnSentence(alias.label, held, aliasLabels) })
    else aliases.push({ id, label: alias.label, channel: alias.channel, marketplace: alias.marketplace })
  }
  aliases.sort((a, b) => a.label.localeCompare(b.label))

  return { rootId, rootSku: root.sku, products: products.map((p) => ({ id: p.id, sku: p.sku })), aliases, familyDeleted: products.some((p) => p.id === rootId), refusals }
}

/** The confirm's read. */
export const previewSheetDelete = (productId: string, rows: readonly SheetDeleteRow[]) => planSheetDelete(prisma, productId, rows)

export interface SheetDeleteExpected { products: string[]; aliases: string[] }

/**
 * Delete what the person confirmed. The plan is read again inside the transaction; when it no longer moves exactly the
 * products and aliases the confirm named, nothing is written.
 */
export async function deleteSheetRows(productId: string, rows: readonly SheetDeleteRow[], expected: SheetDeleteExpected, actor: string | null) {
  return relationshipTransaction(async (tx) => {
    const plan = await planSheetDelete(tx, productId, rows)
    if (!sameSet(plan.products.map((p) => p.id), expected.products) || !sameSet(plan.aliases.map((a) => a.id), expected.aliases))
      throw new SheetDeleteError('These rows changed since the check. Nothing was deleted. Press Delete again to see what it does now.', 409)
    const now = new Date()
    if (plan.products.length) {
      const ids = plan.products.map((p) => p.id)
      const moved = await tx.product.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: now } })
      if (moved.count !== ids.length) throw new SheetDeleteError('A product changed while it was being deleted. Nothing was deleted. Reload the page.', 409)
      // One audit row per product, as the recycle bin's own action writes them.
      await tx.auditLog.createMany({ data: plan.products.map((p) => ({ userId: actor, entityType: 'Product', entityId: p.id, action: 'soft-delete',
        before: { deletedAt: null }, after: { deletedAt: now.toISOString() }, metadata: { sku: p.sku, source: 'product-sheet' } })) })
    }
    if (plan.aliases.length) {
      const ids = plan.aliases.map((a) => a.id)
      const archived = await tx.productListingAlias.updateMany({ where: { id: { in: ids }, status: 'ACTIVE' }, data: { status: 'ARCHIVED' } })
      if (archived.count !== ids.length) throw new SheetDeleteError('An extra listing changed while it was being deleted. Nothing was deleted. Reload the page.', 409)
      await tx.auditLog.createMany({ data: plan.aliases.map((a) => ({ userId: actor, entityType: 'ProductListingAlias', entityId: a.id, action: 'archive',
        before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' }, metadata: { label: a.label, channel: a.channel, marketplace: a.marketplace, productId: plan.rootId, source: 'product-sheet' } })) })
    }
    // The products grid reads the cache: the binned rows leave it, and the family's own row is repainted, in this commit.
    await productReadCacheService.refreshInTransaction(tx, [...new Set([plan.rootId, ...plan.products.map((p) => p.id)])])
    return { ...plan, deleted: { products: plan.products.length, aliases: plan.aliases.length } }
  })
}

/**
 * Undo a sheet delete: the products out of the recycle bin, the aliases ACTIVE again. Only what belongs to this family
 * (its main product may itself be in the bin). A product or alias already back is left as it is.
 */
export async function restoreSheetRows(productId: string, input: SheetDeleteExpected, actor: string | null) {
  const productIds = [...new Set(input.products)]
  const aliasIds = [...new Set(input.aliases)]
  if (!productIds.length && !aliasIds.length) throw new SheetDeleteError('Name the products or listings to restore.', 400)
  if (productIds.length + aliasIds.length > SHEET_DELETE_MAX_ROWS) throw new SheetDeleteError(`Restore at most ${SHEET_DELETE_MAX_ROWS} at a time.`, 400)
  return relationshipTransaction(async (tx) => {
    const seed = await tx.product.findUnique({ where: { id: productId }, select: { id: true, parentId: true } })
    if (!seed) throw new SheetDeleteError('This product is not in Nexus any more.', 404)
    const rootId = seed.parentId ?? seed.id
    const products = productIds.length
      ? await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, parentId: true, deletedAt: true } })
      : []
    if (products.length !== productIds.length || products.some((p) => p.id !== rootId && p.parentId !== rootId))
      throw new SheetDeleteError('These products are not in this family. Nothing was restored.', 409)
    const rootBinned = await tx.product.findFirst({ where: { id: rootId, deletedAt: { not: null } }, select: { id: true } })
    if (rootBinned && !productIds.includes(rootId))
      throw new SheetDeleteError('The family\'s main product is in the recycle bin. Restore it with them. Nothing was restored.', 409)
    const aliases = aliasIds.length
      ? await tx.productListingAlias.findMany({ where: { id: { in: aliasIds } }, select: { id: true, productId: true, label: true, channel: true, marketplace: true, status: true } })
      : []
    if (aliases.length !== aliasIds.length || aliases.some((a) => a.productId !== rootId))
      throw new SheetDeleteError('These listings are not on this product. Nothing was restored.', 409)

    const binned = products.filter((p) => p.deletedAt !== null)
    if (binned.length) {
      await tx.product.updateMany({ where: { id: { in: binned.map((p) => p.id) }, deletedAt: { not: null } }, data: { deletedAt: null } })
      await tx.auditLog.createMany({ data: binned.map((p) => ({ userId: actor, entityType: 'Product', entityId: p.id, action: 'restore',
        before: { deletedAt: p.deletedAt?.toISOString() ?? null }, after: { deletedAt: null }, metadata: { sku: p.sku, source: 'product-sheet' } })) })
    }
    const archived = aliases.filter((a) => a.status === 'ARCHIVED')
    if (archived.length) {
      await tx.productListingAlias.updateMany({ where: { id: { in: archived.map((a) => a.id) }, status: 'ARCHIVED' }, data: { status: 'ACTIVE' } })
      await tx.auditLog.createMany({ data: archived.map((a) => ({ userId: actor, entityType: 'ProductListingAlias', entityId: a.id, action: 'restore',
        before: { status: 'ARCHIVED' }, after: { status: 'ACTIVE' }, metadata: { label: a.label, channel: a.channel, marketplace: a.marketplace, productId: rootId, source: 'product-sheet' } })) })
    }
    await productReadCacheService.refreshInTransaction(tx, [...new Set([rootId, ...binned.map((p) => p.id)])])
    return { rootId, restored: { products: binned.length, aliases: archived.length } }
  })
}

/** The request body's rows, refused in plain words when malformed. */
export function parseSheetDeleteRows(body: unknown): SheetDeleteRow[] {
  const rows = (body as { rows?: unknown } | null)?.rows
  if (!Array.isArray(rows)) throw new SheetDeleteError('rows must be a list of { productId, aliasId }.', 400)
  return rows.map((row) => {
    const r = row as { productId?: unknown; aliasId?: unknown }
    if (typeof r?.productId !== 'string' || !r.productId.trim()) throw new SheetDeleteError('Each row needs its productId.', 400)
    if (r.aliasId != null && (typeof r.aliasId !== 'string' || !r.aliasId.trim())) throw new SheetDeleteError('A row\'s aliasId must be text or null.', 400)
    return { productId: r.productId.trim(), aliasId: typeof r.aliasId === 'string' ? r.aliasId.trim() : null }
  })
}

/** `{ products: string[], aliases: string[] }`, as the confirm named them. */
export function parseSheetDeleteExpected(value: unknown): SheetDeleteExpected {
  const v = value as { products?: unknown; aliases?: unknown } | null
  const list = (x: unknown, name: string) => {
    if (x === undefined) return []
    if (!Array.isArray(x) || x.some((id) => typeof id !== 'string' || !id.trim())) throw new SheetDeleteError(`${name} must be a list of ids.`, 400)
    return x as string[]
  }
  return { products: list(v?.products, 'products'), aliases: list(v?.aliases, 'aliases') }
}
