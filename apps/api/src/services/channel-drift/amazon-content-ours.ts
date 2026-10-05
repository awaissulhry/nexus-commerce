/**
 * PLAN A-39 (R-41) — "ours" for ONE Amazon listing: what the studio publication builder WOULD send for its content and
 * its mapped attributes, built per listing through the builder's own seams — never a second opinion of the payload.
 *
 *   · content    — `resolvePublishContent` → the review gate → `buildAmazonContentEntries`
 *                  (`studio-publication-amazon.ts`, the `buildAmazonContentAttributes` call);
 *   · attributes — `resolveBatch` (this product only, cached schemas only) → `mappedAmazonRoots` per root (A-33's ONE
 *                  serializer) + the listing settings the studio serialises with `attributesFromCells`.
 *
 * NOT the whole-family builder (`prepareAmazonPublication`): it refuses a FAMILY on ~15 publish guards (images,
 * fulfilment, a closed offer…), and one family's guard must not blind the read of every listing in it.
 *
 * What the builder would NOT send is reported as not compared, with the reason — never as clean:
 *   · content under an unreviewed machine draft (the builder refuses, D7);
 *   · a root whose cell has an error or a pending translation (`applyResolvedMappingToAmazonFeed` refuses);
 *   · a root with listing-owned leaves (`mappedAmazonRoots` refuses);
 *   · a family's variation-axis roots (the variation resolver owns them) and the structure roots;
 *   · price, stock, media, channel-reported data (their own builders; price/stock are 3.5a).
 */
import prisma from '../../db.js'
import { withCachedSchemas } from '../pim/cached-schema-context.js'
import { marketLanguages, languageTag } from '../pim/market-languages.js'
import { resolvePublishContent, publishReviewIssues, requireReviewedContent } from '../pim/publish-review-gate.js'
import { buildAmazonContentEntries } from '../pim/amazon-content-payload.js'
import { resolveBatch } from '../pim/mapping/resolve-batch.service.js'
import { loadAmazonSpec } from '../pim/channel-specs/index.js'
import { attributesFromCells } from '../pim/mapping/schema-requirements.js'
import { mappedAmazonRoots } from '../amazon/mapping-payload.js'
import { loadStoredVariationProjection } from '../pim/stored-variation-projection.js'
import { configuredAmazonMarketplaceId } from '../categories/marketplace-ids.js'
import { CONTENT_ROOTS, STRUCTURE_ROOTS, OUT_OF_SCOPE_ROOTS, type ContentEntry, type NotCompared } from './amazon-content-compare.js'
import { reportedSkuOf } from '../listings/reported-sku.js'

/** The studio's owners whose values another builder sends (`studio-publication-amazon.ts`, `ownedKeys`). */
const OTHER_BUILDERS = new Set(['Pricing', 'Inventory', 'Media', 'Product media', 'Channel-reported data'])


export interface AmazonOurs {
  listingId: string
  sku: string
  market: string
  marketplaceId: string
  accountId: string
  tags: string[]
  content: Record<string, ContentEntry[]>
  attributes: Record<string, unknown>
  notCompared: NotCompared[]
}

/**
 * The seller SKU Amazon holds this listing under (S7, `reportedSkuOf`): its confirmed own SKU, else the studio's rule
 * (one active offer SKU, then the stored identity, else the product's — `studio-publication-amazon.ts`). No single SKU
 * is a reason, never a guess.
 */
function sellerSku(listing: Parameters<typeof reportedSkuOf>[0] & { product: { sku: string } }): { ok: true; sku: string } | { ok: false; reason: string } {
  const answer = reportedSkuOf(listing, listing.product.sku)
  if (!answer.conflict) return { ok: true, sku: answer.sku }
  return { ok: false, reason: answer.conflict.code === 'MULTIPLE_ACTIVE_OFFERS'
    ? 'several active seller SKUs — the builder would refuse'
    : `no single seller SKU — ${answer.conflict.sentence}` }
}

export type OursResult = { ok: true; ours: AmazonOurs } | { ok: false; reason: string }

