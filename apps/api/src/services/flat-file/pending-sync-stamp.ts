/**
 * FFT.4 — pending/failed outbound-sync state, stamped onto flat-file rows.
 *
 * The grids' price/qty cells show LIVE DB values (snapshot live-overlay), so a
 * saved change "reverts" visually until the outbound queue pushes it — with the
 * RT instant lane that window is ~2s, but holds/retries/failures are exactly
 * what the operator must SEE instead of mistaking them for data loss. Each row
 * gains `_pendingSync: [{ type, status }]` when its product has queue rows that
 * are not terminal-success. Advisory: any failure here never blocks a load.
 */

interface PendingSyncDb {
  outboundSyncQueue: {
    findMany: (args: unknown) => Promise<Array<{ productId: string | null; syncType: string; syncStatus: string }>>
  }
}

export interface PendingSyncEntry { type: string; status: 'PENDING' | 'IN_PROGRESS' | 'FAILED' }

export async function stampPendingSync(
  db: PendingSyncDb,
  rows: Array<Record<string, unknown>>,
  opts: { channel: 'AMAZON' | 'EBAY'; marketplace?: string },
): Promise<void> {
  try {
    const pids = [...new Set(rows.map((r) => String(r._productId ?? '')).filter(Boolean))]
    if (!pids.length) return
    const region = opts.marketplace
      ? (opts.channel === 'EBAY' && opts.marketplace.toUpperCase() === 'UK' ? 'GB' : opts.marketplace.toUpperCase())
      : undefined
    const pending = await db.outboundSyncQueue.findMany({
      where: {
        productId: { in: pids },
        targetChannel: opts.channel,
        ...(region ? { OR: [{ targetRegion: region }, { targetRegion: null }] } : {}),
        syncStatus: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
      },
      select: { productId: true, syncType: true, syncStatus: true },
      take: 2000,
    })
    if (!pending.length) return
    const byPid = new Map<string, PendingSyncEntry[]>()
    for (const q of pending) {
      if (!q.productId) continue
      const arr = byPid.get(q.productId) ?? []
      arr.push({ type: q.syncType, status: q.syncStatus as PendingSyncEntry['status'] })
      byPid.set(q.productId, arr)
    }
    for (const r of rows) {
      const p = byPid.get(String(r._productId ?? ''))
      if (p) r._pendingSync = p
    }
  } catch {
    /* advisory — never block a grid load */
  }
}
