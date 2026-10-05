/**
 * Item ID control, step I3 — prove a Shopify Product ID for a family, as THIS business's own Shopify store. Two models,
 * each with its main row (the row whose Product ID cell is the control; every other row says "Set on the main row"):
 *
 *   One product per family (the default): the family's root row. One Shopify product carries the whole family; each
 *     variation row is one of its variants. The proof reads the product through the store's read-only admin client and
 *     the channel gateway (`shopifyAdminReader`): `product(id)` answers only for a product of THIS store, so a product of
 *     another store (another business's) is "not in this store"; a product carrying another Nexus identity
 *     (`nexus.family_id`: another product or business) is refused; no other family may hold it; each row is matched to a
 *     variant by its own channel SKU (exact, as stock sync compares them: `channel-sku.ts`) or by the variant id it holds.
 *     The link then stores, per row, the product id and — on a variant's row — `platformAttributes.variantId` and
 *     `inventoryItemId` (and the store's location when it has exactly one), which price and stock sync read.
 *   Colour products (the store's switch on, and the family has a colour axis): each colour is its own Shopify product,
 *     and the family's root row is still the door — it holds no product of its own. Check runs colour products' Find
 *     with the typed product (`sourceProductId`: Shopify is read; the proposal is stored in Nexus, nothing is written to
 *     Shopify), and names the colour and the sizes it matched; Link runs Confirm for that one colour, which writes the
 *     Nexus identity (and any SKU a matched variant lacks) on the Shopify product, reads it back and links the sizes.
 *     A colour product is not cleared here (its links are colour products' own; Clear refuses, saying so).
 */
import { logger } from '../../../utils/logger.js'
import {
  carryRows, channelSkusOf, emptyProof, familyRowsOf, heldByAnotherFamily, matchedSkusOf, object, ownSkuOn, where,
  type ChannelItemProof, type Coordinate, type FamilyRow,
} from './common.js'
import prisma from '../../../db.js'

type ShopifyRead = <T = any>(query: string, variables?: Record<string, unknown>) => Promise<{ data: T | null; errors: Array<{ message: string }> }>

export interface ShopifyLinkDeps {
  reader?: (accountId: string) => Promise<{ read: ShopifyRead; domain: string }>
  /** Colour products' own services (stood in by the tests). */
  colour?: {
    enabled: (accountId: string) => Promise<boolean>
    mode: (rootId: string) => Promise<'colour-products' | 'one-product'>
    find: (rootId: string, scope: ColourScope, body: { sourceProductId: string }) => Promise<ColourView>
    confirm: (rootId: string, scope: ColourScope, body: { colours: Array<{ valueKey: string; shopifyProductId: string }> }) => Promise<unknown>
  }
}

export type ColourScope = { accountId?: string; market?: string; aliasKey?: string }
interface ColourProposal { shopifyProductId?: string | null; title?: string | null; status?: string | null; variants?: Array<{ productId: string; sku: string; shopifyVariantId: string; inventoryItemId: string | null }>; skusToWrite?: unknown[]; issues?: Array<{ message: string }> }
export interface ColourView {
  plan: { mode: string; products: Array<{ key: string; nexusValue: string }> }
  colourProducts: Array<{ id: string; valueKey: string; state: string; shopifyProductId: string | null; proposal: unknown }>
}

/** A Shopify Product ID as typed: the number, or its `gid://shopify/Product/<n>` form. */
export function shopifyProductNumber(raw: string): string | null {
  const text = String(raw ?? '').trim()
  const match = /^(?:gid:\/\/shopify\/Product\/)?(\d{1,20})$/.exec(text)
  return match ? match[1] : null
}
const gid = (type: string, id: string) => `gid://shopify/${type}/${id}`
const short = (value: unknown): string | null => (typeof value === 'string' || typeof value === 'number') && String(value).trim() ? String(value).split('/').at(-1)!.trim() : null

/** The Nexus identity a one-product family's Shopify product carries (`content-sync.service.ts`). */
export const familyIdentity = (c: Pick<Coordinate, 'workspaceId' | 'root' | 'aliasKey'>) => `${c.workspaceId ?? 'nexus'}:${c.root.id}${c.aliasKey ? ':' + c.aliasKey : ''}`

