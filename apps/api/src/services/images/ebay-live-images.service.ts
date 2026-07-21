/**
 * PB.8a — Refresh "what's currently live on eBay" for a product.
 *
 * Calls eBay Trading API GetItem with the product's ebayItemId,
 * parses PictureDetails (gallery) + VariationSpecificPictureSet
 * (per-variation pictures), and upserts the result into the
 * ChannelLiveImage table as a read-replica of channel state.
 *
 * Today's resolution path:
 *   1. Look up product.ebayItemId.
 *   2. Single GetItem call.
 *   3. Walk PictureDetails/PictureURL and store one ChannelLiveImage
 *      per URL with slot = position-as-string ('0', '1', ...).
 *   4. Walk Variations/VariationSpecificPictureSet — for each set,
 *      store per-URL rows with externalSku=variationValue and slot
 *      = position-as-string within that set.
 *   5. Delete stale rows for this (product, channel='EBAY') that
 *      no longer appear.
 *
 * Dev-mode safety:
 *   The eBay Trading API requires real credentials. When
 *   NEXUS_EBAY_REAL_API !== 'true' OR creds are missing we return a
 *   no-op result rather than 500'ing, so the UI's "Refresh" button
 *   doesn't error in environments without eBay creds. Operator
 *   sees an empty strip (or stale rows from a prior real call) in
 *   that case.
 */

import prisma from '../../db.js'
import { callTradingApi, siteIdForMarket } from '../ebay-trading-api.service.js'
import { ebayAuthService } from '../ebay-auth.service.js'

export interface RefreshEbayLiveImagesResult {
  productId: string
  channel: 'EBAY'
  itemId: string | null
  picturesFetched: number
  variationSetsFetched: number
  rowsUpserted: number
  rowsDeleted: number
  skipped?: 'NO_ITEM_ID' | 'NO_CREDS' | 'API_DISABLED'
  error?: string
}

interface RefreshOptions {
  productId: string
}

interface ParsedItemImages {
  galleryUrls: string[]
  variationSets: Array<{ variationKey: string; variationValue: string; urls: string[] }>
}

function hasRealApi(): boolean {
  return process.env.NEXUS_EBAY_REAL_API === 'true'
}

