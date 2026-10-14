/**
 * Find (docs/studies/shopify-linked-variations-PLAN.md §3.5, PR 3): which live Shopify product is each colour of a family,
 * and which variant each size. It READS Shopify and never writes it. The proposal is stored on the family's colour
 * product rows (the only writer of `ShopifyColourProduct`), for the operator to confirm; confirming is a separate step.
 *
 * Where it looks: the products already linked, the products holding the family's SKUs, one product the operator names,
 * and every member of those products' groups (one product of a group names the rest — the live GALE Yellow has no SKUs).
 *
 * The operator may choose the Shopify product of a colour (`choices`): that choice outranks every guess (name, group,
 * SKUs) and is kept on the colour's proposal (`chosenProductId`), so the next Find and Confirm match the same way; a
 * choice of `null` lets Find guess again. The sizes are still matched inside it by SKU, then by option values.
 */
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { matchColourProducts, type ColourCandidate, type ColourMatch, type ColourPlan } from '@nexus/shared/shopify-colour-products'
import { shopifyAdmin, type ShopifyGraphql } from '../admin-client.js'
import { contentDestination, type ContentScope } from '../content-workspace.service.js'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'
import { readColourProductSettings, type ColourProductSettings } from './settings.js'
import { loadColourPlan } from './family.js'
import { colourAdoptOnly, commitColourSyncChange, guardedColourGraphql, withColourSyncLock } from './sync-work.js'
import { listingSkuRefusal, withListingSkus } from './listing-skus.js'

/** The most Shopify products one Find reads (a group plus the products holding the family's SKUs). */
export const FIND_PRODUCT_LIMIT = 100
const SKU_BATCH = 25, READ_BATCH = 50
const productGid = /^gid:\/\/shopify\/Product\/\d+$/
const findBodySchema = z.object({
  sourceProductId: z.string().regex(productGid, 'Choose a Shopify product.').optional(),
  /** The operator's Shopify product per colour; null withdraws an earlier choice. */
  choices: z.array(z.object({ valueKey: z.string().min(1).max(255), shopifyProductId: z.string().regex(productGid, 'Choose a Shopify product.').nullable() }).strict()).max(256).optional(),
}).strict().superRefine((body, ctx) => {
  if (body.choices && new Set(body.choices.map(c => c.valueKey)).size !== body.choices.length) ctx.addIssue({ code: 'custom', message: 'Choose one Shopify product per colour.' })
})
const skuKey = (sku: string | null | undefined) => (sku ?? '').trim().toLocaleUpperCase('en')

/**
 * The Shopify products holding any of these SKUs. Shopify's search is loose, so only exact SKUs count. S5 — the callers
 * pass each size under the SKU Shopify knows it by (`withListingSkus`), so a listing with its own SKU is found by it.
 */
export async function productsWithSkus(gql: ShopifyGraphql, skus: readonly string[]): Promise<string[]> {
  const ids = new Set<string>(), wanted = [...new Set(skus.map(skuKey).filter(Boolean))]
  const quote = (sku: string) => `"${sku.replace(/["\\]/g, '\\$&')}"`
  for (let i = 0; i < wanted.length; i += SKU_BATCH) {
    const batch = wanted.slice(i, i + SKU_BATCH), exact = new Set(batch)
    const data = await gql(`query NexusColourSkus($query:String!) { productVariants(first:250,query:$query) { nodes { sku product { id } } } }`, { query: batch.map(s => `sku:${quote(s)}`).join(' OR ') })
    for (const node of data.productVariants?.nodes ?? []) if (exact.has(skuKey(node.sku))) ids.add(node.product.id)
  }
  return [...ids]
}

