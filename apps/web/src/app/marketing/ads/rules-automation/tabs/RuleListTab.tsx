'use client'

/**
 * RuleListTab — the shared rules-grid body used by the interim rule sections (Bid · Budget ·
 * Keyword Harvest) and the exporter of `HistoryDrawer` (Automations). Renders through the ONE
 * shared AdsDataGrid.
 *
 * P2.5 — every control on this grid now WRITES or says it cannot. The old version mutated React
 * state under a modal reading "This cannot be undone": Delete removed a row that returned on
 * reload, the Automation toggle flipped a pixel, and the Criteria/Frequency pencils edited a
 * display string no rule ever read. The pencils and their bulk dialogs are REMOVED (a criteria
 * summary cannot round-trip into stored conditions — the builder's Open link is the editor);
 * Delete calls the real endpoint; the Automation toggle PATCHes the builder rule's `control`
 * field, and is disabled with the reason on engine rules, whose mode lives on Automations.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Toggle, ToolbarButton } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { Plus, Trash2, ExternalLink, Clock, X, RotateCcw } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'
import { ruleBelongsToTab } from '../_shared/tabs'
import { RULE_TYPES } from '../_shared/ruleTypes'

const BUILDER_SLUGS = new Set(RULE_TYPES.map((r) => r.slug))
const isBuilderRule = (rule: Record<string, unknown> | undefined): boolean => {
  const a0 = (Array.isArray(rule?.actions) ? rule!.actions[0] : null) as { type?: string } | null
  return !!a0?.type && BUILDER_SLUGS.has(a0.type)
}

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

type BulkKind = 'automation' | 'delete'

export function RuleListTab({ noun, seed, onAddRule, liveType, editHref, emptyNode }: { noun: string; seed: RuleRow[]; onAddRule: () => void; liveType?: string; editHref?: (id: string) => string; emptyNode?: ReactNode }) {
  const [rows, setRows] = useState<RuleRow[]>(liveType ? [] : seed)
  const [sel, setSel] = useState<Set<string>>(new Set())
  // P2.5 — the raw rules by id, kept so a toggle can PATCH the real actions array rather than
  // reconstructing it from a display row.
  const [raw, setRaw] = useState<Map<string, Record<string, unknown>>>(new Map())
  // B6: when liveType is set (Budget), load REAL rules of that type instead of placeholder seeds.
  useEffect(() => {
    if (!liveType) return
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`).then((r) => r.json())
        const all = (Array.isArray(j?.rules) ? j.rules : Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []) as Array<Record<string, unknown>>
        // `liveType` is the TAB KEY, not an action type — see RULE_TAB_ACTION_TYPES for why
        // comparing the two directly matched nothing and emptied every live tab.
        const mine = all.filter((r) => ruleBelongsToTab(r.actions, liveType))
        if (alive) { setRows(mine.map(ruleToRow)); setRaw(new Map(mine.map((r) => [String(r.id), r]))) }
      } catch { if (alive) setRows([]) }
    })()
    return () => { alive = false }
  }, [liveType])
  const [bulk, setBulk] = useState<{ kind: BulkKind; ids: string[] } | null>(null)
  const [historyRule, setHistoryRule] = useState<{ id: string; name: string } | null>(null)
  const nounLower = noun.toLowerCase()

  /**
   * P2.5 — a REAL toggle, for the rows it can be real on. A builder rule's automation switch is
   * `actions[0].control` ('automate' auto-applies once graduated; 'manual' always proposes) —
   * PATCHed here, optimistically, reverted on failure. An engine rule has no such field: its
   * mode is `autonomyLevel`, owned by the Automations page, so its toggle renders disabled with
   * that pointer instead of flipping a pixel that wrote nothing (the old behaviour).
   */
  const setAutomation = async (id: string, on: boolean): Promise<boolean> => {
    const rule = raw.get(id)
    if (!rule || !isBuilderRule(rule)) return false
    const actions = (rule.actions as Array<Record<string, unknown>>).map((a, i) => (i === 0 ? { ...a, control: on ? 'automate' : 'manual' } : a))
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, automation: on } : r)))
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions }),
      })
      if (!res.ok) throw new Error(String(res.status))
      setRaw((m) => { const n = new Map(m); n.set(id, { ...rule, actions }); return n })
      return true
    } catch {
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, automation: !on } : r)))
      return false
    }
  }

  const columns: GridColumn<RuleRow>[] = useMemo(() => [
    {
      key: 'automation', label: 'Automation', metric: false, sortable: false,
      render: (r) => {
        const builder = isBuilderRule(raw.get(r.id))
        return (
          <Toggle
            checked={r.automation}
            aria-label={`Automation for ${r.name}`}
            disabled={r.live && !builder}
            title={r.live && !builder ? 'This rule’s mode is set on the Automations page' : undefined}
            onClick={() => { if (!r.live || builder) void setAutomation(r.id, !r.automation) }}
          />
        )
      },
    },
    { key: 'criteria', label: 'Criteria', metric: false, sortable: false, render: (r) => <span className="h10-nt-crit">{r.criteria}</span> },
    {
      key: 'frequency', label: 'Frequency', metric: false, sortable: false,
      render: (r) => <span className="h10-nt-freq"><b>{r.freqDay}</b><span>{r.freqTime}</span></span>,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [raw])

  const renderFirst = (r: RuleRow): ReactNode => {
    const href = editHref && r.live ? editHref(r.id) : null
    return (
      <span className="h10-nt-namew">
        {href ? <a className="h10-nt-name" href={href}>{r.name}</a> : <a className="h10-nt-name" href="#" onClick={(e) => e.preventDefault()}>{r.name}</a>}
        <span className="h10-nt-acts">
          {href ? <a className="h10-nt-open" href={href} onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Open</a>
            : <a className="h10-nt-open" href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}><ExternalLink size={11} /> Open</a>}
          {r.live && <Button size="xs" className="h10-nt-open hist" onClick={(e) => { e.stopPropagation(); setHistoryRule({ id: r.id, name: r.name }) }}><Clock size={11} /> History</Button>}
        </span>
      </span>
    )
  }

  /**
   * P2.5 — bulk actions call the endpoints they always claimed to. Delete removes only the rows
   * whose DELETE succeeded (a failure stays visible instead of vanishing locally); Automation
   * applies to the builder rules in the selection and reports how many engine rules it could
   * not touch. Live rows only — seeds have nothing behind them to write.
   */
  const applyBulk = async (kind: BulkKind, ids: string[], payload?: { on?: boolean }) => {
    setBulk(null)
    if (kind === 'delete') {
      if (!liveType) { setRows((rs) => rs.filter((r) => !ids.includes(r.id))); setSel(new Set()); return }
      const deleted: string[] = []
      for (const id of ids) {
        try {
          const res = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'DELETE' })
          if (res.ok) deleted.push(id)
        } catch { /* row stays — visibly not deleted */ }
      }
      setRows((rs) => rs.filter((r) => !deleted.includes(r.id)))
      setRaw((m) => { const n = new Map(m); for (const id of deleted) n.delete(id); return n })
      setSel(new Set())
      return
    }
    // automation
    for (const id of ids) await setAutomation(id, !!payload?.on)
    setSel(new Set())
  }

  return (
    <>
      <AdsDataGrid<RuleRow>
        rows={rows}
        rowId={(r) => r.id}
        enabledFirst={(r) => r.automation}
        noun={noun}
        firstColLabel={noun}
        renderFirst={renderFirst}
        firstSortValue={(r) => r.name}
        columns={columns}
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
    toolbarRight={<Button variant="primary" onClick={onAddRule}><Plus size={13} /> Rule</Button>}
        selectionActions={(ids) => (
          <span className="h10-bulkrow">
            <Button variant="ghost" onClick={() => setBulk({ kind: 'automation', ids })}>Automation</Button>
            <Button variant="ghost" onClick={() => setBulk({ kind: 'delete', ids })}><Trash2 size={13} /> Delete</Button>
          </span>
        )}
      />
      {bulk && <BulkModal kind={bulk.kind} count={bulk.ids.length} nounLower={nounLower} engineCount={liveType ? bulk.ids.filter((id) => !isBuilderRule(raw.get(id))).length : 0} onApply={(p) => void applyBulk(bulk.kind, bulk.ids, p)} onClose={() => setBulk(null)} />}
      {historyRule && <HistoryDrawer rule={historyRule} onClose={() => setHistoryRule(null)} />}
    </>
  )
}

