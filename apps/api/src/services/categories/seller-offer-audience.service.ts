/**
 * Amazon Business (B2B) step 1 (~/nexus-archive/2026-10-12-amazon-business-b2b/RESEARCH.md) — WHICH offer audiences
 * Amazon allows this business's account, per market and product type.
 *
 * Amazon lists the `B2B` audience only in a definition asked for WITH the account's `sellerId`. The shared
 * `CategorySchema` cache is marketplace-wide on purpose (schema-sync.service.ts) and never asks with it, so it can never
 * say B2B. Measured 2026-10-12: with `sellerId` all six product types in use on IT and DE list `["B2B","ALL"]`; without
 * it, `["ALL"]` only.
 *
 * The answer is kept as a `SellerReferenceLabel` row (fieldKey `purchasable_offer.audience`, labels = audience code →
 * Amazon's name), keyed by the connection whose credentials asked. The nightly schema refresh writes it for this
 * business's OWN Amazon accounts; the Matrix reads it (one indexed read, never a provider call).
 */
import prisma from '../../db.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { isOwnConnection, listActiveConnections } from '../connection-resolver.service.js'
import { amazonSellerOfferAudience } from './seller-schema.service.js'
import { normaliseCategory } from './schema-coverage.service.js'

export const OFFER_AUDIENCE_FIELD_KEY = 'purchasable_offer.audience'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const upper = (s: string) => s.trim().toUpperCase()

/**
 * Ask Amazon, per (market, product type) the business uses × each of its own active Amazon accounts, and keep the
 * audiences. An empty answer is not written (it would erase a real one); one failure is logged and the loop goes on.
 */
export async function refreshSellerOfferAudiences(
  pairs: ReadonlyArray<{ marketplace: string; productType: string }>,
  opts: { throttleMs?: number; label?: string } = {},
): Promise<{ stored: number; failed: number }> {
  const throttleMs = opts.throttleMs ?? 300
  const connections = (await listActiveConnections('AMAZON')).filter(isOwnConnection)
  let stored = 0, failed = 0
  for (const connection of connections) {
    for (const pair of pairs) {
      const marketplace = upper(pair.marketplace)
      try {
        const labels = await amazonSellerOfferAudience(connection.id, marketplace, pair.productType)
        if (Object.keys(labels).length) {
          await prisma.sellerReferenceLabel.upsert({
            where: { channel_connectionId_marketplace_productType_fieldKey: { workspaceId: workspaceIdForQuery(), channel: 'AMAZON', connectionId: connection.id, marketplace, productType: pair.productType, fieldKey: OFFER_AUDIENCE_FIELD_KEY } },
            create: { channel: 'AMAZON', connectionId: connection.id, marketplace, productType: pair.productType, fieldKey: OFFER_AUDIENCE_FIELD_KEY, labels, fetchedAt: new Date() },
            update: { labels, fetchedAt: new Date() },
          })
          stored++
        }
      } catch (err) {
        failed++
        logger.warn(`${opts.label ?? 'seller-offer-audience'}: seller definition failed`, {
          connectionId: connection.id, marketplace, productType: pair.productType, error: err instanceof Error ? err.message : String(err),
        })
      }
      if (throttleMs > 0) await sleep(throttleMs) // the Product Type Definitions API is rate-limited
    }
  }
  return { stored, failed }
}

/** `connectionId|MARKET` — the key `storedOfferAudiences` answers by. */
export const offerAudienceKey = (connectionId: string, marketplace: string) => `${connectionId}|${upper(marketplace)}`

/** The kept audience codes of one product type, by `offerAudienceKey`. A key that is missing was never measured. */
export async function storedOfferAudiences(productType: string, connectionIds: readonly string[]): Promise<Map<string, string[]>> {
  if (!connectionIds.length) return new Map()
  const rows = await prisma.sellerReferenceLabel.findMany({
    where: { channel: 'AMAZON', fieldKey: OFFER_AUDIENCE_FIELD_KEY, productType, connectionId: { in: [...connectionIds] } },
    select: { connectionId: true, marketplace: true, labels: true },
  })
  return new Map(rows.map(r => [offerAudienceKey(r.connectionId, r.marketplace),
    r.labels && typeof r.labels === 'object' && !Array.isArray(r.labels) ? Object.keys(r.labels) : []]))
}

/**
 * The product types a listing's B2B answer may be kept under, in the names the nightly refresh uses (upper case,
 * recognised): the listing's Amazon type, then its product's, then its family's. The first one Amazon answered for wins.
 */
export function businessTypeCandidates(l: { platformAttributes?: unknown; product?: { productType?: string | null; parent?: { productType?: string | null } | null } | null }): string[] {
  const own = l.platformAttributes && typeof l.platformAttributes === 'object' ? (l.platformAttributes as { productType?: unknown }).productType : null
  const out = [own, l.product?.productType, l.product?.parent?.productType].map((v) => normaliseCategory('AMAZON', v)).filter((v): v is string => !!v)
  return [...new Set(out)]
}

export interface BusinessAudienceListing {
  marketplace: string
  platformAttributes?: unknown
  product?: { productType?: string | null; parent?: { productType?: string | null } | null } | null
}

/**
 * ONE rule for "does Amazon list B2B for this listing" (the business price door and the Matrix read): the kept answers
 * of the listing's account and market under the first of its product types Amazon answered for. One read per product
 * type. The resolver answers `null` when nothing was ever measured for it.
 */
export async function loadBusinessAudiences<L extends BusinessAudienceListing>(
  listings: readonly L[],
  accountOf: (l: L) => string | null,
): Promise<(l: L) => { productType: string; audience: string[] } | null> {
  const audiences = new Map<string, Map<string, string[]>>()
  for (const pt of new Set(listings.flatMap(businessTypeCandidates))) {
    const accounts = [...new Set(listings.filter((l) => businessTypeCandidates(l).includes(pt)).map(accountOf).filter((v): v is string => !!v))]
    audiences.set(pt, await storedOfferAudiences(pt, accounts))
  }
  return (l) => {
    const account = accountOf(l)
    if (!account) return null
    for (const pt of businessTypeCandidates(l)) {
      const audience = audiences.get(pt)?.get(offerAudienceKey(account, l.marketplace))
      if (audience) return { productType: pt, audience }
    }
    return null
  }
}
