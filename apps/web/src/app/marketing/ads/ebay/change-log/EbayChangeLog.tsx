'use client'

/**
 * ER3.4 (D4, deltas 8–10) — the account-wide Change Log: every write Nexus
 * made to eBay, immutable, filterable by Change Type AND Change Source (the
 * H10 idiom) — automation / operator / external-accepted, derived from
 * recorded actors, never guessed. Campaign deep links; cursor pagination.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import '../ebay.css'
import { getEbayAds, actionSummary, SOURCE_LABELS, type ActionRow } from '../_lib'

const PAGE = 200

export function EbayChangeLog() {
  const [rows, setRows] = useState<ActionRow[] | null>(null)
  const [more, setMore] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((before?: string) => {
    setBusy(true)
    getEbayAds<{ actions: ActionRow[] }>(`/actions?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`)
      .then((j) => {
        setRows((prev) => (before ? [...(prev ?? []), ...j.actions] : j.actions))
        setMore(j.actions.length === PAGE)
        setError(null)
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false))
  }, [])
  useEffect(() => { load() }, [load])

  const all = useMemo(() => rows ?? [], [rows])

  const columns: GridColumn<ActionRow>[] = useMemo(() => [
    {
      key: 'source', label: 'Source', metric: false, sortValue: (a) => a.source ?? '',
      render: (a) => { const s = SOURCE_LABELS[a.source ?? 'operator'] ?? SOURCE_LABELS.operator; return <span className={`h10-pill ${s.cls}`} title={s.tip}>{s.label}</span> },
    },
    { key: 'action', label: 'Action', metric: false, sortValue: (a) => a.actionType, render: (a) => <span className="h10-pill arch">{a.actionType.replace(/_/g, ' ')}</span> },
    { key: 'change', label: 'Change', metric: false, sortable: false, render: (a) => <span className="eb-cl-change" title={actionSummary(a)}>{actionSummary(a) || '—'}</span> },
    {
      key: 'result', label: 'Result', metric: false, sortValue: (a) => a.channelResponseStatus,
      render: (a) => {
        const mode = String((a.payloadAfter as { _mode?: string } | null)?._mode ?? '')
        return (
          <span className="eb-cl-result">
            <span className={`h10-pill ${a.channelResponseStatus === 'SUCCESS' ? 'ok' : 'warn'}`}>{a.channelResponseStatus.toLowerCase()}</span>
            {mode && mode !== 'accept' && <span className={`h10-pill ${mode === 'live' ? 'ok' : 'arch'}`}>{mode}</span>}
            {a.rolledBackAt && <span className="h10-pill warn" title={`Rolled back ${new Date(a.rolledBackAt).toLocaleString('en-GB')}`}>rolled back</span>}
          </span>
        )
      },
    },
  ], [])

  const filters: GridFilter[] = useMemo(() => [
    {
      key: 'source', label: 'Change source', kind: 'select',
      options: [{ value: 'automation', label: 'Automation' }, { value: 'operator', label: 'Operator' }, { value: 'external_accepted', label: 'External (accepted)' }],
      placeholder: 'All sources', value: (a) => (a as ActionRow).source ?? 'operator',
    },
    {
      key: 'type', label: 'Change type', kind: 'select',
      options: [...new Set(all.map((a) => a.actionType))].sort().map((t) => ({ value: t, label: t.replace(/_/g, ' ') })),
      placeholder: 'All types', value: (a) => (a as ActionRow).actionType,
    },
  ], [all])

  return (
    <div className="h10-am eb-changelog">
      <AdsPageHeader
        channel="ebay"
        title="eBay Change Log"
        subtitle="Every write Nexus made to eBay — immutable, account-wide. Automation, operator and accepted external changes, each traceable to its actor."
        markets={['EBAY_IT']} market="EBAY_IT" onMarketChange={() => {}}
        showLearn={false} showDataSync={false} showDateRange={false}
      />
      {error && <div className="h10-am-latest" role="alert"><b>Load failed:</b> {error} · <button className="h10-am-link" onClick={() => load()}>Retry</button></div>}

      <AdsDataGrid<ActionRow>
        rows={all}
        loading={rows == null}
        rowId={(a) => a.id}
        noun="Change"
        selectable={false}
        firstColLabel="When · Target"
        renderFirst={(a) => (
          <div className="nmw">
            <span className="t">{new Date(a.createdAt).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            {a.campaignId
              ? <Link className="mk h10-am-link" href={`/marketing/ads/ebay/campaigns/${a.campaignId}`} title={a.campaignName ?? undefined}>{a.campaignName ?? '—'}</Link>
              : <span className="mk">{a.campaignName ?? 'account'}</span>}
          </div>
        )}
        firstSortValue={(a) => a.createdAt}
        columns={columns}
        filters={filters}
        filtersDefaultOpen={false}
        searchable
        searchPlaceholder="Search actions / campaigns…"
        searchValue={(a) => `${a.actionType} ${a.campaignName ?? ''} ${actionSummary(a)}`}
        defaultSort={{ key: '__first', dir: 'desc' }}
        storageKey="h10-ebay-changelog-cols"
        reportLabel={all[0] ? `Newest change: ${new Date(all[0].createdAt).toLocaleString('en-GB')}` : undefined}
        emptyLabel="No writes recorded yet — campaign actions, rule applies and drift decisions land here."
      />
      {more && all.length > 0 && (
        <div style={{ padding: '10px 2px' }}>
          <button type="button" className="h10-am-btn sm" disabled={busy} onClick={() => load(all[all.length - 1]?.createdAt)}>{busy ? 'Loading…' : 'Load older'}</button>
        </div>
      )}
    </div>
  )
}
