/**
 * Sharing studio step 4 — a listing's own CONTENT, copied once into the drafts the receiving business made from the
 * shared product's layout (plan docs/2026-09-28-sharing-review-and-plan.md §13; the share's "listings" group).
 *
 * The only writer is the catalog transfer engine, as for a file import and the live sync:
 *   1. the database door (`nexus_assortment_sync_source`, via `linkSource`) names the shared product and its
 *      variations, for this business's own active link;
 *   2. in the sharing business's context, as the system, the rows of the listings at ONE coordinate (channel, market,
 *      its account of the given rank) are exported as the engine exports a file (`catalogRows`, listings only), with
 *      the channel field of each row, so each field is classified (`classifyListingField`: an allow-list);
 *   3. back here, each copied row moves to this business's coordinate: its SKU (through the share's links), its
 *      account, its alias of the same name; only a listing that is still a DRAFT here (never published, no channel id)
 *      receives rows — a listing on a channel is never changed;
 *   4. the engine plans the rows against THIS business's channel contract and applies them, without queueing any
 *      channel push. A field the contract refuses is left out and named.
 */
import { transferCategoryField, transferIsStore, type TransferRow } from '@nexus/shared/catalog-transfer'
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { WorkspaceError, requireWorkspace, withWorkspace } from '../../lib/workspace-context.js'
import { listActiveConnections } from '../connection-resolver.service.js'
import { catalogRows, productInclude } from '../pim/catalog-transfer-export.js'
import { buildTransferPlan, managedChannelField, transferContracts } from '../pim/catalog-transfer-plan.js'
import { applyTransferTarget, loadTransferContext } from '../pim/catalog-transfer.service.js'
import { linkSource, type LinkSource } from './copy-source.service.js'
import { classifyListingField } from './field-groups.js'
import { marketLanguages } from '../pim/market-languages.js'
import { logger } from '../../utils/logger.js'

const LIVE_OR_DRAFT = { notIn: ['ENDED', 'REMOVED'] }

export interface ListingContentResult {
  /** Drafts here that received content (one per product, per main listing or alias). */
  listings: number
  /** Values written into those drafts (per field and language). */
  copied: number
  /** Fields of the sharing business's listings that stay with each business (offer terms, shipping, policies, …). */
  notShared: number
  /** Refused by this business's channel contract, with the reason: one field of a listing, or (field null) all of it. */
  refused: Array<{ listing: string; field: string | null; message: string }>
  /** Listings not copied because neither business has a channel category for them (and no default is mapped here). */
  noCategory: string[]
  /** Listings here left unchanged, by alias name or "main listing": already on a channel … */
  onChannel: string[]
  /** … or a draft that already has content of its own (a copy is made once; after that it is this business's). */
  ownContent: string[]
  /** Languages the sharing business writes this listing in that this business's market does not carry: not copied. */
  otherLanguages: string[]
  /** The copy as a whole could not be made (the drafts were): why, in words. */
  error: string | null
}

const MAIN = 'main listing'

interface Coordinate { channel: string; marketplace: string; sourceAccount: number }

interface SourceListings {
  /** The copyable rows (the allow-list), with the SHARING business's SKUs and alias ids. */
  rows: TransferRow[]
  notShared: number
  /** The sharing business's alias id → its name. */
  labelOf: Map<string, string>
  /** The sharing business's SKU → product id. */
  idOf: Map<string, string>
  rootSku: string
}

/**
 * The sharing business's listing rows at ONE coordinate (channel, market, its account of the given rank), read in its
 * context as the system and filtered to the fields a copy may carry. Call in the FOLLOWER's context, with the door the
 * database gave it for its own link; the context is checked back.
 */