function buildGetItemRequest(itemId: string): string {
  // OAuth (X-EBAY-API-IAF-TOKEN) is supplied by callTradingApi via header —
  // NO RequesterCredentials in the body. `Variations.Pictures` returns the
  // VariationSpecificName (the image axis, e.g. Colore) alongside each
  // VariationSpecificPictureSet, so we can record which axis the sets vary by.
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Item.ItemID</OutputSelector>
  <OutputSelector>Item.PictureDetails.PictureURL</OutputSelector>
  <OutputSelector>Item.Variations.Pictures</OutputSelector>
</GetItemRequest>`
}

function parseGetItemResponse(body: string): ParsedItemImages {
  // Gallery: extract from the PictureDetails block ONLY. A body-wide PictureURL
  // scan would also pull in the VariationSpecificPictureSet URLs (which live
  // under <Pictures>), mixing per-variation photos into the shared gallery.
  const galleryFinal: string[] = []
  const pdMatch = body.match(/<PictureDetails>([\s\S]*?)<\/PictureDetails>/)
  if (pdMatch) {
    const pdRe = /<PictureURL>([^<]+)<\/PictureURL>/g
    let m: RegExpExecArray | null
    while ((m = pdRe.exec(pdMatch[1] ?? '')) !== null) {
      if (m[1]) galleryFinal.push(m[1])
    }
  }

  // Variation sets: <VariationSpecificPictureSet><VariationSpecificValue>…</…>
  // <PictureURL>…</PictureURL> … </VariationSpecificPictureSet>
  const variationSets: ParsedItemImages['variationSets'] = []
  // We need both the variation NAME (e.g. "Color") AND each set's value.
  // The schema places <VariationSpecificName> outside of each set:
  // <Pictures><VariationSpecificName>Color</VariationSpecificName>
  //   <VariationSpecificPictureSet>...</...>
  //   ...
  // </Pictures>
  const picturesMatch = body.match(/<Pictures>([\s\S]*?)<\/Pictures>/)
  if (picturesMatch) {
    const inner = picturesMatch[1] ?? ''
    const nameMatch = inner.match(/<VariationSpecificName>([^<]+)<\/VariationSpecificName>/)
    const variationKey = nameMatch?.[1] ?? 'Color'
    const setRe = /<VariationSpecificPictureSet>([\s\S]*?)<\/VariationSpecificPictureSet>/g
    let sm: RegExpExecArray | null
    while ((sm = setRe.exec(inner)) !== null) {
      const setBlock = sm[1] ?? ''
      const valueMatch = setBlock.match(/<VariationSpecificValue>([^<]+)<\/VariationSpecificValue>/)
      const value = valueMatch?.[1]
      if (!value) continue
      const urlRe = /<PictureURL>([^<]+)<\/PictureURL>/g
      const urls: string[] = []
      let um: RegExpExecArray | null
      while ((um = urlRe.exec(setBlock)) !== null) {
        if (um[1]) urls.push(um[1])
      }
      if (urls.length > 0) {
        variationSets.push({ variationKey, variationValue: value, urls })
      }
    }
  }

  return { galleryUrls: galleryFinal, variationSets }
}

export async function refreshEbayLiveImages(
  opts: RefreshOptions,
): Promise<RefreshEbayLiveImagesResult> {
  const { productId } = opts

  const base: Omit<RefreshEbayLiveImagesResult, 'itemId'> = {
    productId,
    channel: 'EBAY',
    picturesFetched: 0,
    variationSetsFetched: 0,
    rowsUpserted: 0,
    rowsDeleted: 0,
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, sku: true, ebayItemId: true },
  })
  if (!product) {
    return { ...base, itemId: null, skipped: 'NO_ITEM_ID' }
  }
  // EB-IMG — listing shells carry no ebayItemId; their live ItemID lives on
  // the SharedListingMembership rows (parentSku = shell SKU). Fall back so
  // the drawer's live strip and post-publish read-back work on shells too.
  let liveItemId = product.ebayItemId
  let marketplace = 'IT' // eBay is IT-only today (project_active_channels)
  if (!liveItemId && product.sku) {
    const membership = await prisma.sharedListingMembership.findFirst({
      where: { parentSku: product.sku, status: 'ACTIVE' },
      select: { itemId: true, marketplace: true },
    })
    liveItemId = membership?.itemId ?? null
    if (membership?.marketplace) marketplace = membership.marketplace
  }
  if (!liveItemId) {
    return { ...base, itemId: null, skipped: 'NO_ITEM_ID' }
  }

  // Dev guard: don't attempt the call if the real-API opt-in is off. The FE
  // surfaces the "skipped" code as a hint.
  if (!hasRealApi()) {
    return { ...base, itemId: liveItemId, skipped: 'API_DISABLED' }
  }

  // Auth: the whole system authenticates eBay via the DB channelConnection +
  // ebayAuthService (OAuth / X-EBAY-API-IAF-TOKEN), NOT the legacy Auth'n'Auth
  // EBAY_TOKEN. The old legacy path here silently no-op'd on any OAuth
  // deployment (EBAY_TOKEN unset/stale) — the live image strip was always
  // empty. Mirror reconcileMembershipsFromEbay / the shared-image push.
  const conn = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true },
  })
  if (!conn) {
    return { ...base, itemId: liveItemId, skipped: 'NO_CREDS' }
  }

  let body: string
  try {
    const oauthToken = await ebayAuthService.getValidToken(conn.id)
    // callTradingApi injects the IAF token + throws on HTTP error / Ack=Failure
    // (surfacing the real LongMessage), so no manual ack check is needed.
    const res = await callTradingApi('GetItem', buildGetItemRequest(liveItemId), {
      oauthToken,
      siteId: siteIdForMarket(marketplace),
    })
    body = res.raw
  } catch (err) {
    return {
      ...base,
      itemId: liveItemId,
      error: err instanceof Error ? err.message : 'GetItem failed',
    }
  }

  const parsed = parseGetItemResponse(body)

  // Full-replace the read-replica for this (product, EBAY). We can't per-row
  // upsert because the composite unique key includes the NULLABLE `marketplace`
  // (null for eBay) and Prisma rejects null in a composite-unique WHERE — the
  // latent reason the old upsert threw once auth actually returned data.
  // Delete-then-create is also the honest model for a live read-replica: it
  // mirrors exactly what's live right now (rows removed on eBay disappear here).
  const rows: Array<{
    productId: string; channel: string; marketplace: null; externalSku: string | null
    asin: null; slot: string; url: string; sortOrder: number
  }> = []
  // Gallery rows: externalSku=null, slot = position.
  parsed.galleryUrls.forEach((url, i) => {
    rows.push({ productId, channel: 'EBAY', marketplace: null, externalSku: null, asin: null, slot: String(i), url, sortOrder: i })
  })
  // Variation-set rows: externalSku=variationValue, slot = position within the set.
  for (const set of parsed.variationSets) {
    set.urls.forEach((url, i) => {
      rows.push({ productId, channel: 'EBAY', marketplace: null, externalSku: set.variationValue, asin: null, slot: String(i), url, sortOrder: i })
    })
  }

  const delRes = await prisma.channelLiveImage.deleteMany({ where: { productId, channel: 'EBAY' } })
  if (rows.length > 0) {
    await prisma.channelLiveImage.createMany({ data: rows })
  }

  return {
    ...base,
    itemId: liveItemId,
    picturesFetched: parsed.galleryUrls.length,
    variationSetsFetched: parsed.variationSets.length,
    rowsUpserted: rows.length,
    rowsDeleted: delRes.count,
  }
}
