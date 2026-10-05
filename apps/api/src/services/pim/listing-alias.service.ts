import { productReadCacheService } from '../product-read-cache.service.js'
import type { Prisma } from '@prisma/client'
import { relationshipTransaction, relationshipProduct, ProductRelationshipError } from './product-relationship.service.js'
/**
 * PES.5 — listing alias CRUD.
 *
 * An alias is an Nth listing of ONE product on ONE channel × marketplace ×
 * account. See `docs/pes5-phase0-backend.md` §2 for why it is a table rather
 * than a discriminator column, and §0 F2 for the 22 `EBAY_LISTING_SHELL`
 * phantom products this replaces.
 *
 * ⚠ Creation is INERT until PES.5-ii drops the pre-alias 4-column unique
 * indexes. Those still enforce one listing per (product, channel, marketplace,
 * account), so the second listing row violates them even though the new
 * 5-column indexes permit it. That is deliberate — the two index widths must
 * coexist for one release so a rolling deploy's old container keeps working.
 * `createAlias` detects the collision and reports it as exactly that, rather
 * than letting a raw P2002 reach the operator as "something went wrong".
 */
import { UnknownProductError } from './studio-sheet.service.js'
import { resolveChannelConnectionId } from '../connection-resolver.service.js'
import { channelLabel } from '@nexus/shared/channel-label'
// A call-time import only: draft-listing.service imports this module's alias check the same way.
import { draftListingFields } from './draft-listing.service.js'

export class AliasCreationBlockedError extends Error {
  readonly code = 'alias_creation_blocked'
  constructor() {
    super('Listing aliases are unavailable until the listing setup is updated. Contact your administrator, then try again.')
    this.name = 'AliasCreationBlockedError'
  }
}

export class AliasNotFoundError extends Error {
  readonly code = 'alias_not_found'
  constructor(readonly aliasId: string) {
    super(`No listing alias with id "${aliasId}"`)
    this.name = 'AliasNotFoundError'
  }
}

export class AliasScopeMismatchError extends Error {
  readonly code = 'LISTING_SCOPE_MISMATCH'
  readonly statusCode = 409
  constructor() {
    super('The listing alias does not belong to this product and account scope. Reload the listing before editing it.')
  }
}

/** A pasted/deep-linked alias ID is not authority to write another family's listing. */
export async function validateAliasWriteTargets(targets: Array<{
  productId: string; channel: string; marketplace: string; connectionId: string | null; aliasKey: string
}>, database?: Prisma.TransactionClient, includeArchived = false) {
  if (!targets.length) return
  const prisma = database ?? (await import('../../db.js')).default
  const [products, aliases] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: [...new Set(targets.map(t => t.productId))] }, deletedAt: null }, select: { id: true, parentId: true } }),
    prisma.productListingAlias.findMany({ where: { id: { in: [...new Set(targets.map(t => t.aliasKey))] }, ...(includeArchived ? {} : { status: 'ACTIVE' }) },
      select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true } }),
  ])
  const roots = new Map(products.map(p => [p.id, p.parentId ?? p.id]))
  const byId = new Map(aliases.map(alias => [alias.id, alias]))
  for (const target of targets) {
    const alias = byId.get(target.aliasKey)
    if (!alias || alias.productId !== roots.get(target.productId) || alias.channel !== target.channel ||
      alias.marketplace !== target.marketplace || alias.channelConnectionId !== target.connectionId) throw new AliasScopeMismatchError()
  }
}

export interface CreateAliasInput {
  productId: string
  channel: string
  marketplace: string
  accountId?: string
  label?: string
  /** The listing's own seller SKU (2026-10-01), unique in the business and never a product's SKU. */
  sku?: string
  /**
   * Add rows (R3, 2026-10-05): `sku` is also the new listing's channel SKU — written on its main row (the family root's
   * listing) by the one writer, `setChannelSku`, with every channel-SKU check (the product-SKU characters, another
   * product's SKU, another product's listing on this account). A refusal creates nothing. The eBay import, which names
   * an alias by its file's SKU, leaves this off and keeps the alias-only record it had.
   */
  channelSku?: boolean
  createdBy?: string | null
}