const PRODUCT_READ = `query NexusLinkProduct($id: ID!) {
  product(id: $id) { id title status identity: metafield(namespace: "nexus", key: "family_id") { value }
    variants(first: 250) { nodes { id sku inventoryItem { id } } pageInfo { hasNextPage } } }
  locations(first: 50) { nodes { id isActive } } }`

interface RemoteProduct {
  id: string; title: string; status: string; identity: { value: string } | null
  variants: { nodes: Array<{ id: string; sku: string | null; inventoryItem: { id: string } | null }>; pageInfo: { hasNextPage: boolean } }
}

async function openReader(accountId: string, deps: ShopifyLinkDeps) {
  if (deps.reader) return deps.reader(accountId)
  const { shopifyAdminReader } = await import('../../shopify/admin-client.js')
  return shopifyAdminReader(accountId)
}

function colourServices(deps: ShopifyLinkDeps): NonNullable<ShopifyLinkDeps['colour']> {
  if (deps.colour) return deps.colour
  return {
    enabled: async (accountId) => (await (await import('../../shopify/colour-products/settings.js')).readColourProductSettings(accountId)).enabled,
    mode: async (rootId) => (await (await import('../../shopify/colour-products/family.js')).loadColourPlan(rootId)).plan.mode,
    find: async (rootId, scope, body) => (await import('../../shopify/colour-products/find.service.js')).findColourProducts(rootId, scope, body) as unknown as Promise<ColourView>,
    confirm: async (rootId, scope, body) => (await import('../../shopify/colour-products/confirm.service.js')).confirmColourProducts(rootId, scope, body),
  }
}

/** Whether this family's Shopify listing is colour products on this store (the switch on, and a colour axis). */
export async function isColourFamily(coordinate: Coordinate, deps: ShopifyLinkDeps = {}): Promise<boolean> {
  if (!coordinate.accountId) return false
  const colour = colourServices(deps)
  if (!(await colour.enabled(coordinate.accountId))) return false
  return (await colour.mode(coordinate.root.id)) === 'colour-products'
}

/** A colour product's rows hold its colour mapping: their links are colour products' own. */
export const COLOUR_CLEAR_REFUSED = 'This family\'s Shopify products are colour products: each colour\'s product is linked by colour products, and Nexus does not unlink one here. Nothing changed.'
export const holdsColourProduct = (rows: ReadonlyArray<{ platformAttributes: unknown }>) => rows.some((r) => !!object(r.platformAttributes).shopifyColourProductId)

const statusOf = (shopifyStatus: string | null | undefined) => (String(shopifyStatus ?? '').toUpperCase() === 'ACTIVE' ? 'ACTIVE' as const : 'INACTIVE' as const)
const statusWords = (status: string) => ({ ACTIVE: 'Active', DRAFT: 'Draft', ARCHIVED: 'Archived' } as Record<string, string>)[status] ?? status

