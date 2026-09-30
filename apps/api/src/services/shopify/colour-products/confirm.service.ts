/**
 * Confirm (docs/studies/shopify-linked-variations-PLAN.md §3.5, PR 3b): the operator accepts Find's proposal for one or
 * more colours, and Nexus adopts those Shopify products.
 *
 * Nothing is written until every named colour passes, on a fresh read of Shopify: the match is still the one Find
 * proposed (else "run Find again"), it has no open issue, no size of it is already the listing of another Shopify
 * product or variant, the product carries no other Nexus identity, and the stock location is known. Then, per colour,
 * through the gateway: the Nexus identity `nexus.family_id` = `<business>:<family>:c:<colour product row>` (T8: settable
 * on a product Nexus did not create, unique per store) and the Nexus SKU on each matched variant that has none (E4 a),
 * both read back. Last, one transaction per colour: each matched size's Shopify listing gets the exact ids the price and
 * stock sync use (`offer-sync.service.ts`), and the colour product row becomes LINKED.
 *
 * It never adds, removes or reorders a variant, and never writes the grouping fields (that is the link writer, PR 4).
 */
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { matchColourProducts, SHOPIFY_LINKED_LIST_LIMIT, type ColourMatchVariant } from '@nexus/shared/shopify-colour-products'
import { shopifyAdmin, assertShopifyResult as checked, type ShopifyGraphql } from '../admin-client.js'
import { SHOPIFY_IDENTITY_NOT_ID, shortId } from '../content-publisher.js'
import { contentDestination, object, type ContentScope } from '../content-workspace.service.js'
import { getShopifyPublishMode } from '../../shopify-publish-gate.service.js'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'
import { DraftListingError, ensureDraftListings } from '../../pim/draft-listing.service.js'
import { productReadCacheService } from '../../product-read-cache.service.js'
import { logger } from '../../../utils/logger.js'
import { readColourProductSettings } from './settings.js'
import { loadColourPlan } from './family.js'
import { claimedElsewhere, colourProductsView, gatherCandidates, linkedProducts, rowsWhere, type Destination } from './find.service.js'

const productGid = /^gid:\/\/shopify\/Product\/\d+$/
const locationGid = /^gid:\/\/shopify\/Location\/\d+$/
const confirmBodySchema = z.object({
  colours: z.array(z.object({
    valueKey: z.string().min(1).max(255),
    shopifyProductId: z.string().regex(productGid, 'Choose a Shopify product.'),
    /** The colour's name on Shopify (E1). Default: the name the row has, else the one the Shopify product shows. */
    colourName: z.string().trim().min(1, 'Name the colour, or leave the name out.').max(255).optional(),
    /** Where this colour's stock is counted. Default: the store's only active location. */
    locationId: z.string().regex(locationGid, 'Choose a Shopify location.').optional(),
  }).strict()).min(1, 'Choose at least one colour to confirm.').max(SHOPIFY_LINKED_LIST_LIMIT),
}).strict().superRefine((body, ctx) => {
  if (new Set(body.colours.map(c => c.valueKey)).size !== body.colours.length) ctx.addIssue({ code: 'custom', message: 'Name each colour once.' })
  if (new Set(body.colours.map(c => c.shopifyProductId)).size !== body.colours.length) ctx.addIssue({ code: 'custom', message: 'One Shopify product can be one colour only.' })
})

/** The identity of one colour product in its store. The row id never changes, so a renamed colour keeps its product. */
export const colourProductIdentity = (row: { workspaceId: string; familyId: string; id: string }) => `${row.workspaceId}:${row.familyId}:c:${row.id}`

const CONFIRM_READ = `query NexusColourConfirmRead($ids:[ID!]!) {
  nodes(ids:$ids) { ... on Product { id title status identity: metafield(namespace:"nexus",key:"family_id") { value } } }
  locations(first:250) { nodes { id name isActive } }
  identityDefinition: metafieldDefinitions(ownerType:PRODUCT,namespace:"nexus",key:"family_id",first:1) { nodes { id type { name } capabilities { uniqueValues { enabled } } } } }`
