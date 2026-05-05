/**
 * F.1.3 — Backfill DailySalesAggregate from existing OrderItem rows.
 *
 * One-shot script that materializes the trailing 365 days of orders into
 * the new fact table. Idempotent — safe to re-run; the underlying upsert
 * resolves conflicts via (sku, channel, marketplace, day).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx packages/database/scripts/backfill-sales-aggregates.ts
 *   DATABASE_URL=... npx tsx packages/database/scripts/backfill-sales-aggregates.ts 30   # last 30 days only
 *
 * Performance note: the underlying refresh uses a single
 * INSERT ... ON CONFLICT statement per call. Splitting the window into
 * monthly chunks keeps memory bounded and gives progress feedback for
 * large catalogs.
 */
import { refreshSalesAggregates } from '../../../apps/api/src/services/sales-aggregate.service.ts'

async function main() {
  const daysArg = parseInt(process.argv[2] ?? '365', 10)
  const days = Number.isNaN(daysArg) ? 365 : Math.max(1, Math.min(daysArg, 1825))

  const now = new Date()
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() - days + 1)

  console.log(
    `Backfilling DailySalesAggregate from ${start.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)} (${days} days)`,
  )

  // Process one month at a time so progress is visible and a partial
  // failure doesn't waste the whole run.
  let cursor = new Date(start)
  let totalWritten = 0
  let totalSkipped = 0
  const startedAt = Date.now()

  while (cursor <= now) {
    const chunkEnd = new Date(cursor)
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 30)
    if (chunkEnd > now) chunkEnd.setTime(now.getTime())

    const result = await refreshSalesAggregates({
      from: cursor,
      to: chunkEnd,
    })

    const label = `${cursor.toISOString().slice(0, 10)} → ${chunkEnd
      .toISOString()
      .slice(0, 10)}`
    console.log(
      `  ${label.padEnd(28)}  +${String(result.rowsWritten).padStart(6)} written, ` +
        `${String(result.rowsSkipped).padStart(4)} stale removed, ` +
        `${result.durationMs}ms`,
    )

    totalWritten += result.rowsWritten
    totalSkipped += result.rowsSkipped
    cursor = new Date(chunkEnd)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  const totalDurationMs = Date.now() - startedAt
  console.log()
  console.log(
    `Done — ${totalWritten} rows written, ${totalSkipped} stale rows removed, ${totalDurationMs}ms total.`,
  )
}

main()
  .catch((e) => {
    console.error('Backfill failed:', e)
    process.exit(1)
  })
  .then(() => process.exit(0))
