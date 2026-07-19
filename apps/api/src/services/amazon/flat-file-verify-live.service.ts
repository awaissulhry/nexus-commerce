/**
 * FFT.4 — "Verify against live": on-demand content compare between the grid's
 * truth (ChannelListing + flatFileSnapshot) and what Amazon actually serves
 * (getListingsItem via fetchListingForFlatFile), per SKU.
 *
 * Read-only against Amazon. The client renders drifts per SKU/field with
 * "adopt live" (apply live values into the grid as dirty edits, then Save) and
 * "keep mine" (re-arm Submit) actions — the compare itself never writes.
 */

import type { PrismaClient } from '@prisma/client'

export interface LiveFieldDrift {
  field: string
  mine: string
  live: string
}

export interface LiveVerifyResult {
  sku: string
  status: 'match' | 'drift' | 'missing-on-amazon' | 'error'
  drifts: LiveFieldDrift[]
  error?: string
}

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim()
const numeric = (s: string) => {
  if (s === '' || /[^0-9.,\-\s]/.test(s)) return null
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const same = (a: string, b: string) => {
  if (a === b) return true
  const na = numeric(a)
  const nb = numeric(b)
  return na != null && nb != null && na === nb
}

interface LivePayload {
  title?: string | null
  attributes: Record<string, any>
}

/** Pure diff — exported for tests. `mine` = the grid row truth (snapshot keys
 *  + live CL price/qty); `live` = the fetched Amazon listing. Only fields
 *  present on BOTH sides are compared (a blank side is a fill-gap, not drift). */
export function diffMineVsLive(
  mine: { title?: unknown; description?: unknown; bullets?: unknown[]; price?: unknown; quantity?: unknown; brand?: unknown },
  live: LivePayload,
): LiveFieldDrift[] {
  const drifts: LiveFieldDrift[] = []
  const attrs = live.attributes ?? {}
  const push = (field: string, mineV: unknown, liveV: unknown) => {
    const m = norm(mineV)
    const l = norm(liveV)
    if (m === '' || l === '') return
    if (!same(m, l)) drifts.push({ field, mine: m, live: l })
  }
  push('title', mine.title, live.title ?? attrs.item_name?.[0]?.value)
  push('description', mine.description, attrs.product_description?.[0]?.value)
  push('brand', mine.brand, attrs.brand?.[0]?.value)
  const liveBullets: string[] = Array.isArray(attrs.bullet_point)
    ? attrs.bullet_point.map((b: any) => norm(b?.value ?? b)).filter(Boolean)
    : []
  const mineBullets = (mine.bullets ?? []).map((b) => norm(b)).filter(Boolean)
  const n = Math.min(mineBullets.length, liveBullets.length)
  for (let i = 0; i < n; i++) push(`bullet_${i + 1}`, mineBullets[i], liveBullets[i])
  const livePrice = attrs.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax
  push('price', mine.price, livePrice)
  const liveQty = attrs.fulfillment_availability?.[0]?.quantity
  push('quantity', mine.quantity, liveQty)
  return drifts
}

export async function verifySkusAgainstLive(
  prisma: PrismaClient,
  fetchListing: (sku: string, marketplaceId: string) => Promise<LivePayload | null>,
  opts: { skus: string[]; marketplace: string; marketplaceId: string },
): Promise<LiveVerifyResult[]> {
  const mp = opts.marketplace.toUpperCase()
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', marketplace: mp, product: { sku: { in: opts.skus }, deletedAt: null } },
    select: {
      price: true, quantity: true, title: true, description: true, bulletPointsOverride: true,
      flatFileSnapshot: true,
      product: { select: { sku: true, fulfillmentMethod: true } },
    },
  })
  const bySku = new Map(listings.map((l) => [l.product.sku, l]))

  const out: LiveVerifyResult[] = []
  // Sequential — the SP client rate-limits internally; verify batches are ≤50.
  for (const sku of opts.skus) {
    const cl = bySku.get(sku)
    try {
      const live = await fetchListing(sku, opts.marketplaceId)
      if (!live) {
        out.push({ sku, status: 'missing-on-amazon', drifts: [] })
        continue
      }
      const snap = (cl?.flatFileSnapshot ?? {}) as Record<string, unknown>
      const bullets: unknown[] = []
      for (let i = 1; i <= 5; i++) {
        const v = snap[`bullet_point_${i}`]
        if (norm(v)) bullets.push(v)
      }
      if (!bullets.length && Array.isArray(cl?.bulletPointsOverride)) bullets.push(...(cl!.bulletPointsOverride as unknown[]))
      const isFba = cl?.product.fulfillmentMethod === 'FBA'
      const drifts = diffMineVsLive(
        {
          title: snap.item_name ?? cl?.title,
          description: snap.product_description ?? cl?.description,
          brand: snap.brand,
          bullets,
          price: cl?.price,
          // FBA quantity is Amazon-managed — never call it drift.
          quantity: isFba ? '' : cl?.quantity,
        },
        live,
      )
      out.push({ sku, status: drifts.length ? 'drift' : 'match', drifts })
    } catch (e) {
      out.push({ sku, status: 'error', drifts: [], error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}