const READ_BACK = `query NexusColourReadBack($id:ID!,$location:ID!) { product(id:$id) { id status identity: metafield(namespace:"nexus",key:"family_id") { value }
  variants(first:250) { nodes { id sku inventoryItem { id inventoryLevel(locationId:$location) { id } } } } } }`

type Row = Awaited<ReturnType<typeof prisma.shopifyColourProduct.findMany>>[number]
interface StoredProposal { shopifyProductId?: string | null; shopifyColourName?: string | null; variants?: ColourMatchVariant[]; skusToWrite?: Array<{ shopifyVariantId: string; sku: string }> }
interface Adoption {
  row: Row; name: string; title: string; shopifyProductId: string; identity: string; identityWritten: boolean
  colourName: string | null; locationId: string; variants: ColourMatchVariant[]; skusToWrite: Array<{ shopifyVariantId: string; sku: string }>
}

/** The pairing the operator confirms: each Nexus size with one Shopify variant and its inventory item. */
const pairing = (variants: readonly ColourMatchVariant[] = []) => JSON.stringify(variants.map(v => [v.productId, v.shopifyVariantId, v.inventoryItemId]).sort())

/** Confirms the named colours: every check first, then the Shopify writes and the Nexus links, colour by colour. */
export async function confirmColourProducts(productId: string, scope: ContentScope, body: unknown) {
  const input = confirmBodySchema.parse(body ?? {})
  if (getShopifyPublishMode() !== 'live') throw new WorkspaceScopeError('Shopify writes are switched off on this server. Nothing was changed.', 409)
  const destination = await contentDestination(productId, scope)
  const settings = await readColourProductSettings(destination.accountId)
  if (!settings.enabled) throw new WorkspaceScopeError('Switch on colour products for this Shopify store first. Nothing was changed.', 409)
  const rows = await prisma.shopifyColourProduct.findMany({ where: rowsWhere(destination) })
  const rowOf = new Map(rows.map(r => [r.valueKey, r]))
  const missingRows = input.colours.filter(c => !(rowOf.get(c.valueKey)?.proposal))
  if (missingRows.length) throw new WorkspaceScopeError('Run Find first: there is no proposal to confirm for every chosen colour. Nothing was changed.', 409)

  // The names this confirm stores, and the plan they give (a blank or repeated name refuses below).
  const nameOf = (c: typeof input.colours[number]) => c.colourName ?? rowOf.get(c.valueKey)!.colourName ?? (rowOf.get(c.valueKey)!.proposal as StoredProposal).shopifyColourName ?? null
  const colourNames = { ...Object.fromEntries(rows.filter(r => r.colourName).map(r => [r.valueKey, r.colourName!])), ...Object.fromEntries(input.colours.flatMap(c => nameOf(c) ? [[c.valueKey, nameOf(c)!]] : [])) }
  const { plan } = await loadColourPlan(destination.familyId, { colourNames })
  if (plan.mode !== 'colour-products' || !plan.splitAxis) throw new WorkspaceScopeError('This family has no colour to show as separate Shopify products. Nothing was changed.', 422)

  const { graphql } = await shopifyAdmin(destination.accountId)
  const linked = linkedProducts(rows)
  const candidates = await gatherCandidates(graphql, settings, plan, [...Object.values(linked), ...input.colours.map(c => c.shopifyProductId)])
  const matches = matchColourProducts(plan, candidates, linked)
  const claimed = await claimedElsewhere(destination, input.colours.map(c => c.shopifyProductId))
  const read = await graphql(CONFIRM_READ, { ids: input.colours.map(c => c.shopifyProductId) })
  const remote = new Map<string, { title: string; status: string; identity: string | null }>((read.nodes ?? []).filter((n: any) => n?.id).map((n: any) => [n.id, { title: n.title, status: n.status, identity: n.identity?.value ?? null }]))
  const locations = (read.locations?.nodes ?? []).filter((l: any) => l?.isActive !== false && locationGid.test(l?.id ?? '')).map((l: any) => l.id as string)
  const definition = read.identityDefinition?.nodes?.[0] ?? null
  if (definition && definition.type?.name !== 'id') throw new WorkspaceScopeError(SHOPIFY_IDENTITY_NOT_ID, 422)
  if (definition && !definition.capabilities?.uniqueValues?.enabled) throw new WorkspaceScopeError('The Shopify field “Nexus family identity” (nexus.family_id) does not require unique values. Turn on “Unique values” for it in Shopify (Settings → Custom data → Products), then confirm again. Nothing was changed.', 422)

  const childIds = plan.products.flatMap(p => p.variants.map(v => v.productId))
  const listings = await prisma.channelListing.findMany({ where: { productId: { in: childIds }, ...listingCoordinate(destination) }, select: { productId: true, externalListingId: true, platformAttributes: true } })
  const problems: string[] = []
  const adoptions: Adoption[] = []
  for (const colour of input.colours) {
    const row = rowOf.get(colour.valueKey)!, proposal = row.proposal as StoredProposal
    const product = plan.products.find(p => p.key === colour.valueKey)
    if (!product) { problems.push(`"${colour.valueKey}" is no longer a colour of this family. Run Find again.`); continue }
    const name = product.nexusValue, fresh = matches.find(m => m.key === colour.valueKey)!, shopify = remote.get(colour.shopifyProductId)
    const before = problems.length
    for (const issue of plan.issues) if (issue.severity === 'error' && (!issue.key || issue.key === colour.valueKey)) problems.push(issue.message)
    if (row.state === 'LINKED' && row.shopifyProductId !== colour.shopifyProductId) problems.push(`"${name}" is already linked to another Shopify product.`)
    else if (!shopify) problems.push(`The Shopify product chosen for "${name}" no longer exists. Run Find again.`)
    else if (proposal.shopifyProductId !== colour.shopifyProductId || fresh.shopifyProductId !== colour.shopifyProductId || pairing(fresh.variants) !== pairing(proposal.variants)
      || fresh.skusToWrite.some(s => !proposal.skusToWrite?.some(p => p.shopifyVariantId === s.shopifyVariantId && p.sku === s.sku))) {
      problems.push(`"${shopify.title}" changed since Find, or Find proposed another product for "${name}". Run Find again.`)
    }
    // The checks of the product and its sizes, only when it is the product the fresh match gives this colour.
    const same = !!shopify && fresh.shopifyProductId === colour.shopifyProductId, sizes = same ? fresh.variants : []
    for (const issue of same ? fresh.issues : []) problems.push(issue.message)
    const owner = claimed.find(c => c.shopifyProductId === colour.shopifyProductId)
    if (owner) problems.push(`"${shopify?.title ?? name}" is already the Shopify product of ${owner.family.sku}.`)
    if (same && !sizes.length) problems.push(`No size of "${name}" matches a variant of "${shopify.title}".`)
    const identity = colourProductIdentity(row)
    if (same && shopify.identity && shopify.identity !== identity) problems.push(`"${shopify.title}" already carries another Nexus identity (${shopify.identity}). It belongs to another Nexus product or colour.`)
    for (const v of sizes) {
      // Stock sync compares the SKUs exactly; the matcher compares them without case or spaces.
      if (v.by === 'sku' && v.shopifySku !== v.sku) problems.push(`In "${shopify?.title ?? name}", a variant has SKU ${v.shopifySku}; Nexus has ${v.sku}. Stock sync needs exactly the same SKU. Change one of them.`)
      if (!v.inventoryItemId) problems.push(`In "${shopify?.title ?? name}", the variant of ${v.sku} has no inventory item.`)
      const listing = listings.find(l => l.productId === v.productId), pa = object(listing?.platformAttributes)
      const tiedProduct = pa.shopifyProductId ?? listing?.externalListingId
      if (tiedProduct && String(tiedProduct) !== shortId(colour.shopifyProductId)) problems.push(`${v.sku} is already the listing of another Shopify product (${tiedProduct}).`)
      else if (pa.variantId && String(pa.variantId) !== shortId(v.shopifyVariantId)) problems.push(`${v.sku} is already the listing of another variant of "${shopify?.title ?? name}".`)
    }
    const locationId = colour.locationId ?? (locations.length === 1 ? locations[0] : null)
    if (!locationId) problems.push(locations.length ? `The store has ${locations.length} active locations. Choose where the stock of "${name}" is counted.` : 'The Shopify store has no active location.')
    else if (!locations.includes(locationId)) problems.push(`The location chosen for "${name}" is not an active location of the store.`)
    if (problems.length === before && same && locationId) adoptions.push({ row, name, title: shopify.title, shopifyProductId: colour.shopifyProductId, identity, identityWritten: shopify.identity !== identity,
      colourName: nameOf(colour), locationId, variants: sizes, skusToWrite: fresh.skusToWrite })
  }
  if (problems.length) throw new WorkspaceScopeError(`${[...new Set(problems)].join(' ')} Nothing was changed.`, 409)

  if (!definition) checked((await graphql(`mutation NexusCreateDefinition($definition:MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition:$definition) { createdDefinition { id } userErrors { field message } } }`,
    { definition: { namespace: 'nexus', key: 'family_id', name: 'Nexus family identity', type: 'id', ownerType: 'PRODUCT', access: { storefront: 'PUBLIC_READ' }, validations: [], capabilities: { uniqueValues: { enabled: true } } } })).metafieldDefinitionCreate, 'Create metafield definition')
  const confirmed: Array<Awaited<ReturnType<typeof adopt>>> = []
  try {
    for (const adoption of adoptions) {
      try {
        confirmed.push(await adopt(graphql, destination, adoption))
      } catch (error) {
        const done = confirmed.length ? ` ${confirmed.map(c => `"${c.name}"`).join(', ')} ${confirmed.length === 1 ? 'is' : 'are'} confirmed.` : ''
        if (error instanceof WorkspaceScopeError) throw new WorkspaceScopeError(`${error.message}${done}`, error.statusCode)
        throw new WorkspaceScopeError(`Shopify did not accept the change to "${adoption.title}" (${adoption.name}): ${error instanceof Error ? error.message : String(error)}.${done} Run Find again, then confirm what is left.`, 502)
      }
    }
  } finally {
    // A colour confirmed (or renamed) is not linked yet: no "Linked ✓" on the family until the link writer reads it back.
    // After the loop, so no adoption's own optimistic check sees another row change.
    if (confirmed.length) await prisma.shopifyColourProduct.updateMany({ where: { ...rowsWhere(destination), linkVerifiedAt: { not: null } }, data: { linkVerifiedAt: null } })
  }
  return { ...await colourProductsView(destination, plan, settings), confirmed }
}

