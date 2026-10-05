/**
 * P0c — Amazon quantity READ-BACK reconcile (the closed loop).
 *
 * Lesson of 2026-07-20: the system verified its own sends, never Amazon's
 * state — a weeks-long 403 hid behind success-logging. This job pulls
 * Amazon's OWN record of every listing (GET_MERCHANT_LISTINGS_ALL_DATA via
 * fetchActiveCatalog — the reliable source, per the FBA-flip incident) and
 * diffs actual vs intended quantity for FBM listings:
 *   - mismatches persist to SyncHealthLog (CHANNEL_QTY_READBACK, deduped)
 *   - bounded self-heal: corrective pushes re-enqueued (dispatch re-reads +
 *     clamps as usual; FBA rows never touched — report AMAZON_* rows skipped
 *     AND our side excludes FBA by the canonical signals)
 *
 * eBay has had this loop since P5.2 (ebay-readback); Amazon never did.
 *
 * Schedule: daily 04:15 UTC (opt-out NEXUS_QTY_READBACK=0; override
 * NEXUS_QTY_READBACK_SCHEDULE). One-shot on-demand: insert a CronRun row
 * jobName 'amazon-qty-readback-request' status RUNNING and boot/restart —
 * same DB-directive pattern as the notification recycle.
 */

import { createOutboundRow } from '../services/outbound-rows.js'
import { priceDrift, priceDriftMessage, priceHealEnabled, type PriceDrift } from '../services/price-readback.service.js'
import { recordChannelReadback, type DriftField } from '../services/channel-drift.service.js'
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { CHANNEL_SKU_LISTING_SELECT } from '../services/listings/channel-sku.js'
import type { ChannelSkuListing } from '../services/listings/channel-sku.pure.js'
import { amazonAccountIdFor, onAccount, reportedSkuOf } from '../services/listings/reported-sku.js'

