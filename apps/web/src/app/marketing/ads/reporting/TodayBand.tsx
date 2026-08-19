'use client'

/**
 * R5 — "Today so far".
 *
 * Every report on this page runs a day behind, because the Ads API v3 feeds are daily and land
 * overnight. So the one question an operator asks first — *what have we spent and sold today?* —
 * was the one question Reporting could not answer, and answering it meant leaving for Amazon's
 * console.
 *
 * It needs no new ingest and no new SQL. The Amazon Marketing Stream feed is hourly and current
 * to today in all four markets, and the runner already has an `hourly` spec with `date` and
 * `hour` dimensions and the full metric set. This is two queries against that spec: one grouped
 * by market, one by hour.
 *
 * ── Two honesty rules it exists to keep ─────────────────────────────────────────────────────
 *
 * 1. **Say how complete "today" is.** The stream lags roughly an hour, so at 19:00 UTC the last
 *    hour with data is 18:00. A figure labelled "today" that silently omits the last hour reads
 *    as a decline. It states the hour it counts through.
 *
 * 2. **Say who "we" is.** Italy is around two thirds of this account's impressions, so an
 *    account-wide live total is mostly a live Italy total. The markets are listed with their
 *    share rather than averaged into one number — the same rule that made per-market freshness
 *    the point of the report library.
 *
 * Derived metrics (CTR, CVR, ACOS) come from the server per row and are never summed here:
 * an average of four ACOSes is not the account's ACOS.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { formatCell, runReport, type ColumnMeta, type ReportParams } from './report-api'

/**
 * 🔴 The UTC day, NOT the local one — and this is the opposite of what the date picker wants.
 *
 * The Marketing Stream buckets by hour IN UTC (`ads-report-specs.ts`: "Hour of day in UTC, as
 * Amazon Marketing Stream delivers it"). Asking for the LOCAL day therefore asks for the wrong
 * day for as long as the two disagree: measured on prod at 00:24 Europe/Rome, the local date was
 * already 2026-08-20 while UTC was still 22:00 on the 19th, so the query returned **0 rows** and
 * the band vanished — while 22 hours of real data sat under the previous UTC date.
 *
 * `report-api`'s `isoDay` is local on purpose (R2): the picker draws a local calendar over
 * per-marketplace daily feeds. Both are right; they are answering different questions, which is
 * exactly why this one is spelled out here rather than shared.
 */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** "19 Aug" from a YYYY-MM-DD, read back in UTC so it cannot shift the day it just chose. */
