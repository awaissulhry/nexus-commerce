'use client'

/**
 * CBN.3 — Campaign Negative Targets tab on the shared <AdsDataGrid> (H10 match). Columns:
 * Target · Status · Match Type · Date Added. Toolbar: "Edit Negative Targets" (editMode →
 * Status via PATCH /advertising/ad-targets/:id) · "+ Negative Targets" (opens the
 * AddNegativeKeywordsModal) · Customize. Data: GET /advertising/targets?campaignId=<internal>
 * &negative=1, filtered to isNegative===true (deploy-safe vs an API predating the flag).
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Pill } from '@/design-system/primitives'
import { Plus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { adsWriteMany, eachSummary, NOT_ON_AMAZON_TIP, SEND_NOW } from '../../../_shared/adsWrite'
import { AdsDataGrid, type GridColumn, type GridEditMode } from '../../_grid/AdsDataGrid'
import { STATUS_PILL } from '../../_grid/format'
import { StatusOptions, AD_STATUS_OPTS } from '../../FilterDropdown'
import { bulkPatch } from '../../_grid/bulkActions'
import { AddNegativeKeywordsModal } from './AddNegativeKeywordsModal'
import type { CampaignDetailData } from '../CampaignDetail'
import { pillTone } from '../../../_shared/pillTone'
import { Listbox, useToast } from '@/design-system/components'

interface NegRow { id: string; text: string; matchType: string; status: string; createdAt?: string | null; onAmazon: boolean }
const titleCase = (s?: string | null) => (s ? s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—')
const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

export function NegativeTargetsTab({ campaign }: { campaign: CampaignDetailData | null }) {
  const cid = campaign?.id ?? null
  const [rows, setRows] = useState<NegRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [bump, setBump] = useState(0)
  // CM-11 — every write's answer is read and shown, with the server's reason for what did not change.
  const { toast } = useToast()
  const report = useMemo(() => (res: Awaited<ReturnType<typeof adsWriteMany>>) => {
    const s = eachSummary(res, 'negative')
    toast(s.text, s.tone, { duration: res.failed.length ? 9000 : 4000 })
  }, [toast])
  const badge = (campaign?.targetingType ?? '').toUpperCase().includes('AUTO') ? 'A' : 'M'

  useEffect(() => {
    if (!cid) { setLoading(false); setRows([]); return }
    let cancel = false; setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/targets?campaignId=${cid}&negative=1&limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (cancel) return
        const raw = (d.rows ?? []) as Array<{ id: string; text: string; matchType: string; status: string; isNegative?: boolean; createdAt?: string | null; externalTargetId?: string | null }>
        // An API without the field (older deploy) reads as on Amazon, as before.
        setRows(raw.filter((r) => r.isNegative === true).map((r) => ({ id: r.id, text: r.text, matchType: r.matchType, status: r.status, createdAt: r.createdAt, onAmazon: r.externalTargetId !== null })))
      })
      .catch(() => { if (!cancel) setRows([]) })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [cid, bump])

  const columns: GridColumn<NegRow>[] = useMemo(() => [
    { key: 'status', label: 'Status', metric: false, sortable: false, render: (r) => { if (!r.onAmazon) return <Pill tone="warning" title={NOT_ON_AMAZON_TIP}>Not on Amazon</Pill>; const sp = STATUS_PILL[r.status] ?? { label: titleCase(r.status), cls: '' }; return <Pill tone={pillTone(sp.cls)}>{sp.label}</Pill> }, total: '' },
    { key: 'matchType', label: 'Match Type', metric: false, sortable: true, render: (r) => titleCase(r.matchType), sortValue: (r) => titleCase(r.matchType), total: '' },
    { key: 'dateAdded', label: 'Date Added', metric: false, sortable: true, render: (r) => fmtDate(r.createdAt), sortValue: (r) => (r.createdAt ? Date.parse(r.createdAt) : 0), total: '' },
  ], [])

  const editMode = useMemo<GridEditMode<NegRow>>(() => ({
    label: 'Edit Negative Targets',
    fields: [
      { key: 'status', initial: (r) => r.status, render: (v, set) => <Listbox width="100%" value={v} onChange={set} options={AD_STATUS_OPTS} ariaLabel="Status" />, renderPopover: (v, set) => <StatusOptions value={v} onChange={set} /> },
    ],
    onApply: async (edits) => {
      const res = await adsWriteMany(edits.filter((e) => e.values.status).map((e) =>
        ({ id: e.id, path: `/api/advertising/ad-targets/${e.id}`, body: { status: e.values.status, ...SEND_NOW, reason: 'Edit Negative Targets' } })))
      setBump((b) => b + 1)
      report(res)
    },
  }), [report])

  // Bulk actions (shown when negatives are selected): Enable/Archive/Pause (no bid on negatives).
  const [bulkBusy, setBulkBusy] = useState(false)
  const patchEach = async (ids: string[], body: Record<string, unknown>, clear: () => void) => {
    if (bulkBusy) return
    setBulkBusy(true)
    try { const res = await bulkPatch('ad-targets', ids, body); clear(); setBump((b) => b + 1); report(res) } finally { setBulkBusy(false) }
  }

  return (
    <>
      <AdsDataGrid<NegRow>
        rows={rows}
        loading={loading}
        rowId={(r) => r.id}
        enabledFirst={(r) => r.status}
        noun="Target"
        firstColLabel="Target"
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
    toolbarRight={<Button variant="primary" onClick={() => setShowAdd(true)}><Plus size={13} /> Negative Targets</Button>}
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
