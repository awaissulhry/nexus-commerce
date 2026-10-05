/**
 * MCP full control I6 — what each channel account holds, as the channel's own read says (section 04 §4.1, §4.5).
 *
 * A sweep reads one account's live ids through the channel gateway (an adapter per channel: eBay here; Amazon,
 * Shopify and Etsy in channel-held-readers.ts), and records each one in ChannelHeldId, linked to the listing in this
 * business that carries it. The identity audit then compares (identity-audit.service.ts): #3 a listing whose id its
 * account does not hold, #4 an id the account holds that no listing carries, #12 a seller SKU that differs from the one
 * Nexus would send (recorded, never renamed on the channel: d12).
 *
 * Read-only towards the channel. A read that failed or stopped early (a page cap) is INCOMPLETE: what it saw is
 * recorded, but nothing is marked missing (endedAt) — only a complete read may say an id is gone — and ChannelHeldSweep
 * says so. The audit trusts "not held" only after a complete sweep, for listings that existed when it began.
 *
 * Off by default: the daily job (jobs/identity-channel-sweep.job.ts) runs only with NEXUS_IDENTITY_SWEEP=1. Channel
 * logins are KMS-sealed, so real reads work in the deployed API only.
 */
import prisma from '../../db.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { identitySellerSku } from '../listing-claim-identity.js'
import { shortShopifyId } from './identity-read.service.js'

export type HeldChannel = 'EBAY' | 'AMAZON' | 'SHOPIFY' | 'ETSY'

/** One id the account holds, as its channel reports it. */
export interface HeldItem {
  /** The Nexus market code when the read names one; null = take it from the listing that carries the id. */
  marketplace: string | null
  externalId: string
  parentExternalId?: string | null
  sellerSku?: string | null
  title?: string | null
  remoteStatus?: string | null
}

export interface HeldRead {
  items: HeldItem[]
  /** True only when the read saw everything the account holds (every page, no error). */
  complete: boolean
  /** Why it is incomplete. */
  reason?: string
}

export interface HeldConnection {
  id: string
  channelType: string
  marketplace: string | null
  externalAccountId: string | null
}

export interface HeldReader {
  channel: HeldChannel
  read(connection: HeldConnection): Promise<HeldRead>
}

export interface SweepReport {
  channel: HeldChannel
  connectionId: string
  complete: boolean
  reason?: string
  seen: number
  linked: number
  unlinked: number
  ended: number
}

const clip = (text: string | null | undefined, cap = 300) => (text == null ? null : text.length > cap ? `${text.slice(0, cap - 1)}…` : text)

/** The form an id is compared in: Shopify ids without their gid prefix, everything trimmed. */
export function heldIdKey(channel: string, id: string | null | undefined): string | null {
  if (id == null) return null
  const text = channel === 'SHOPIFY' ? shortShopifyId(id) : String(id).trim()
  return text || null
}

type ListingRow = {
  id: string
  productId: string
  marketplace: string
  externalListingId: string | null
  platformAttributes: unknown
  channelSku: string | null
  liveChannelSku: string | null
  product: { sku: string; parentId: string | null }
  offers: Array<{ sku: string; fulfillmentMethod: string; isActive: boolean }>
}

/**
 * The listing of this account that carries an id: the one whose seller SKU is the channel's, else the family's own.
 * The seller SKU is `identitySellerSku` (S8: the listing's own SKU first), the same order as the audit's #12 comparison.
 */
function pick(candidates: ListingRow[], item: HeldItem): ListingRow | null {
  if (!candidates.length) return null
  const inMarket = item.marketplace ? candidates.filter((c) => c.marketplace === item.marketplace) : candidates
  const pool = inMarket.length ? inMarket : candidates
  const sku = item.sellerSku?.trim()
  if (sku) {
    const bySku = pool.find((c) => identitySellerSku(c) === sku)
    if (bySku) return bySku
  }
  return pool.find((c) => !c.product.parentId || c.product.parentId === c.productId) ?? pool[0]
}

/**
 * Sweep one account of this business: read what it holds, record it, link it, and — after a complete read only — mark
 * what it no longer holds.
 */
