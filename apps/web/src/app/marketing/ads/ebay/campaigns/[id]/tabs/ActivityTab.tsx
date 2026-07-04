'use client'

/**
 * EV4b — Activity on the shared row-list skin + H10Select filters (zero
 * native controls): the immutable per-campaign event log (v1 semantics
 * preserved) with action-type/mode filters and cursor pagination.
 */
import { useCallback, useEffect, useState } from 'react'
import { H10Select } from '../../../../campaigns/FilterDropdown'
import { getEbayAds, actionSummary, type ActionRow } from '../../../_lib'

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
    <div className="h10-am-card eb-rowlist" style={{ maxWidth: 1080 }}>
      <div className="eb-rowlist-bar">
        <p>Every write Nexus made to this campaign — immutable. Drift repairs and accepted eBay-side changes appear here too.</p>
        <H10Select ariaLabel="Action type" width={180} value={typeFilter} onChange={setTypeFilter}
          options={[{ value: 'all', label: 'All actions' }, ...types.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))]} />
        <H10Select ariaLabel="Mode" width={130} value={modeFilter} onChange={setModeFilter}
          options={[{ value: 'all', label: 'All modes' }, { value: 'live', label: 'live' }, { value: 'sandbox', label: 'sandbox' }, { value: 'local', label: 'local' }]} />
      </div>
      {rows == null ? (
        <div className="h10-cd-skel" aria-busy="true"><div className="sk-line w40" /><div className="sk-block" /></div>
      ) : visible.length === 0 ? (
        <div className="h10-cd-empty"><h3>No Nexus writes yet</h3><p>This campaign has only been synced (Seller Hub-managed or read-only so far).</p></div>
      ) : (
        <>
          {visible.map((a) => {
            const mode = String((a.payloadAfter as { _mode?: string } | null)?._mode ?? '')
            return (
              <div key={a.id} className="eb-row">
                <span className="dim eb-ts-col">{new Date(a.createdAt).toLocaleString('en-GB')}</span>
                <span className="h10-pill arch">{a.actionType.replace(/_/g, ' ')}</span>
                {mode && <span className={`h10-pill ${mode === 'live' ? 'ok' : 'warn'}`}>{mode}</span>}
                <span className={`h10-pill ${a.channelResponseStatus === 'SUCCESS' ? 'ok' : 'warn'}`}>{a.channelResponseStatus.toLowerCase()}</span>
                <span>{actionSummary(a)}</span>
              </div>
            )
          })}
          {more && (
            <div className="eb-rowlist-foot">
              <button type="button" className="h10-am-btn sm" disabled={busy} onClick={() => load(rows[rows.length - 1]?.createdAt)}>{busy ? 'Loading…' : 'Load older'}</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