async function readSourceListings(door: LinkSource, group: Coordinate): Promise<SourceListings | null> {
  const follower = requireWorkspace()
  const root = door.source!
  const sourceIds = [root.id, ...door.variations.map((v) => v.id)]
  const { channel, marketplace } = group
  const read = await withWorkspace({ workspaceId: door.ownerWorkspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, async (): Promise<SourceListings | null> => {
    const connection = (await listActiveConnections(channel))[group.sourceAccount - 1]
    if (!connection) return null
    const [listings, aliases, products, families] = await Promise.all([
      prisma.channelListing.findMany({
        where: { productId: { in: sourceIds }, channel, marketplace, channelConnectionId: connection.id, listingStatus: LIVE_OR_DRAFT },
        select: { id: true, productId: true, aliasKey: true },
      }),
      prisma.productListingAlias.findMany({ where: { productId: root.id, channel, marketplace, channelConnectionId: connection.id, status: 'ACTIVE' }, select: { id: true, label: true } }),
      prisma.product.findMany({ where: { id: { in: sourceIds }, deletedAt: null }, include: productInclude, orderBy: { sku: 'asc' } }),
      prisma.productFamily.findMany({ select: { id: true, code: true } }),
    ])
    const labelOf = new Map(aliases.map((a) => [a.id, a.label]))
    const idOf = new Map(products.map((p) => [p.sku, p.id]))
    // An archived alias is not part of the layout, so it is not copied either.
    const kept = listings.filter((l) => l.aliasKey === '' || labelOf.has(l.aliasKey))
    const out: SourceListings = { rows: [], notShared: 0, labelOf, idOf, rootSku: root.sku }
    if (!kept.length) return out
    const copyable = await copyableRows(products, kept.map((l) => ({ ...l, channel, marketplace, channelConnectionId: connection.id })), marketplace, families)
    out.rows = copyable.rows
    out.notShared = copyable.notShared
    return out
  })
  // Back in this business's context: nothing below may touch the other business's tables.
  if (requireWorkspace().workspaceId !== follower.workspaceId) throw new WorkspaceError('context_leak', 'The business context did not return to the follower.', 500)
  return read
}

/**
 * Per layout group key: the slots ('' = the main listing, else the alias name in lower case) whose listing in the
 * sharing business has content a copy would carry (a text or item specific of its own; a category alone is not). null: the
 * share does not offer listing content. Call in the FOLLOWER's context.
 */
export async function sourceContentSlots(linkId: string, groups: Array<Coordinate & { key: string }>): Promise<Map<string, Set<string>> | null> {
  const door = await linkSource(linkId)
  if (!door.source || door.source.deleted || !(door.fieldGroups as string[]).includes('listings')) return null
  const out = new Map<string, Set<string>>()
  for (const group of groups) {
    // A coordinate the sharing business cannot export (a market with no language set) has nothing to offer here.
    const source = await readSourceListings(door, group).catch((error: unknown) => {
      logger.warn('[assortment] listing content not readable', { linkId, group: group.key, error: error instanceof Error ? error.message : String(error) })
      return null
    })
    const slots = new Set<string>()
    for (const row of source?.rows ?? []) {
      if (row.sku !== source!.rootSku || row.action !== 'SET' || row.field === transferCategoryField(group.channel)) continue
      slots.add(row.aliasKey ? String(source!.labelOf.get(row.aliasKey) ?? '').trim().toLowerCase() : '')
    }
    out.set(group.key, slots)
  }
  return out
}

/**
 * Copy one layout group's content into this business's drafts on `accountId`: every draft of the family there that has
 * no listing content of its own receives the sharing business's rows for the same product and listing (main, or the
 * alias of the same name). Call in the FOLLOWER's context. null: the share does not offer listing content.
 */
export async function copyListingContent(input: { linkId: string; rootId: string; group: Coordinate; accountId: string }): Promise<ListingContentResult | null> {
  const follower = requireWorkspace()
  const result: ListingContentResult = { listings: 0, copied: 0, notShared: 0, refused: [], noCategory: [], onChannel: [], ownContent: [], otherLanguages: [], error: null }
  const door = await linkSource(input.linkId)
  if (!door.source || door.source.deleted) throw new WorkspaceError('source_gone', 'The shared product is no longer shared, so its listing content cannot be read.', 409)
  if (!(door.fieldGroups as string[]).includes('listings')) return null
  const { channel, marketplace } = input.group
  const categoryKey = transferCategoryField(channel)

  // ── 2. The sharing business's rows for this one coordinate, filtered to what a copy may carry ──
  const source = await readSourceListings(door, input.group)
  if (!source || !source.rows.length) { result.notShared = source?.notShared ?? 0; return result }
  result.notShared = source.notShared

  // ── 3. Move each copied row to this business's coordinate ──
  const links = await prisma.catalogLink.findMany({
    where: { shareId: door.shareId, targetWorkspaceId: follower.workspaceId, status: 'active', sourceProductId: { in: [...source.idOf.values()] } },
    select: { sourceProductId: true, targetProductId: true },
  })
  const targetOf = new Map(links.map((l) => [l.sourceProductId, l.targetProductId]))
  const [targets, aliases] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: [...targetOf.values()] }, deletedAt: null }, select: { id: true, sku: true } }),
    prisma.productListingAlias.findMany({ where: { productId: input.rootId, channel, marketplace, channelConnectionId: input.accountId, status: 'ACTIVE' }, select: { id: true, label: true } }),
  ])
  const targetSku = new Map(targets.map((t) => [t.id, t.sku]))
  const aliasByLabel = new Map(aliases.map((a) => [a.label.trim().toLowerCase(), a.id]))
  const here = await prisma.channelListing.findMany({
    where: { productId: { in: targets.map((t) => t.id) }, channel, marketplace, channelConnectionId: input.accountId, listingStatus: LIVE_OR_DRAFT },
    select: { id: true, productId: true, aliasKey: true, listingStatus: true, isPublished: true, externalListingId: true, platformAttributes: true },
  })
  const nameOf = (aliasKey: string) => aliasKey ? aliases.find((a) => a.id === aliasKey)?.label ?? aliasKey : MAIN
  const drafts = here.filter((l) => l.listingStatus === 'DRAFT' && !l.isPublished && !l.externalListingId)
  const owned = await draftsWithOwnContent(drafts, targets.map((t) => t.id), marketplace)
  const open = new Set(drafts.filter((l) => !owned.has(l.id)).map((l) => `${l.productId}|${l.aliasKey}`))
  // Named only where the sharing business has content to copy into it: the family's main listing or alias.
  const rootId = input.rootId
  const withContent = new Set(source.rows.filter((row) => row.action === 'SET' && row.field !== categoryKey).map((row) => row.aliasKey ? String(source.labelOf.get(row.aliasKey) ?? '').trim().toLowerCase() : ''))
  const named = (l: { productId: string; aliasKey: string }) => l.productId === rootId && withContent.has(l.aliasKey ? nameOf(l.aliasKey).trim().toLowerCase() : '')
  const names = (list: typeof here) => [...new Set(list.filter(named).map((l) => nameOf(l.aliasKey)))].sort((a, b) => a === MAIN ? -1 : b === MAIN ? 1 : a.localeCompare(b))
  result.onChannel = names(here.filter((l) => !drafts.includes(l)))
  result.ownContent = names(drafts.filter((l) => owned.has(l.id)))

  // A text in a language this business's market does not carry has nowhere to go: it is left out and named.
  const languages = new Set((await marketLanguages(channel, marketplace).catch(() => [] as string[])).map((language) => language.toLowerCase()))
  const otherLanguages = new Set<string>()
  // The category travels only as a value (never "follow the default", which would clear one chosen here), and only
  // into a draft that has none: a category chosen here stays.
  const storedCategory = new Map(drafts.map((l) => [`${l.productId}|${l.aliasKey}`, (l.platformAttributes as Record<string, unknown> | null)?.[categoryKey] ?? null]))
  const rows: TransferRow[] = []
  for (const row of source.rows) {
    if (row.locale && !languages.has(row.locale.toLowerCase())) { if (row.action === 'SET') otherLanguages.add(row.locale.toLowerCase()); continue }
    const sourceProductId = source.idOf.get(row.sku)
    const targetId = sourceProductId ? targetOf.get(sourceProductId) : undefined
    const sku = targetId ? targetSku.get(targetId) : undefined
    if (!targetId || !sku) continue // a variation this business does not follow: nothing to copy it into
    const aliasKey = row.aliasKey ? aliasByLabel.get(String(source.labelOf.get(row.aliasKey) ?? '').trim().toLowerCase()) : ''
    if (aliasKey === undefined) continue // the alias was not made here
    if (!open.has(`${targetId}|${aliasKey}`)) continue // on a channel, or already this business's own
    if (row.field === categoryKey && (row.action !== 'SET' || storedCategory.get(`${targetId}|${aliasKey}`))) continue
    // The source version names the OTHER business's record; here it would read as a stale export.
    const { version: _sourceVersion, ...rest } = row
    rows.push({ ...rest, sku, accountId: input.accountId, aliasKey })
  }
  result.otherLanguages = [...otherLanguages].sort()
  if (!rows.length) return result

  // ── 4. Per listing: plan against this business's contract, and apply; a refused field is left out and named ──
  const skus = new Set(targets.map((t) => t.sku))
  const idOfSku = new Map(targets.map((t) => [t.sku, t.id]))
  const context = await loadTransferContext(rows, prisma)
  const byListing = new Map<string, TransferRow[]>()
  for (const row of rows) byListing.set(`${row.sku}|${row.aliasKey}`, [...(byListing.get(`${row.sku}|${row.aliasKey}`) ?? []), row])
  const noCategory = new Set<string>()
  for (const group of byListing.values()) {
    // A listing that only follows the product over there has nothing of its own to copy: not a refusal, nothing to do.
    if (!group.some((row) => row.action === 'SET')) continue
    const { sku, aliasKey } = group[0]
    const name = nameOf(aliasKey)
    const hasCategory = transferIsStore(channel) || group.some((row) => row.field === categoryKey)
      || !!storedCategory.get(`${idOfSku.get(sku)}|${aliasKey}`) || !!context.categoryDefaults?.[JSON.stringify([sku, channel, marketplace])]
    if (!hasCategory) { if (idOfSku.get(sku) === rootId) noCategory.add(name); continue }
    const refused = await applyListingRows(group, marketplace, skus, `assortment-listing-content:${input.linkId}`)
    const applied = group.filter((row) => !refused.fields.has(row.field))
    if (refused.whole) result.refused.push({ listing: name, field: null, message: refused.whole })
    else for (const [field, message] of refused.fields) result.refused.push({ listing: name, field, message })
    if (refused.whole || !applied.length) continue
    result.copied += applied.filter((row) => row.action === 'SET' || row.action === 'CLEAR').length
    result.listings++
  }
  result.noCategory = [...noCategory].sort((a, b) => a === MAIN ? -1 : b === MAIN ? 1 : a.localeCompare(b))
  return result
}

