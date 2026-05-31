'use client'

/**
 * Apex A.2a — Live Writes & Guardrails panel (campaign Settings tab).
 *
 * The operator surface for the cautious cutover: a per-campaign live-write
 * allowlist toggle (DEFAULT-DENY — nothing hits Amazon for this campaign until
 * it's on), the bid-safety guardrails (CPC ceiling, max-change-%, writes/day),
 * a read-only gate dry-run showing exactly why a live write would pass or be
 * refused, and a preview of the mutations currently queued for this campaign.
 *
 * Read-only except the explicit toggle/save actions. Sends nothing to Amazon.
 */

import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

interface PendingWrite {
  queueId: string
  syncType: string
  entityType: string | null
  entityId: string
  externalId: string | null
  fieldChanges: Array<{ field: string; oldValue: string | null; newValue: string | null }>
  holdUntil: string | null
  graceExpired: boolean
  requestPreview: { endpoint: string; externalId: string | null; changes: Record<string, string | null> }
}

interface PreviewResponse {
  campaign: { id: string; name: string; marketplace: string | null; liveBidWritesEnabled: boolean; writesToday: number }
  adsMode: 'sandbox' | 'live'
  gate: { allowed: true; mode: string } | { allowed: false; reason: string; deniedAt: string }
  guardrails: {
    cpcCeiling: { enabled: boolean; multiple: number }
    maxBidChangePct: number | null
    maxWritesPerDay: number | null
  }
  pending: PendingWrite[]
  pendingCount: number
  recent?: Array<{ queueId: string; syncType: string; status: string; errorCode: string | null; errorMessage: string | null; changes: Record<string, string | null>; at: string | null }>
}