/** Prove a Shopify product for a ONE-PRODUCT family. Never writes; refusals are returned (`refusal`). */
export async function proveShopifyProduct(coordinate: Coordinate, rawId: string, input: { acknowledgeUnverifiable?: boolean; mcp?: boolean }, deps: ShopifyLinkDeps = {}): Promise<ChannelItemProof> {
  const id = shopifyProductNumber(rawId)
  const proof = emptyProof('SHOPIFY', id ?? String(rawId ?? '').trim())
  if (!id) return { ...proof, refusal: `${where(coordinate)}: a Shopify Product ID is a number (the digits at the end of the product's admin address, …/products/<number>).` }
  if (!coordinate.accountId) return { ...proof, refusal: `${where(coordinate)} names no account: set its account first.` }
  const other = await heldByAnotherFamily(coordinate, id, [{ platformAttributes: { path: ['shopifyProductId'], equals: id } }])
  const colourElsewhere = other ? null : await prisma.shopifyColourProduct.findFirst({ where: { channelConnectionId: coordinate.accountId, shopifyProductId: gid('Product', id), familyId: { not: coordinate.root.id } }, select: { family: { select: { sku: true } } } })
  const holder = other ?? colourElsewhere?.family.sku ?? null
  if (holder) return { ...proof, verdict: 'rejected', reason: `Already linked to another product (${holder}).`, refusal: `${where(coordinate)}: Shopify product ${id} is already linked to another product here (${holder}). Nothing changed.` }

  let reader: { read: ShopifyRead; domain: string }
  try {
    reader = await openReader(coordinate.accountId, deps)
  } catch (error) {
    logger.warn('[identity-fix] link: the Shopify store cannot be read', { error: error instanceof Error ? error.message : String(error) })
    return { ...proof, refusal: `${where(coordinate)}: its Shopify store has no working sign-in in Nexus, so the Product ID cannot be checked on Shopify. Reconnect the store in Nexus (Settings, Channels), then check again.` }
  }
  type ProductAnswer = { product: RemoteProduct | null; locations?: { nodes: Array<{ id: string; isActive: boolean }> } | null }
  let answer: { data: ProductAnswer | null; errors: Array<{ message: string }> }
  try {
    answer = await reader.read<ProductAnswer>(PRODUCT_READ, { id: gid('Product', id) })
  } catch (error) {
    return { ...proof, refusal: `${where(coordinate)}: Shopify could not be read (${error instanceof Error ? error.message : String(error)}). Nothing changed.` }
  }
  const product = answer.data?.product ?? null
  if (!product) {
    if (answer.errors.length && !answer.data) return { ...proof, refusal: `${where(coordinate)}: Shopify could not be read (${answer.errors[0].message}). Nothing changed.` }
    return { ...proof, verdict: 'rejected', reason: 'Not a product of this store.', refusal: `${where(coordinate)}: this business's Shopify store (${reader.domain}) has no product ${id}. A product of another store is never linked here. Nothing changed.` }
  }
  if (product.variants.pageInfo.hasNextPage) return { ...proof, refusal: `${where(coordinate)}: Shopify product ${id} has more than 250 variants. Nexus manages at most 250 per Shopify product. Nothing changed.` }
  proof.title = product.title?.trim() || null
  proof.channelStatus = product.status ?? null
  proof.status = statusOf(product.status)
  const identity = product.identity?.value?.trim() || null
  const own = familyIdentity(coordinate)
  if (identity && identity !== own) {
    const colour = identity.startsWith(`${coordinate.workspaceId ?? 'nexus'}:${coordinate.root.id}:c:`)
    return { ...proof, verdict: 'rejected', reason: 'Another Nexus identity.', refusal: colour
      ? `${where(coordinate)}: Shopify product ${id} is one of this family's colour products. Colour products link it. Nothing changed.`
      : `${where(coordinate)}: Shopify product ${id} carries another Nexus identity (${identity}): it belongs to another Nexus product or business. Nothing changed.` }
  }

  const variants = product.variants.nodes.map((v) => ({ id: short(v.id)!, sku: (v.sku ?? '').trim(), inventoryItemId: short(v.inventoryItem?.id) }))
  const skus = [...new Set(variants.map((v) => v.sku).filter(Boolean))]
  proof.liveSkus = skus
  const family = await familyRowsOf(coordinate)
  const skusByRow = new Map(family.map((row) => [row.id, channelSkusOf(row)]))
  // A variant per row: its own channel SKU, exact and only on one variant; else the variant id it already holds.
  const variantOf = (row: FamilyRow) => {
    const bySku = ownSkuOn(row, skusByRow, skus, true)
    if (bySku) {
      const named = variants.filter((v) => v.sku === bySku.sku.trim())
      if (named.length === 1) return named[0]
    }
    const held = short(object(row.platformAttributes).variantId)
    return held ? variants.find((v) => v.id === held) ?? null : null
  }
  proof.matchedSkus = matchedSkusOf(family, skusByRow, skus, true)
  const heldMatches = family.filter((row) => variantOf(row))
  if (!skus.length && !heldMatches.length) {
    proof.verdict = 'unverifiable'
    proof.reason = 'The product reports no SKUs on Shopify.'
    if (input.acknowledgeUnverifiable !== true) {
      return { ...proof, refusal: input.mcp
        ? `${where(coordinate)}: Shopify product ${id} reports no SKUs, so Nexus cannot prove it is this listing's. Ask again with acknowledgeUnverifiable to link it anyway.`
        : `${where(coordinate)}: Shopify product ${id} reports no SKUs, so Nexus cannot prove it is this listing's. Give its variants their SKUs on Shopify, then check again.` }
    }
  } else if (!heldMatches.length) {
    return { ...proof, verdict: 'rejected', reason: 'No SKU of this family on the product.',
      refusal: `${where(coordinate)}: none of the ${skus.length} SKU(s) on Shopify product ${id} (${skus.slice(0, 5).join(', ')}${skus.length > 5 ? ', …' : ''}) is a SKU this family sends to this store (Shopify stock sync needs exactly the same SKU). Nothing changed.` }
  } else {
    proof.verdict = 'verified'
    proof.reason = `A product of this business's store (${reader.domain}); ${heldMatches.length} of this family's rows are its variants.`
  }
  // The match counts as this family's for the main row when any row matched (by SKU or by the variant id it holds).
  if (!proof.matchedSkus.length && heldMatches.length) proof.matchedSkus = heldMatches.map((row) => variantOf(row)!.sku || variantOf(row)!.id)

  const locations = (answer.data?.locations?.nodes ?? []).filter((l) => l && l.isActive !== false && /^gid:\/\/shopify\/Location\/\d+$/.test(l.id))
  const location = locations.length === 1 ? locations[0].id : null
  if (!location) proof.notes.push(answer.data?.locations ? `The store has ${locations.length} active locations: stock is not sent to this product until its location is set (Publish review).` : 'Nexus could not read the store\'s locations: stock is not sent to this product until its location is set (Publish review).')

  carryRows(coordinate, family, proof, (row) => {
    const variant = variantOf(row)
    return variant ? { sku: variant.sku || null } : null
  }, (row) => {
    const variant = variantOf(row)
    const pa = object(row.platformAttributes)
    const bag: Record<string, unknown> = { ...pa, nexusFamilyId: coordinate.root.id, shopifyProductId: id }
    if (variant) {
      bag.variantId = variant.id
      if (variant.inventoryItemId) bag.inventoryItemId = variant.inventoryItemId
      if (location && !pa.inventoryLocationId) bag.inventoryLocationId = location
    }
    return { platformAttributes: bag }
  }, { anyRow: !skus.length && !heldMatches.length })
  if (!proof.rows.length) return { ...proof, refusal: `${where(coordinate)}: Shopify product ${id} carries none of this listing's rows here. Nothing changed.` }
  const byId = new Map(family.map((row) => [row.id, row]))
  proof.unchanged = proof.rows.every((row) => {
    const pa = object(byId.get(row.id)?.platformAttributes), next = row.platformAttributes ?? {}
    return short(row.externalListingId) === id && row.listingStatus === proof.status && row.isPublished === (proof.status === 'ACTIVE')
      && short(pa.variantId) === short(next.variantId) && short(pa.inventoryItemId) === short(next.inventoryItemId)
  })
  return proof
}