/**
 * A listing's rows as the engine exports them (listings only, no price or stock: `catalogRows` leaves managed fields out
 * of a bounded export), split into what a copy may carry and a count of the rest. Each row is classified by the field
 * its channel declares for the category the row was read under (its own, or the mapped default).
 */
async function copyableRows(
  products: Array<Prisma.ProductGetPayload<{ include: typeof productInclude }>>,
  listings: Array<{ id: string; productId: string; channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string }>,
  market: string,
  families?: Array<{ id: string; code: string }>,
): Promise<{ rows: TransferRow[]; notShared: number }> {
  const out = { rows: [] as TransferRow[], notShared: 0 }
  const root = products.find((p) => !p.parentId) ?? products[0]
  if (!root || !listings.length) return out
  const contracts = transferContracts(market, { allowIncompleteSchema: true, allowUnknownMarket: true })
  const boundary = {
    productId: root.id, rootId: root.id,
    products: products.map((p) => ({ id: p.id, sku: p.sku, parentId: p.parentId })),
    includeShared: false,
    listings: listings.map((l) => ({ id: l.id, productId: l.productId, channel: l.channel, accountId: l.channelConnectionId!, marketplace: l.marketplace, aliasKey: l.aliasKey })),
    locales: [],
  }
  const meta = new WeakMap<TransferRow, { category: string }>()
  const rows = await catalogRows(products, { market, boundary }, contracts, families ?? await prisma.productFamily.findMany({ select: { id: true, code: true } }), meta as never)
  const fields = new Map<string, { group: string; managed: boolean }>()
  const at = (row: TransferRow) => `${row.channel}|${row.accountId}|${meta.get(row)?.category ?? ''}`
  for (const coordinate of new Set(rows.map(at))) {
    const [channel, accountId, category] = coordinate.split('|')
    const contract = await contracts.channel(channel, market, category, accountId)
    for (const field of contract.fields) fields.set(`${coordinate}|${field.fieldKey}`, { group: field.group, managed: managedChannelField(field) })
  }
  for (const row of rows) {
    if (row.entity !== 'Listings' && row.entity !== 'Overrides') continue
    const facts = fields.get(`${at(row)}|${row.field}`)
    if ('never' in classifyListingField({ key: row.field, category: row.field === transferCategoryField(row.channel), group: facts?.group, managed: facts?.managed })) out.notShared++
    else out.rows.push(row)
  }
  return out
}

