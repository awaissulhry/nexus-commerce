'use client'

/**
 * ER3.2 (delta 6) — the Suggestions queue on H10 idioms: kind chips with
 * counts, per-row Why (real reasoning), ✓ Apply, ✕ menu (Dismiss · Snooze 7d ·
 * 30d · Stop for this target), campaign deep links, bulk "Apply N changes".
 * Dismiss may re-suggest next run — stated, not hidden. Snooze/stop ride the
 * decide endpoint's snoozeDays.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../../campaigns/_grid/AdsDataGrid'
import { getEbayAds, postEbayAds } from '../../_lib'
import { kindLabel, type WhyReasoning } from '../_lib/rules'
import { WhyModal } from '../modals/WhyModal'

export interface SuggestionRow {
  id: string; kind: string; status: string; ruleId: string | null
  entityRef: { campaignId?: string; campaignName?: string; listingId?: string; keywordText?: string; marketplace?: string }
  proposedAction: { from?: unknown; to?: unknown }
  reasoning?: WhyReasoning | null
  // ER4 E3 — honest weekly extrapolation from the entity's own window facts
  estimatedImpact?: { feesDeltaCentsPerWeek?: number; salesAtRiskCentsPerWeek?: number; assumption: string } | null
  createdAt: string
}

function DecideMenu({ row, busy, onDecide }: { row: SuggestionRow; busy: boolean; onDecide: (ids: string[], decision: 'approve' | 'reject', snoozeDays?: number, label?: string) => void }) {
  const [open, setOpen] = useState(false)
  // fixed-position: the grid scroller clips absolute menus on the last row
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const toggle = () => {
    if (!open) {
      const r = ref.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 168) })
    }
    setOpen((o) => !o)
  }
  const pick = (snoozeDays: number | undefined, label: string) => { setOpen(false); onDecide([row.id], 'reject', snoozeDays, label) }
  return (
    <span className="eb-rule-menu" ref={ref}>
      <button type="button" className="h10-am-btn sm" disabled={busy} aria-label="Dismiss options" onClick={toggle}>✕ <ChevronDown size={11} /></button>
      {open && pos && (
        <span className="h10-statusmenu eb-statusfix" style={{ position: 'fixed', top: pos.top, left: pos.left }}>
          <button type="button" title="May re-suggest on the next evaluation if conditions still hold" onClick={() => pick(undefined, 'dismissed (may re-suggest)')}>Dismiss</button>
          <button type="button" onClick={() => pick(7, 'snoozed 7d')}>Snooze 7 days</button>
          <button type="button" onClick={() => pick(30, 'snoozed 30d')}>Snooze 30 days</button>
          <button type="button" className="danger" title="This kind of change for this exact target won't be suggested again" onClick={() => pick(3650, 'stopped for this target')}>Stop for this target</button>
        </span>
      )}
    </span>
  )
}

export function SuggestionsTab({ busy, act, bump, highlightId }: { busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void>; bump: number; highlightId?: string | null }) {
  const [rows, setRows] = useState<SuggestionRow[]>([])
  const [ruleNames, setRuleNames] = useState<Map<string, string>>(new Map())
  const [kind, setKind] = useState<string>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [why, setWhy] = useState<SuggestionRow | null>(null)
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    const [p, r] = await Promise.all([
      getEbayAds<{ proposals: SuggestionRow[] }>('/automation/proposals?status=PENDING'),
      getEbayAds<{ rules: Array<{ id: string; name: string }> }>('/automation/rules'),
    ])
    setRows(p.proposals); setRuleNames(new Map(r.rules.map((x) => [x.id, x.name])))
  }, [])
  useEffect(() => { reload().catch(() => {}).finally(() => setLoaded(true)) }, [reload, bump])
  // ER3.5 — digest deep link: scroll the highlighted suggestion into view
  useEffect(() => {
    if (!highlightId || !loaded) return
    const el = document.querySelector('.eb-hl-row')
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlightId, loaded, rows])
  const highlightMissing = !!highlightId && loaded && !rows.some((r) => r.id === highlightId)

  const kinds = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])
  const visible = useMemo(() => (kind === 'all' ? rows : rows.filter((r) => r.kind === kind)), [rows, kind])

  const decide = useCallback((ids: string[], decision: 'approve' | 'reject', snoozeDays?: number, label?: string) => {
    void act(async () => {
      await postEbayAds('/automation/proposals/decide', { ids, decision, ...(snoozeDays ? { snoozeDays } : {}) })
      setSelected(new Set())
    }, label ?? (decision === 'approve' ? `applied ${ids.length} change${ids.length === 1 ? '' : 's'}` : 'dismissed'))
  }, [act])

  const columns: GridColumn<SuggestionRow>[] = useMemo(() => [
    { key: 'kind', label: 'Suggestion', metric: false, sortValue: (p) => p.kind, render: (p) => <span className="h10-pill ok">{kindLabel(p.kind)}</span> },
    { key: 'change', label: 'Change', metric: false, sortable: false, render: (p) => <span>{String(p.proposedAction.from ?? '')} → <b>{String(p.proposedAction.to ?? '')}</b></span> },
    { key: 'rule', label: 'Rule', metric: false, sortValue: (p) => (p.ruleId ? ruleNames.get(p.ruleId) ?? '' : ''), render: (p) => <span className="eb-be-hint">{p.ruleId ? ruleNames.get(p.ruleId) ?? '—' : 'guard'}</span> },
    { key: 'guard', label: 'Guardrail', metric: false, sortable: false, render: (p) => p.reasoning?.clampNote ? <span className="h10-pill warn">{p.reasoning.clampNote}</span> : <span className="h10-pill ok">within break-even</span> },
    {
      key: 'impact', label: 'Est. / wk', metric: false, sortValue: (p) => p.estimatedImpact?.feesDeltaCentsPerWeek ?? 0,
      tip: 'Linear extrapolation of the entity\'s own window facts — hover a value for the exact assumption. Blank = no defensible model for this kind.',
      render: (p) => {
        const ei = p.estimatedImpact
        if (!ei) return <span style={{ color: '#8a93a1' }}>—</span>
        return (
          <span className="eb-impact" title={ei.assumption}>
            {ei.feesDeltaCentsPerWeek != null && (
              <span className={ei.feesDeltaCentsPerWeek <= 0 ? 'good' : 'bad'}>
                {ei.feesDeltaCentsPerWeek <= 0 ? '−' : '+'}€{(Math.abs(ei.feesDeltaCentsPerWeek) / 100).toFixed(2)} fees
              </span>
            )}
            {ei.salesAtRiskCentsPerWeek != null && ei.salesAtRiskCentsPerWeek > 0 && (
              <span className="risk">€{(ei.salesAtRiskCentsPerWeek / 100).toFixed(2)} sales at risk</span>
            )}
          </span>
        )
      },
    },
    { key: 'why', label: 'Why', metric: false, sortable: false, render: (p) => <button type="button" className="h10-am-link" onClick={() => setWhy(p)}>Why…</button> },
    { key: 'age', label: 'Proposed', metric: false, sortValue: (p) => p.createdAt, render: (p) => new Date(p.createdAt).toLocaleDateString('en-GB') },
    {
      key: 'decide', label: '', metric: false, sortable: false, render: (p) => (
        <span className="eb-decide-cell">
          <button type="button" className="h10-am-btn sm primary" disabled={busy} title="Apply through the guarded write layer" onClick={() => decide([p.id], 'approve')}>✓ Apply</button>
          <DecideMenu row={p} busy={busy} onDecide={decide} />
        </span>
      ),
    },
  ], [busy, decide, ruleNames])

  return (
    <>
      {highlightMissing && (
        <p className="eb-be-hint" role="status" style={{ margin: '0 0 8px' }}>
          The suggestion from your digest was already decided — see the <b>Applied</b> tab or the Change Log.
        </p>
      )}
      <div className="eb-kind-chips" role="tablist" aria-label="Suggestion kinds">
        <button type="button" role="tab" aria-selected={kind === 'all'} className={`eb-kind-chip ${kind === 'all' ? 'on' : ''}`} onClick={() => setKind('all')}>All · {rows.length}</button>
        {kinds.map(([k, n]) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={`eb-kind-chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{kindLabel(k)} · {n}</button>
        ))}
      </div>
      <AdsDataGrid<SuggestionRow>
        rows={visible}
        rowId={(p) => p.id}
        noun="Suggestion"
        firstColLabel="Target"
        renderFirst={(p) => (
          <div className="nmw">
            {p.entityRef.campaignId
              ? <Link className="t h10-am-link" href={`/marketing/ads/ebay/campaigns/${p.entityRef.campaignId}`} title={p.entityRef.campaignName}>{p.entityRef.campaignName ?? '—'}</Link>
              : <span className="t" title={p.entityRef.campaignName}>{p.entityRef.campaignName ?? '—'}</span>}
            <span className="mk">{p.entityRef.listingId ?? p.entityRef.keywordText ?? ''}</span>
          </div>
        )}
        firstSortValue={(p) => p.entityRef.campaignName ?? ''}
        columns={columns}
        selected={selected}
        onSelectedChange={setSelected}
        selectionActions={(ids, clear) => (
          <span className="h10-bulkrow">
            <button type="button" className="h10-am-btn bulk" disabled={busy} onClick={() => { decide(ids, 'approve'); clear() }}>Apply {ids.length} change{ids.length === 1 ? '' : 's'}</button>
            <button type="button" className="h10-am-btn bulk" disabled={busy} onClick={() => { decide(ids, 'reject', undefined, `dismissed ${ids.length}`); clear() }}>Dismiss {ids.length}</button>
          </span>
        )}
        storageKey="h10-ebay-suggestions-cols"
        rowClassName={(p2) => (highlightId && p2.id === highlightId ? 'eb-hl-row' : undefined)}
        emptyLabel="Nothing awaiting review — suggestions appear after the daily evaluation (or Evaluate now)."
      />
      <WhyModal open={why != null} onClose={() => setWhy(null)}
        title={why ? `${kindLabel(why.kind)} — ${why.entityRef.campaignName ?? ''} ${why.entityRef.listingId ?? why.entityRef.keywordText ?? ''}` : ''}
        reasoning={why?.reasoning ?? null}
        ruleName={why?.ruleId ? ruleNames.get(why.ruleId) ?? null : 'engine guard'}
        campaignId={why?.entityRef.campaignId}
        estimatedImpact={why?.estimatedImpact} />
    </>
  )
}
