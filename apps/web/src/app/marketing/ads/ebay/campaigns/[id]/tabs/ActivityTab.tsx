'use client'

/**
 * ER1 — Activity: the immutable per-campaign event log (v1 preserved) +
 * action-type/mode filters and cursor pagination ("Load older"). Every write
 * Nexus made — drift repairs and accepted eBay-side changes included.
 */
import { useCallback, useEffect, useState } from 'react'
import { getEbayAds, type ActionRow } from '../../../_lib'
import { money } from '../../../../campaigns/_grid/format'

function actionSummary(a: ActionRow): string {
  const after = a.payloadAfter ?? {}
  const parts: string[] = []
  if (after.rates && typeof after.rates === 'object') parts.push(`${Object.keys(after.rates as object).length} rate(s)`)
  if (Array.isArray(after.results)) { const r = after.results as Array<{ ok: boolean }>; parts.push(`${r.filter((x) => x.ok).length}/${r.length} ok`) }
  if (after.dailyBudgetCents != null) parts.push(`budget → ${money(Number(after.dailyBudgetCents))}`)
  if (after.status != null) parts.push(`status → ${String(after.status)}`)
  if (after.name != null) parts.push(`name → ${String(after.name)}`)
  if (after.endDate !== undefined) parts.push(`end date → ${after.endDate == null ? 'never' : String(after.endDate).slice(0, 10)}`)
  if (after.posture != null) parts.push(`posture → ${String(after.posture)}${after.protected != null ? ` · protected ${String(after.protected)}` : ''}`)
  if (after.field != null) parts.push(`${String(after.field)}${after.value != null ? ` → ${String(after.value)}` : ''}`)
  if (after.counts && typeof after.counts === 'object') parts.push(Object.entries(after.counts as Record<string, number>).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', '))
  return parts.join(' · ')
}

export function ActivityTab({ externalCampaignId }: { externalCampaignId: string }) {
  const [rows, setRows] = useState<ActionRow[] | null>(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const [modeFilter, setModeFilter] = useState('all')
  const [more, setMore] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback((before?: string) => {
    setBusy(true)
    getEbayAds<{ actions: ActionRow[] }>(`/actions?entityId=${encodeURIComponent(externalCampaignId)}&limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`)
      .then((j) => {
        setRows((prev) => (before ? [...(prev ?? []), ...j.actions] : j.actions))
        setMore(j.actions.length === 100)
      })
      .catch(() => setRows((prev) => prev ?? []))
      .finally(() => setBusy(false))
  }, [externalCampaignId])
  useEffect(() => { load() }, [load])

  const types = Array.from(new Set((rows ?? []).map((a) => a.actionType))).sort()
  const visible = (rows ?? []).filter((a) => {
    const mode = String((a.payloadAfter as { _mode?: string } | null)?._mode ?? '')
    return (typeFilter === 'all' || a.actionType === typeFilter) && (modeFilter === 'all' || mode === modeFilter)
  })

  return (
    <div className="h10-am-card" style={{ padding: '6px 0', maxWidth: 1080 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px 4px', flexWrap: 'wrap' }}>
        <p style={{ fontSize: 12, color: '#5b6573', margin: 0, flex: 1 }}>Every write Nexus made to this campaign — immutable. Drift repairs and accepted eBay-side changes appear here too.</p>
        <select className="h10-cd-input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Action type">
          <option value="all">All actions</option>
          {types.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
        <select className="h10-cd-input" value={modeFilter} onChange={(e) => setModeFilter(e.target.value)} aria-label="Mode">
          <option value="all">All modes</option><option value="live">live</option><option value="sandbox">sandbox</option><option value="local">local</option>
        </select>
      </div>
      {rows == null ? (
        <div style={{ padding: '24px 18px', fontSize: 13, color: '#8a93a1' }}>Loading…</div>
      ) : visible.length === 0 ? (
        <div className="h10-cd-empty"><h3>No Nexus writes yet</h3><p>This campaign has only been synced (Seller Hub-managed or read-only so far).</p></div>
      ) : (
        <>
          {visible.map((a) => {
            const mode = String((a.payloadAfter as { _mode?: string } | null)?._mode ?? '')
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px', borderBottom: '1px solid #eef1f5', flexWrap: 'wrap', fontSize: 12.5 }}>
                <span style={{ color: '#8a93a1', minWidth: 128 }}>{new Date(a.createdAt).toLocaleString('en-GB')}</span>
                <span className="h10-pill arch">{a.actionType.replace(/_/g, ' ')}</span>
                {mode && <span className={`h10-pill ${mode === 'live' ? 'ok' : 'warn'}`}>{mode}</span>}
                <span className={`h10-pill ${a.channelResponseStatus === 'SUCCESS' ? 'ok' : 'warn'}`}>{a.channelResponseStatus.toLowerCase()}</span>
                <span style={{ color: '#283441' }}>{actionSummary(a)}</span>
              </div>
            )
          })}
          {more && (
            <div style={{ padding: '10px 18px' }}>
              <button type="button" className="h10-am-btn sm" disabled={busy} onClick={() => load(rows[rows.length - 1]?.createdAt)}>{busy ? 'Loading…' : 'Load older'}</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
