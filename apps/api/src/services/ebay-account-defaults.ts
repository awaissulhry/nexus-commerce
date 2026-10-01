/**
 * Publish without surprises (2026-10-01, audit P2/P3/P5) — what Nexus last learned about an eBay account's defaults,
 * kept on the account (`ChannelConnection.connectionMetadata`) so a review in dry-run mode and the readiness check can
 * use it without asking eBay.
 *
 *   · `itemLocation` — the account's item location (country, postal code, city) from its first usable eBay inventory
 *     location. Publish already falls back to it (`studio-publication-ebay.ts`); until now only the country was read and
 *     nothing wrote it, so every new family needed a postal code typed by hand.
 *   · `ebayAccountRead` — whether that read found a usable location, and per eBay market whether the account has a
 *     shipping, payment and return policy. Only a read that SUCCEEDED is recorded: a failed read says nothing, and a
 *     check built on it would refuse on a guess.
 *
 * Written by `EbayAccountService.getSnapshot` whenever it reads eBay. Pure readers below; one writer, which never throws.
 */
import type { EbayMerchantLocation } from './ebay-account.service.js'

export type EbayPolicyKind = 'shipping' | 'payment' | 'return'
export const EBAY_POLICY_KINDS: readonly EbayPolicyKind[] = ['shipping', 'payment', 'return']
/** The policy id fields, per kind, as the sheet and the account default name them. */
export const EBAY_POLICY_FIELD: Readonly<Record<EbayPolicyKind, 'fulfillmentPolicyId' | 'paymentPolicyId' | 'returnPolicyId'>> = {
  shipping: 'fulfillmentPolicyId', payment: 'paymentPolicyId', return: 'returnPolicyId',
}

export interface EbayItemLocation { country: string; postalCode: string; city: string }

interface StoredRead {
  locations?: { readAt: string; found: boolean }
  policies?: Record<string, Partial<Record<EbayPolicyKind, boolean>> & { readAt: string }>
}

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const text = (value: unknown) => value == null ? '' : String(value).trim()

/** The eBay marketplace id a 2-letter market goes by (UK is eBay's GB site). */
export function ebayMarketplaceId(market: string): string {
  const code = market.toUpperCase().replace(/^EBAY_/, '')
  return code === 'UK' || code === 'GB' ? 'EBAY_GB' : `EBAY_${code}`
}

/** The first usable location: enabled, with a country and a postal code or city (what eBay needs to create a listing). */
export function usableEbayLocation(locations: readonly EbayMerchantLocation[]): (EbayItemLocation & { key: string }) | null {
  for (const location of locations) {
    if (location.enabled === false) continue
    const country = text(location.country).toUpperCase(), postalCode = text(location.postalCode), city = text(location.city)
    if (/^[A-Z]{2}$/.test(country) && (postalCode || city)) return { key: location.key, country, postalCode, city }
  }
  return null
}

/**
 * The item location a listing sends: its own cells win, then the account's stored location, then the server's default.
 * eBay takes the country with a postal code OR a city (Trading `Item.PostalCode` / `Item.Location`).
 */
export function resolveEbayItemLocation(own: { country?: unknown; postalCode?: unknown; city?: unknown }, metadata: unknown, env: NodeJS.ProcessEnv = process.env): EbayItemLocation {
  const origin = record(record(metadata).itemLocation)
  const first = (...values: unknown[]) => text(values.find(value => text(value) !== ''))
  return {
    country: first(own.country, origin.country, env.EBAY_ITEM_COUNTRY),
    city: first(own.city, origin.city, env.EBAY_ITEM_LOCATION),
    postalCode: first(own.postalCode, origin.postalCode, env.EBAY_ITEM_POSTAL_CODE),
  }
}

export const isCompleteEbayLocation = (location: EbayItemLocation) => !!location.country && !!(location.postalCode || location.city)

/** Whether the last successful read of this account found no usable location (true), found one (false), or never ran (null). */
export function ebayLocationKnownMissing(metadata: unknown): boolean | null {
  const read = record(record(metadata).ebayAccountRead) as StoredRead
  return read.locations ? !read.locations.found : null
}

/** Per policy kind: true when the last successful read found NO policy of that kind for this market; null when unknown. */
export function ebayPolicyKnownMissing(metadata: unknown, market: string): Record<EbayPolicyKind, boolean | null> {
  const read = record(record(metadata).ebayAccountRead) as StoredRead
  const facts = record(read.policies?.[ebayMarketplaceId(market)])
  return Object.fromEntries(EBAY_POLICY_KINDS.map(kind => [kind, typeof facts[kind] === 'boolean' ? !facts[kind] : null])) as Record<EbayPolicyKind, boolean | null>
}

/**
 * Keep what one successful read of the account learned. Only what was READ is written (a failed policy list or location
 * list is left as it was). An `itemLocation` someone set by other means (no `source: 'ebay'`) is never replaced.
 * Optimistic: the row is updated only if nobody changed it meanwhile; a lost race is simply not recorded (the next read
 * records it). Never throws — publishing must not fail because a note could not be kept.
 */
export async function rememberEbayAccountRead(connectionId: string, marketplaceId: string, read: {
  locations?: readonly EbayMerchantLocation[]
  policies?: Partial<Record<EbayPolicyKind, number>>
}): Promise<void> {
  try {
    const { default: prisma } = await import('../db.js')
    const row = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { connectionMetadata: true, updatedAt: true } })
    if (!row) return
    const metadata = record(row.connectionMetadata)
    const previous = record(metadata.ebayAccountRead) as StoredRead
    const now = new Date().toISOString()
    const next: Record<string, unknown> = { ...metadata }
    const stored: StoredRead = { ...previous }
    let changed = false
    if (read.locations) {
      const usable = usableEbayLocation(read.locations)
      if (previous.locations?.found !== !!usable) { stored.locations = { readAt: now, found: !!usable }; changed = true }
      const current = record(metadata.itemLocation)
      if (usable && (!Object.keys(current).length || current.source === 'ebay')) {
        const location = { country: usable.country, postalCode: usable.postalCode || null, city: usable.city || null, locationKey: usable.key, source: 'ebay' }
        if (current.country !== location.country || (current.postalCode ?? null) !== location.postalCode || (current.city ?? null) !== location.city || current.locationKey !== location.locationKey) {
          next.itemLocation = { ...location, readAt: now }
          changed = true
        }
      }
    }
    if (read.policies && Object.keys(read.policies).length) {
      const before = record(previous.policies?.[marketplaceId])
      const facts = Object.fromEntries(Object.entries(read.policies).map(([kind, count]) => [kind, (count ?? 0) > 0]))
      if (Object.entries(facts).some(([kind, has]) => before[kind] !== has)) {
        stored.policies = { ...(previous.policies ?? {}), [marketplaceId]: { ...before, ...facts, readAt: now } }
        changed = true
      }
    }
    if (!changed) return
    next.ebayAccountRead = stored
    await prisma.channelConnection.updateMany({ where: { id: connectionId, updatedAt: row.updatedAt }, data: { connectionMetadata: next as never } })
  } catch (error) {
    console.warn(`[EbayAccountService] account defaults not kept: ${error instanceof Error ? error.message : String(error)}`)
  }
}
