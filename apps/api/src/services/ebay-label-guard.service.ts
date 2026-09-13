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
import { assertPushAllowed } from '@nexus/shared/push-lock'
import { ebayAuthService } from './ebay-auth.service.js'
import { callTradingApi, siteIdForMarket } from './ebay-trading-api.service.js'
import { logger } from '../utils/logger.js'
import { whereCoordinate, type ListingCoordinate } from '../lib/listing-coordinate.js'

/** Full reads let the terminal-intent check take effect when PR.5 adds the
 * column; today's schema has no endedAt. Conservatively skip every ENDED row. */
function terminal(row: { listingStatus?: string; presenceIntent?: string; endedAt?: unknown }): boolean {
  return row.listingStatus === 'ENDED' || !!row.endedAt || ['ENDED', 'DISCONTINUED', 'RELEASED'].includes(row.presenceIntent ?? '')
}

export async function backfillListingIdentity(coordinate: ListingCoordinate, itemId: string): Promise<number> {
  const where = { ...whereCoordinate(coordinate), externalListingId: null }
  const row = await prisma.channelListing.findFirst({ where })
  if (!row || terminal(row)) return 0
  const updated = await prisma.channelListing.updateMany({
    where: { ...where, id: row.id, listingStatus: row.listingStatus,
      ...('presenceIntent' in row ? { presenceIntent: row.presenceIntent } : {}),
    },
    data: { externalListingId: itemId },
  })
  return updated.count
}

export interface LabelGuardSummary {
  refusals: Array<{ marketplace: string; itemId: string; code: string; sentence: string }>
  checked: number
  set: number
  kept: number
  unsupported: number
  failed: number
  /** Live listings linked ONLY via ChannelListing (no memberships) whose
   *  product is an eBay listing shell — they carry no pool sync at all.
   *  The guard labels them AND reports them so the half-adopted state is
   *  never invisible (Saponette incident #42). */
  halfAdopted: number
  /** Membership-backed listings whose parent product's ChannelListing was
   *  missing externalListingId — backfilled by this run (Lane-A/Lane-B
   *  linkage consistency). */
  clLinked: number
}

/** Ensure the custom label (Item.SKU = parent SKU) on the given listings, or
 *  on EVERY live listing we know when no scope is passed — membership-backed
 *  (Lane B) AND ChannelListing-linked (Lane A). Incident #42 (Saponette):
 *  the guard walked memberships only, so a listing adopted as a plain CL
 *  (no memberships) never got its label — invisible to all three call
 *  sites. The universe is now BOTH lanes. */
/** FFT-I2 — self-healing pool links: any membership whose productId is NULL
 *  relinks by EXACT sku to an alive product (deterministic post-relabel; a
 *  membership sku IS the pool child sku). 196 estate-wide null links collapsed
 *  the family file to one group on 2026-07-20; the reconcile writer is fixed,
 *  and this sweep guarantees any future regression heals within one cron tick.
 *  Never overwrites a non-null link. */
export async function relinkNullPoolMemberships(): Promise<{ scanned: number; relinked: number }> {
  const prisma = (await import('../db.js')).default
  const broken = await prisma.sharedListingMembership.findMany({
    where: { productId: null },
    select: { id: true, sku: true },
  })
  if (!broken.length) return { scanned: 0, relinked: 0 }
  const skus = [...new Set(broken.map((m) => m.sku).filter(Boolean))]
  const products = skus.length
    ? await prisma.product.findMany({ where: { sku: { in: skus }, deletedAt: null }, select: { id: true, sku: true } })
    : []
  const bySku = new Map(products.map((p) => [p.sku, p.id]))
  let relinked = 0
  for (const m of broken) {
    const pid = m.sku ? bySku.get(m.sku) : undefined
    if (!pid) continue
    await prisma.sharedListingMembership.update({ where: { id: m.id }, data: { productId: pid } }).catch(() => null)
    relinked++
  }
  return { scanned: broken.length, relinked }
}

