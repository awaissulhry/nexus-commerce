/**
 * Incident #36 — the parent-SKU custom label is a GUARANTEED INVARIANT.
 *
 * eBay drops Item.SKU at AddFixedPriceItem for multi-variation listings (the
 * label only sticks via a follow-up revise), and adopted listings may never
 * have carried one. The owner's rule: the label must never be missing and
 * must never require a manual backfill.
 *
 * ensureListingLabels() walks every distinct (marketplace, itemId) with
 * memberships, reads the live Item.SKU (cheap OutputSelector GetItem), and
 * revises it to the family's parent SKU when absent/different. Listings that
 * reject Trading revises (Inventory-API-managed) are skipped — their label is
 * the group key by construction. Called from:
 *   1. listing creation (inline, incident #35);
 *   2. membership adoption (upsert hook — new listings adopted via save);
 *   3. the periodic guard cron (self-heal for anything else, forever).
 */

import prisma from '../db.js'
import { ebayAuthService } from './ebay-auth.service.js'
import { callTradingApi, siteIdForMarket } from './ebay-trading-api.service.js'
import { logger } from '../utils/logger.js'

export interface LabelGuardSummary {
  checked: number
  set: number
  kept: number
  unsupported: number
  failed: number
}

/** Ensure the custom label (Item.SKU = parent SKU) on the given listings, or
 *  on EVERY membership-backed listing when no scope is passed. */
export async function ensureListingLabels(scope?: Array<{ marketplace: string; itemId: string }>): Promise<LabelGuardSummary> {
  const summary: LabelGuardSummary = { checked: 0, set: 0, kept: 0, unsupported: 0, failed: 0 }

  const conn = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true },
  })
  if (!conn) return summary
  const token = await ebayAuthService.getValidToken(conn.id)

  let targets: Array<{ marketplace: string; itemId: string; parentSku: string }>
  const groups = await prisma.sharedListingMembership.groupBy({
    by: ['marketplace', 'itemId', 'parentSku'],
    where: scope?.length
      ? { OR: scope.map((s) => ({ marketplace: s.marketplace.toUpperCase(), itemId: s.itemId })) }
      : {},
  })
  targets = groups
    .map((g) => ({ marketplace: g.marketplace, itemId: g.itemId, parentSku: g.parentSku ?? '' }))
    // numeric parentSku = the pre-S6 first-touch fallback — not a real label
    .filter((t) => t.parentSku && !/^\d+$/.test(t.parentSku))

  for (const t of targets) {
    summary.checked++
    try {
      const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${t.itemId}</ItemID><OutputSelector>Item.SKU</OutputSelector></GetItemRequest>`,
        { oauthToken: token, siteId: siteIdForMarket(t.marketplace) })
      if (!got.raw) continue // dry-run/neutralized — indeterminate, never touch
      const liveSku = /<SKU>([^<]*)<\/SKU>/.exec(got.raw)?.[1] ?? ''
      if (liveSku === t.parentSku) {
        summary.kept++
        continue
      }
      await callTradingApi('ReviseFixedPriceItem', `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><ItemID>${t.itemId}</ItemID><SKU>${t.parentSku}</SKU></Item></ReviseFixedPriceItemRequest>`,
        { oauthToken: token, siteId: siteIdForMarket(t.marketplace) })
      summary.set++
      logger.info('ebay-label-guard: custom label set', { itemId: t.itemId, parentSku: t.parentSku })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/magazzino|inventory/i.test(msg)) summary.unsupported++
      else {
        summary.failed++
        logger.warn('ebay-label-guard: label ensure failed (will retry next run)', { itemId: t.itemId, err: msg })
      }
    }
    await new Promise((r) => setTimeout(r, 300)) // rate-limit courtesy
  }
  return summary
}