function shortUtc(iso: string): string {
  return new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** The stream is hourly, so anything finer is polling for its own sake. */
const REFRESH_MS = 5 * 60 * 1000

/** What the band shows, in this order. Everything else the spec returns stays out of the way. */
const SHOWN = ['impressions', 'clicks', 'cost', 'sales', 'orders', 'acos']

interface Today {
  /** The UTC day these figures cover — stated, never assumed to be the reader's today. */
  day: string
  columns: ColumnMeta[]
  totals: Record<string, unknown> | null
  markets: Array<{ marketplace: string; impressions: number }>
  newestHour: number | null
  currency: string
}

/**
 * Whole-percent shares that actually sum to 100.
 *
 * Rounding each share on its own does not: this account's real split
 * (65.2 / 22.6 / 7.6 / 4.6) rounds to 65 + 23 + 8 + 5 = **101**, and a set of shares adding to
 * 101% undermines every other number in the band. Largest-remainder apportionment gives the
 * extra point to whichever market lost the most to rounding, so the row is internally
 * consistent without misstating anyone by more than a point.
 */
function wholePercentShares(values: number[]): number[] {
  const total = values.reduce((s, v) => s + v, 0)
  if (total <= 0) return values.map(() => 0)
  const exact = values.map((v) => (v / total) * 100)
  const floors = exact.map(Math.floor)
  let left = 100 - floors.reduce((s, v) => s + v, 0)
  const order = exact
    .map((v, i) => ({ i, rem: v - Math.floor(v) }))
    .sort((a, b) => b.rem - a.rem)
  const out = [...floors]
  for (const { i } of order) {
    if (left <= 0) break
    out[i] += 1
    left -= 1
  }
  return out
}

function params(groupBy: string[], pageSize: number): ReportParams {
  const day = utcDay(new Date())
  return {
    reportId: 'hourly',
    from: day, to: day,
    marketplaces: [], adProducts: [], search: '',
    groupBy, columns: [],
    sortCol: null, sortDir: 'desc',
    page: 1, pageSize,
  }
}

export function TodayBand() {
  const [data, setData] = useState<Today | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    Promise.all([
      runReport(params(['marketplace'], 20), ac.signal),
      runReport(params(['hour'], 30), ac.signal),
    ])
      .then(([byMarket, byHour]) => {
        const hours = byHour.rows
          .map((r) => Number(r.hour))
          .filter((h) => Number.isFinite(h))
        setData({
          day: utcDay(new Date()),
          columns: byMarket.columns,
          totals: byMarket.totals,
          markets: byMarket.rows
            .map((r) => ({ marketplace: String(r.marketplace ?? ''), impressions: Number(r.impressions ?? 0) }))
            .sort((a, b) => b.impressions - a.impressions),
          newestHour: hours.length ? Math.max(...hours) : null,
          currency: byMarket.currency,
        })
        setError(null)
      })
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return
        setError((e as Error).message)
      })
      .finally(() => setLoading(false))
    return () => ac.abort()
  }, [nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  useEffect(() => {
    const t = window.setInterval(refresh, REFRESH_MS)
    return () => window.clearInterval(t)
  }, [refresh])

  const metrics = useMemo(
    () => SHOWN
      .map((id) => data?.columns.find((c) => c.id === id))
      .filter((c): c is ColumnMeta => !!c),
    [data],
  )

  // Nothing yet today is a real state — before the first hour lands there is genuinely
  // nothing to report, and saying so beats a row of zeros that look like a collapse.
  const totalImpressions = data?.markets.reduce((s, m) => s + m.impressions, 0) ?? 0
  const shares = useMemo(
    () => wholePercentShares((data?.markets ?? []).map((m) => m.impressions)),
    [data],
  )

  // A failed fetch stays silent: the report list below is the page, and a live extra must never
  // break it. An EMPTY day does not — it renders and says it is waiting. Returning null there
  // (which this did) made the whole band disappear for the first hours of every UTC day, which
  // reads as a removed feature rather than as a feed that has not reported yet.
  if (error || (!loading && !data)) return null

  return (
    <section className={`rpt-today${loading ? ' is-loading' : ''}`} aria-label="Today so far">
      <div className="hd">
        <span className="lbl">Today so far</span>
        <span className="thru">
          {data ? `${shortUtc(data.day)} UTC · ` : ''}
          {data?.newestHour != null
            ? `through ${String(data.newestHour).padStart(2, '0')}:59`
            : 'no hours reported yet'}
        </span>
        <button type="button" className="rf" onClick={refresh} aria-label="Refresh today's figures">
          <RefreshCw size={12} aria-hidden />
        </button>
        <Link href="/marketing/ads/reporting/hourly" className="open">
          Hourly report <ArrowRight size={12} aria-hidden />
        </Link>
      </div>

      <div className="figs">
        {data?.newestHour == null ? (
          <span className="rpt-today-wait">
            The stream has not delivered an hour for this UTC day yet. It usually lands within the hour.
          </span>
        ) : metrics.map((c) => (
          <span className="fig" key={c.id}>
            <span className="k">{c.label}</span>
            <b>{formatCell(data?.totals?.[c.id], c.format, data?.currency ?? 'EUR')}</b>
          </span>
        ))}
      </div>

      {/* Which market this is really made of. Share is of impressions, the one metric every
          market always has — a share of sales would be undefined on a market with none. */}
      {data?.newestHour != null && (data?.markets.length ?? 0) > 0 && (
        <div className="mkts">
          {data!.markets.map((m, i) => (
            <span className="mkt" key={m.marketplace}>
              <span className="code">{m.marketplace}</span>
              <span className="sh">{totalImpressions > 0 ? `${shares[i]}%` : '—'}</span>
            </span>
          ))}
          <span className="of">of impressions</span>
        </div>
      )}
    </section>
  )
}
