'use client'

/**
 * EV4b — Activity on the shared row-list skin + H10Select filters (zero
 * native controls): the immutable per-campaign event log (v1 semantics
 * preserved) with action-type/mode filters and cursor pagination.
 */
import { useCallback, useEffect, useState } from 'react'

import { getEbayAds, actionSummary, type ActionRow } from '../../../_lib'
import { Button, Pill } from '@/design-system/primitives'
import { pillTone } from '../../../../_shared/pillTone'
import { Listbox } from '@/design-system/components'

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
    <div className="nds-card h10-cardstack eb-rowlist" style={{ maxWidth: 1080 }}>
      <div className="eb-rowlist-bar">
        <p>Every write Nexus made to this campaign — immutable. Drift repairs and accepted eBay-side changes appear here too.</p>
        <span className="eb-dd dense"><Listbox ariaLabel="Action type" width={180} value={typeFilter} onChange={setTypeFilter}
          options={[{ value: 'all', label: 'All actions' }, ...types.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))]} /></span>
        <span className="eb-dd dense"><Listbox ariaLabel="Mode" width={130} value={modeFilter} onChange={setModeFilter}
          options={[{ value: 'all', label: 'All modes' }, { value: 'live', label: 'live' }, { value: 'sandbox', label: 'sandbox' }, { value: 'local', label: 'local' }]} /></span>
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
                <Pill tone="neutral">{a.actionType.replace(/_/g, ' ')}</Pill>
                {mode && <Pill tone={pillTone(mode === 'live' ? 'ok' : 'warn')}>{mode}</Pill>}
                <Pill tone={pillTone(a.channelResponseStatus === 'SUCCESS' ? 'ok' : 'warn')}>{a.channelResponseStatus.toLowerCase()}</Pill>
                <span>{actionSummary(a)}</span>
              </div>
            )
          })}
          {more && (
            <div className="eb-rowlist-foot">
              <Button size="sm" disabled={busy} onClick={() => load(rows[rows.length - 1]?.createdAt)}>{busy ? 'Loading…' : 'Load older'}</Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