/** Products as the matcher needs them: variants (with inventory items), the colour field and the grouping list. */
export async function readColourCandidates(gql: ShopifyGraphql, settings: Pick<ColourProductSettings, 'valueField' | 'listField'>, ids: readonly string[]): Promise<ColourCandidate[]> {
  const out: ColourCandidate[] = []
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    const data = await gql(`query NexusColourCandidates($ids:[ID!]!,$vns:String!,$vkey:String!,$lns:String!,$lkey:String!) { nodes(ids:$ids) { ... on Product { id title handle status
      colour: metafield(namespace:$vns,key:$vkey) { value } group: metafield(namespace:$lns,key:$lkey) { value }
      variants(first:250) { nodes { id sku inventoryItem { id } selectedOptions { value } } pageInfo { hasNextPage } } } } }`,
    { ids: ids.slice(i, i + READ_BATCH), vns: settings.valueField.namespace, vkey: settings.valueField.key, lns: settings.listField.namespace, lkey: settings.listField.key })
    for (const node of data.nodes ?? []) {
      if (!node?.id) continue
      if (node.variants.pageInfo.hasNextPage) throw new WorkspaceScopeError(`"${node.title}" has more than 250 variants. Nexus manages at most 250 per Shopify product.`, 422)
      let group: string[] = []
      try { const parsed = JSON.parse(node.group?.value ?? '[]'); if (Array.isArray(parsed)) group = parsed.filter((id): id is string => typeof id === 'string' && productGid.test(id)) } catch { group = [] }
      out.push({ id: node.id, title: node.title, handle: node.handle, status: node.status, colourName: node.colour?.value ?? null, group,
        variants: node.variants.nodes.map((v: any) => ({ id: v.id, sku: v.sku || null, inventoryItemId: v.inventoryItem?.id ?? null, options: v.selectedOptions.map((o: { value: string }) => o.value) })) })
    }
  }
  return out
}

export type Destination = Awaited<ReturnType<typeof contentDestination>>
export const rowsWhere = (d: Destination) => ({ familyId: d.familyId, channelConnectionId: d.accountId, marketplace: d.marketplace, aliasKey: d.aliasKey ?? '' })

/** What the sheet and the review show: the plan, the store switch and the rows. No Shopify call. */
export async function colourProductsView(destination: Destination, plan: ColourPlan, settings: Awaited<ReturnType<typeof readColourProductSettings>>) {
  const rows = await prisma.shopifyColourProduct.findMany({ where: rowsWhere(destination), orderBy: { createdAt: 'asc' } })
  const linked = rows.some(r => r.state === 'LINKED' && r.shopifyProductId)
  return {
    familyId: destination.familyId, accountId: destination.accountId, settings,
    // Adopt only: the colours are linked and Nexus writes nothing else to them until "Start full sync".
    sync: { linked, adoptOnly: linked && await colourAdoptOnly(destination) },
    plan: { mode: plan.mode, splitAxis: plan.splitAxis, grouped: plan.grouped, issues: plan.issues,
      products: plan.products.map(p => ({ key: p.key, position: p.position, nexusValue: p.nexusValue, colourName: p.colourName, colourNameSource: p.colourNameSource, options: p.options, variants: p.variants.length,
        sizes: p.variants.map(v => ({ productId: v.productId, sku: v.sku, options: v.options.map(o => o.value) })) })) },
    colourProducts: rows.map(r => ({ id: r.id, valueKey: r.valueKey, colourName: r.colourName, state: r.state, shopifyProductId: r.shopifyProductId, remoteStatus: r.remoteStatus,
      checkedAt: r.checkedAt?.toISOString() ?? null, linkVerifiedAt: r.linkVerifiedAt?.toISOString() ?? null, proposal: r.proposal })),
  }
}

/**
 * The family's colour plan on this destination. S5 — each size under the SKU Shopify knows it by (its listing's own SKU,
 * else the product SKU: `withListingSkus`); `skuProblems` names a size whose listing has no single SKU — a caller that
 * calls Shopify refuses on it.
 */
export async function planFor(destination: Destination) {
  const rows = await prisma.shopifyColourProduct.findMany({ where: rowsWhere(destination),
    select: { id: true, valueKey: true, colourName: true, state: true, shopifyProductId: true, createdAt: true, linkVerifiedAt: true, proposal: true } })
  const colourNames = Object.fromEntries(rows.filter(r => r.colourName).map(r => [r.valueKey, r.colourName!]))
  const [settings, { plan: familyPlan }] = await Promise.all([readColourProductSettings(destination.accountId), loadColourPlan(destination.familyId, { colourNames })])
  const { plan, problems: skuProblems } = await withListingSkus(destination, familyPlan)
  return { rows, settings, plan, skuProblems }
}

export async function readColourProducts(productId: string, scope: ContentScope) {
  const destination = await contentDestination(productId, scope)
  const { settings, plan } = await planFor(destination)
  return colourProductsView(destination, plan, settings)
}

/** Reads Shopify and stores a proposal per colour. Confirmed links stay confirmed; nothing is written to Shopify. */
export async function findColourProducts(productId: string, scope: ContentScope, body: unknown) {
  const input = findBodySchema.parse(body ?? {})
  const destination = await contentDestination(productId, scope)
  return withColourSyncLock(destination, () => findDestination(destination, input))
}

