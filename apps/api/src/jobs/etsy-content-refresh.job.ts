/**
 * P4.6f — keep our copy of Etsy's listings inside Etsy's six-hour rule.
 *
 * FINAL-PLAN §13 records it as **required**: *"Etsy's terms: listing content at most 6 hours
 * stale."* P4.6e measured the answer and it was **never met**, for three independent reasons each
 * sufficient on its own (`build/P4.6e.md` §3): the `etsy-sync` job is registry-only and has never
 * been scheduled; its client needs env credentials production does not have; and its `x-api-key`
 * is the OAuth access token, so Etsy would refuse the call even with credentials.
 *
 * This job replaces that dead path with the **connected-account reader**, which works.
 *
 * ## 🔴 What it writes, and what it must never write
 *
 * It writes **three** columns: `listingStatus`, `lastSyncedAt`, `lastSyncStatus`.
 *
 * It does **not** write quantity, price, stock or title. That is P4.3a's ruling and it is the
 * whole reason this job is shaped the way it is: `syncInventoryFromEtsy` wrote Etsy's quantities
 * straight into `ProductVariation.stock` and `Product.totalStock`, past the resolver, past the
 * shared-stock pool and past the audit. A refresh job written to "fix staleness" by copying Etsy's
 * numbers back in would be that defect rebuilt with a better excuse.
 *
 * `listingStatus` is different, and the distinction is the point: it is **the channel's own fact
 * about its own listing**, not a value Nexus decides. Nexus already keeps a column for it, and
 * the push lock reads it — so a listing Etsy has ended stops being written to, which is the
 * behaviour P1.7 built that column for.
 *
 * ## Why it sweeps six states instead of asking for "all"
 *
 * `getListingsByShop` takes **one** `state` per call and offers no "all"; its default is `active`.
 * So a sweep that asked once would see only the listings that are fine and would never notice the
 * one that went `expired` — the population the push lock exists for. Etsy's own enum is the list,
 * read from its OpenAPI document rather than typed from memory.
 */
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { etsyReader } from '../services/etsy/read-client.js'

const JOB = 'etsy-content-refresh'

/**
 * Etsy's `state` enum → `ChannelListing.listingStatus`.
 *
 * `sold_out` maps to **ACTIVE** on purpose. On Etsy it means *listed and visible, quantity 0* —
 * the listing is present, and its quantity is a fact this job is forbidden to write. Calling it
 * INACTIVE would make the push lock refuse a listing that is live and only needs restocking,
 * which is the opposite of what an operator wants.
 */
export const ETSY_STATE_TO_LISTING_STATUS: Record<string, string> = {
  active: 'ACTIVE',
  sold_out: 'ACTIVE',
  inactive: 'INACTIVE',
  draft: 'DRAFT',
  expired: 'ENDED',
  removed: 'ENDED',
}

/** Every state Etsy publishes, from its OpenAPI document (`getListingsByShop`, `state` enum). */
export const ETSY_LISTING_STATES = ['active', 'inactive', 'sold_out', 'draft', 'expired', 'removed'] as const

const PAGE = 100          // Etsy's documented maximum for `limit`
const MAX_PAGES = 100     // 10,000 listings per state per shop; a guard, not an expectation

export interface EtsyContentRefreshReport {
  accounts: number
  listingsSeen: number
  matched: number
  statusChanged: number
  freshened: number
  unmatched: number
  errors: Array<{ accountId: string; state?: string; error: string }>
}

interface EtsyListingRow { listing_id?: unknown; state?: unknown }

