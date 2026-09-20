/**
 * P4.2c — image read-back for the other two channels.
 *
 * ## What was measured (2026-09-20)
 *
 * The P4.2 row asks for *"read-back for every channel"*. All three channels have
 * a read-back **function**. Only one of them ever runs on its own:
 *
 * | Channel | Function | Scheduled | On demand |
 * |---|---|---|---|
 * | eBay | `refreshEbayLiveImages` + `readbackAllEbayLiveImages` | **yes**, every 6 hours | yes |
 * | Amazon | `refreshAmazonLiveImages` | **no** | yes — a route, and the adopt service |
 * | Shopify | `refreshShopifyLiveImages` | **no** | yes — a route |
 *
 * **A read-back that only runs when somebody opens a screen cannot detect
 * drift.** It confirms what the person is already looking at. Drift is precisely
 * the case where nobody is looking — the channel changed and we did not.
 *
 * So Amazon and Shopify have the capability and not the habit. This file is the
 * habit, built on eBay's shape: parents and standalone products only, sequential,
 * and it returns a countable summary so a quiet run is a MEASUREMENT rather than
 * a silence.
 *
 * ## Two things it does differently from eBay's, on purpose
 *
 * 1. **Amazon reads per SKU per MARKETPLACE**, so an unbounded sweep multiplies
 *    by the number of markets. It asks only for the marketplaces a product
 *    actually has an Amazon `ChannelListing` in — never the whole list — and a
 *    cap bounds the run.
 * 2. **Shopify's refresh self-skips with `NO_CREDS`** when `SHOPIFY_SHOP_NAME` /
 *    `SHOPIFY_ACCESS_TOKEN` are absent, and P2.4 measured that **production has
 *    no `SHOPIFY_*` variable at all**. Those skips are counted separately from
 *    real ones, because "it ran and there was nothing to do" and "it cannot run"
 *    must not look alike.
 *
 * ## Off by default
 *
 * `NEXUS_ENABLE_IMAGE_READBACK_SWEEP=true` turns it on. It is off because it is
 * **new recurring API traffic on the Owner's own seller accounts** — the same
 * reason P1.8's contract run, P6.1's rotation and P3.2's suppression pull all
 * ship off. Nothing here is unverified; the switch is about spend, not doubt.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface ImageReadbackSummary {
  channel: 'AMAZON' | 'SHOPIFY'
  /** Products considered before the cap. */
  eligible: number
  /** Products actually visited this run. */
  scanned: number
  refreshed: number
  /** Ran, and the channel had nothing to give. */
  empty: number
  /** Skipped for a reason the channel gave (no id on the listing, etc). */
  skipped: number
  /** 🔴 Could not run at all — no credentials. NOT the same as `empty`. */
  unconfigured: number
  errored: number
  capped: boolean
}

/** Is the sweep on? Off unless explicitly enabled. */
export function imageReadbackSweepEnabled(): boolean {
  return process.env.NEXUS_ENABLE_IMAGE_READBACK_SWEEP === 'true'
}

/**
 * How many products one run may visit. Bounded so a sweep cannot run away.
 *
 * Exported so the ceiling can be tested as a VALUE. A behavioural test would
 * need 5,000 fixtures to tell 5,000 from 999,999, so it would not discriminate —
 * and a rule about a value that no test can distinguish is not guarded.
 */
export function readbackCap(): number {
  const raw = Number(process.env.NEXUS_IMAGE_READBACK_MAX_PER_RUN)
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 400
}

/**
 * Parents and standalone products that have a listing on this channel.
 *
 * A variant child's images mirror its parent's listing, so sweeping children
 * would re-read the same listing — eBay's sweep says the same in its own words.
 */
async function eligibleProducts(channel: 'AMAZON' | 'SHOPIFY'): Promise<Array<{ id: string; marketplaces: string[] }>> {
  const listings = await prisma.channelListing.findMany({
    where: { channel, product: { deletedAt: null, OR: [{ isParent: true }, { parentId: null }] } },
    select: { productId: true, marketplace: true },
  })
  const byProduct = new Map<string, Set<string>>()
  for (const row of listings) {
    const set = byProduct.get(row.productId) ?? new Set<string>()
    if (row.marketplace) set.add(row.marketplace)
    byProduct.set(row.productId, set)
  }
  return [...byProduct.entries()].map(([id, marketplaces]) => ({ id, marketplaces: [...marketplaces] }))
}

