'use client'

/**
 * Automation ▸ Dayparting. Day-of-week CVR heatmap (vs account average →
 * bid-up/down) from /advertising/dayparting-intel, recommended windows, and
 * the AdSchedule list with enable/disable. Hour-of-day multipliers activate
 * once Amazon Marketing Stream delivers hourly rows.
 */

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Clock } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
interface DayRow { weekday: number; label: string; orders: number; cvr: number | null; cvrIndex: number | null; recommend: 'bid-up' | 'bid-down' | 'keep' }
interface Intel { days: DayRow[]; hourlyAvailable: boolean; peakHours: number[]; weakHours: number[]; recommendedWindows: Array<{ days: number[]; startHour: number; endHour: number }> }
interface Schedule { id: string; name: string; campaignId: string; enabled: boolean; lastEvaluatedAt?: string | null }

const fmtWin = (w: { days: number[]; startHour: number; endHour: number }) => `${w.days.map((d) => DOW[d] ?? d).join('/')} · ${String(w.startHour).padStart(2, '0')}:00–${String(w.endHour).padStart(2, '0')}:00`

export function DaypartingTab() {
  const [intel, setIntel] = useState<Intel | null>(null)
  const [scheds, setScheds] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const b = getBackendUrl()
      const [i, s] = await Promise.all([
        fetch(`${b}/api/advertising/dayparting-intel`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch(`${b}/api/advertising/schedules`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
      ])
      setIntel(i as Intel); setScheds((s.items ?? []) as Schedule[])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const toggle = async (s: Schedule) => {
    setBusy(s.id)
    try { await fetch(`${getBackendUrl()}/api/advertising/schedules/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) }); await load() } finally { setBusy(null) }
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><Clock size={15} style={{ stroke: 'var(--brand)' }} /> Day-of-week performance <span className="mut">· CVR vs account average</span><span className="spacer" style={{ flex: 1 }} /><button className="ctl" onClick={() => void load()}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button></div>
        <div className="bd">
          {!intel ? <div className="empty">Loading…</div> : (
            <div className="heatgrid">
              {intel.days.map((d) => (
                <div key={d.weekday} className={`heatcell ${d.recommend === 'bid-up' ? 'up' : d.recommend === 'bid-down' ? 'down' : ''}`}>
                  <div className="hd2">{d.label}</div>
                  <div className="hi">{d.cvrIndex != null ? `${d.cvrIndex.toFixed(2)}×` : '—'}</div>
                  <div className="hs">{d.orders} orders{d.recommend !== 'keep' ? ` · ${d.recommend === 'bid-up' ? 'bid up' : 'bid down'}` : ''}</div>
                </div>
              ))}
            </div>
          )}
          {intel && !intel.hourlyAvailable && <p className="note" style={{ marginTop: 10 }}>Hour-of-day multipliers (peak ×1.5 / off-peak ×0.7) activate once Amazon Marketing Stream is delivering hourly data — the weekday signal above comes from daily reports.</p>}
          {intel && intel.recommendedWindows.length > 0 && <div style={{ marginTop: 10 }}><span className="sub">Recommended windows: </span>{intel.recommendedWindows.map((w, i) => <span key={i} className="condchip" style={{ marginRight: 5 }}>{fmtWin(w)}</span>)}</div>}
        </div>
      </div>

      <div className="card">
        <div className="hd">Schedules <span className="mut">· {scheds.length}</span></div>
        <div className="tablewrap"><table>
          <thead><tr><th className="l">Schedule</th><th>Status</th><th>Last evaluated</th><th></th></tr></thead>
          <tbody>
            {scheds.length === 0 && <tr><td colSpan={4} className="empty">No dayparting schedules yet. Apply a recommended window to a campaign to create one.</td></tr>}
            {scheds.map((s) => (
              <tr key={s.id}>
                <td className="l">{s.name}</td>
                <td><span className={`modepill ${s.enabled ? 'live' : 'off'}`}>{s.enabled ? 'Active' : 'Off'}</span></td>
                <td className="num">{s.lastEvaluatedAt ? new Date(s.lastEvaluatedAt).toLocaleString() : '—'}</td>
                <td><button className="iact" disabled={busy === s.id} onClick={() => void toggle(s)}>{s.enabled ? 'Disable' : 'Enable'}</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </>
  )
}