/** True when the DB still carries the pre-alias narrow unique indexes. */
export async function legacyAliasIndexesPresent(): Promise<boolean> {
  const { default: prisma } = await import('../../db.js')
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT count(*)::int AS n FROM pg_indexes
      WHERE tablename = 'ChannelListing'
        AND indexname IN ('ChannelListing_productId_channelMarket_conn_key',
                          'ChannelListing_productId_channel_marketplace_conn_key')`,
  )
  return Number(rows[0]?.n ?? 0) > 0
}

/**
 * Create an alias AND the ChannelListing rows that hang off it — one per family
 * member, carrying no overrides, so the alias opens fully inheriting from
 * master and the operator pins only what should differ.
 */
export async function createAlias(input: CreateAliasInput) {
  const channel = input.channel.toUpperCase()
  const marketplace = input.marketplace.toUpperCase()

  const connectionId = await resolveChannelConnectionId(channel, input.accountId)
  // An alias is a listing on one account: none connected means no alias (the draft rule requires the account).
  const label = channelLabel(channel)
  if (!connectionId) throw new ProductRelationshipError(`Connect ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} account before adding a listing on ${marketplace}.`)
  if (await legacyAliasIndexesPresent()) throw new AliasCreationBlockedError()
  // Call-time, like the database client: the channel-SKU module reaches the identity guards and the channel specs.
  const channelSkus = input.channelSku && input.sku !== undefined ? await import('../listings/channel-sku.js') : null
  if (channelSkus && input.sku?.trim()) {
    // The channel-SKU rule first, so a typo is named before anything is read or written.
    const problem = channelSkus.channelSkuProblem(input.sku.trim())
    if (problem) throw new channelSkus.ChannelSkuError(400, problem, 'INVALID_SKU')
  }
  const sku = input.sku === undefined ? undefined : await checkListingSku(input.sku)
  return relationshipTransaction(async tx => {
    const seed = await tx.product.findFirst({
      where: { id: input.productId, deletedAt: null },
      select: { id: true, parentId: true },
    })
    if (!seed) throw new UnknownProductError(input.productId)
    const rootId = seed.parentId ?? seed.id
    const root = await relationshipProduct(tx, rootId)
    if (root.parentId) throw new ProductRelationshipError('This family changed. Reload it before adding a listing alias.')

    const family = await tx.product.findMany({
      where: { OR: [{ id: rootId }, { parentId: rootId }], deletedAt: null },
      select: { id: true },
    })

    const highest = await tx.productListingAlias.findFirst({
      where: { productId: rootId, channel, marketplace, channelConnectionId: connectionId },
      orderBy: { position: 'desc' },
      select: { position: true },
    })
    const position = (highest?.position ?? 0) + 1

    const alias = await tx.productListingAlias.create({
      data: {
        productId: rootId,
        channel,
        marketplace,
        channelConnectionId: connectionId,
        label: input.label?.trim() || `Listing ${position + 1}`,
        position,
        ...(sku ? { sku } : {}),
        createdBy: input.createdBy ?? null,
      },
    }).catch(error => { throw listingSkuTaken(error, sku) })

    // Step 7 — every alias row is an inert draft decided by the one draft rule (`draftListingFields`): DRAFT,
    // unpublished and paused, so a brand-new alias is never swept into an outbound push before an operator has
    // looked at it. BOTH `aliasId` (the FK) and `aliasKey` (the NOT NULL discriminator on the unique keys, because
    // Prisma cannot target a null inside a compound unique) are written together there.
    await tx.channelListing.createMany({
      data: family.map((p) => draftListingFields({ productId: p.id, channel, market: marketplace, accountId: connectionId, aliasKey: alias.id })),
    })

    // R3 — the alias's SKU is its main row's own channel SKU (S9 keeps `ProductListingAlias.sku` in step with it).
    if (channelSkus && sku) {
      const main = await tx.channelListing.findFirst({ where: { aliasId: alias.id, productId: rootId }, select: { id: true } })
      if (!main) throw new ProductRelationshipError('This family changed. Reload it before adding a listing alias.')
      await channelSkus.setChannelSku(tx, { listingId: main.id, sku, actorId: input.createdBy ?? null, reason: 'New listing alias' })
    }

    await productReadCacheService.refreshInTransaction(tx, family.map(member => member.id))
    return alias
  })
}

/** A listing SKU: trimmed, 1–200 characters, and not a live product's SKU in this business (a file could not tell them apart). */
async function checkListingSku(value: string) {
  const sku = value.trim()
  if (!sku || sku.length > 200) throw new ProductRelationshipError('A listing SKU needs 1 to 200 characters.')
  const { default: prisma } = await import('../../db.js')
  if (await prisma.product.findFirst({ where: { sku, deletedAt: null }, select: { id: true } })) throw new ProductRelationshipError(`${sku} is already a product SKU in this business. Choose another SKU for the listing.`)
  // An archived listing gives its SKU up to a live one (an import names a listing again after an undo archived it).
  await prisma.productListingAlias.updateMany({ where: { sku, status: 'ARCHIVED' }, data: { sku: null } })
  return sku
}
const listingSkuTaken = (error: unknown, sku: string | undefined) => (error as { code?: string })?.code === 'P2002' && sku
  ? new ProductRelationshipError(`${sku} is already the SKU of another listing in this business.`) : error

/** 2026-10-01 — give an extra listing that has no SKU its seller SKU (an import names it so). Never replaces a SKU. */
export async function nameListingAlias(aliasId: string, value: string) {
  const sku = await checkListingSku(value)
  const { default: prisma } = await import('../../db.js')
  const updated = await prisma.productListingAlias.updateMany({ where: { id: aliasId, sku: null, status: 'ACTIVE' }, data: { sku } })
    .catch(error => { throw listingSkuTaken(error, sku) })
  if (updated.count !== 1) throw new ProductRelationshipError('This listing changed, or already has a SKU. Import the file again.')
}

type AliasMutationScope = { productId: string; accountId?: string }

async function mutateAlias<T>(aliasId: string, scope: AliasMutationScope, includeArchived: boolean, mutate: (tx: Prisma.TransactionClient, existing: Prisma.ProductListingAliasGetPayload<object>) => Promise<T>) {
  const { default: prisma } = await import('../../db.js')
  const before = await prisma.productListingAlias.findUnique({ where: { id: aliasId } })
  if (!before) throw new AliasNotFoundError(aliasId)
  // Connection resolution uses the root client. Resolve before reserving a transaction connection.
  const connectionId = await resolveChannelConnectionId(before.channel, scope.accountId)
  return relationshipTransaction(async tx => {
    const existing = await tx.productListingAlias.findUnique({ where: { id: aliasId } })
    if (!existing) throw new AliasNotFoundError(aliasId)
    if (existing.channel !== before.channel) throw new AliasScopeMismatchError()
    await validateAliasWriteTargets([{ productId: scope.productId, channel: existing.channel,
      marketplace: existing.marketplace, connectionId, aliasKey: existing.id }], tx, includeArchived)
    return mutate(tx, existing)
  })
}

export async function updateAlias(aliasId: string, patch: { label?: string; position?: number }, scope: AliasMutationScope) {
  if (patch.label !== undefined && !patch.label.trim()) throw new ProductRelationshipError('A listing alias needs a name.', 400)
  if (patch.position !== undefined && (!Number.isSafeInteger(patch.position) || patch.position < 1)) throw new ProductRelationshipError('The listing position must be a positive whole number.', 400)
  return mutateAlias(aliasId, scope, false, tx => tx.productListingAlias.update({
    where: { id: aliasId },
    data: { ...(patch.label !== undefined ? { label: patch.label.trim() } : {}), ...(patch.position !== undefined ? { position: patch.position } : {}) },
  }))
}

/** Archive retains listing records and is safe to repeat after a lost acknowledgement. */
export async function archiveAlias(aliasId: string, scope: AliasMutationScope) {
  return mutateAlias(aliasId, scope, true, (tx, existing) => existing.status === 'ARCHIVED'
    ? Promise.resolve(existing)
    : tx.productListingAlias.update({ where: { id: aliasId }, data: { status: 'ARCHIVED' } }))
}