/** The plain sentences of a Shopify proof (before the rows a link writes). */
export function shopifyFoundSentences(proof: ChannelItemProof): string[] {
  const out: string[] = []
  if (proof.title) out.push(`Shopify product ${proof.itemId}: "${proof.title}".`)
  if (proof.channelStatus) out.push(proof.status === 'ACTIVE' ? 'Shopify reports it as Active.' : `Shopify reports it as ${statusWords(proof.channelStatus)}: Nexus records it as Inactive (not for sale).`)
  if (proof.verdict === 'verified') out.push('A product of this business\'s Shopify store.')
  return [...out, ...proof.notes]
}

/**
 * Colour products, Check: Find with the typed product, then the colour it matched. Shopify is read; the proposal is
 * stored in Nexus (Confirm needs it). Refusals are returned.
 */
export async function proveShopifyColour(coordinate: Coordinate, rawId: string, deps: ShopifyLinkDeps = {}): Promise<ChannelItemProof> {
  const id = shopifyProductNumber(rawId)
  const proof = emptyProof('SHOPIFY', id ?? String(rawId ?? '').trim())
  if (!id) return { ...proof, refusal: `${where(coordinate)}: a Shopify Product ID is a number (the digits at the end of the product's admin address, …/products/<number>).` }
  const colour = colourServices(deps)
  let view: ColourView
  try {
    view = await colour.find(coordinate.root.id, scopeOf(coordinate), { sourceProductId: gid('Product', id) })
  } catch (error) {
    return { ...proof, refusal: `${where(coordinate)}: ${error instanceof Error ? error.message : String(error)}` }
  }
  const row = view.colourProducts.find((r) => object(r.proposal).shopifyProductId === gid('Product', id))
  if (!row) return { ...proof, verdict: 'rejected', reason: 'No colour.', refusal: `${where(coordinate)}: Shopify product ${id} is not one of this family's colours: colour products matched it to none (its SKUs and colour do not match a colour of this family). Nothing changed.` }
  const proposal = object(row.proposal) as ColourProposal
  const name = view.plan.products.find((p) => p.key === row.valueKey)?.nexusValue ?? row.valueKey
  proof.title = proposal.title ?? null
  proof.channelStatus = proposal.status ?? null
  proof.status = statusOf(proposal.status)
  const sizes = (proposal.variants ?? []).map((v) => ({ productId: v.productId, sku: v.sku }))
  proof.liveSkus = sizes.map((s) => s.sku)
  proof.matchedSkus = sizes.map((s) => s.sku)
  const issues = (proposal.issues ?? []).map((i) => i.message).filter(Boolean)
  if (issues.length) return { ...proof, verdict: 'rejected', reason: 'Colour issues.', refusal: `${where(coordinate)}: ${issues.join(' ')} Nothing changed.` }
  if (!sizes.length) return { ...proof, verdict: 'rejected', reason: 'No size.', refusal: `${where(coordinate)}: no size of "${name}" matches a variant of Shopify product ${id}. Nothing changed.` }
  proof.verdict = 'verified'
  proof.reason = `Colour products matched it to "${name}".`
  const skusToWrite = Array.isArray(proposal.skusToWrite) ? proposal.skusToWrite.length : 0
  proof.colour = { valueKey: row.valueKey, name, shopifyProductId: gid('Product', id), sizes,
    writes: `Link confirms "${name}": Nexus writes its identity on Shopify product ${id}${skusToWrite ? ` and the SKU of ${skusToWrite} variant${skusToWrite === 1 ? '' : 's'} that lack one` : ''}, reads it back, then links ${sizes.length} size${sizes.length === 1 ? '' : 's'}.` }
  const family = await familyRowsOf(coordinate)
  const bySize = new Map(sizes.map((s) => [s.productId, s.sku]))
  for (const listing of family) {
    if (!bySize.has(listing.productId)) continue
    proof.rows.push({ id: listing.id, productId: listing.productId, sku: listing.product?.sku ?? '', channelSku: bySize.get(listing.productId)!, externalListingId: listing.externalListingId,
      listingStatus: listing.listingStatus, isPublished: listing.isPublished, version: listing.version })
  }
  proof.unchanged = row.state === 'LINKED' && row.shopifyProductId === gid('Product', id)
  proof.notes.push(proof.colour.writes)
  return proof
}

export const scopeOf = (c: Coordinate): ColourScope => ({ accountId: c.accountId ?? undefined, market: c.market, aliasKey: c.aliasKey || undefined })

/** Colour products, Link: Confirm the one colour Check matched (it re-reads Shopify and refuses what changed since). */
export async function confirmShopifyColour(coordinate: Coordinate, proof: ChannelItemProof, deps: ShopifyLinkDeps = {}): Promise<void> {
  if (!proof.colour) throw new Error('No colour to confirm.')
  await colourServices(deps).confirm(coordinate.root.id, scopeOf(coordinate), { colours: [{ valueKey: proof.colour.valueKey, shopifyProductId: proof.colour.shopifyProductId }] })
}