export async function amazonContentOurs(listingId: string): Promise<OursResult> {
  const listing = await prisma.channelListing.findUnique({ where: { id: listingId }, include: { translations: true, offers: true,
    product: { include: { translations: true, parent: { include: { translations: true } } } } } })
  if (!listing || listing.channel !== 'AMAZON') return { ok: false, reason: 'not an Amazon listing' }
  if (!listing.channelConnectionId) return { ok: false, reason: 'the listing names no Amazon account' }
  const seller = sellerSku(listing)
  if (seller.ok === false) return { ok: false, reason: seller.reason }
  const sku = seller.sku
  const market = listing.marketplace.toUpperCase()
  const marketplaceId = await configuredAmazonMarketplaceId(market)
  if (!marketplaceId) return { ok: false, reason: `no Amazon marketplace id configured for ${market}` }
  const languages = await marketLanguages('AMAZON', market)
  if (!languages.length) return { ok: false, reason: `no content language configured for Amazon·${market}` }
  const tags = [...new Set(languages.map(l => languageTag(l, market)))]
  const notCompared: NotCompared[] = []
  const product = listing.product as any
  const parent = product.parent ?? null

  // ── content: the builder's own seam ──
  let content: Record<string, ContentEntry[]> = {}
  const rows = await resolvePublishContent({ product, parent, listing: listing as any, channel: 'AMAZON', marketplace: market })
  const review = requireReviewedContent() ? publishReviewIssues(rows) : []
  if (review.length) {
    for (const root of CONTENT_ROOTS) for (const tag of tags) notCompared.push({ field: `${root}[${tag}]`, reason: 'an unreviewed machine draft — the builder would refuse to send it (D7)' })
  } else content = buildAmazonContentEntries(rows, { marketplace: market, marketplaceId })

  // ── attributes: the resolver's cells through A-33's serializer, cached schemas only (no provider call) ──
  const attributes: Record<string, unknown> = {}
  try {
    await withCachedSchemas(async () => {
      const resolved = await resolveBatch({ channel: 'AMAZON', marketplace: market, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey ?? '',
        productIds: [listing.productId], locale: languages[0], includeCatalogue: true })
      const data = resolved.products[0]
      if (!data || !resolved.catalogue) { notCompared.push({ field: '(attributes)', reason: 'the product could not be resolved' }); return }
      const productType = String(data.category?.channelCategoryId ?? product.productType ?? '').toUpperCase()
      const spec = productType ? await loadAmazonSpec(market, productType, listing.channelConnectionId) : null
      if (!spec || spec.absent || !resolved.catalogue.schema?.present) { notCompared.push({ field: '(attributes)', reason: `no cached ${productType || 'category'} schema for Amazon·${market}` }); return }
      const catalogue = resolved.catalogue.fields
      const cells = data.cells
      const rootOf = (key: string) => spec.fields.find(f => f.key === key)?.attribute ?? null
      const skip = new Set<string>([...CONTENT_ROOTS, ...STRUCTURE_ROOTS, ...OUT_OF_SCOPE_ROOTS])
      if (product.parentId) {
        const stored = await loadStoredVariationProjection({ productId: product.parentId, channel: 'AMAZON', market, accountId: listing.channelConnectionId, aliasKey: listing.aliasKey ?? '' })
        for (const axis of stored.cell.axes.filter(a => a.included && a.target)) {
          for (const f of spec.fields.filter(f => f.key === axis.target || f.attribute === axis.target)) {
            if (!skip.has(f.attribute)) notCompared.push({ field: f.attribute, reason: 'a variation axis — the variation resolver sends it' })
            skip.add(f.attribute)
          }
        }
      }
      // Mapped roots: the fields `applyResolvedMappingToAmazonFeed` serialises.
      const mapped = catalogue.filter(f => !f.sourceOwner && f.schemaKnown !== false)
      const roots = new Set(mapped.map(f => rootOf(f.fieldKey)).filter((r): r is string => !!r && !skip.has(r)))
      for (const root of [...roots].sort()) {
        const keys = spec.fields.filter(f => f.attribute === root).map(f => f.key)
        const blocked = keys.map(k => cells[k]).find(c => c && (c.errors?.length || c.needsTranslation))
        if (blocked) { notCompared.push({ field: root, reason: blocked.needsTranslation ? 'a translation is pending — the builder would refuse' : `the mapping has an error — the builder would refuse: ${blocked.errors.join('; ')}` }); continue }
        try {
          const value = mappedAmazonRoots(spec, catalogue, cells, new Set([root]))[root]
          if (value !== undefined) attributes[root] = value
        } catch (error) { notCompared.push({ field: root, reason: error instanceof Error ? error.message : String(error) }) }
      }
      // Listing settings the studio serialises one level up (`ownedKeys`), minus price.
      const owned = catalogue.filter(f => f.sourceOwner && !OTHER_BUILDERS.has(f.sourceOwner.label)).map(f => f.fieldKey)
      const values = Object.fromEntries(owned.filter(k => cells[k] !== undefined).map(k => [k, cells[k].value]))
      for (const [root, value] of Object.entries(attributesFromCells(spec, values))) {
        if (!skip.has(root) && attributes[root] === undefined && value !== undefined) attributes[root] = value
      }
    })
  } catch (error) {
    notCompared.push({ field: '(attributes)', reason: `the attributes could not be built: ${error instanceof Error ? error.message : String(error)}` })
  }
  return { ok: true, ours: { listingId, sku, market, marketplaceId, accountId: listing.channelConnectionId, tags, content, attributes, notCompared } }
}
