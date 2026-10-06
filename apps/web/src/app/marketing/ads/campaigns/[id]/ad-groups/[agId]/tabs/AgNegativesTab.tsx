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
import { Button, Pill } from '@/design-system/primitives'
import { Plus } from 'lucide-react'
import { adsWriteMany, eachSummary, NOT_ON_AMAZON_TIP, type EachResult, SEND_NOW } from '../../../../../_shared/adsWrite'
import { AdsDataGrid, type GridColumn, type GridEditMode } from '../../../../_grid/AdsDataGrid'
import { STATUS_PILL } from '../../../../_grid/format'
import { StatusOptions, AD_STATUS_OPTS } from '../../../../FilterDropdown'
import { bulkPatch } from '../../../../_grid/bulkActions'
import { AddNegativeTargetsModal } from './AddNegativeTargetsModal'
import { AddNegativeKeywordsAgModal } from './AddNegativeKeywordsAgModal'
import type { AdGroupDetailData } from '../AdGroupDetail'
import { pillTone } from '../../../../../_shared/pillTone'
import { Listbox, useToast } from '@/design-system/components'

interface NegT { id: string; expressionValue: string; expressionType?: string | null; kind?: string | null; status: string; isNegative?: boolean; createdAt?: string | null; externalTargetId?: string | null }
interface NegRow { id: string; text: string; matchType: string; status: string; createdAt?: string | null; onAmazon: boolean }
const titleCase = (s?: string | null) => (s ? s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—')
const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

export function AgNegativesTab({ adGroup, onRefresh, mode }: { adGroup: AdGroupDetailData | null; onRefresh?: () => void; mode: 'targets' | 'keywords' }) {
  const rows = useMemo<NegRow[]>(() => {
    const all = (adGroup?.targets as NegT[] | undefined) ?? []
    return all
      .filter((t) => t.isNegative === true && (mode === 'keywords' ? t.kind === 'KEYWORD' : t.kind !== 'KEYWORD'))
      // CM-25 — null = Amazon never took it (a row without the field, from an older API, reads as on Amazon).
      .map((t) => ({ id: t.id, text: t.expressionValue, matchType: t.expressionType ?? '', status: t.status, createdAt: t.createdAt, onAmazon: t.externalTargetId !== null }))
  }, [adGroup, mode])
  const noun = mode === 'keywords' ? 'Keyword' : 'Target'
  const [bulkBusy, setBulkBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  // CM-11 — every write's answer is read and shown, with the server's reason for what did not change.
  const { toast } = useToast()
  const report = useMemo(() => (res: EachResult) => {
    const s = eachSummary(res, `negative ${noun.toLowerCase()}`)
    toast(s.text, s.tone, { duration: res.failed.length ? 9000 : 4000 })
  }, [toast, noun])

  const columns: GridColumn<NegRow>[] = useMemo(() => [
    { key: 'status', label: 'Status', metric: false, sortable: false, render: (r) => { if (!r.onAmazon) return <Pill tone="warning" title={NOT_ON_AMAZON_TIP}>Not on Amazon</Pill>; const sp = STATUS_PILL[r.status] ?? { label: titleCase(r.status), cls: '' }; return <Pill tone={pillTone(sp.cls)}>{sp.label}</Pill> }, total: '' },
    { key: 'matchType', label: 'Match Type', metric: false, sortable: true, render: (r) => titleCase(r.matchType), sortValue: (r) => titleCase(r.matchType), total: '' },
    { key: 'dateAdded', label: 'Date Added', metric: false, sortable: true, render: (r) => fmtDate(r.createdAt), sortValue: (r) => (r.createdAt ? Date.parse(r.createdAt) : 0), total: '' },
  ], [])

  const editMode = useMemo<GridEditMode<NegRow>>(() => ({
    label: `Edit Negative ${noun}s`,
    fields: [
      { key: 'status', initial: (r) => r.status, render: (v, set) => <Listbox width="100%" value={v} onChange={set} options={AD_STATUS_OPTS} ariaLabel="Status" />, renderPopover: (v, set) => <StatusOptions value={v} onChange={set} /> },
    ],
    onApply: async (edits) => {
      const res = await adsWriteMany(edits.filter((e) => e.values.status).map((e) =>
        ({ id: e.id, path: `/api/advertising/ad-targets/${e.id}`, body: { status: e.values.status, ...SEND_NOW, reason: `Edit Negative ${noun}s` } })))
      onRefresh?.()
      report(res)
    },
  }), [noun, onRefresh, report])

  const patchEach = async (ids: string[], body: Record<string, unknown>, clear: () => void) => {
    if (bulkBusy) return
    setBulkBusy(true)
    try { const res = await bulkPatch('ad-targets', ids, body); clear(); onRefresh?.(); report(res) } finally { setBulkBusy(false) }
  }

  return (
    <>
    <AdsDataGrid<NegRow>
      rows={rows}
      rowId={(r) => r.id}
      enabledFirst={(r) => r.status}
      noun={noun}
      firstColLabel={noun}
      renderFirst={(r) => <div className="nmw"><span className="t" title={r.text}>{r.text}</span></div>}
      firstSortValue={(r) => r.text.toLowerCase()}
      columns={columns}
      editMode={editMode}
      selectionActions={(ids, clear) => (
        <span className="h10-bulkrow">
          <Button variant="ghost" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'ENABLED', reason: 'Bulk enable' }, clear)}>Enable</Button>
          <Button variant="ghost" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'ARCHIVED', reason: 'Bulk archive' }, clear)}>Archive</Button>
          <Button variant="ghost" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'PAUSED', reason: 'Bulk pause' }, clear)}>Pause</Button>
        </span>
      )}
   toolbarRight={<Button variant="primary" onClick={() => setShowAdd(true)}><Plus size={13} /> {mode === 'targets' ? 'Negative Targets' : 'Negative Keywords'}</Button>}
      emptyLabel={`No negative ${mode === 'keywords' ? 'keywords' : 'targets'} on this ad group.`}
    />
    {showAdd && mode === 'targets' && adGroup && <AddNegativeTargetsModal adGroupId={adGroup.id} adGroupName={adGroup.name} campaignName={adGroup.campaign?.name ?? ''} onClose={() => setShowAdd(false)} onAdded={() => onRefresh?.()} />}
    {showAdd && mode === 'keywords' && adGroup && <AddNegativeKeywordsAgModal externalCampaignId={adGroup.campaign?.externalCampaignId ?? null} externalAdGroupId={adGroup.externalAdGroupId ?? null} marketplace={adGroup.campaign?.marketplace ?? null} campaignName={adGroup.campaign?.name ?? ''} adGroupName={adGroup.name} onClose={() => setShowAdd(false)} onAdded={() => onRefresh?.()} />}
    </>
  )
}
