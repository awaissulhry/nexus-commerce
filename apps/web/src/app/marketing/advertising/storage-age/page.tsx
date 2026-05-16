/**
 * AD.2 — FBA aged-stock heatmap + drill-down.
 *
 * Reads /api/advertising/fba-storage-age, groups by marketplace × bucket,
 * renders a heatmap cell for each. Click-through to the SKU list under
 * each bucket. The 30d/60d/90d projection toggle switches the cell
 * label between projected LTS fees in those horizons.
 */

import Link from 'next/link'
import { Warehouse } from 'lucide-react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { formatEur, formatNumber } from '../_shared/formatters'
import { getBackendUrl } from '@/lib/backend-url'
import { StorageAgeHeatmap } from './StorageAgeHeatmap'

export const dynamic = 'force-dynamic'

interface StorageAgeRow {
  id: string
  sku: string
  asin: string | null
  marketplace: string
  productId: string | null
  polledAt: string
  quantityInAge0_90: number
  quantityInAge91_180: number
  quantityInAge181_270: number
  quantityInAge271_365: number
  quantityInAge365Plus: number
  currentStorageFeeCents: number
  projectedLtsFee30dCents: number
  projectedLtsFee60dCents: number
  projectedLtsFee90dCents: number
  daysToLtsThreshold: number | null
}

async function fetchAll(): Promise<StorageAgeRow[]> {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/fba-storage-age?limit=500`,
    { cache: 'no-store' },
  )
  if (!res.ok) return []
  const json = (await res.json()) as { items: StorageAgeRow[] }
  return json.items
}

export default async function StorageAgePage() {
  const rows = await fetchAll()

  const totals = {
    skus: rows.length,
    units:
      rows.reduce(
        (a, r) =>
          a +
          r.quantityInAge0_90 +
          r.quantityInAge91_180 +
          r.quantityInAge181_270 +
          r.quantityInAge271_365 +
          r.quantityInAge365Plus,
        0,
      ),
    fee30: rows.reduce((a, r) => a + r.projectedLtsFee30dCents, 0),
    fee60: rows.reduce((a, r) => a + r.projectedLtsFee60dCents, 0),
    fee90: rows.reduce((a, r) => a + r.projectedLtsFee90dCents, 0),
    critical: rows.filter((r) => r.daysToLtsThreshold != null && r.daysToLtsThreshold <= 14)
      .length,
  }

  return (
    <div className="px-4 py-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <Warehouse className="h-5 w-5 text-amber-500" />
        Stock invecchiato FBA
      </h1>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
        Snapshot dell&apos;ultimo ingest per marketplace × fascia d&apos;età. Click su una
        cella per vedere gli SKU. Il toggle 30g/60g/90g mostra le commissioni LTS proiettate
        in quell&apos;orizzonte.
      </p>
      <AdvertisingNav />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Stat label="SKU" value={formatNumber(totals.skus)} />
        <Stat label="Unità" value={formatNumber(totals.units)} />
        <Stat label="LTS proietti 30g" value={formatEur(totals.fee30)} />
        <Stat label="LTS proietti 60g" value={formatEur(totals.fee60)} />
        <Stat
          label="Critici (≤14g)"
          value={formatNumber(totals.critical)}
          accent={totals.critical > 0 ? 'rose' : null}
        />
      </div>

      {rows.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-6 text-center text-sm text-slate-500">
          Nessun dato. Esegui l&apos;ingest:{' '}
          <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
            POST /api/advertising/cron/fba-storage-age-ingest/trigger
          </code>
        </div>
      ) : (
        <StorageAgeHeatmap rows={rows} />
      )}

      <div className="mt-4 text-[11px] text-slate-400 dark:text-slate-500">
        Crons:{' '}
        <Link
          href="/sync-logs"
          className="underline hover:text-slate-600 dark:hover:text-slate-300"
        >
          fba-storage-age-ingest
        </Link>{' '}
        ogni 6 ore
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: 'rose' | null
}) {
  return (
    <div
      className={`bg-white dark:bg-slate-900 border rounded-md px-3 py-2 ${
        accent === 'rose'
          ? 'border-rose-200 dark:border-rose-900'
          : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div
        className={`text-base font-semibold tabular-nums ${
          accent === 'rose'
            ? 'text-rose-700 dark:text-rose-300'
            : 'text-slate-900 dark:text-slate-100'
        }`}
      >
        {value}
      </div>
    </div>
  )
}