export async function sweepAccount(connectionId: string, reader: HeldReader, now = new Date()): Promise<SweepReport> {
  const ws = workspaceIdForQuery()
  const connection = await prisma.channelConnection.findFirst({
    where: { id: connectionId, workspaceId: ws },
    select: { id: true, channelType: true, marketplace: true, externalAccountId: true },
  })
  if (!connection) throw new Error('This account is not one of this business\'s own.')
  if (connection.channelType.toUpperCase() !== reader.channel) throw new Error(`This account is not a ${reader.channel} account.`)
  const channel = reader.channel
  const report: SweepReport = { channel, connectionId, complete: false, seen: 0, linked: 0, unlinked: 0, ended: 0 }

  await prisma.channelHeldSweep.upsert({
    where: { held_sweep: { workspaceId: ws, channelConnectionId: connectionId, channel } },
    create: { channel, channelConnectionId: connectionId, startedAt: now },
    update: { startedAt: now, finishedAt: null, reason: null },
  })

  let read: HeldRead
  try {
    read = await reader.read(connection)
  } catch (error) {
    read = { items: [], complete: false, reason: `the read failed: ${error instanceof Error ? error.message : String(error)}` }
  }

  const listings = await prisma.channelListing.findMany({
    where: { channelConnectionId: connectionId, channel, product: { deletedAt: null } },
    select: {
      id: true, productId: true, marketplace: true, externalListingId: true, platformAttributes: true,
      channelSku: true, liveChannelSku: true,
      product: { select: { sku: true, parentId: true } },
      offers: { select: { sku: true, fulfillmentMethod: true, isActive: true } },
    },
  })
  const byId = new Map<string, ListingRow[]>()
  for (const l of listings as unknown as ListingRow[]) {
    const keys = new Set([heldIdKey(channel, l.externalListingId)])
    if (channel === 'SHOPIFY') {
      const pa = (l.platformAttributes ?? {}) as Record<string, unknown>
      keys.add(heldIdKey(channel, pa.shopifyProductId as string | undefined))
      keys.add(heldIdKey(channel, pa.variantId as string | undefined))
    }
    for (const key of keys) if (key) byId.set(key, [...(byId.get(key) ?? []), l])
  }

  const seenKeys = new Set<string>()
  for (const raw of read.items) {
    const externalId = heldIdKey(channel, raw.externalId)
    if (!externalId) continue
    const item: HeldItem = { ...raw, externalId, sellerSku: raw.sellerSku?.trim() ?? '' }
    const listing = pick(byId.get(externalId) ?? [], item)
    const marketplace = item.marketplace ?? listing?.marketplace ?? connection.marketplace ?? 'UNKNOWN'
    const sellerSku = item.sellerSku ?? ''
    const key = `${marketplace}|${externalId}|${sellerSku}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const existing = await prisma.channelHeldId.findUnique({
      where: { held_id: { workspaceId: ws, channelConnectionId: connectionId, marketplace, externalId, sellerSku } },
      select: { id: true, matchState: true },
    })
    const matchState = existing?.matchState === 'IGNORED' ? 'IGNORED' : listing ? 'LINKED' : 'UNLINKED'
    const data = {
      channel, parentExternalId: heldIdKey(channel, item.parentExternalId ?? null), title: clip(item.title), remoteStatus: clip(item.remoteStatus, 60),
      lastSeenAt: now, endedAt: null, listingId: listing?.id ?? null, matchState,
    }
    if (existing) await prisma.channelHeldId.update({ where: { id: existing.id }, data })
    else await prisma.channelHeldId.create({ data: { ...data, channelConnectionId: connectionId, marketplace, externalId, sellerSku, firstSeenAt: now } })
    report.seen++
    if (listing) report.linked++
    else report.unlinked++
  }

  if (read.complete) {
    // Only a read that saw everything may say an id is gone.
    const ended = await prisma.channelHeldId.updateMany({
      where: { channelConnectionId: connectionId, channel, endedAt: null, lastSeenAt: { lt: now } },
      data: { endedAt: now },
    })
    report.ended = ended.count
  }
  report.complete = read.complete
  if (read.reason) report.reason = read.reason
  await prisma.channelHeldSweep.update({
    where: { held_sweep: { workspaceId: ws, channelConnectionId: connectionId, channel } },
    data: { finishedAt: new Date(), complete: read.complete, itemsSeen: report.seen, reason: clip(read.reason ?? null), ...(read.complete ? { lastCompleteAt: now } : {}) },
  })
  if (!read.complete) logger.warn('[identity-sweep] incomplete read: nothing marked missing', { channel, connectionId, reason: read.reason })
  return report
}

// ── eBay: GetMyeBaySelling ActiveList, page by page, through the gateway ─────────────────────────────

const TRADING_URL = 'https://api.ebay.com/ws/api.dll'
const EBAY_SITE_TO_MARKET: Record<string, string> = { Italy: 'IT', Germany: 'DE', France: 'FR', Spain: 'ES', UK: 'UK', US: 'US' }

/** The items of one ActiveList page: the item, its own SKU and each variation's SKU. */
export function parseHeldEbayPage(xml: string): HeldItem[] {
  const out: HeldItem[] = []
  for (const match of xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
    const block = match[1]
    const withoutVariations = block.replace(/<Variations>[\s\S]*?<\/Variations>/g, '')
    const tag = (name: string, from = withoutVariations) => from.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim()
    const itemId = tag('ItemID')
    if (!itemId) continue
    const site = tag('Site')
    const base = { marketplace: site ? EBAY_SITE_TO_MARKET[site] ?? null : null, externalId: itemId, title: tag('Title') ?? null, remoteStatus: tag('ListingStatus') ?? 'Active' }
    const variationSkus = [...block.matchAll(/<Variation>[\s\S]*?<SKU>([^<]*)<\/SKU>[\s\S]*?<\/Variation>/g)].map((m) => m[1].trim()).filter(Boolean)
    if (variationSkus.length) for (const sku of variationSkus) out.push({ ...base, sellerSku: sku, parentExternalId: itemId })
    else out.push({ ...base, sellerSku: tag('SKU') ?? '' })
  }
  return out
}

export function ebayHeldReader(options: {
  /** One Trading call through the gateway (tests stand it in). */
  send?: (connectionId: string, body: string, page: number) => Promise<string>
  pageCap?: number
} = {}): HeldReader {
  const pageCap = options.pageCap ?? Number(process.env.NEXUS_IDENTITY_SWEEP_PAGE_CAP ?? 50)
  const send = options.send ?? (async (connectionId: string, body: string) => {
    const { EbayAuthService } = await import('../ebay-auth.service.js')
    const { ebayTradingSend } = await import('../gateway/ebay.js')
    const token = await new EbayAuthService().getValidToken(connectionId)
    const response = await ebayTradingSend(connectionId, TRADING_URL, {
      method: 'POST',
      headers: { 'X-EBAY-API-COMPATIBILITY-LEVEL': '1193', 'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling', 'X-EBAY-API-SITEID': '101', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' },
      body,
    })
    return response.text()
  })
  return {
    channel: 'EBAY',
    async read(connection) {
      const items: HeldItem[] = []
      for (let page = 1; page <= pageCap; page++) {
        const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList>
</GetMyeBaySellingRequest>`
        let xml: string
        try {
          xml = await send(connection.id, body, page)
        } catch (error) {
          return { items, complete: false, reason: `page ${page} could not be read: ${error instanceof Error ? error.message : String(error)}` }
        }
        const ack = xml.match(/<Ack>(.*?)<\/Ack>/)?.[1]
        if (ack !== 'Success' && ack !== 'Warning') {
          return { items, complete: false, reason: `page ${page}: eBay answered ${ack ?? 'nothing'}` }
        }
        items.push(...parseHeldEbayPage(xml))
        const totalPages = Number(xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? 1)
        if (page >= totalPages) return { items, complete: true }
        if (page === pageCap) return { items, complete: false, reason: `stopped at the ${pageCap}-page cap with ${totalPages} pages (NEXUS_IDENTITY_SWEEP_PAGE_CAP)` }
      }
      return { items, complete: false, reason: 'no page was read' }
    },
  }
}