/**
 * Amazon image read-back across every product that has an Amazon listing.
 *
 * One `getListingsItem` per SKU per marketplace, and ONLY the marketplaces that
 * product is actually listed in.
 */
export async function readbackAllAmazonLiveImages(): Promise<ImageReadbackSummary> {
  const summary: ImageReadbackSummary = {
    channel: 'AMAZON', eligible: 0, scanned: 0, refreshed: 0, empty: 0, skipped: 0, unconfigured: 0, errored: 0, capped: false,
  }
  const { amazonCredsConfigured } = await import('../../lib/amazon-sp-client.js')
  if (!(await amazonCredsConfigured())) {
    // Measured, not guessed: this profile has no Amazon account. Counted, not
    // swallowed — a per-profile skip is not a fact about production.
    summary.unconfigured = 1
    return summary
  }

  const products = await eligibleProducts('AMAZON')
  summary.eligible = products.length
  const limit = readbackCap()
  summary.capped = products.length > limit

  const { refreshAmazonLiveImages } = await import('./amazon-live-images.service.js')
  for (const product of products.slice(0, limit)) {
    for (const marketplaceCode of product.marketplaces) {
      summary.scanned++
      try {
        const r = await refreshAmazonLiveImages({ productId: product.id, marketplaceCode })
        if (r.rowsUpserted > 0) summary.refreshed++
        else summary.empty++
      } catch (err) {
        summary.errored++
        logger.warn('amazon-image-readback: product failed', {
          productId: product.id, marketplaceCode,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
  return summary
}

/**
 * Shopify image read-back across every product that has a Shopify listing.
 *
 * 🔴 `refreshShopifyLiveImages` answers `skipped: 'NO_CREDS'` when the env
 * credentials are absent, and P2.4 measured that production has no `SHOPIFY_*`
 * variable. That outcome is counted as **unconfigured**, never as `empty` — "it
 * ran and found nothing" and "it could not run" are different answers and a
 * summary that blends them is the false green this programme keeps finding.
 */
export async function readbackAllShopifyLiveImages(): Promise<ImageReadbackSummary> {
  const summary: ImageReadbackSummary = {
    channel: 'SHOPIFY', eligible: 0, scanned: 0, refreshed: 0, empty: 0, skipped: 0, unconfigured: 0, errored: 0, capped: false,
  }
  const products = await eligibleProducts('SHOPIFY')
  summary.eligible = products.length
  const limit = readbackCap()
  summary.capped = products.length > limit

  const { refreshShopifyLiveImages } = await import('./shopify-live-images.service.js')
  for (const product of products.slice(0, limit)) {
    summary.scanned++
    try {
      const r = await refreshShopifyLiveImages({ productId: product.id })
      if (r.skipped === 'NO_CREDS') summary.unconfigured++
      else if (r.error) summary.errored++
      else if (r.skipped) summary.skipped++
      else if (r.rowsUpserted > 0) summary.refreshed++
      else summary.empty++
    } catch (err) {
      summary.errored++
      logger.warn('shopify-image-readback: product failed', {
        productId: product.id, error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return summary
}

/** Both channels, for the cron. eBay has had its own sweep since before P4.2. */
export async function runImageReadbackSweep(): Promise<ImageReadbackSummary[]> {
  if (!imageReadbackSweepEnabled()) {
    logger.info('image-readback sweep: off (set NEXUS_ENABLE_IMAGE_READBACK_SWEEP=true)')
    return []
  }
  const out: ImageReadbackSummary[] = []
  for (const run of [readbackAllAmazonLiveImages, readbackAllShopifyLiveImages]) {
    try {
      const summary = await run()
      logger.info('image-readback sweep: complete', summary as unknown as Record<string, unknown>)
      out.push(summary)
    } catch (err) {
      logger.error('image-readback sweep: run failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}