function BulkModal({ kind, count, nounLower, engineCount, onApply, onClose }: {
  kind: BulkKind; count: number; nounLower: string
  /** selected rows that are ENGINE rules — Automation cannot touch them (mode lives on Automations) */
  engineCount: number
  onApply: (p?: { on?: boolean }) => void
  onClose: () => void
}) {
  const [on, setOn] = useState(true)
  const TITLE: Record<BulkKind, string> = { automation: 'Set Automation', delete: 'Delete Rules' }
  const ruleNoun = count === 1 ? nounLower : `${nounLower}s`
  return (
    <Modal
      open
      onClose={onClose}
      title={TITLE[kind]}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button
          variant={kind === 'delete' ? 'danger' : 'primary'} size="sm"
          onClick={() => onApply(kind === 'automation' ? { on } : undefined)}
        >
          {kind === 'delete' ? 'Delete' : 'Apply'}
        </Button>
      </>}
    >
      <p className="h10-ntm-say">
        {kind === 'delete'
          // P2.5 — the warning is finally TRUE (this used to remove rows from React state), and
          // it says the whole cost: AutomationRuleExecution rows cascade with the rule, so its
          // history — the evidence of what it did — is destroyed with it.
          ? `Delete ${count} ${ruleNoun}? This deletes the rule AND its execution history, and cannot be undone.`
          : `Apply to ${count} selected ${ruleNoun}.`}
        {kind === 'automation' && engineCount > 0 && ` ${engineCount} of them ${engineCount === 1 ? 'is an engine rule' : 'are engine rules'} whose mode is set on the Automations page — ${engineCount === 1 ? 'it' : 'they'} will be skipped.`}
      </p>
      {kind === 'automation' && (
        <label className="h10-ntm-tog">
          <Toggle checked={on} onChange={setOn} aria-label="Automation" />
          {' '}Automation {on ? 'On' : 'Off'}
        </label>
      )}
    </Modal>
  )
}

