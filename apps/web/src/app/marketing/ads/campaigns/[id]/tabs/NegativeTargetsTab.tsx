'use client'

/**
 * CBN.3 — Campaign Negative Targets tab on the shared <AdsDataGrid> (H10 match). Columns:
 * Target · Status · Match Type · Date Added. Toolbar: "Edit Negative Targets" (editMode →
 * Status via PATCH /advertising/ad-targets/:id) · "+ Negative Targets" (opens the
 * AddNegativeKeywordsModal) · Customize. Data: GET /advertising/targets?campaignId=<internal>
 * &negative=1, filtered to isNegative===true (deploy-safe vs an API predating the flag).
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { AdsDataGrid, type GridColumn, type GridEditMode } from '../../_grid/AdsDataGrid'
import { STATUS_PILL } from '../../_grid/format'
import { H10Select, StatusOptions, AD_STATUS_OPTS } from '../../FilterDropdown'
import { bulkPatch } from '../../_grid/bulkActions'
import { AddNegativeKeywordsModal } from './AddNegativeKeywordsModal'
import type { CampaignDetailData } from '../CampaignDetail'

interface NegRow { id: string; text: string; matchType: string; status: string; createdAt?: string | null }
const titleCase = (s?: string | null) => (s ? s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—')
const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

export function NegativeTargetsTab({ campaign }: { campaign: CampaignDetailData | null }) {
  const cid = campaign?.id ?? null
  const [rows, setRows] = useState<NegRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [bump, setBump] = useState(0)
  const badge = (campaign?.targetingType ?? '').toUpperCase().includes('AUTO') ? 'A' : 'M'

  useEffect(() => {
    if (!cid) { setLoading(false); setRows([]); return }
    let cancel = false; setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/targets?campaignId=${cid}&negative=1&limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (cancel) return
        const raw = (d.rows ?? []) as Array<{ id: string; text: string; matchType: string; status: string; isNegative?: boolean; createdAt?: string | null }>
        setRows(raw.filter((r) => r.isNegative === true).map((r) => ({ id: r.id, text: r.text, matchType: r.matchType, status: r.status, createdAt: r.createdAt })))
      })
      .catch(() => { if (!cancel) setRows([]) })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [cid, bump])

  const columns: GridColumn<NegRow>[] = useMemo(() => [
    { key: 'status', label: 'Status', metric: false, sortable: false, render: (r) => { const sp = STATUS_PILL[r.status] ?? { label: titleCase(r.status), cls: '' }; return <span className={`h10-pill ${sp.cls}`}>{sp.label}</span> }, total: '' },
    { key: 'matchType', label: 'Match Type', metric: false, sortable: true, render: (r) => titleCase(r.matchType), sortValue: (r) => titleCase(r.matchType), total: '' },
    { key: 'dateAdded', label: 'Date Added', metric: false, sortable: true, render: (r) => fmtDate(r.createdAt), sortValue: (r) => (r.createdAt ? Date.parse(r.createdAt) : 0), total: '' },
  ], [])

  const editMode = useMemo<GridEditMode<NegRow>>(() => ({
    label: 'Edit Negative Targets',
    fields: [
      { key: 'status', initial: (r) => r.status, render: (v, set) => <H10Select width="100%" value={v} onChange={set} options={AD_STATUS_OPTS} ariaLabel="Status" />, renderPopover: (v, set) => <StatusOptions value={v} onChange={set} /> },
    ],
    onApply: async (edits) => {
      await Promise.all(edits.filter((e) => e.values.status).map((e) =>
        fetch(`${getBackendUrl()}/api/advertising/ad-targets/${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: e.values.status, applyImmediately: false, reason: 'Edit Negative Targets' }) })))
      setBump((b) => b + 1)
    },
  }), [])

  // Bulk actions (shown when negatives are selected): Enable/Archive/Pause (no bid on negatives).
  const [bulkBusy, setBulkBusy] = useState(false)
  const patchEach = async (ids: string[], body: Record<string, unknown>, clear: () => void) => {
    if (bulkBusy) return
    setBulkBusy(true)
    try { await bulkPatch('ad-targets', ids, body); clear(); setBump((b) => b + 1) } finally { setBulkBusy(false) }
  }

  return (
    <>
      <AdsDataGrid<NegRow>
        rows={rows}
        loading={loading}
        rowId={(r) => r.id}
        noun="Target"
        firstColLabel="Target"
        renderFirst={(r) => <div className="nmw"><span className="t" title={r.text}>{r.text}</span></div>}
        firstSortValue={(r) => r.text.toLowerCase()}
        columns={columns}
        editMode={editMode}
        selectionActions={(ids, clear) => (
          <span className="h10-bulkrow">
            <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'ENABLED', reason: 'Bulk enable' }, clear)}>Enable</button>
            <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'ARCHIVED', reason: 'Bulk archive' }, clear)}>Archive</button>
            <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'PAUSED', reason: 'Bulk pause' }, clear)}>Pause</button>
          </span>
        )}
        toolbarRight={<button type="button" className="h10-am-btn primary" onClick={() => setShowAdd(true)}><Plus size={13} /> Negative Targets</button>}
        emptyLabel="No negative targets on this campaign."
      />
      {showAdd && (
        <AddNegativeKeywordsModal
          campaignName={campaign?.name ?? 'Campaign'}
          badge={badge}
          externalCampaignId={campaign?.externalCampaignId ?? null}
          marketplace={campaign?.marketplace ?? null}
          onClose={() => setShowAdd(false)}
          onDone={() => setBump((b) => b + 1)}
        />
      )}
    </>
  )
}