/**
 * The drafts here that already hold listing content of their own: a value a copy would carry (a text, an item
 * specific) that the engine reads as SET. A draft just made holds none; one this business wrote into, or
 * a copy made before, does. Its own offer terms, shipping or policies do not count: a copy never touches them.
 */
export async function draftsWithOwnContent(drafts: Array<{ id: string; productId: string; aliasKey: string }>, productIds: string[], market: string): Promise<Set<string>> {
  if (!drafts.length) return new Set()
  const [products, listings] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, include: productInclude, orderBy: { sku: 'asc' } }),
    prisma.channelListing.findMany({ where: { id: { in: drafts.map((d) => d.id) } }, select: { id: true, productId: true, channel: true, channelConnectionId: true, marketplace: true, aliasKey: true } }),
  ])
  const { rows } = await copyableRows(products, listings, market)
  const idOf = new Map(products.map((p) => [p.sku, p.id]))
  // A category alone is not content: one chosen here (to make a listing copyable) leaves the draft open to a copy.
  const owned = new Set(rows.filter((row) => row.action === 'SET' && row.field !== transferCategoryField(row.channel)).map((row) => `${idOf.get(row.sku)}|${row.channel}|${row.accountId}|${row.aliasKey}`))
  return new Set(listings.filter((l) => owned.has(`${l.productId}|${l.channel}|${l.channelConnectionId}|${l.aliasKey}`)).map((l) => l.id))
}