async function findDestination(destination: Destination, input: z.infer<typeof findBodySchema>) {
  const { rows, settings, plan, skuProblems } = await planFor(destination)
  if (plan.mode !== 'colour-products' || !plan.splitAxis) return colourProductsView(destination, plan, settings)
  if (skuProblems.length) throw new WorkspaceScopeError(listingSkuRefusal(skuProblems), 409)
  const unknown = (input.choices ?? []).filter(c => !plan.products.some(p => p.key === c.valueKey))
  if (unknown.length) throw new WorkspaceScopeError(`${unknown.map(c => `"${c.valueKey}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a colour of this family. Reload, then choose again.`, 409)
  const graphql = guardedColourGraphql((await shopifyAdmin(destination.accountId)).graphql)
  const linked = linkedProducts(rows)
  const chosen = operatorChoices(rows, input.choices)
  const candidates = await gatherCandidates(graphql, settings, plan, [...Object.values(linked), ...Object.values(chosen), ...(input.sourceProductId ? [input.sourceProductId] : [])])
  const matches = matchColourProducts(plan, candidates, linked, chosen)
  const claimed = await claimedElsewhere(destination, matches.map(m => m.shopifyProductId).filter((id): id is string => !!id))
  // The store's active locations, for the review: with more than one, the operator says where a colour's stock counts.
  const locations = ((await graphql(`query NexusColourLocations { locations(first:250) { nodes { id name isActive } } }`)).locations?.nodes ?? [])
    .filter((l: any) => l?.isActive !== false && /^gid:\/\/shopify\/Location\/\d+$/.test(l?.id ?? '')).map((l: any) => ({ id: l.id as string, name: String(l.name ?? '') }))
  await saveProposals(destination, plan, matches, candidates, claimed, chosen)
  return { ...await colourProductsView(destination, plan, settings), locations }
}

/**
 * The operator's product per colour: the choices kept on the proposals of colours not linked yet, then this request's
 * (null withdraws one). Confirm passes the same set, so its fresh match is the one Find proposed.
 */
export function operatorChoices(rows: ReadonlyArray<{ valueKey: string; state: string; proposal: unknown }>, choices: ReadonlyArray<{ valueKey: string; shopifyProductId?: string | null }> = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const id = (row.proposal as { chosenProductId?: unknown } | null)?.chosenProductId
    if (row.state !== 'LINKED' && typeof id === 'string' && productGid.test(id)) out[row.valueKey] = id
  }
  for (const choice of choices) {
    if (choice.shopifyProductId) out[choice.valueKey] = choice.shopifyProductId
    else delete out[choice.valueKey]
  }
  return out
}

const storeSearchSchema = z.object({ query: z.string().trim().max(200).optional(), cursor: z.string().max(1000).optional() }).passthrough()
const STORE_PRODUCTS = `query NexusColourStoreProducts($query:String,$after:String,$vns:String!,$vkey:String!) {
  products(first:25,after:$after,query:$query,sortKey:TITLE) { nodes { id title handle status featuredMedia { preview { image { url } } }
    colour: metafield(namespace:$vns,key:$vkey) { value } variantsCount { count } variants(first:5) { nodes { sku } } }
  pageInfo { hasNextPage endCursor } } }`

/**
 * The store's products for the operator to choose a colour's product from, by title (Shopify's own product search): each
 * with its status, image, the colour it shows today (the store's colour field, `custom.variation_value`), its number of
 * variants, a SKU it holds, and the Nexus colour it is already linked to. Reads Shopify; writes nothing.
 */
export async function searchColourStoreProducts(productId: string, scope: ContentScope, raw: unknown) {
  const input = storeSearchSchema.parse(raw ?? {})
  const destination = await contentDestination(productId, scope)
  const settings = await readColourProductSettings(destination.accountId)
  const graphql = (await shopifyAdmin(destination.accountId)).graphql
  const data = await graphql(STORE_PRODUCTS, { query: input.query || null, after: input.cursor || null, vns: settings.valueField.namespace, vkey: settings.valueField.key })
  const nodes: any[] = (data.products?.nodes ?? []).filter((n: any) => n?.id && productGid.test(n.id))
  const claims = nodes.length ? await prisma.shopifyColourProduct.findMany({ where: { channelConnectionId: destination.accountId, shopifyProductId: { in: nodes.map(n => n.id) } },
    select: { shopifyProductId: true, valueKey: true, state: true, familyId: true, family: { select: { sku: true } } } }) : []
  return {
    items: nodes.map(n => {
      const claim = claims.find(c => c.shopifyProductId === n.id)
      return { id: n.id as string, title: n.title as string, handle: n.handle as string, status: n.status as string, image: n.featuredMedia?.preview?.image?.url ?? null,
        colourName: n.colour?.value ?? null, variants: n.variantsCount?.count ?? null, sampleSku: n.variants?.nodes?.find((v: any) => v?.sku)?.sku ?? null,
        linkedTo: claim ? { familySku: claim.family.sku, valueKey: claim.valueKey, state: claim.state, thisFamily: claim.familyId === destination.familyId } : null }
    }),
    cursor: data.products?.pageInfo?.hasNextPage ? data.products.pageInfo.endCursor ?? null : null,
  }
}

