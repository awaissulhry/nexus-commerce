'use client'

/**
 * RuleListTab — the shared rules-grid body used by every rule sub-tab (Negative Targeting ·
 * Bid · Keyword Harvest · Budget · Dayparting · Budget Schedules · Placement · …). Renders
 * through the ONE shared AdsDataGrid with:
 *   • per-row hover pencils on Criteria + Frequency, and a row-hover "Open" link
 *   • multi-select bulk toolbar (Automation · Criteria · Frequency · Delete) → bulk-edit dialogs
 * Parameterised by `noun` + `seed` rows; tabs without a recording reference seed representative
 * placeholder rules so the page stays whole.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Plus, Trash2, ExternalLink, Clock, X } from 'lucide-react'
import { AdsDataGrid, type GridColumn, type GridEditMode } from '../../campaigns/_grid/AdsDataGrid'
import { H10Select } from '../../campaigns/FilterDropdown'
import { getBackendUrl } from '@/lib/backend-url'

export interface RuleRow { id: string; name: string; automation: boolean; criteria: string; freqDay: string; freqTime: string; live?: boolean }

// B6: summarise a stored rule's conditions + budget action into the one-line "Criteria" cell.
const OP_SYM: Record<string, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }
const BUD_VERB: Record<string, string> = { set: 'Set', incPct: '+', decPct: '−', incAbs: '+€', decAbs: '−€' }
function summariseRule(rule: { conditions?: Array<{ conditions?: Array<{ metric?: string; op?: string; value?: string }>; action?: { op?: string; value?: string } }> }): string {
  const c0 = rule.conditions?.[0]
  const ifs = (c0?.conditions ?? []).map((c) => `${c.metric ?? ''}${OP_SYM[c.op ?? ''] ?? ' '}${c.value ?? ''}`).filter(Boolean).join(', ')
  const a = c0?.action
  if (!a?.op) return ifs || '—'
  const pctOp = a.op === 'incPct' || a.op === 'decPct'
  const then = a.op === 'set' ? `Set €${a.value}` : `${BUD_VERB[a.op] ?? ''}${a.value}${pctOp ? '%' : ''}`
  return ifs ? `${ifs} → ${then}` : then
}
function ruleToRow(rule: Record<string, unknown>): RuleRow {
  const a = (Array.isArray(rule.actions) ? rule.actions[0] : null) as { control?: string; schedule?: { frequency?: string; time?: string } } | null
  const s = a?.schedule ?? {}
  const t = s.time ?? '00:00'; const [hh] = t.split(':'); const h = Number(hh) || 0
  const label = h === 0 ? '12:00 AM' : h < 12 ? `${String(h).padStart(2, '0')}:00 AM` : h === 12 ? '12:00 PM' : `${String(h - 12).padStart(2, '0')}:00 PM`
  return { id: String(rule.id), name: String(rule.name ?? 'Untitled'), automation: a?.control === 'automate', criteria: summariseRule(rule as never), freqDay: s.frequency ?? 'Daily', freqTime: label, live: true }
}

const FREQ_DAYS = ['Daily', 'Weekly', 'Monthly'].map((v) => ({ value: v, label: v }))
const TIMES = Array.from({ length: 24 }, (_, h) => {
  const label = h === 0 ? '12:00 AM' : h < 12 ? `${String(h).padStart(2, '0')}:00 AM` : h === 12 ? '12:00 PM' : `${String(h - 12).padStart(2, '0')}:00 PM`
  return { value: label, label }
})

type BulkKind = 'automation' | 'criteria' | 'frequency' | 'delete'

export function RuleListTab({ noun, seed, onAddRule, liveType, editHref, emptyNode }: { noun: string; seed: RuleRow[]; onAddRule: () => void; liveType?: string; editHref?: (id: string) => string; emptyNode?: ReactNode }) {
  const [rows, setRows] = useState<RuleRow[]>(liveType ? [] : seed)
  const [sel, setSel] = useState<Set<string>>(new Set())
  // B6: when liveType is set (Budget), load REAL rules of that type instead of placeholder seeds.
  useEffect(() => {
    if (!liveType) return
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`).then((r) => r.json())
        const all = (Array.isArray(j?.rules) ? j.rules : Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []) as Array<Record<string, unknown>>
        const mine = all.filter((r) => { const a = (Array.isArray(r.actions) ? r.actions[0] : null) as { type?: string } | null; return a?.type === liveType })
        if (alive) setRows(mine.map(ruleToRow))
      } catch { if (alive) setRows([]) }
    })()
    return () => { alive = false }
  }, [liveType])
  const [bulk, setBulk] = useState<{ kind: BulkKind; ids: string[] } | null>(null)
  const [historyRule, setHistoryRule] = useState<{ id: string; name: string } | null>(null)
  const nounLower = noun.toLowerCase()

  const patch = (id: string, p: Partial<RuleRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)))
  const toggleAutomation = (id: string) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, automation: !r.automation } : r)))

  const columns: GridColumn<RuleRow>[] = useMemo(() => [
    {
      key: 'automation', label: 'Automation', metric: false, sortable: false,
      render: (r) => <button type="button" className={`h10-bktoggle ${r.automation ? 'on' : ''}`} role="switch" aria-checked={r.automation} aria-label={`Automation for ${r.name}`} onClick={() => toggleAutomation(r.id)}><span /></button>,
    },
    { key: 'criteria', label: 'Criteria', metric: false, sortable: false, render: (r) => <span className="h10-nt-crit">{r.criteria}</span> },
    {
      key: 'frequency', label: 'Frequency', metric: false, sortable: false,
      render: (r) => <span className="h10-nt-freq"><b>{r.freqDay}</b><span>{r.freqTime}</span></span>,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  const editMode: GridEditMode<RuleRow> = useMemo(() => ({
    label: 'Edit', bulk: false,
    fields: [
      { key: 'criteria', initial: (r) => r.criteria, render: (v, set) => <input className="h10-nt-edit" value={v} onChange={(e) => set(e.target.value)} aria-label="Criteria" autoFocus /> },
      {
        key: 'frequency', initial: (r) => `${r.freqDay}|${r.freqTime}`,
        render: (v, set) => { const [d, t] = v.split('|'); return (<span className="h10-nt-freqedit"><H10Select width={150} options={FREQ_DAYS} value={d} onChange={(nv) => set(`${nv}|${t}`)} ariaLabel="Frequency day" /><H10Select width={150} options={TIMES} value={t} onChange={(nv) => set(`${d}|${nv}`)} ariaLabel="Frequency time" /></span>) },
      },
    ],
    onApply: (edits) => {
      for (const e of edits) {
        if (e.values.criteria != null) patch(e.id, { criteria: e.values.criteria })
        if (e.values.frequency != null) { const [d, t] = e.values.frequency.split('|'); patch(e.id, { freqDay: d, freqTime: t }) }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])

  const renderFirst = (r: RuleRow): ReactNode => {
    const href = editHref && r.live ? editHref(r.id) : null
    return (
      <span className="h10-nt-namew">
        {href ? <a className="h10-nt-name" href={href}>{r.name}</a> : <a className="h10-nt-name" href="#" onClick={(e) => e.preventDefault()}>{r.name}</a>}
        <span className="h10-nt-acts">
          {href ? <a className="h10-nt-open" href={href} onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Open</a>
            : <a className="h10-nt-open" href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}><ExternalLink size={11} /> Open</a>}
          {r.live && <button type="button" className="h10-nt-open hist" onClick={(e) => { e.stopPropagation(); setHistoryRule({ id: r.id, name: r.name }) }}><Clock size={11} /> History</button>}
        </span>
      </span>
    )
  }

  const applyBulk = (kind: BulkKind, ids: string[], payload?: { on?: boolean; criteria?: string; freqDay?: string; freqTime?: string }) => {
    if (kind === 'delete') { setRows((rs) => rs.filter((r) => !ids.includes(r.id))); setSel(new Set()) }
    else setRows((rs) => rs.map((r) => {
      if (!ids.includes(r.id)) return r
      if (kind === 'automation') return { ...r, automation: !!payload?.on }
      if (kind === 'criteria') return { ...r, criteria: payload?.criteria ?? r.criteria }
      if (kind === 'frequency') return { ...r, freqDay: payload?.freqDay ?? r.freqDay, freqTime: payload?.freqTime ?? r.freqTime }
      return r
    }))
    setBulk(null)
  }

  return (
    <>
      <AdsDataGrid<RuleRow>
        rows={rows}
        rowId={(r) => r.id}
        noun={noun}
        firstColLabel={noun}
        renderFirst={renderFirst}
        firstSortValue={(r) => r.name}
        columns={columns}
        editMode={editMode}
        selectable
        selected={sel}
        onSelectedChange={setSel}
        customizable={false}
        searchable
        searchPlaceholder="Search rules…"
        searchValue={(r) => r.name}
        pagerCentered
        defaultSort={{ key: '__first', dir: 'asc' }}
        emptyLabel={`No ${nounLower}s yet.`}
        emptyNode={emptyNode}
        toolbarRight={<button type="button" className="h10-am-btn primary" onClick={onAddRule}><Plus size={13} /> Rule</button>}
        selectionActions={(ids) => (
          <span className="h10-bulkrow">
            <button type="button" className="h10-am-btn bulk" onClick={() => setBulk({ kind: 'automation', ids })}>Automation</button>
            <button type="button" className="h10-am-btn bulk" onClick={() => setBulk({ kind: 'criteria', ids })}>Criteria</button>
            <button type="button" className="h10-am-btn bulk" onClick={() => setBulk({ kind: 'frequency', ids })}>Frequency</button>
            <button type="button" className="h10-am-btn bulk" onClick={() => setBulk({ kind: 'delete', ids })}><Trash2 size={13} /> Delete</button>
          </span>
        )}
      />
      {bulk && <BulkModal kind={bulk.kind} count={bulk.ids.length} nounLower={nounLower} onApply={(p) => applyBulk(bulk.kind, bulk.ids, p)} onClose={() => setBulk(null)} />}
      {historyRule && <HistoryDrawer rule={historyRule} onClose={() => setHistoryRule(null)} />}
    </>
  )
}

function BulkModal({ kind, count, nounLower, onApply, onClose }: {
  kind: BulkKind; count: number; nounLower: string
  onApply: (p?: { on?: boolean; criteria?: string; freqDay?: string; freqTime?: string }) => void
  onClose: () => void
}) {
  const [on, setOn] = useState(true)
  const [criteria, setCriteria] = useState('Sales=0, Clicks≥20')
  const [freqDay, setFreqDay] = useState('Daily')
  const [freqTime, setFreqTime] = useState('06:00 AM')
  const TITLE: Record<BulkKind, string> = { automation: 'Set Automation', criteria: 'Edit Criteria', frequency: 'Set Frequency', delete: 'Delete Rules' }
  const ruleNoun = count === 1 ? nounLower : `${nounLower}s`
  const submit = () => {
    if (kind === 'automation') onApply({ on })
    else if (kind === 'criteria') onApply({ criteria })
    else if (kind === 'frequency') onApply({ freqDay, freqTime })
    else onApply()
  }
  return (
    <div className="h10-ntm-back" onClick={onClose}>
      <div className="h10-ntm" role="dialog" aria-modal="true" aria-label={TITLE[kind]} onClick={(e) => e.stopPropagation()}>
        <div className="h10-ntm-h"><b>{TITLE[kind]}</b></div>
        <div className="h10-ntm-sub">{kind === 'delete' ? `Delete ${count} ${ruleNoun}? This cannot be undone.` : `Apply to ${count} selected ${ruleNoun}.`}</div>
        <div className="h10-ntm-b">
          {kind === 'automation' && (
            <label className="h10-ntm-tog"><button type="button" className={`h10-bktoggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label="Automation" onClick={() => setOn((v) => !v)}><span /></button> Automation {on ? 'On' : 'Off'}</label>
          )}
          {kind === 'criteria' && <input className="h10-rb-input" style={{ width: '100%' }} value={criteria} onChange={(e) => setCriteria(e.target.value)} aria-label="Criteria" />}
          {kind === 'frequency' && <span className="h10-nt-freqedit"><H10Select width={170} options={FREQ_DAYS} value={freqDay} onChange={setFreqDay} ariaLabel="Frequency day" /><H10Select width={170} options={TIMES} value={freqTime} onChange={setFreqTime} ariaLabel="Frequency time" /></span>}
        </div>
        <div className="h10-ntm-f">
          <button type="button" className="cancel" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <button type="button" className={`apply ${kind === 'delete' ? 'danger' : ''}`} onClick={submit}>{kind === 'delete' ? 'Delete' : 'Apply'}</button>
        </div>
      </div>
    </div>
  )
}

// F3 — per-rule execution history: recent AutomationRuleExecution audit rows for a live rule.
interface ExecRow { id: string; status: string; dryRun: boolean; startedAt: string; errorMessage: string | null; actionResults: Array<{ type: string; ok?: boolean; output?: { wouldChange?: string; newDailyBudget?: number; skipped?: string }; error?: string }> }
const STATUS_TONE: Record<string, string> = { SUCCESS: 'ok', DRY_RUN: 'dry', PARTIAL: 'warn', FAILED: 'bad', NO_MATCH: 'muted', CAP_EXCEEDED: 'warn' }
function HistoryDrawer({ rule, onClose }: { rule: { id: string; name: string }; onClose: () => void }) {
  const [items, setItems] = useState<ExecRow[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try { const j = await fetch(`${getBackendUrl()}/api/advertising/automation-rule-executions?ruleId=${rule.id}&limit=30`).then((r) => r.json()); if (alive) setItems(Array.isArray(j?.items) ? j.items : []) }
      catch { if (alive) setItems([]) } finally { if (alive) setLoading(false) }
    })()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => { alive = false; document.removeEventListener('keydown', k) }
  }, [rule.id, onClose])
  const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }
  const summary = (e: ExecRow) => {
    const acted = (e.actionResults ?? []).filter((a) => a.ok && a.output && !a.output.skipped)
    if (!acted.length) return e.status === 'NO_MATCH' ? 'No match' : '—'
    return acted.map((a) => a.output?.wouldChange ?? (a.output?.newDailyBudget != null ? `→ €${a.output.newDailyBudget}` : a.type)).join(', ')
  }
  return (
    <div className="h10-hist-back" onClick={onClose}>
      <div className="h10-hist" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`History — ${rule.name}`}>
        <div className="h10-hist-h"><div><b>Execution history</b><span title={rule.name}>{rule.name}</span></div><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="h10-hist-b">
          {loading ? <div className="h10-hist-msg">Loading…</div>
            : items.length === 0 ? <div className="h10-hist-msg">No runs yet. This rule produces audit rows once it&rsquo;s enabled and the evaluator ticks.</div>
            : items.map((e) => (
              <div className="h10-hist-r" key={e.id}>
                <span className={`st ${STATUS_TONE[e.status] ?? 'muted'}`}>{e.dryRun && e.status !== 'NO_MATCH' ? 'Proposed' : e.status === 'SUCCESS' ? 'Applied' : e.status.replace('_', ' ').toLowerCase()}</span>
                <span className="sum" title={e.errorMessage ?? ''}>{e.errorMessage ?? summary(e)}</span>
                <span className="when">{ago(e.startedAt)}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