export async function refreshEtsyContent(): Promise<EtsyContentRefreshReport> {
  const report: EtsyContentRefreshReport = {
    accounts: 0, listingsSeen: 0, matched: 0, statusChanged: 0, freshened: 0, unmatched: 0, errors: [],
  }

  // MAP.3 — through the resolver, never `prisma.channelConnection` directly. The connection-
  // resolver ratchet caught the first version of this line and it was right to: its baseline is
  // **0**, and `listActiveConnections` is the accessor that already means exactly this — "every
  // active account for this channel", which its own comment calls the correct query. A sweep is
  // not an exception to the rule; it is the one shape the rule has an accessor for.
  const { listActiveConnections } = await import('../services/connection-resolver.service.js')
  const connections = await listActiveConnections('ETSY')

  for (const connection of connections) {
    report.accounts++
    let reader: Awaited<ReturnType<typeof etsyReader>>
    try {
      reader = await etsyReader(connection.id)
    } catch (err) {
      // A shop with no verified identity cannot be read. Recorded, and the sweep carries on to the
      // next account rather than taking every other shop's freshness down with it.
      report.errors.push({ accountId: connection.id, error: err instanceof Error ? err.message : String(err) })
      continue
    }

    for (const state of ETSY_LISTING_STATES) {
      const status = ETSY_STATE_TO_LISTING_STATUS[state]
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const answer = await reader.get<{ results?: EtsyListingRow[]; count?: number }>(
            `/shops/${reader.shopId}/listings?state=${state}&limit=${PAGE}&offset=${page * PAGE}`,
          )
          const rows = Array.isArray(answer?.results) ? answer.results : []
          if (rows.length === 0) break

          for (const row of rows) {
            const listingId = String(row.listing_id ?? '')
            if (!/^[1-9]\d*$/.test(listingId)) continue
            report.listingsSeen++

            // Matched on the ACCOUNT as well as the id: Etsy listing ids are per shop, so the same
            // number in another shop is a different listing (the same rule as P4.6e's write guard).
            const listings = await prisma.channelListing.findMany({
              where: { channel: 'ETSY', externalListingId: listingId, channelConnectionId: connection.id },
              select: { id: true, listingStatus: true },
            })
            if (listings.length === 0) { report.unmatched++; continue }

            for (const listing of listings) {
              report.matched++
              const changed = listing.listingStatus !== status
              await prisma.channelListing.update({
                where: { id: listing.id },
                // Three columns, and only these three. Quantity, price, stock and title are
                // Nexus's own and are never written from a channel read (P4.3a).
                data: { listingStatus: status, lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS' },
              })
              report.freshened++
              if (changed) report.statusChanged++
            }
          }
          if (rows.length < PAGE) break
        }
      } catch (err) {
        report.errors.push({ accountId: connection.id, state, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return report
}

export async function runEtsyContentRefresh(): Promise<EtsyContentRefreshReport> {
  let report: EtsyContentRefreshReport | null = null
  await recordCronRun(JOB, async () => {
    report = await refreshEtsyContent()
    logger.info(`${JOB}: swept`, report)
    // The run's own summary line, so the Health tab shows the numbers and not just "ok".
    // Errors are named in it: a sweep that freshened nothing because every call failed must not
    // read the same as a sweep that found nothing to do (P3.6 — no_data is never a pass).
    const r = report as EtsyContentRefreshReport
    return {
      summary: `${r.accounts} account(s), ${r.listingsSeen} listing(s) seen, ${r.freshened} freshened, ${r.statusChanged} status change(s), ${r.unmatched} not in Nexus, ${r.errors.length} error(s)`,
    }
  })
  return report ?? { accounts: 0, listingsSeen: 0, matched: 0, statusChanged: 0, freshened: 0, unmatched: 0, errors: [] }
}

let scheduledTask: { stop: () => void } | null = null

export function startEtsyContentRefreshCron(): void {
  if (process.env.NEXUS_ETSY_CONTENT_REFRESH === '0') {
    logger.info(`${JOB} cron: disabled via NEXUS_ETSY_CONTENT_REFRESH=0`)
    return
  }
  if (scheduledTask) {
    logger.warn(`${JOB} cron already started — skipping`)
    return
  }
  // Every four hours, not every six. The rule is a SIX-hour ceiling, so scheduling at exactly six
  // leaves a listing stale the moment a run is late or slow — the bound would be met only by a
  // sweep that never slips. Four hours gives a whole run's worth of headroom.
  const schedule = process.env.NEXUS_ETSY_CONTENT_REFRESH_SCHEDULE ?? '20 */4 * * *'
  if (!cron.validate(schedule)) {
    logger.error(`${JOB} cron: invalid schedule, not starting`, { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => { await runEtsyContentRefresh() })
  logger.info(`${JOB} cron: scheduled`, { schedule })
}