/** Value key → Shopify product, for the colours already confirmed. */
export const linkedProducts = (rows: ReadonlyArray<{ valueKey: string; state: string; shopifyProductId: string | null }>): Record<string, string> =>
  Object.fromEntries(rows.filter(r => r.state === 'LINKED' && r.shopifyProductId).map(r => [r.valueKey, r.shopifyProductId!]))

/**
 * Every Shopify product one colour match weighs: the seeds (linked products, a product the operator names), the products
 * holding the family's exact SKUs, and every member of their groups. Find and Confirm read the same set, so Confirm
 * re-runs the match Find proposed.
 */
export async function gatherCandidates(graphql: ShopifyGraphql, settings: Pick<ColourProductSettings, 'valueField' | 'listField'>, plan: ColourPlan, seeds: readonly string[]): Promise<ColourCandidate[]> {
  const seed = [...new Set([...seeds, ...await productsWithSkus(graphql, plan.products.flatMap(p => p.variants.map(v => v.sku)))])].slice(0, FIND_PRODUCT_LIMIT)
  let candidates = await readColourCandidates(graphql, settings, seed)
  const members = [...new Set(candidates.flatMap(c => c.group))].filter(id => !candidates.some(c => c.id === id)).slice(0, Math.max(0, FIND_PRODUCT_LIMIT - candidates.length))
  if (members.length) candidates = [...candidates, ...await readColourCandidates(graphql, settings, members)]
  return candidates
}

/** A Shopify product confirmed for another family can be this family's only after that link is removed. */
export function claimedElsewhere(destination: Destination, shopifyProductIds: readonly string[]) {
  return prisma.shopifyColourProduct.findMany({ where: { channelConnectionId: destination.accountId, familyId: { not: destination.familyId }, shopifyProductId: { in: [...shopifyProductIds] } },
    select: { shopifyProductId: true, family: { select: { sku: true } } } })
}

async function saveProposals(destination: Destination, plan: ColourPlan, matches: ColourMatch[], candidates: ColourCandidate[], claimed: Array<{ shopifyProductId: string | null; family: { sku: string } }>,
  chosen: Readonly<Record<string, string>>) {
  const at = new Date()
  await commitColourSyncChange(async tx => {
    const rows = await tx.shopifyColourProduct.findMany({ where: rowsWhere(destination) })
    for (const match of matches) {
      const candidate = candidates.find(c => c.id === match.shopifyProductId) ?? null
      const elsewhere = claimed.find(c => c.shopifyProductId && c.shopifyProductId === match.shopifyProductId)
      const issues = [...match.issues, ...(elsewhere ? [{ code: 'linked-elsewhere', productIds: [], message: `"${candidate?.title}" is already the Shopify product of ${elsewhere.family.sku}.` }] : [])]
      const proposal = { at: at.toISOString(), method: match.method, shopifyProductId: match.shopifyProductId, title: candidate?.title ?? null, handle: candidate?.handle ?? null,
        status: candidate?.status ?? null, shopifyColourName: match.shopifyColourName, variants: match.variants, missing: match.missing, extra: match.extra, skusToWrite: match.skusToWrite,
        skusToRecord: match.skusToRecord, skusToReplace: match.skusToReplace, chosenProductId: chosen[match.key] ?? null, issues }
      const row = rows.find(r => r.valueKey === match.key)
      const data = { splitAxis: plan.splitAxis!, proposal: proposal as unknown as Prisma.InputJsonValue, remoteStatus: candidate?.status ?? null, checkedAt: at,
        state: row?.state === 'LINKED' ? 'LINKED' : match.shopifyProductId && !elsewhere ? 'PROPOSED' : 'NOT_FOUND' }
      if (row) await tx.shopifyColourProduct.update({ where: { id: row.id }, data })
      else await tx.shopifyColourProduct.create({ data: { ...rowsWhere(destination), valueKey: match.key, ...data } })
    }
  })
}
