/**
 * FFT.4 — pending/failed outbound-sync summary for a loaded row set.
 *
 * Rows arrive from GET /rows with `_pendingSync: [{ type, status }]` stamped
 * server-side (PENDING / IN_PROGRESS / FAILED queue entries). The grids render
 * one honest strip from this: "N changes syncing…" and, louder, "N sync
 * FAILED" with the SKUs — so queue lag or a failed push never reads as
 * "my saved value reverted".
 */

export interface PendingSyncSummary {
  pending: number
  failed: number
  pendingSkus: string[]
  failedSkus: string[]
}

export function computePendingSyncSummary(rows: Array<Record<string, unknown>>): PendingSyncSummary {
  const out: PendingSyncSummary = { pending: 0, failed: 0, pendingSkus: [], failedSkus: [] }
  for (const r of rows) {
    const entries = r._pendingSync
    if (!Array.isArray(entries) || entries.length === 0) continue
    const sku = String(r.item_sku ?? r.sku ?? '').trim() || '(no sku)'
    let hasPending = false
    let hasFailed = false
    for (const e of entries as Array<{ status?: string }>) {
      if (e?.status === 'FAILED') hasFailed = true
      else if (e?.status === 'PENDING' || e?.status === 'IN_PROGRESS') hasPending = true
    }
    if (hasFailed) { out.failed++; out.failedSkus.push(sku) }
    if (hasPending) { out.pending++; out.pendingSkus.push(sku) }
  }
  return out
}