export async function ensureListingLabels(scope?: Array<{ marketplace: string; itemId: string }>): Promise<LabelGuardSummary> {
  const summary: LabelGuardSummary = { checked: 0, set: 0, kept: 0, unsupported: 0, failed: 0, halfAdopted: 0, clLinked: 0, refusals: [] }

  const scopeItemIds = scope?.length ? new Set(scope.map((s) => s.itemId)) : null

  let targets: Array<{ marketplace: string; itemId: string; parentSku: string; channelConnectionId: string | null; lane: 'membership' | 'cl' }>
  const groups = await prisma.sharedListingMembership.groupBy({
    by: ['marketplace', 'itemId', 'parentSku', 'channelConnectionId'],
    where: scope?.length
      ? { status: 'ACTIVE', OR: scope.map((s) => ({ marketplace: s.marketplace.toUpperCase(), itemId: s.itemId })) }
      : { status: 'ACTIVE' },
  })
  targets = groups
    .map((g) => ({ marketplace: g.marketplace, itemId: g.itemId, parentSku: g.parentSku ?? '', channelConnectionId: g.channelConnectionId, lane: 'membership' as const }))
    // numeric parentSku = the pre-S6 first-touch fallback — not a real label
    .filter((t) => t.parentSku && !/^\d+$/.test(t.parentSku))

  // Lane A — listings linked only via ChannelListing (no memberships): the
  // product on the CL IS the listing parent (real parent, shell, or
  // standalone), so its SKU is the expected label. Child products' CLs are
  // family bookkeeping rows, never a listing of their own — excluded.
  const memberItemIds = new Set(
    (await prisma.sharedListingMembership.groupBy({ by: ['itemId'] })).map((g) => g.itemId),
  )
  const laneACls = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', externalListingId: { not: null }, product: { deletedAt: null, parentId: null } },
    include: { product: { select: { sku: true, productType: true } } },
  })
  for (const cl of laneACls) {
    if (terminal(cl)) continue
    const itemId = String(cl.externalListingId ?? '').trim()
    if (!itemId || !/^\d+$/.test(itemId)) continue // empty/junk ItemIDs never reach GetItem
    if (memberItemIds.has(itemId)) continue // membership target already covers it
    if (scopeItemIds && !scopeItemIds.has(itemId)) continue
    const sku = cl.product?.sku ?? ''
    if (!sku || /^\d+$/.test(sku)) continue
    if (targets.some((t) => t.itemId === itemId)) continue
    targets.push({
      marketplace: (cl.marketplace ?? cl.region ?? 'IT').toUpperCase(),
      itemId,
      parentSku: sku,
      lane: 'cl',
      channelConnectionId: cl.channelConnectionId,
    })
    if (cl.product?.productType === 'EBAY_LISTING_SHELL') {
      // A shell bound to a live listing with ZERO memberships = half-adopted:
      // labeled here, but its quantities ride nothing. Reported every run so
      // it can never rot silently; the reconcile flow heals it on touch.
      summary.halfAdopted++
      logger.warn('ebay-label-guard: half-adopted shell listing (labeled; no memberships — reconcile to wire pool sync)', {
        itemId, parentSku: sku,
      })
    }
  }

  // Lane-A/Lane-B linkage consistency: a membership-backed listing whose
  // parent product's CL lost (or never had) externalListingId — backfill it
  // so every walker sees the same truth from either lane.
  if (!scope?.length) {
    for (const t of targets) {
      if (t.lane !== 'membership') continue
      try {
        const parentProduct = await prisma.product.findFirst({
          where: { sku: t.parentSku, deletedAt: null },
          select: { id: true },
        })
        if (!parentProduct) continue
        if (!t.channelConnectionId) continue // never guess a primary account
        const candidates = await prisma.channelListing.findMany({
          where: { productId: parentProduct.id, channel: 'EBAY', marketplace: t.marketplace, channelConnectionId: t.channelConnectionId },
          take: 2,
        })
        // Memberships have no alias field: only an unambiguous stored row can
        // provide that level. Even a terminal sibling makes this ambiguous.
        if (candidates.length !== 1) continue
        const updated = { count: await backfillListingIdentity(candidates[0], t.itemId) }
        if (updated.count > 0) {
          summary.clLinked += updated.count
          logger.info('ebay-label-guard: backfilled CL externalListingId from membership', { itemId: t.itemId, parentSku: t.parentSku })
        }
      } catch { /* consistency backfill is best-effort */ }
    }
  }

  for (const t of targets) {
    const refuse = (code: string, sentence: string) => {
      summary.failed++
      summary.refusals.push({ marketplace: t.marketplace, itemId: t.itemId, code, sentence })
    }
    if (!t.channelConnectionId) { refuse('PUSH_CONTROL_UNAVAILABLE', 'The owning account is unknown; label repair was not sent.'); continue }
    summary.checked++
    let controls
    try {
      // An ItemID can be shared by several product coordinates. Every owning
      // row must allow this push; no primary-account fallback or empty control.
      controls = await prisma.channelListing.findMany({ where: {
        channel: 'EBAY', externalListingId: t.itemId,
        channelConnectionId: t.channelConnectionId, marketplace: t.marketplace.toUpperCase(),
      } })
      controls.forEach(whereCoordinate)
    } catch {
      refuse('PUSH_CONTROL_UNAVAILABLE', 'Listing controls could not be read; label repair was not sent.')
      continue
    }
    if (!controls.length) { refuse('PUSH_CONTROL_UNAVAILABLE', 'No owning listing controls were found; label repair was not sent.'); continue }
    const locked = controls.map(assertPushAllowed).find(refusal => refusal !== null)
    if (locked) { refuse(locked.code, locked.sentence); continue }
    if (controls.some(terminal)) { refuse('PUSH_LEGACY_ENDED', 'This listing was ended; label repair was not sent.'); continue }
    try {
      const token = await ebayAuthService.getValidToken(t.channelConnectionId)
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
