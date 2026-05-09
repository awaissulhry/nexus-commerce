'use client'

/**
 * W9.6j — Small drawer panels (extracted together because they're
 * always rendered side-by-side inside ForecastDetailDrawer).
 *
 * Includes:
 *   SignalsPanel + SignalChip   F.4 — holiday/weather/retail
 *                                signal multipliers + per-signal
 *                                chip with tone (green/rose/slate)
 *   StockByLocationPanel        R.2 — per-location quantity /
 *                                reserved / available + marketplace
 *                                served, with fallback warning
 *   ChannelCoverPanel           R.2 — per-channel days-of-cover
 *                                with progress bar tone (red/amber/
 *                                slate)
 *
 * Adds dark-mode classes throughout (the inline versions were
 * bright-only on container backgrounds, panel surfaces, header
 * labels, pill tones, fallback warning, and progress bar tracks).
 */

import { cn } from '@/lib/utils'

export function SignalsPanel({ signals }: { signals: unknown }) {
  const s = signals as
    | {
        combined?: number
        holiday?: number
        weather?: number
        retail?: number
        notes?: Array<{ source: string; description: string; factor: number }>
      }
    | null
    | undefined
  const combined = s?.combined
  const holiday = s?.holiday ?? 1
  const weather = s?.weather ?? 1
  const retail = s?.retail ?? 1
  const notes = s?.notes
  if (
    typeof combined !== 'number' ||
    (combined === 1 && holiday === 1 && weather === 1 && retail === 1)
  ) {
    return (
      <div>
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
          External signals
        </div>
        <div className="text-base text-slate-500 dark:text-slate-400">
          Neutral — baseline forecast applies.
        </div>
      </div>
    )
  }
  return (
    <div>
      <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
        External signals (combined ×
        <span className="font-mono text-slate-700 dark:text-slate-300 ml-1">
          {Number(combined).toFixed(2)}
        </span>
        )
      </div>
      <div className="grid grid-cols-3 gap-2 mb-2 text-base">
        <SignalChip label="Holiday" factor={holiday} />
        <SignalChip label="Weather" factor={weather} />
        <SignalChip label="Retail" factor={retail} />
      </div>
      {Array.isArray(notes) && notes.length > 0 && (
        <ul className="text-sm text-slate-600 dark:text-slate-400 space-y-0.5">
          {notes.slice(0, 5).map((n, i) => (
            <li key={i} className="inline-flex items-center gap-1">
              <span className="text-slate-400 dark:text-slate-500 capitalize">
                {n.source}:
              </span>
              <span>{n.description}</span>
              <span className="ml-auto font-mono text-slate-500 dark:text-slate-400">
                ×{Number(n.factor).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function SignalChip({
  label,
  factor,
}: {
  label: string
  factor: number
}) {
  const tone =
    factor > 1.05
      ? 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-900'
      : factor < 0.95
        ? 'text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-950/40 dark:border-rose-900'
        : 'text-slate-600 bg-slate-50 border-slate-200 dark:text-slate-400 dark:bg-slate-900 dark:border-slate-800'
  return (
    <div className={cn('border rounded px-2 py-1 text-sm', tone)}>
      <div className="uppercase tracking-wider text-xs font-semibold opacity-70">
        {label}
      </div>
      <div className="tabular-nums font-semibold">
        ×{Number(factor).toFixed(2)}
      </div>
    </div>
  )
}

interface AtpLocationRow {
  locationId: string
  locationCode: string
  locationName: string
  locationType: string
  servesMarketplaces: string[]
  quantity: number
  reserved: number
  available: number
}

export function StockByLocationPanel({
  atp,
}: {
  atp: {
    leadTimeDays: number
    leadTimeSource: string
    inboundWithinLeadTime: number
    byLocation?: AtpLocationRow[]
    totalAvailable?: number
    stockSource?: string
  }
}) {
  const byLocation = atp.byLocation ?? []
  const totalAvailable = atp.totalAvailable ?? 0
  const inboundLT = atp.inboundWithinLeadTime ?? 0
  const stockSource = atp.stockSource ?? 'STOCK_LEVEL'
  const isFallback = stockSource === 'PRODUCT_TOTAL_STOCK_FALLBACK'

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded p-3 bg-slate-50/50 dark:bg-slate-950/40">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          Stock by location
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Lead time:{' '}
          <span className="font-semibold text-slate-700 dark:text-slate-300">
            {atp.leadTimeDays}d
          </span>{' '}
          <span className="font-mono text-xs">
            ({String(atp.leadTimeSource).toLowerCase().replace(/_/g, ' ')})
          </span>
        </div>
      </div>

      {isFallback && (
        <div className="text-sm text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded px-2 py-1.5 mb-2">
          This product hasn't been migrated to per-location tracking yet. Totals
          below are inferred from{' '}
          <span className="font-mono">Product.totalStock</span>; reconcile via
          the Stock workspace for accurate numbers.
        </div>
      )}

      {byLocation.length === 0 ? (
        <div className="text-base text-slate-500 dark:text-slate-400 italic py-2">
          No stock at any location. Receive inventory or update via Stock workspace.
        </div>
      ) : (
        <ul className="space-y-1.5 text-base">
          {byLocation.map((loc) => (
            <li
              key={loc.locationId}
              className="flex items-center justify-between gap-2"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-sm text-slate-700 dark:text-slate-300 truncate">
                  {loc.locationCode}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  {String(loc.locationType).toLowerCase().replace('_', ' ')}
                  {loc.servesMarketplaces && loc.servesMarketplaces.length > 0 && (
                    <span> · {loc.servesMarketplaces.join(', ')}</span>
                  )}
                </div>
              </div>
              <div className="text-right tabular-nums flex-shrink-0">
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  {loc.available}
                </div>
                {loc.reserved > 0 && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {loc.quantity} − {loc.reserved} reserved
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800 grid grid-cols-3 gap-2 text-base">
        <div>
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            Available
          </div>
          <div className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
            {totalAvailable}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            Inbound (LT)
          </div>
          <div className="tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
            +{inboundLT}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            ATP
          </div>
          <div className="tabular-nums font-bold text-slate-900 dark:text-slate-100">
            {totalAvailable + inboundLT}
          </div>
        </div>
      </div>
    </div>
  )
}

interface ChannelCoverRow {
  channel: string
  marketplace: string
  velocityPerDay: number
  available: number
  locationCode: string | null
  source: string
  daysOfCover: number | null
}

export function ChannelCoverPanel({
  channelCover,
  leadTimeDays,
}: {
  channelCover: ChannelCoverRow[]
  leadTimeDays: number
}) {
  if (channelCover.length === 0) return null
  const maxBar = Math.max(
    ...channelCover.map((c) => c.daysOfCover ?? 0),
    leadTimeDays * 4,
  )

  return (
    <div>
      <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
        Days of cover by channel
      </div>
      <ul className="space-y-1.5 text-base">
        {channelCover.map((c, i) => {
          const tone =
            c.daysOfCover == null
              ? 'bg-slate-50 border-slate-200 text-slate-500 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400'
              : c.daysOfCover <= leadTimeDays
                ? 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-950/40 dark:border-rose-900 dark:text-rose-300'
                : c.daysOfCover <= leadTimeDays * 2
                  ? 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-300'
                  : 'bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300'
          const barWidth =
            c.daysOfCover != null
              ? Math.min(100, Math.round((c.daysOfCover / maxBar) * 100))
              : 0
          return (
            <li key={i} className={cn('border rounded px-2 py-1.5', tone)}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-sm">
                    {c.channel} · {c.marketplace}
                  </span>
                  {c.source !== 'EXACT_MATCH' && (
                    <span className="ml-1 text-xs uppercase tracking-wider opacity-70">
                      {c.source === 'WAREHOUSE_DEFAULT'
                        ? '(default WH)'
                        : '(no location)'}
                    </span>
                  )}
                </div>
                <div className="tabular-nums text-sm flex-shrink-0">
                  {c.available} ÷ {c.velocityPerDay}/d ={' '}
                  <span className="font-semibold">
                    {c.daysOfCover == null ? '—' : `${c.daysOfCover}d`}
                  </span>
                </div>
              </div>
              {c.daysOfCover != null && c.velocityPerDay > 0 && (
                <div className="mt-1 h-1 bg-white/60 dark:bg-slate-950/60 rounded overflow-hidden">
                  <div
                    className={cn(
                      'h-full',
                      c.daysOfCover <= leadTimeDays
                        ? 'bg-rose-500 dark:bg-rose-600'
                        : c.daysOfCover <= leadTimeDays * 2
                          ? 'bg-amber-500 dark:bg-amber-600'
                          : 'bg-slate-400 dark:bg-slate-500',
                    )}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
