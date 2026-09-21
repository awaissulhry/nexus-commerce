/**
 * P4.6e — Etsy's six-hour rule.
 *
 * FINAL-PLAN §13 records it as a **required** data rule: *"Etsy's terms: listing content at most
 * 6 hours stale… Must be met once we write or show Etsy data."* P4.6 is that moment.
 *
 * ## What was measured, 2026-09-21
 *
 * | fact | state |
 * |---|---|
 * | the job that refreshes Etsy listings (`etsy-sync`) | **registry-only** — a manual "Run now", **never scheduled** |
 * | that job's client | `EstySyncService` → `EtsyService`, which needs **env credentials production does not have** |
 * | and its `x-api-key` | the **OAuth access token** (P4.6b) — Etsy would refuse the call even with credentials |
 * | so Etsy content freshness in production | **nothing has ever refreshed it** |
 *
 * 🔴 So the rule is not "at risk", it is **not met**, and it has never been met. Three independent
 * reasons, each sufficient on its own — which is itself the finding: a path can look present in
 * three places and be dead in all of them.
 *
 * ## What this module does, and what it deliberately does not
 *
 * It **measures and reports**. It does not pull Etsy's values into Nexus.
 *
 * That restraint is P4.3a's ruling, and it is not negotiable here: `syncInventoryFromEtsy` wrote
 * Etsy's quantities straight into `ProductVariation.stock` and `Product.totalStock`, past the
 * resolver, past the shared-stock pool and past the audit. A refresh job written to "fix
 * staleness" by copying Etsy's numbers back in would be that defect rebuilt with a better excuse.
 *
 * The **write** path already satisfies the rule by construction, and that is worth stating
 * plainly: `writeEtsyInventory` reads the listing's inventory from Etsy **immediately before**
 * every write, because the PUT is a full replace and there is no other way to build the body. Its
 * read is seconds old, not hours.
 *
 * What is left is the **display** half, and closing it needs a connected-account read job — the
 * `etsyReader` works; the legacy client is what does not. That is named in the P4.6e record as
 * open work rather than half-built here.
 */

/** Etsy's terms: six hours. */
export const ETSY_MAX_CONTENT_AGE_MS = 6 * 60 * 60 * 1000

/**
 * Is our copy of an Etsy listing too old to show?
 *
 * 🔴 `null` is **stale**, not fresh. "Never synced" is the worst case and the one every Etsy row
 * is in today; reading absence as freshness is P3.6's rule inverted — `no_data` is never a pass.
 */
export function etsyContentIsStale(lastSyncedAt: Date | null | undefined, now: number = Date.now()): boolean {
  if (!lastSyncedAt) return true
  const at = lastSyncedAt.getTime()
  if (Number.isNaN(at)) return true
  // A timestamp in the FUTURE is not fresh either — it is a clock or a bug, and treating it as
  // "very recent" would be the one reading that hides the problem.
  if (at > now) return true
  return now - at >= ETSY_MAX_CONTENT_AGE_MS
}

export interface EtsyFreshnessCensus {
  total: number
  stale: number
  neverSynced: number
  /** The oldest `lastSyncedAt` among rows that have one, as an ISO string. */
  oldestAt: string | null
}

/** A census of how well the six-hour rule is being kept. Pure: the caller does the reading. */
export function etsyFreshnessCensus(
  rows: ReadonlyArray<{ lastSyncedAt: Date | null }>,
  now: number = Date.now(),
): EtsyFreshnessCensus {
  let stale = 0
  let neverSynced = 0
  let oldest: number | null = null
  for (const row of rows) {
    if (etsyContentIsStale(row.lastSyncedAt, now)) stale++
    if (!row.lastSyncedAt) neverSynced++
    else {
      const at = row.lastSyncedAt.getTime()
      if (!Number.isNaN(at) && (oldest === null || at < oldest)) oldest = at
    }
  }
  return { total: rows.length, stale, neverSynced, oldestAt: oldest === null ? null : new Date(oldest).toISOString() }
}
