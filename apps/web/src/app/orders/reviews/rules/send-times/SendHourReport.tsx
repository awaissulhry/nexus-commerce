'use client'

/**
 * STO.5 — descriptive "when do requests convert" heatmap (read-only).
 *
 * Weekday × hour grid of SENT review requests, shaded by volume, with the
 * conversion count where reviews have been attributed. Purely informational —
 * the operator eyeballs it to nudge the send-times table. Needs review ingestion
 * to show conversion; until then it shows only the send distribution.
 */

import { useEffect, useState } from 'react'
import { BarChart3, Info } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
interface Cell { dayOfWeek: number; hour: number; sent: number; converted: number }
interface Report { windowDays: number; totalSent: number; totalConverted: number; hasReviews: boolean; cells: Cell[] }

export default function SendHourReport() {
  const [data, setData] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/review-send-windows/conversion?windowDays=90`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [])

  const byKey = new Map<string, Cell>()
  let maxSent = 0
  for (const c of data?.cells ?? []) { byKey.set(`${c.dayOfWeek}-${c.hour}`, c); if (c.sent > maxSent) maxSent = c.sent }

  const shade = (sent: number, converted: number) => {
    if (sent === 0) return 'bg-slate-50 dark:bg-slate-900/40'
    if (converted > 0) return 'bg-emerald-500/80 text-white'
    const t = maxSent ? sent / maxSent : 0
    if (t > 0.66) return 'bg-blue-500/80 text-white'
    if (t > 0.33) return 'bg-blue-400/60'
    return 'bg-blue-200/60 dark:bg-blue-900/50'
  }

  const rate = data && data.totalSent ? Math.round((data.totalConverted / data.totalSent) * 1000) / 10 : 0

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-1">
        <BarChart3 size={16} className="text-blue-600" />
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Conversion by send time</h2>
        <span className="text-xs text-tertiary">last 90 days</span>
      </div>

      {loading ? (
        <p className="text-sm text-tertiary py-6">Loading…</p>
      ) : !data || data.totalSent === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400 py-4">No requests sent in the last 90 days yet — this fills in as the mailer sends.</p>
      ) : (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-3">
            <strong className="text-slate-900 dark:text-slate-100">{data.totalSent}</strong> sent ·{' '}
            <strong className="text-slate-900 dark:text-slate-100">{data.totalConverted}</strong> converted ·{' '}
            <strong className="text-slate-900 dark:text-slate-100">{rate}%</strong>
          </p>

          {!data.hasReviews && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 mb-3 text-xs text-amber-800 dark:text-amber-300">
              <Info size={14} className="shrink-0 mt-0.5" />
              <span>No reviews ingested yet, so conversion reads 0. The grid below still shows <strong>when</strong> requests are firing — turn on ingestion to light up conversion. (Don’t over-tune on tiny samples.)</span>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="border-separate" style={{ borderSpacing: '2px' }}>
              <thead>
                <tr>
                  <th className="w-8" />
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h} className="text-[9px] text-tertiary font-normal tabular-nums w-5">{h % 3 === 0 ? h : ''}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAYS.map((day, d) => (
                  <tr key={d}>
                    <td className="text-[11px] text-slate-500 dark:text-slate-400 pr-1 text-right">{day}</td>
                    {Array.from({ length: 24 }, (_, h) => {
                      const c = byKey.get(`${d}-${h}`)
                      const sent = c?.sent ?? 0
                      const converted = c?.converted ?? 0
                      return (
                        <td key={h}
                          title={`${day} ${String(h).padStart(2, '0')}:00 — sent ${sent}${converted ? `, converted ${converted}` : ''}`}
                          className={`h-5 w-5 rounded-sm text-center text-[9px] leading-5 tabular-nums ${shade(sent, converted)}`}>
                          {sent || ''}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-tertiary mt-2">Shaded by send volume; green = had an attributed review. Hours are each request’s marketplace-local time.</p>
        </>
      )}
    </Card>
  )
}