const listingCoordinate = (d: Destination) => ({ channel: 'SHOPIFY', marketplace: d.marketplace, channelConnectionId: d.accountId, aliasKey: d.aliasKey ?? '' })

/** One colour: the identity and the missing SKUs on Shopify, read back; then its listings and row in one transaction. */
async function adopt(graphql: ShopifyGraphql, destination: Destination, a: Adoption) {
  if (a.identityWritten) checked((await graphql(`mutation NexusColourIdentity($metafields:[MetafieldsSetInput!]!) { metafieldsSet(metafields:$metafields) { metafields { id } userErrors { field message } } }`,
    { metafields: [{ ownerId: a.shopifyProductId, namespace: 'nexus', key: 'family_id', type: 'id', value: a.identity }] })).metafieldsSet, 'Set the Nexus identity')
  if (a.skusToWrite.length) checked((await graphql(`mutation NexusColourWriteSkus($productId:ID!,$variants:[ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId:$productId,variants:$variants) { userErrors { field message } } }`,
    { productId: a.shopifyProductId, variants: a.skusToWrite.map(s => ({ id: s.shopifyVariantId, inventoryItem: { sku: s.sku } })) })).productVariantsBulkUpdate, 'Write the Nexus SKUs')

  const back = (await graphql(READ_BACK, { id: a.shopifyProductId, location: a.locationId })).product
  if (!back) throw new WorkspaceScopeError(`"${a.title}" could not be read back from Shopify.`, 502)
  if (back.identity?.value !== a.identity) throw new WorkspaceScopeError(`Shopify did not keep the Nexus identity on "${a.title}".`, 502)
  const remoteVariants = new Map<string, any>(back.variants.nodes.map((v: any) => [v.id, v]))
  const wrong = a.variants.filter(v => remoteVariants.get(v.shopifyVariantId)?.sku !== v.sku || remoteVariants.get(v.shopifyVariantId)?.inventoryItem?.id !== v.inventoryItemId)
  if (wrong.length) throw new WorkspaceScopeError(`Shopify read back other SKUs for ${wrong.map(v => v.sku).join(', ')} on "${a.title}".`, 502)
  const notStocked = a.variants.filter(v => !remoteVariants.get(v.shopifyVariantId)?.inventoryItem?.inventoryLevel).map(v => v.sku)
  const isPublished = back.status === 'ACTIVE'

  const productIds = a.variants.map(v => v.productId)
  let draftsCreated = 0
  try {
    await prisma.$transaction(async tx => {
      const row = await tx.shopifyColourProduct.findUnique({ where: { id: a.row.id } })
      if (!row || row.updatedAt.getTime() !== a.row.updatedAt.getTime()) throw new WorkspaceScopeError(`"${a.name}" changed while it was confirmed. Run Find again.`, 409)
      const ensured = await ensureDraftListings(tx, { channel: 'SHOPIFY', market: destination.marketplace, accountId: destination.accountId, aliasKey: destination.aliasKey ?? '', productIds, family: true })
      draftsCreated = ensured.filter(e => e.created).length
      const listings = await tx.channelListing.findMany({ where: { productId: { in: productIds }, ...listingCoordinate(destination) } })
      for (const v of a.variants) {
        const listing = listings.find(l => l.productId === v.productId)
        if (!listing) throw new WorkspaceScopeError(`The Shopify listing of ${v.sku} is missing.`, 409)
        const pa = object(listing.platformAttributes), tied = pa.shopifyProductId ?? listing.externalListingId
        if ((tied && String(tied) !== shortId(a.shopifyProductId)) || (pa.variantId && String(pa.variantId) !== shortId(v.shopifyVariantId))) throw new WorkspaceScopeError(`${v.sku} became the listing of another Shopify product while it was confirmed.`, 409)
        await tx.channelListing.update({ where: { id: listing.id }, data: {
          platformAttributes: { ...pa, nexusFamilyId: destination.familyId, shopifyColourProductId: a.row.id, shopifyProductId: shortId(a.shopifyProductId), variantId: shortId(v.shopifyVariantId),
            inventoryItemId: shortId(v.inventoryItemId!), inventoryLocationId: a.locationId } as Prisma.InputJsonValue,
          externalListingId: shortId(a.shopifyProductId), platformProductId: shortId(a.shopifyProductId), isPublished, listingStatus: isPublished ? 'ACTIVE' : 'INACTIVE',
          // A draft this confirm made real loses the pause that kept it inert (as a publish does); any other row keeps its own.
          ...(isStillDraftListing(listing) ? { syncPaused: false } : {}), version: { increment: 1 },
        } })
      }
      await tx.shopifyColourProduct.update({ where: { id: a.row.id }, data: { state: 'LINKED', shopifyProductId: a.shopifyProductId, colourName: a.colourName, remoteStatus: back.status, checkedAt: new Date() } })
    })
  } catch (error) {
    if (error instanceof DraftListingError) throw new WorkspaceScopeError(error.message, error.statusCode)
    if ((error as { code?: string }).code === 'P2002') throw new WorkspaceScopeError(`"${a.title}" is already the Shopify product of another colour of this store.`, 409)
    throw error
  }
  await productReadCacheService.refreshMany([destination.familyId, ...productIds]).catch(err => logger.warn('[shopify-colour-confirm] product read cache refresh failed', { familyId: destination.familyId, error: err instanceof Error ? err.message : String(err) }))
  return { valueKey: a.row.valueKey, name: a.name, shopifyProductId: a.shopifyProductId, status: back.status as string, identityWritten: a.identityWritten, skusWritten: a.skusToWrite.length,
    sizesLinked: a.variants.length, draftsCreated, locationId: a.locationId, notStockedAt: notStocked }
}