// F3 — per-rule execution history: recent AutomationRuleExecution audit rows for a live rule.
interface ExecRow { id: string; status: string; dryRun: boolean; startedAt: string; errorMessage: string | null; actionResults: Array<{ type: string; ok?: boolean; output?: { wouldChange?: string; newDailyBudget?: number; skipped?: string }; error?: string }> }
const STATUS_TONE: Record<string, string> = { SUCCESS: 'ok', DRY_RUN: 'dry', PARTIAL: 'warn', FAILED: 'bad', NO_MATCH: 'muted', CAP_EXCEEDED: 'warn' }

/**
 * ACR.6 (R1) — undo a whole execution, not one change at a time.
 *
 * The Change Log can undo a single change, which is the right grain when a person made it. An
 * automation execution is different: one tick of one rule can move a dozen bids across as many
 * campaigns, and undoing that twelve times — while getting none of them wrong — is not a recovery
 * path. `POST /actions/:executionId/rollback` reverses the set as one operation, and it was
 * reachable only from the legacy execution-detail page that Stage 6 retires.
 *
 * The server enforces a hard 24h window (409 `rollback_window_expired`) and refuses executions
 * outside the advertising domain. This mirrors both client-side purely so the button is absent
 * rather than failing on click — the server remains the authority.
 *
 * Dry-run rows never offer it: a proposal wrote nothing, so there is nothing to reverse, and an
 * enabled button there would imply the run had taken effect.
 */
const ROLLBACK_WINDOW_MS = 24 * 60 * 60 * 1000
interface RollbackResult {
  ok: boolean; reversed: number; skipped: number; failed: number
  details: Array<{ actionLogId: string; actionType: string; entityType: string; entityId: string; outcome: 'REVERSED' | 'SKIPPED' | 'FAILED'; reason?: string }>
}
const rollbackable = (e: ExecRow) =>
  !e.dryRun
  && (e.status === 'SUCCESS' || e.status === 'PARTIAL')
  && Date.now() - new Date(e.startedAt).getTime() < ROLLBACK_WINDOW_MS

