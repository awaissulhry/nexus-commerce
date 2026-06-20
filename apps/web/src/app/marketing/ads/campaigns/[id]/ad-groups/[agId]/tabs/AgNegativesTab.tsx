'use client'

/**
 * Ad Group Negative Targets / Negative Keywords tabs — one shared component (mode-switched)
 * on the shared <AdsDataGrid>, matching the campaign Negative Targets tab. Rows come straight
 * from adGroup.targets[] filtered to isNegative === true and split by kind (KEYWORD →
 * Negative Keywords; PRODUCT/CATEGORY → Negative Targets). Columns: Status · Match Type ·
 * Date Added. Edit + bulk Enable/Archive/Pause via PATCH /advertising/ad-targets/:id.
 * (The "+ Negative" creation flow is ad-group-scoped follow-up; the grid + edit ship now.)
 */
import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { AdsDataGrid, type GridColumn, type GridEditMode } from '../../../../_grid/AdsDataGrid'
import { STATUS_PILL } from '../../../../_grid/format'
import { H10Select, StatusOptions, AD_STATUS_OPTS } from '../../../../FilterDropdown'
import { bulkPatch } from '../../../../_grid/bulkActions'
import { AddNegativeTargetsModal } from './AddNegativeTargetsModal'
import { AddNegativeKeywordsAgModal } from './AddNegativeKeywordsAgModal'
import type { AdGroupDetailData } from '../AdGroupDetail'

interface NegT { id: string; expressionValue: string; expressionType?: string | null; kind?: string | null; status: string; isNegative?: boolean; createdAt?: string | null }
interface NegRow { id: string; text: string; matchType: string; status: string; createdAt?: string | null }
const titleCase = (s?: string | null) => (s ? s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—')
const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

export function AgNegativesTab({ adGroup, onRefresh, mode }: { adGroup: AdGroupDetailData | null; onRefresh?: () => void; mode: 'targets' | 'keywords' }) {
  const rows = useMemo<NegRow[]>(() => {
    const all = (adGroup?.targets as NegT[] | undefined) ?? []
    return all
      .filter((t) => t.isNegative === true && (mode === 'keywords' ? t.kind === 'KEYWORD' : t.kind !== 'KEYWORD'))
      .map((t) => ({ id: t.id, text: t.expressionValue, matchType: t.expressionType ?? '', status: t.status, createdAt: t.createdAt }))
  }, [adGroup, mode])
  const noun = mode === 'keywords' ? 'Keyword' : 'Target'
  const [bulkBusy, setBulkBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)

  const columns: GridColumn<NegRow>[] = useMemo(() => [
    { key: 'status', label: 'Status', metric: false, sortable: false, render: (r) => { const sp = STATUS_PILL[r.status] ?? { label: titleCase(r.status), cls: '' }; return <span className={`h10-pill ${sp.cls}`}>{sp.label}</span> }, total: '' },
    { key: 'matchType', label: 'Match Type', metric: false, sortable: true, render: (r) => titleCase(r.matchType), sortValue: (r) => titleCase(r.matchType), total: '' },
    { key: 'dateAdded', label: 'Date Added', metric: false, sortable: true, render: (r) => fmtDate(r.createdAt), sortValue: (r) => (r.createdAt ? Date.parse(r.createdAt) : 0), total: '' },
  ], [])

  const editMode = useMemo<GridEditMode<NegRow>>(() => ({
    label: `Edit Negative ${noun}s`,
    fields: [
      { key: 'status', initial: (r) => r.status, render: (v, set) => <H10Select width="100%" value={v} onChange={set} options={AD_STATUS_OPTS} ariaLabel="Status" />, renderPopover: (v, set) => <StatusOptions value={v} onChange={set} /> },
    ],
    onApply: async (edits) => {
      await Promise.all(edits.filter((e) => e.values.status).map((e) =>
        fetch(`${getBackendUrl()}/api/advertising/ad-targets/${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: e.values.status, applyImmediately: false, reason: `Edit Negative ${noun}s` }) })))
      onRefresh?.()
    },
  }), [noun, onRefresh])

  const patchEach = async (ids: string[], body: Record<string, unknown>, clear: () => void) => {
    if (bulkBusy) return
    setBulkBusy(true)
    try { await bulkPatch('ad-targets', ids, body); clear(); onRefresh?.() } finally { setBulkBusy(false) }
  }

  return (
    <>
    <AdsDataGrid<NegRow>
      rows={rows}
      rowId={(r) => r.id}
      noun={noun}
      firstColLabel={noun}
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
      toolbarRight={<button type="button" className="h10-am-btn primary" onClick={() => setShowAdd(true)}><Plus size={13} /> {mode === 'targets' ? 'Negative Targets' : 'Negative Keywords'}</button>}
      emptyLabel={`No negative ${mode === 'keywords' ? 'keywords' : 'targets'} on this ad group.`}
    />
    {showAdd && mode === 'targets' && adGroup && <AddNegativeTargetsModal adGroupId={adGroup.id} adGroupName={adGroup.name} campaignName={adGroup.campaign?.name ?? ''} onClose={() => setShowAdd(false)} onAdded={() => onRefresh?.()} />}
    {showAdd && mode === 'keywords' && adGroup && <AddNegativeKeywordsAgModal externalCampaignId={adGroup.campaign?.externalCampaignId ?? null} externalAdGroupId={adGroup.externalAdGroupId ?? null} marketplace={adGroup.campaign?.marketplace ?? null} campaignName={adGroup.campaign?.name ?? ''} adGroupName={adGroup.name} onClose={() => setShowAdd(false)} onAdded={() => onRefresh?.()} />}
    </>
  )
}