export function LiveWritesPanel({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // Local editable guardrail inputs (seeded from server on load).
  const [cpcEnabled, setCpcEnabled] = useState(false)
  const [cpcMultiple, setCpcMultiple] = useState('1.5')
  const [maxChangePct, setMaxChangePct] = useState('')
  const [maxWritesPerDay, setMaxWritesPerDay] = useState('')

  const load = useCallback(async () => {
    setErr('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/pending-writes`, { cache: 'no-store' })
      const j = (await r.json()) as PreviewResponse & { error?: string }
      if (j.error) throw new Error(j.error)
      setData(j)
      setCpcEnabled(j.guardrails.cpcCeiling.enabled)
      setCpcMultiple(String(j.guardrails.cpcCeiling.multiple ?? 1.5))
      setMaxChangePct(j.guardrails.maxBidChangePct != null ? String(j.guardrails.maxBidChangePct) : '')
      setMaxWritesPerDay(j.guardrails.maxWritesPerDay != null ? String(j.guardrails.maxWritesPerDay) : '')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [campaignId])

  useEffect(() => { void load() }, [load])

  const toggleAllowlist = async (enabled: boolean) => {
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/live-writes`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setMsg(enabled ? '✓ live writes enabled for this campaign' : '✓ live writes disabled')
      await load()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  const saveGuardrails = async () => {
    setBusy(true); setMsg('')
    try {
      const cpc = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/cpc-ceiling`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: cpcEnabled, multiple: parseFloat(cpcMultiple) || 1.5 }),
      }).then((x) => x.json())
      if (cpc?.error) throw new Error(cpc.error)
      const g = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/guardrails`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxBidChangePct: maxChangePct.trim() === '' ? null : Number(maxChangePct),
          maxWritesPerDay: maxWritesPerDay.trim() === '' ? null : Number(maxWritesPerDay),
        }),
      }).then((x) => x.json())
      if (g?.error) throw new Error(g.error)
      setMsg('✓ guardrails saved')
      await load()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  if (loading) return <div className="p-4 text-sm text-slate-400">Loading live-write status…</div>
  if (err) return <div className="p-4 text-sm text-rose-600">Couldn’t load live-write status: {err}</div>
  if (!data) return null

  const live = data.adsMode === 'live'
  const allowed = data.gate.allowed
  const inputCls = 'mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950'

  return (
    <div className="border-t border-slate-200 dark:border-slate-800 pt-4 mt-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Live writes &amp; guardrails</h3>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${live ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
          platform mode: {data.adsMode}
        </span>
      </div>

      {/* Gate dry-run banner */}
      <div className={`rounded-md px-3 py-2 text-sm border ${allowed ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300' : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300'}`}>
        {allowed ? (
          <>✓ A live bid write to this campaign would be <strong>allowed</strong> ({(data.gate as { mode: string }).mode}).</>
        ) : (
          <>This campaign is <strong>not writing live</strong>. Reason: {(data.gate as { reason: string }).reason}</>
        )}
      </div>

      {/* Allowlist toggle */}
      <div className="flex items-center justify-between rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2.5">
        <div>
          <div className="text-sm font-medium text-slate-700 dark:text-slate-200">Allow live bid writes for this campaign</div>
          <div className="text-xs text-slate-500">Default-deny. Automation and the bidding engine only touch Amazon for allowlisted campaigns. {data.campaign.writesToday > 0 && <span className="text-slate-400">· {data.campaign.writesToday} live write(s) today</span>}</div>
        </div>
        <button
          onClick={() => void toggleAllowlist(!data.campaign.liveBidWritesEnabled)}
          disabled={busy}
          role="switch"
          aria-checked={data.campaign.liveBidWritesEnabled}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition disabled:opacity-50 ${data.campaign.liveBidWritesEnabled ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-600'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${data.campaign.liveBidWritesEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {/* Guardrails */}
      <div className="rounded-md border border-slate-200 dark:border-slate-700 px-3 py-3 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="text-xs text-slate-500 flex flex-col">
            Max bid change per move (%)
            <input type="number" min="0" max="500" placeholder="no limit" value={maxChangePct} onChange={(e) => setMaxChangePct(e.target.value)} className={inputCls} />
          </label>
          <label className="text-xs text-slate-500 flex flex-col">
            Max live writes per day
            <input type="number" min="0" max="10000" placeholder="no limit" value={maxWritesPerDay} onChange={(e) => setMaxWritesPerDay(e.target.value)} className={inputCls} />
          </label>
          <label className="text-xs text-slate-500 flex flex-col">
            CPC ceiling (× historical CPC)
            <div className="flex items-center gap-2 mt-0.5">
              <input type="checkbox" checked={cpcEnabled} onChange={(e) => setCpcEnabled(e.target.checked)} className="h-4 w-4" />
              <input type="number" min="1" max="10" step="0.1" value={cpcMultiple} onChange={(e) => setCpcMultiple(e.target.value)} disabled={!cpcEnabled} className={`${inputCls} flex-1 disabled:opacity-50`} />
            </div>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => void saveGuardrails()} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Saving…' : 'Save guardrails'}</button>
          {msg && <span className={`text-sm ${msg.startsWith('✓') ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600'}`}>{msg}</span>}
        </div>
      </div>

      {/* Pending writes preview */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300">Queued writes ({data.pendingCount})</h4>
          <button onClick={() => void load()} disabled={busy} className="text-xs text-blue-600 hover:underline disabled:opacity-50">Refresh</button>
        </div>
        {data.pending.length === 0 ? (
          <div className="text-xs text-slate-400 px-1 py-2">Nothing queued for this campaign.</div>
        ) : (
          <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">Request</th>
                  <th className="text-left px-2 py-1.5 font-medium">External ID</th>
                  <th className="text-left px-2 py-1.5 font-medium">Changes</th>
                  <th className="text-left px-2 py-1.5 font-medium">Sends</th>
                </tr>
              </thead>
              <tbody>
                {data.pending.map((p) => (
                  <tr key={p.queueId} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-1.5 font-mono text-slate-600 dark:text-slate-300">{p.requestPreview.endpoint}</td>
                    <td className="px-2 py-1.5 font-mono text-slate-500">{p.externalId ?? '—'}</td>
                    <td className="px-2 py-1.5 text-slate-600 dark:text-slate-300">{Object.entries(p.requestPreview.changes).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}</td>
                    <td className="px-2 py-1.5">{p.graceExpired ? <span className="text-amber-600">now</span> : <span className="text-slate-400">in grace</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent write outcomes */}
      {data.recent && data.recent.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">Recent writes</h4>
          <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">Status</th>
                  <th className="text-left px-2 py-1.5 font-medium">Changes</th>
                  <th className="text-left px-2 py-1.5 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.queueId} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-1.5">
                      <span className={`font-medium ${r.status === 'SUCCESS' ? 'text-emerald-600' : r.status === 'FAILED' ? 'text-rose-600' : 'text-slate-500'}`}>{r.status}</span>
                    </td>
                    <td className="px-2 py-1.5 text-slate-600 dark:text-slate-300">{Object.entries(r.changes).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}</td>
                    <td className="px-2 py-1.5 text-slate-500 max-w-[420px] truncate" title={r.errorMessage ?? ''}>{r.errorMessage ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
