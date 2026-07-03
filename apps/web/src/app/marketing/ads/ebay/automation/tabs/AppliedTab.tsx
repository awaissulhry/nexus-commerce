'use client'

/**
 * ER3.2 (delta 7) — Applied as a real grid: timestamps, rule, target link,
 * change, result detail, actor, one-click rollback. Fixes the critique's
 * no-dates/no-pagination finding; the grid's pager and sort are built-in.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AdsDataGrid, type GridColumn } from '../../../campaigns/_grid/AdsDataGrid'
import { getEbayAds, postEbayAds } from '../../_lib'
import { kindLabel } from '../_lib/rules'
import type { SuggestionRow } from './SuggestionsTab'

interface AppliedRow extends SuggestionRow {
  decidedBy: string | null; decidedAt: string | null
  appliedResult: { detail?: string } | null
}

export function AppliedTab({ busy, act, bump }: { busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void>; bump: number }) {
  const [rows, setRows] = useState<AppliedRow[]>([])
  const [ruleNames, setRuleNames] = useState<Map<string, string>>(new Map())

  const reload = useCallback(async () => {
    const [p, r] = await Promise.all([
      getEbayAds<{ proposals: AppliedRow[] }>('/automation/proposals?status=APPLIED'),
      getEbayAds<{ rules: Array<{ id: string; name: string }> }>('/automation/rules'),
    ])
    setRows(p.proposals); setRuleNames(new Map(r.rules.map((x) => [x.id, x.name])))
  }, [])
  useEffect(() => { reload().catch(() => {}) }, [reload, bump])

  const columns: GridColumn<AppliedRow>[] = useMemo(() => [
    { key: 'when', label: 'When', metric: false, sortValue: (p) => p.decidedAt ?? p.createdAt, render: (p) => new Date(p.decidedAt ?? p.createdAt).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) },
    { key: 'kind', label: 'Change', metric: false, sortValue: (p) => p.kind, render: (p) => <span className="h10-pill ok">{kindLabel(p.kind)}</span> },
    { key: 'delta', label: 'From → To', metric: false, sortable: false, render: (p) => <span>{String(p.proposedAction.from ?? '')} → <b>{String(p.proposedAction.to ?? '')}</b></span> },
    { key: 'rule', label: 'Rule', metric: false, sortValue: (p) => (p.ruleId ? ruleNames.get(p.ruleId) ?? '' : ''), render: (p) => <span className="eb-be-hint">{p.ruleId ? ruleNames.get(p.ruleId) ?? '—' : 'guard'}</span> },
    { key: 'result', label: 'Result', metric: false, sortable: false, render: (p) => <span className="eb-be-hint" title={p.appliedResult?.detail}>{p.appliedResult?.detail ?? '—'}</span> },
    { key: 'actor', label: 'Actor', metric: false, sortValue: (p) => p.decidedBy ?? '', render: (p) => <span className="eb-chip" title={p.decidedBy ?? undefined}>{p.decidedBy === 'automation:ebay-ads' ? 'autopilot' : 'operator'}</span> },
    {
      key: 'rb', label: '', metric: false, sortable: false, render: (p) => (
        <button type="button" className="h10-am-btn sm" disabled={busy} title="Push the recorded inverse back through the guarded write layer"
          onClick={() => void act(() => postEbayAds(`/automation/proposals/${p.id}/rollback`, {}), 'rolled back')}>
          Rollback
        </button>
      ),
    },
  ], [busy, act, ruleNames])

  return (
    <AdsDataGrid<AppliedRow>
      rows={rows}
      rowId={(p) => p.id}
      noun="Applied change"
      firstColLabel="Target"
      renderFirst={(p) => (
        <div className="nmw">
          {p.entityRef.campaignId
            ? <Link className="t h10-am-link" href={`/marketing/ads/ebay/campaigns/${p.entityRef.campaignId}`} title={p.entityRef.campaignName}>{p.entityRef.campaignName ?? '—'}</Link>
            : <span className="t">{p.entityRef.campaignName ?? '—'}</span>}
          <span className="mk">{p.entityRef.listingId ?? p.entityRef.keywordText ?? ''}</span>
        </div>
      )}
      firstSortValue={(p) => p.entityRef.campaignName ?? ''}
      columns={columns}
      storageKey="h10-ebay-applied-cols"
      emptyLabel="Nothing applied yet — AUTOPILOT rules (dial on Auto) and approved suggestions report here, each with one-click rollback."
    />
  )
}
