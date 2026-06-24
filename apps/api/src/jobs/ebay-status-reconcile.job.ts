/**
 * B4 — eBay listing status-reconcile cron.
 *
 * eBay listings can drift out of sync with what Nexus records as their
 * status. A listing can end, get suspended, go out of stock, or get
 * relisted on eBay's side — and ChannelListing.listingStatus never
 * finds out, leaving the cockpit and listing views showing stale state.
 *
 * This cron fetches all active eBay ChannelListing rows (listingStatus
 * not in REMOVED/CANCELLED/DRAFT), groups them by product SKU so each
 * SKU is checked once via GET /sell/inventory/v1/offer?sku={sku}, and
 * maps the eBay offer status back to our listingStatus:
 *
 *   PUBLISHED  → ACTIVE
 *   UNPUBLISHED → DRAFT
 *   HTTP 404   → REMOVED
 *
 * Any divergence triggers a DB update. The job processes SKUs in
 * batches of 20 with a 500 ms inter-batch pause for eBay rate-limit
 * safety.
 *
 * Gated behind NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON=1 (default OFF
 * — operator opt-in required because the job calls the live eBay API
 * on every run and should not fire in dev / CI environments without
 * real credentials).
 *
 * Default schedule: 02:00 UTC daily. Override via
 * NEXUS_EBAY_STATUS_RECONCILE_SCHEDULE.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { ebayAuthService } from '../services/ebay-auth.service.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const JOB_NAME = 'ebay-status-reconcile'
const BATCH_SIZE = 20
const BATCH_DELAY_MS = 500

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: { checked: number; updated: number; errors: number } | null = null

// ── eBay offer status → Nexus listingStatus mapping ──────────────────────────

type EbayOfferStatus = 'PUBLISHED' | 'UNPUBLISHED' | string

function ebayStatusToListing(ebayStatus: EbayOfferStatus): string {
  if (ebayStatus === 'PUBLISHED') return 'ACTIVE'
  if (ebayStatus === 'UNPUBLISHED') return 'DRAFT'
  return 'DRAFT' // conservative fallback for unknown values
}

// ── Shape of eBay GET /sell/inventory/v1/offer response ──────────────────────

interface EbayOffer {
  offerId?: string
  status?: EbayOfferStatus
  listing?: { listingId?: string }
  sku?: string
}

interface EbayOffersResponse {
  offers?: EbayOffer[]
  total?: number
}

// ── Core tick ────────────────────────────────────────────────────────────────

export async function runEbayStatusReconcile(): Promise<void> {
  if (process.env.NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON !== '1') {
    logger.debug(`${JOB_NAME}: disabled — set NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON=1 to enable`)
    return
  }

  // Resolve the active eBay connection once per run. We use the first
  // active connection — sites with multiple eBay accounts can extend
  // this later with a per-connection sweep.
  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true },
  })

  if (!connection) {
    logger.warn(`${JOB_NAME}: no active eBay ChannelConnection found — skipping`)
    return
  }

  let token: string
  try {
    token = await ebayAuthService.getValidToken(connection.id)
  } catch (err) {
    logger.error(`${JOB_NAME}: failed to get eBay access token`, {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  const apiBase = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'

  // Fetch all eBay ChannelListings that are not already in a terminal
  // removed/cancelled state — those are the ones that can drift.
  const listings = await prisma.channelListing.findMany({
    where: {
      channel: 'EBAY',
      listingStatus: { notIn: ['REMOVED', 'CANCELLED'] },
      product: {
        deletedAt: null,
      },
    },
    select: {
      id: true,
      listingStatus: true,
      externalListingId: true,
      product: { select: { sku: true } },
    },
  })

  // Build a deduplicated map of sku → [listingIds] so we call the API
  // once per SKU even if there are multiple ChannelListing rows for it
  // (e.g. different marketplaces sharing the same eBay item).
  const skuToListingIds = new Map<string, string[]>()
  const listingById = new Map<string, { listingStatus: string; externalListingId: string | null }>()

  for (const listing of listings) {
    const sku = listing.product?.sku
    if (!sku) continue // orphaned listing without a SKU — skip

    listingById.set(listing.id, {
      listingStatus: listing.listingStatus,
      externalListingId: listing.externalListingId,
    })

    const existing = skuToListingIds.get(sku)
    if (existing) {
      existing.push(listing.id)
    } else {
      skuToListingIds.set(sku, [listing.id])
    }
  }

  const skus = Array.from(skuToListingIds.keys())

  if (skus.length === 0) {
    logger.info(`${JOB_NAME}: no eBay listings to reconcile`)
    lastRunAt = new Date()
    lastSummary = { checked: 0, updated: 0, errors: 0 }
    return
  }

  await recordCronRun(JOB_NAME, async () => {
    let checked = 0
    let updated = 0
    let errors = 0

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US',
    }

    // Process SKUs in batches to respect eBay API rate limits.
    for (let batchStart = 0; batchStart < skus.length; batchStart += BATCH_SIZE) {
      const batch = skus.slice(batchStart, batchStart + BATCH_SIZE)

      await Promise.all(
        batch.map(async (sku) => {
          const listingIds = skuToListingIds.get(sku) ?? []
          let desiredStatus: string | null = null

          try {
            const res = await fetch(
              `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
              { headers },
            )

            if (res.status === 404) {
              desiredStatus = 'REMOVED'
            } else if (!res.ok) {
              const body = await res.text().catch(() => '')
              logger.warn(`${JOB_NAME}: eBay API error for sku=${sku}`, {
                httpStatus: res.status,
                body: body.slice(0, 300),
              })
              errors++
              checked++
              return
            } else {
              const data = (await res.json()) as EbayOffersResponse
              const offer = data.offers?.[0]
              if (!offer) {
                // eBay knows the SKU but returned zero offers — treat as
                // unpublished (no live listing on eBay's side).
                desiredStatus = 'DRAFT'
              } else {
                desiredStatus = ebayStatusToListing(offer.status ?? 'UNPUBLISHED')
              }
            }

            checked++

            // Update every ChannelListing row that maps to this SKU and
            // whose current status diverges from eBay's reality.
            for (const listingId of listingIds) {
              const current = listingById.get(listingId)
              if (!current) continue
              if (current.listingStatus === desiredStatus) continue

              try {
                await prisma.channelListing.update({
                  where: { id: listingId },
                  data: {
                    listingStatus: desiredStatus,
                    lastSyncedAt: new Date(),
                    lastSyncStatus: 'SUCCESS',
                  },
                })
                updated++
                logger.info(`${JOB_NAME}: updated listing status`, {
                  listingId,
                  sku,
                  from: current.listingStatus,
                  to: desiredStatus,
                  externalListingId: current.externalListingId,
                })
              } catch (dbErr) {
                errors++
                logger.error(`${JOB_NAME}: DB update failed for listingId=${listingId}`, {
                  sku,
                  error: dbErr instanceof Error ? dbErr.message : String(dbErr),
                })
              }
            }
          } catch (err) {
            errors++
            checked++
            logger.error(`${JOB_NAME}: unexpected error for sku=${sku}`, {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }),
      )

      // Pause between batches — not after the final one.
      if (batchStart + BATCH_SIZE < skus.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
      }
    }

    lastRunAt = new Date()
    lastSummary = { checked, updated, errors }

    logger.info(`[${JOB_NAME}] checked ${checked} offers, updated ${updated}, errors ${errors}`)
    return `checked=${checked} updated=${updated} errors=${errors}`
  })
}

// ── Cron wiring ──────────────────────────────────────────────────────────────

export function startEbayStatusReconcileCron(): void {
  if (scheduledTask) {
    logger.warn(`${JOB_NAME} cron already started — skipping`)
    return
  }

  const schedule = process.env.NEXUS_EBAY_STATUS_RECONCILE_SCHEDULE ?? '0 2 * * *'

  if (!cron.validate(schedule)) {
    logger.error(`${JOB_NAME} cron: invalid schedule expression`, { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runEbayStatusReconcile()
  })

  logger.info(`${JOB_NAME} cron: scheduled`, { schedule })
}

export function stopEbayStatusReconcileCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getEbayStatusReconcileStatus() {
  return { scheduled: scheduledTask !== null, lastRunAt, lastSummary }
}