const JOB_NAME = 'amazon-qty-readback'
const MP_IDS: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
}
// AS.4b — markets are config, not code. Unknown codes are dropped with a warn
// so a typo narrows coverage visibly instead of crashing the loop.
function readbackMarkets(): string[] {
  const raw = process.env.NEXUS_QTY_READBACK_MARKETS ?? 'IT,DE,FR,ES'
  const wanted = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const known = wanted.filter((m) => MP_IDS[m])
  const unknown = wanted.filter((m) => !MP_IDS[m])
  if (unknown.length) {
    logger.warn(`[${JOB_NAME}] unknown market code(s) in NEXUS_QTY_READBACK_MARKETS ignored`, { unknown })
  }
  return known.length ? known : ['IT', 'DE', 'FR', 'ES']
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export interface ReadbackMismatch {
  sku: string
  marketplace: string
  amazonQty: number
  intendedQty: number
  channelListingId: string
  productId: string
}

/** Pure diff: Amazon's FBM report rows vs our intended quantities. */
export function diffReadback(
  amazonRows: Array<{ sku: string; quantity: number; fulfillmentChannel?: string | null }>,
  ourRows: Array<{ sku: string; quantity: number | null; channelListingId: string; productId: string }>,
  marketplace: string,
): ReadbackMismatch[] {
  const ours = new Map(ourRows.map((r) => [r.sku, r]))
  const out: ReadbackMismatch[] = []
  for (const a of amazonRows) {
    // FBM only — AMAZON_* fulfillment is Amazon-managed stock, never compared.
    if (a.fulfillmentChannel && /^amazon/i.test(a.fulfillmentChannel)) continue
    const mine = ours.get(a.sku)
    if (!mine || mine.quantity == null) continue
    if (a.quantity !== mine.quantity) {
      out.push({
        sku: a.sku,
        marketplace,
        amazonQty: a.quantity,
        intendedQty: mine.quantity,
        channelListingId: mine.channelListingId,
        productId: mine.productId,
      })
    }
  }
  return out
}

export interface PriceReadbackMismatch {
  sku: string
  marketplace: string
  channelListingId: string
  productId: string
  drift: PriceDrift
}

/**
 * P4.4e — the SAME report rows, diffed on price.
 *
 * 🔴 `fetchActiveCatalog` has always parsed `price` out of
 * `GET_MERCHANT_LISTINGS_ALL_DATA` (`CatalogItem.price`), and this job has
 * always thrown it away. The read-back costs **no additional API call**.
 *
 * FBA rows are compared too, unlike the quantity arm: Amazon owns FBA STOCK, not
 * FBA PRICE — a merchant sets the price either way.
 */
export function diffPriceReadback(
  amazonRows: Array<{ sku: string; price: number }>,
  ourRows: Array<{ sku: string; price: number | null; channelListingId: string; productId: string }>,
  marketplace: string,
): PriceReadbackMismatch[] {
  const ours = new Map(ourRows.map((r) => [r.sku, r]))
  const out: PriceReadbackMismatch[] = []
  for (const a of amazonRows) {
    const mine = ours.get(a.sku)
    if (!mine) continue
    const drift = priceDrift({ channelPrice: a.price, intendedPrice: mine.price })
    if (!drift) continue
    out.push({ sku: a.sku, marketplace, channelListingId: mine.channelListingId, productId: mine.productId, drift })
  }
  return out
}

/**
 * PLAN Step 3.5a (A-36) — the same comparison, as one record per LISTING for `ChannelDrift`.
 *
 * A listing is only recorded when the report answered for it (its SKU is in the report), and a field only when both
 * sides have it — the exact skip rules of `diffReadback` (FBA stock is Amazon's; no intended quantity) and of
 * `priceDrift` (no price on either side is not a drift). So `compared` lists what was really compared, a matching field
 * is cleared, and a listing the report did not mention keeps whatever it had.
 */
export function amazonDriftRecords(
  amazonRows: Array<{ sku: string; quantity: number; price?: number | null; fulfillmentChannel?: string | null }>,
  ourRows: Array<{ sku: string; quantity: number | null; price: number | null; channelListingId: string }>,
  qtyDiffs: readonly ReadbackMismatch[],
  priceDiffs: readonly PriceReadbackMismatch[],
): Array<{ channelListingId: string; compared: string[]; differing: DriftField[] }> {
  const bySku = new Map(amazonRows.map((a) => [a.sku, a]))
  const qty = new Map(qtyDiffs.map((d) => [d.channelListingId, d]))
  const price = new Map(priceDiffs.map((d) => [d.channelListingId, d]))
  const out: Array<{ channelListingId: string; compared: string[]; differing: DriftField[] }> = []
  for (const r of ourRows) {
    const a = bySku.get(r.sku)
    if (!a) continue
    const compared: string[] = []
    const differing: DriftField[] = []
    if (!(a.fulfillmentChannel && /^amazon/i.test(a.fulfillmentChannel)) && r.quantity != null) {
      compared.push('quantity')
      const d = qty.get(r.channelListingId)
      if (d) differing.push({ field: 'quantity', ours: d.intendedQty, theirs: d.amazonQty })
    }
    if (r.price != null && Number.isFinite(r.price) && a.price != null && Number.isFinite(a.price)) {
      compared.push('price')
      const d = price.get(r.channelListingId)
      if (d) differing.push({ field: 'price', ours: d.drift.intendedPrice, theirs: d.drift.channelPrice })
    }
    if (compared.length) out.push({ channelListingId: r.channelListingId, compared, differing })
  }
  return out
}

/** One of our listings, as the report keys it. */
export interface OurReadbackRow { sku: string; quantity: number | null; price: number | null; channelListingId: string; productId: string }

/**
 * S7 — our listings keyed by the seller SKU Amazon knows each one by (`reportedSkuOf`: the listing's own SKU, else the
 * product SKU — so a listing without its own SKU is keyed exactly as before). Keyed by the product SKU, a product's
 * extra listing (alias) in the same market collided with its main listing and one of them was compared and healed in
 * the other's name. A listing with no single SKU, and every listing that shares its SKU with another, is left out
 * with a sentence: a report line is never laid on a guessed listing.
 */
export function keyReadbackRows(listings: Array<ChannelSkuListing & {
  id: string; productId: string; quantity: number | null; price: unknown; product?: { sku: string | null } | null
}>): { rows: OurReadbackRow[]; skipped: Array<{ channelListingId: string; reason: string }> } {
  const skipped: Array<{ channelListingId: string; reason: string }> = []
  const bySku = new Map<string, OurReadbackRow[]>()
  for (const l of listings) {
    const answer = reportedSkuOf(l, l.product?.sku ?? '')
    if (answer.sku === null) { skipped.push({ channelListingId: l.id, reason: answer.conflict.sentence }); continue }
    const row = { sku: answer.sku, quantity: l.quantity, price: l.price == null ? null : Number(l.price), channelListingId: l.id, productId: l.productId }
    bySku.set(answer.sku, [...(bySku.get(answer.sku) ?? []), row])
  }
  const rows: OurReadbackRow[] = []
  for (const [sku, group] of bySku) {
    if (group.length === 1) { rows.push(group[0]); continue }
    for (const row of group) skipped.push({ channelListingId: row.channelListingId, reason: `${sku} is the seller SKU of ${group.length} listings in this market. Nexus did not pick one.` })
  }
  return { rows, skipped }
}

export async function runAmazonQtyReadback(): Promise<string> {
  const { AmazonService } = await import('../services/marketplaces/amazon.service.js')
  const amazon = new AmazonService()
  const healMax = Number(process.env.NEXUS_QTY_READBACK_HEAL_MAX ?? 100)

  let compared = 0

  let priceCompared = 0, priceMismatches = 0, priceLogged = 0
  let driftRecorded = 0
  let mismatches = 0
  let healed = 0
  let logged = 0
  const marketSummaries: string[] = []

  const comparedProducts = new Set<string>()
  const mismatchedProducts = new Set<string>()
  // S7 — the report is this account's (the same default chooser the SP-API client runs): only its listings, and
  // unattributed older ones, are laid on it. No account resolves → every listing, as before.
  const accountId = await amazonAccountIdFor()
  let skuSkipped = 0
  for (const mp of readbackMarkets()) {
    let catalog
    try {
      catalog = await amazon.fetchActiveCatalog(MP_IDS[mp])
    } catch (err) {
      marketSummaries.push(`${mp}:report-failed`)
      logger.warn(`[${JOB_NAME}] report pull failed`, {
        marketplace: mp,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
      continue
    }
    if (!catalog?.length) {
      marketSummaries.push(`${mp}:empty`)
      continue
    }

    const ourRows = await prisma.channelListing.findMany({
      where: {
        channel: 'AMAZON',
        marketplace: mp,
        isPublished: true,
        // SC.1 — PAUSED listings are reported nowhere and healed never: the
        // operator explicitly froze them; the read-back must not fight that.
        syncPaused: false,
        // SCT.6 — CLOSED market offers are Inactive by design: reporting them
        // as drift (and 'healing' them with quantity pushes) is pure noise.
        offerClosedAt: null,
        // AS.4b — pinned listings are verified too: after any write (cascade
        // for followers, pin-apply for pinned) cl.quantity IS the intent, so
        // the follow flag must not gate the comparison. Pre-AS.4b the ~260
        // pinned FBM listings were never reconciled against Amazon at all.
        listingStatus: { notIn: ['ENDED', 'REMOVED'] },
        // canonical FBA exclusion — explicit FBM or unresolved-with-FBM-product
        AND: [
          { OR: [{ fulfillmentMethod: 'FBM' }, { fulfillmentMethod: null, product: { fulfillmentMethod: { not: 'FBA' } } }] },
          onAccount(accountId),
        ],
      },
      select: { ...CHANNEL_SKU_LISTING_SELECT, quantity: true, price: true },
    })
    // S7 — keyed by each listing's own seller SKU (else its product SKU, as before); ambiguous rows reported, not compared.
    const keyed = keyReadbackRows(ourRows)
    const mine = keyed.rows
    if (keyed.skipped.length) {
      skuSkipped += keyed.skipped.length
      logger.warn(`[${JOB_NAME}] listings without one seller SKU were not compared`, { marketplace: mp, count: keyed.skipped.length, sample: keyed.skipped.slice(0, 10) })
    }

    const diffs = diffReadback(catalog, mine, mp)
    compared += mine.length
    mismatches += diffs.length

    for (const d of diffs) {
      // Persist (deduped 24h per product+marketplace)
      try {
        const existing = await prisma.syncHealthLog.findFirst({
          where: {
            productId: d.productId,
            channel: 'AMAZON',
            conflictType: 'CHANNEL_QTY_READBACK',
            // A-36 — per product AND market, as the comment above always said: a second market's drift is its own.
            conflictData: { path: ['remote', 'marketplace'], equals: d.marketplace },
            resolutionStatus: 'UNRESOLVED',
            createdAt: { gte: new Date(Date.now() - 24 * 3600e3) },
          },
          select: { id: true },
        })
        if (!existing) {
          const { syncHealthService } = await import('../services/sync-health.service.js')
          await syncHealthService.logConflict({
            channel: 'AMAZON',
            conflictType: 'CHANNEL_QTY_READBACK',
            message: `Amazon shows qty ${d.amazonQty} but intended is ${d.intendedQty} for ${d.sku} (${d.marketplace})`,
            productId: d.productId,
            localData: { intendedQty: d.intendedQty },
            remoteData: { source: 'GET_MERCHANT_LISTINGS_ALL_DATA', amazonQty: d.amazonQty, marketplace: d.marketplace },
          })
          logged++
        }
      } catch { /* observability best-effort */ }

      // Bounded self-heal: re-enqueue the intended quantity.
      if (healed < healMax) {
        try {
          await createOutboundRow(prisma, {
            data: {
              productId: d.productId,
              channelListingId: d.channelListingId,
              targetChannel: 'AMAZON',
              targetRegion: d.marketplace,
              syncType: 'QUANTITY_UPDATE',
              syncStatus: 'PENDING',
              payload: { quantity: d.intendedQty, source: 'QTY_READBACK_HEAL' },
            },
          })
          healed++
        } catch { /* row creation best-effort; next run retries */ }
      }
    }
    marketSummaries.push(`${mp}:${mine.length}cmp/${diffs.length}diff`)
    for (const r of mine) if (r.productId) comparedProducts.add(r.productId)
    for (const d of diffs) if (d.productId) mismatchedProducts.add(d.productId)

    // ── P4.4e — the PRICE arm, over the report rows already in hand ──────────
    // No extra API call: `catalog` is the same response the quantity arm read.
    const priceDiffs = diffPriceReadback(catalog, mine, mp)
    priceCompared += mine.length
    priceMismatches += priceDiffs.length
    for (const d of priceDiffs) {
      try {
        const existing = await prisma.syncHealthLog.findFirst({
          where: {
            productId: d.productId,
            channel: 'AMAZON',
            conflictType: 'CHANNEL_PRICE_READBACK',
            conflictData: { path: ['remote', 'marketplace'], equals: d.marketplace },
            resolutionStatus: 'UNRESOLVED',
            createdAt: { gte: new Date(Date.now() - 24 * 3600e3) },
          },
          select: { id: true },
        })
        if (existing) continue
        const { syncHealthService } = await import('../services/sync-health.service.js')
        await syncHealthService.logConflict({
          channel: 'AMAZON',
          conflictType: 'CHANNEL_PRICE_READBACK',
          message: `${priceDriftMessage({ channel: 'Amazon', sku: d.sku, drift: d.drift })} (${d.marketplace})`,
          productId: d.productId,
          localData: { intendedPrice: d.drift.intendedPrice },
          remoteData: { source: 'GET_MERCHANT_LISTINGS_ALL_DATA', amazonPrice: d.drift.channelPrice, difference: d.drift.difference, marketplace: d.marketplace },
        })
        priceLogged++
      } catch { /* observability best-effort */ }
      // 🔴 No heal. A price correction is a money write made by a machine on a
      // schedule; the Owner has not ruled on it. `priceHealEnabled()` names the
      // switch for the day that ruling exists.
    }

    // A-36 — one ChannelDrift record per listing the report answered for (differences stored, matches cleared).
    for (const rec of amazonDriftRecords(catalog, mine, diffs, priceDiffs)) {
      try {
        await recordChannelReadback({ channelListingId: rec.channelListingId, channel: 'AMAZON', marketplace: mp,
          source: 'amazon-merchant-listings-report', compared: rec.compared, differing: rec.differing })
        driftRecorded++
      } catch { /* observability best-effort: a failed drift write never stops the read-back */ }
    }
  }

  // SC.5-fix — convergence auto-resolve (mirror of the eBay trading sweep):
  // products compared this run and mismatched in NO market clear their
  // UNRESOLVED readback logs, so /api/health reflects open drift only.
  let resolved = 0
  try {
    const converged = [...comparedProducts].filter((pid) => !mismatchedProducts.has(pid))
    if (converged.length > 0) {
      const res = await prisma.syncHealthLog.updateMany({
        where: {
          productId: { in: converged },
          channel: 'AMAZON',
          conflictType: 'CHANNEL_QTY_READBACK',
          resolutionStatus: 'UNRESOLVED',
        },
        data: {
          resolutionStatus: 'RESOLVED',
          resolvedAt: new Date(),
          resolutionNotes: 'auto-resolved: Amazon read-back matched intent in every compared market',
        },
      })
      resolved = res.count
    }
  } catch { /* observability best-effort */ }

  // P4.4e — the price arm is reported BESIDE the quantity arm, never folded into
  // it: a clean quantity run with drifted prices must not read as a clean run.
  const summary = `compared=${compared} mismatches=${mismatches} logged=${logged} healEnqueued=${healed} resolved=${resolved}`
    + ` | price: compared=${priceCompared} mismatches=${priceMismatches} logged=${priceLogged}${priceHealEnabled() ? '' : ' (heal off)'}`
    + ` | drift: recorded=${driftRecorded}`
    + (skuSkipped ? ` | sku: notCompared=${skuSkipped}` : '')
    + ` [${marketSummaries.join(' ')}]`
  logger.info(`[${JOB_NAME}] ${summary}`)
  return summary
}

async function consumeBootDirective(): Promise<void> {
  const req = await prisma.cronRun.findFirst({
    where: { jobName: 'amazon-qty-readback-request', status: 'RUNNING' },
    orderBy: { startedAt: 'desc' },
  }).catch(() => null)
  if (!req) return
  logger.warn(`[${JOB_NAME}] boot directive found — running on-demand read-back`)
  try {
    const summary = await recordCronRun(JOB_NAME, runAmazonQtyReadback)
    await prisma.cronRun.update({
      where: { id: req.id },
      data: { status: 'SUCCESS', finishedAt: new Date(), outputSummary: String(summary).slice(0, 900) },
    }).catch(() => {})
  } catch (err) {
    await prisma.cronRun.update({
      where: { id: req.id },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
    }).catch(() => {})
  }
}

export function startAmazonQtyReadbackCron(): void {
  if (process.env.NEXUS_QTY_READBACK === '0') {
    logger.info(`${JOB_NAME}: disabled via NEXUS_QTY_READBACK=0`)
    return
  }
  if (scheduledTask) return
  const schedule = process.env.NEXUS_QTY_READBACK_SCHEDULE ?? '15 4 * * *'
  if (!cron.validate(schedule)) {
    logger.error(`${JOB_NAME}: invalid schedule`, { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await recordCronRun(JOB_NAME, runAmazonQtyReadback).catch((err) =>
      logger.error(`${JOB_NAME} run failed`, { error: err instanceof Error ? err.message : String(err) }),
    )
  })
  void consumeBootDirective()
  logger.info(`${JOB_NAME} cron: scheduled`, { schedule })
}

export function stopAmazonQtyReadbackCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
