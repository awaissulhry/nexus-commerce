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

function hasCreds(): boolean {
  return !!(
    process.env.EBAY_APP_ID &&
    process.env.EBAY_CERT_ID &&
    process.env.EBAY_DEV_ID &&
    process.env.EBAY_TOKEN
  )
}

function endpoint(): string {
  return process.env.EBAY_SANDBOX === 'true'
    ? 'https://api.sandbox.ebay.com/ws/api.dll'
    : 'https://api.ebay.com/ws/api.dll'
}

function buildGetItemRequest(itemId: string): string {
  // IncludeItemSpecifics=true so VariationSpecifics come through;
  // OutputSelector kept narrow to what we parse so the response
  // stays small.
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${process.env.EBAY_TOKEN ?? ''}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ItemReturnAttributes</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
  <OutputSelector>ItemID</OutputSelector>
  <OutputSelector>PictureDetails.PictureURL</OutputSelector>
  <OutputSelector>Variations.VariationSpecificPictureSet</OutputSelector>
</GetItemRequest>`
}

function parseGetItemResponse(body: string): ParsedItemImages {
  const galleryUrls: string[] = []
  // PictureDetails contains one or more <PictureURL>…</PictureURL>.
  const picRe = /<PictureURL>([^<]+)<\/PictureURL>/g
  let match: RegExpExecArray | null
  while ((match = picRe.exec(body)) !== null) {
    if (match[1]) galleryUrls.push(match[1])
  }
  // Strip duplicates while preserving order — VariationSpecificPictureSet
  // also contains PictureURL tags, so we need a more targeted parser.
  // Simpler: re-extract from the PictureDetails block only.
  const pdMatch = body.match(/<PictureDetails>([\s\S]*?)<\/PictureDetails>/)
  const galleryFinal: string[] = []
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
    select: { id: true, ebayItemId: true },
  })
  if (!product?.ebayItemId) {
    return { ...base, itemId: null, skipped: 'NO_ITEM_ID' }
  }

  // Dev guard: dont attempt the call if real-API is off or creds
  // missing. Caller surfaces the "skipped" code so the FE can show
  // a "configure eBay creds" hint.
  if (!hasRealApi()) {
    return { ...base, itemId: product.ebayItemId, skipped: 'API_DISABLED' }
  }
  if (!hasCreds()) {
    return { ...base, itemId: product.ebayItemId, skipped: 'NO_CREDS' }
  }

  // Real call.
  const xmlPayload = buildGetItemRequest(product.ebayItemId)
  const compatLevel = process.env.EBAY_COMPAT_LEVEL || '1193'

  let body: string
  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-COMPATIBILITY-LEVEL': compatLevel,
        'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID ?? '',
        'X-EBAY-API-APP-NAME': process.env.EBAY_APP_ID ?? '',
        'X-EBAY-API-CERT-NAME': process.env.EBAY_CERT_ID ?? '',
        'X-EBAY-API-SITEID': process.env.EBAY_SITE_ID ?? '3',
        'Content-Type': 'text/xml',
      },
      body: xmlPayload,
    })
    if (!res.ok) {
      return { ...base, itemId: product.ebayItemId, error: `GetItem HTTP ${res.status}` }
    }
    body = await res.text()
  } catch (err) {
    return {
      ...base,
      itemId: product.ebayItemId,
      error: err instanceof Error ? err.message : 'GetItem failed',
    }
  }

  // Ack check.
  const ackMatch = body.match(/<Ack>([^<]+)<\/Ack>/)
  if (ackMatch?.[1] === 'Failure') {
    const errMatch = body.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)
    return { ...base, itemId: product.ebayItemId, error: `eBay GetItem Failure: ${errMatch?.[1] ?? 'unknown'}` }
  }

  const parsed = parseGetItemResponse(body)

  // Upsert rows. Use (productId, channel, marketplace=null,
  // externalSku, slot) as the unique key.
  const seenKeys = new Set<string>()
  let upserted = 0

  // Gallery rows: externalSku=null, slot = position
  for (let i = 0; i < parsed.galleryUrls.length; i++) {
    const url = parsed.galleryUrls[i]!
    const slot = String(i)
    const key = `null|${slot}`
    seenKeys.add(key)
    await prisma.channelLiveImage.upsert({
      where: {
        productId_channel_marketplace_externalSku_slot: {
          productId,
          channel: 'EBAY',
          marketplace: null,
          externalSku: null,
          slot,
        } as any,
      },
      create: {
        productId,
        channel: 'EBAY',
        marketplace: null,
        externalSku: null,
        asin: null,
        slot,
        url,
        sortOrder: i,
      },
      update: { url, sortOrder: i, fetchedAt: new Date() },
    })
    upserted++
  }

  // Variation-set rows: externalSku=variationValue, slot = position
  for (const set of parsed.variationSets) {
    for (let i = 0; i < set.urls.length; i++) {
      const url = set.urls[i]!
      const slot = String(i)
      const key = `${set.variationValue}|${slot}`
      seenKeys.add(key)
      await prisma.channelLiveImage.upsert({
        where: {
          productId_channel_marketplace_externalSku_slot: {
            productId,
            channel: 'EBAY',
            marketplace: null,
            externalSku: set.variationValue,
            slot,
          } as any,
        },
        create: {
          productId,
          channel: 'EBAY',
          marketplace: null,
          externalSku: set.variationValue,
          asin: null,
          slot,
          url,
          sortOrder: i,
        },
        update: { url, sortOrder: i, fetchedAt: new Date() },
      })
      upserted++
    }
  }

  // Delete stale rows: anything in DB for this (product, EBAY) that
  // we didnt re-upsert.
  const existing = await prisma.channelLiveImage.findMany({
    where: { productId, channel: 'EBAY' },
    select: { id: true, externalSku: true, slot: true },
  })
  const toDelete = existing
    .filter((r) => {
      const k = `${r.externalSku ?? 'null'}|${r.slot ?? ''}`
      return !seenKeys.has(k)
    })
    .map((r) => r.id)
  let deleted = 0
  if (toDelete.length > 0) {
    const res = await prisma.channelLiveImage.deleteMany({ where: { id: { in: toDelete } } })
    deleted = res.count
  }

  return {
    ...base,
    itemId: product.ebayItemId,
    picturesFetched: parsed.galleryUrls.length,
    variationSetsFetched: parsed.variationSets.length,
    rowsUpserted: upserted,
    rowsDeleted: deleted,
  }
}