// RA.AUTO — exported so the Automations page reuses this drawer rather than growing a second
// one. Behaviour is unchanged for the five rule-type tabs that already render it. The 24h
// window below is correct here and is NOT the per-action window: `rollbackByExecutionId`
// (rollback.service.ts:424) filters on the flat 24h constant, so a whole-run undo really does
// close after a day whatever it changed. `rollbackWindowMsFor` governs the single-change
// Change Log path instead.
export function HistoryDrawer({ rule, onClose }: { rule: { id: string; name: string }; onClose: () => void }) {
  const [items, setItems] = useState<ExecRow[]>([])
  const [loading, setLoading] = useState(true)
  const [confirming, setConfirming] = useState<ExecRow | null>(null)
  const [rbBusy, setRbBusy] = useState(false)
  const [rbResult, setRbResult] = useState<{ execId: string; r: RollbackResult } | null>(null)
  const [rbError, setRbError] = useState('')
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

  const rollback = async (exec: ExecRow) => {
    setRbBusy(true); setRbError('')
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/actions/${exec.id}/rollback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: `operator rollback from the rule history drawer (${rule.name})` }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRbError(j?.error === 'rollback_window_expired'
          ? 'That run is older than 24 hours — the rollback window has closed. Reverse the individual changes from the Change Log instead.'
          : (j?.error ?? 'Rollback failed.'))
        return
      }
      setRbResult({ execId: exec.id, r: j as RollbackResult })
      setConfirming(null)
    } catch (e) { setRbError((e as Error).message || 'Rollback failed.') } finally { setRbBusy(false) }
  }
  const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }
  const summary = (e: ExecRow) => {
    const acted = (e.actionResults ?? []).filter((a) => a.ok && a.output && !a.output.skipped)
    if (!acted.length) return e.status === 'NO_MATCH' ? 'No match' : '—'
    return acted.map((a) => a.output?.wouldChange ?? (a.output?.newDailyBudget != null ? `→ €${a.output.newDailyBudget}` : a.type)).join(', ')
  }
  return (
    <div className="h10-hist-back" onClick={onClose}>
      <div className="h10-hist" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`History — ${rule.name}`}>
        <div className="h10-hist-h"><div><b>Execution history</b><span title={rule.name}>{rule.name}</span></div><ToolbarButton icon={<X size={18} />} label="Close" tooltip={false} onClick={onClose} /></div>
        {rbError && <div className="h10-hist-err" role="alert">{rbError}</div>}
        <div className="h10-hist-b">
          {loading ? <div className="h10-hist-msg">Loading…</div>
            : items.length === 0 ? <div className="h10-hist-msg">No runs yet. This rule produces audit rows once it&rsquo;s enabled and the evaluator ticks.</div>
            : items.map((e) => {
              const done = rbResult?.execId === e.id ? rbResult.r : null
              return (
                <div className="h10-hist-r" key={e.id}>
                  <span className={`st ${STATUS_TONE[e.status] ?? 'muted'}`}>{e.dryRun && e.status !== 'NO_MATCH' ? 'Proposed' : e.status === 'SUCCESS' ? 'Applied' : e.status.replace('_', ' ').toLowerCase()}</span>
                  <span className="sum" title={e.errorMessage ?? ''}>
                    {e.errorMessage ?? summary(e)}
                    {done && (
                      <em className="h10-hist-undone">
                        Rolled back — {done.reversed} reversed{done.skipped ? ` · ${done.skipped} skipped` : ''}{done.failed ? ` · ${done.failed} failed` : ''}
                      </em>
                    )}
                  </span>
                  <span className="when">
                    {ago(e.startedAt)}
                    {rollbackable(e) && !done && (
                      <button type="button" className="h10-hist-rb" onClick={() => { setRbError(''); setConfirming(e) }}>
                        <RotateCcw size={12} aria-hidden /> Roll back
                      </button>
                    )}
                  </span>
                </div>
              )
            })}
        </div>

        {confirming && (
          <div className="h10-hist-cf" role="dialog" aria-modal="true" aria-label="Confirm rollback">
            <b>Roll back this whole run?</b>
            <p>
              Every change this execution made is reversed in one operation — bids and budgets return to the
              values they held before it ran. Changes already overwritten since are skipped rather than forced,
              and each outcome is reported. The rule itself stays as it is; only this run is undone.
            </p>
            <div className="h10-hist-cf-a">
              <Button size="sm" disabled={rbBusy} onClick={() => setConfirming(null)}>Cancel</Button>
              <Button variant="danger" size="sm" disabled={rbBusy} onClick={() => void rollback(confirming)}>
                {rbBusy ? 'Rolling back…' : 'Roll back run'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