class PlanRefused extends Error {
  constructor(readonly issues: Array<{ field?: string; message: string }>) { super(issues.map((issue) => issue.message).join('; ')) }
}

/**
 * Plan and apply the rows in one transaction, as the live sync does (sync.service.ts `applyRows`): refused fields are
 * dropped and the rest applied; each refused field comes back with its reason. No channel push is queued: these are
 * drafts, and only Publish sends anything.
 */
async function applyListingRows(rows: TransferRow[], market: string, skus: Set<string>, label: string): Promise<{ fields: Map<string, string>; whole: string | null }> {
  const fields = new Map<string, string>()
  const contracts = transferContracts(market, { allowIncompleteSchema: true, allowUnknownMarket: true })
  let attempt = rows
  for (let pass = 0; pass < 3 && attempt.length; pass++) {
    try {
      await inDatabaseTransaction(prisma, async () => {
        // A copy from the sharing business, as the live sync writes: it is not this business's own edit.
        await prisma.$executeRaw`SELECT nexus_assortment_sync_write()`
        const context = await loadTransferContext(attempt, prisma)
        const plan = await buildTransferPlan(attempt, 'update', context, contracts, undefined, { declaredProductSkus: skus, sharedCopy: true })
        if (plan.issues.length) throw new PlanRefused(plan.issues)
        for (const target of plan.targets) {
          if (target.create || target.cells.some((cell) => cell.verdict === 'changed')) await applyTransferTarget(prisma, target, label, null, { queueOutbound: false })
        }
      })
      return { fields, whole: null }
    } catch (error) {
      if (!(error instanceof PlanRefused)) throw error
      const named = new Set(error.issues.map((issue) => issue.field).filter(Boolean) as string[])
      const next = attempt.filter((row) => !named.has(row.field))
      // Every row refused, or an issue that names no field of these rows: the listing as a whole is refused.
      if (!next.length || next.length === attempt.length) return { fields: new Map(), whole: error.issues[0]?.message ?? error.message }
      for (const field of named) fields.set(field, error.issues.find((issue) => issue.field === field)?.message ?? 'refused')
      attempt = next
    }
  }
  return { fields, whole: null }
}
