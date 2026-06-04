'use client'

/**
 * RC4.12 — Top-of-search IS + ACOS trend sparklines. A compact two-up card showing
 * how the campaign's top-of-search impression share and ACOS have moved over the
 * lookback window. Reads /campaigns/:id/rank-trend; renders nothing when there's
 * no data (e.g. a campaign that never showed at the top).
 */

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

interface Trend { axis: string[]; is: (number | null)[]; acos: (number | null)[]; windowDays: number }

function Spark({ data, color }: { data: (number | null)[]; color: string }) {
  const vals = data.filter((v): v is number => v != null)
  if (vals.length < 2) return <svg className="az-spark" viewBox="0 0 120 28" />
  const min = Math.min(...vals), max = Math.max(...vals), range = max - min || 1
  const W = 120, H = 28
  const pts = data.map((v, i) => (v == null ? null : `${((i / (data.length - 1)) * W).toFixed(1)},${(H - ((v - min) / range) * (H - 3) - 1.5).toFixed(1)}`)).filter(Boolean).join(' ')
  const lastI = data.map((v, i) => (v != null ? i : -1)).filter(i => i >= 0).pop() ?? -1
  const lastV = lastI >= 0 ? data[lastI] : null
  return (
    <svg className="az-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {lastV != null && <circle cx={(lastI / (data.length - 1)) * W} cy={H - ((lastV - min) / range) * (H - 3) - 1.5} r={2} fill={color} />}
    </svg>
  )
}

export function RankTrend({ campaignId, lookback }: { campaignId: string; lookback: number }) {
  const [data, setData] = useState<Trend | null>(null)

  useEffect(() => {
    if (!campaignId) { setData(null); return }
    const ac = new AbortController()
    void fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/rank-trend?windowDays=${lookback}`, { cache: 'no-store', signal: ac.signal }).then(r => r.json()).then(d => { if (!ac.signal.aborted) setData(d as Trend) }).catch(() => {})
    return () => ac.abort()
  }, [campaignId, lookback])

  if (!data) return null
  const hasIS = data.is.some(v => v != null)
  const hasAcos = data.acos.some(v => v != null)
  if (!hasIS && !hasAcos) return null
  const last = (a: (number | null)[]) => [...a].reverse().find(v => v != null) ?? null
  const first = (a: (number | null)[]) => a.find(v => v != null) ?? null
  const delta = (a: (number | null)[]) => { const f = first(a), l = last(a); return f != null && l != null ? l - f : null }
  const lastIS = last(data.is), lastAcos = last(data.acos)
  const dIS = delta(data.is), dAcos = delta(data.acos)

  return (
    <div className="az-trend">
      <div className="az-trend-item">
        <div className="hd"><span className="cap">Top-of-search share</span><span className="val">{lastIS != null ? `${Math.round(lastIS * 100)}%` : '—'}</span>{dIS != null && Math.abs(dIS) >= 0.01 && <span className={`dl ${dIS >= 0 ? 'up' : 'dn'}`}>{dIS >= 0 ? '▲' : '▼'} {Math.abs(Math.round(dIS * 100))}pt</span>}</div>
        <Spark data={data.is} color="#1f6feb" />
      </div>
      <div className="az-trend-item">
        <div className="hd"><span className="cap">Top-of-search ACOS</span><span className="val">{lastAcos != null ? `${Math.round(lastAcos * 100)}%` : '—'}</span>{dAcos != null && Math.abs(dAcos) >= 0.01 && <span className={`dl ${dAcos <= 0 ? 'up' : 'dn'}`}>{dAcos >= 0 ? '▲' : '▼'} {Math.abs(Math.round(dAcos * 100))}pt</span>}</div>
        <Spark data={data.acos} color="#b3541e" />
      </div>
      <span className="az-trend-win">{lookback}d</span>
    </div>
  )
}
