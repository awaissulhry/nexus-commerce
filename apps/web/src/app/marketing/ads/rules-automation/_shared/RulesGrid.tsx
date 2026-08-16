'use client'

/**
 * U0 — THE rules grid, in Helium 10's shape. One implementation for every rule-type tab.
 *
 * Study: `docs/2026-08-16-ra-h10-reference-study.md` §2/§3 (measured frame-by-frame from the
 * operator's recording) and §5.2 (the same columns, read out of H10's own JS bundle). A rule-type
 * tab in H10 is ONE card and nothing else:
 *
 *   "Showing 0 Bid Rules" 🔍                                                        [+ Rule]
 *   ☐ · Bid Rule ⇅ · Automation · Criteria · Frequency
 *   (empty) illustration · "Create a Bid Rule to generate suggestions for a campaign!" · Create Rule
 *   ‹ 1 ›                                                                Rows per page: 100
 *
 * This is a PROMOTION, not a rewrite: the body is `tabs/RuleListTab.tsx` — the grid this section
 * already had and mounted nowhere — with its seed/placeholder half removed (every row is live now),
 * `onAddRule` replaced by the builder href H10 links to, and the two states RuleListTab silently
 * conflated split apart (see below). `HistoryDrawer` stays where it is and is imported: Automations
 * imports it from there too, and moving a file two sessions read is churn this unit does not need.
 *
 * 🔴 Three properties worth keeping when you touch this:
 * ① **Membership is `ruleBelongsToTab`** — the SAME predicate the tab badge counts with, so the
 *    badge and the grid cannot disagree. Four tabs (`share-of-voice`, `keyword-tracker`,
 *    `dayparting`, `budget-schedules`) have NO entry in `RULE_TAB_ACTION_TYPES`, so this grid is
 *    empty-by-construction on them until their unit adds one. Check before mounting it there.
 * ② **A failed read never renders as an empty list.** RuleListTab caught its fetch and set `[]`,
 *    so a 500 looked exactly like "no rules yet" — the operator's standing law that "never ran"
 *    and "nothing to do" must never render the same. The error is now its own state, and the
 *    skeleton (`loading`) covers the fetch so the empty state is only ever the truth.
 * ③ **The Automation toggle WRITES.** A builder rule's mode is `actions[0].control`
 *    ('automate' | 'manual') and is PATCHed here, optimistically, reverted on failure. An engine
 *    rule has no such field — its mode is `autonomyLevel`, owned by Automations — so its toggle
 *    renders disabled with that reason rather than lying.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Clock, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'
import { ruleBelongsToTab } from './tabs'
import { RULE_TYPES } from './ruleTypes'
import { NoDataIllus } from './NoDataIllus'
import { HistoryDrawer } from '../tabs/RuleListTab'

const BUILDER_SLUGS = new Set(RULE_TYPES.map((r) => r.slug))

/** A builder rule carries its builder slug as `actions[0].type`; an engine rule carries a real action type. */
const isBuilderRule = (rule: Record<string, unknown> | undefined): boolean => {
  const a0 = (Array.isArray(rule?.actions) ? rule!.actions[0] : null) as { type?: string } | null
  return !!a0?.type && BUILDER_SLUGS.has(a0.type)
}

interface RuleRow {
  id: string
  name: string
  automation: boolean
  criteria: string
  freqDay: string
  freqTime: string
}

// The Criteria cell: the stored conditions + action as one line, the way H10 truncates them
// ("PPC Orders>=1, S…"). Read-only — a summary cannot round-trip into stored conditions, which is
// why H10's inline pencils are not reproduced here; the name opens the builder, which is the editor.
const OP_SYM: Record<string, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }
const ACTION_VERB: Record<string, string> = {
  set: 'Set', incPct: '+', decPct: '−', incAbs: '+€', decAbs: '−€',
}

interface StoredAction { op?: string; value?: string; target?: string }
interface StoredGroup { conditions?: Array<{ metric?: string; op?: string; value?: string }>; action?: StoredAction }

function summariseRule(rule: { conditions?: StoredGroup[] }): string {
  const g = rule.conditions?.[0]
  const ifs = (g?.conditions ?? [])
    .map((c) => `${c.metric ?? ''}${OP_SYM[c.op ?? ''] ?? ' '}${c.value ?? ''}`)
    .filter(Boolean)
    .join(', ')
  const a = g?.action
  if (!a?.op) return ifs || '—'
  const pct = a.op === 'incPct' || a.op === 'decPct'
  const verb = ACTION_VERB[a.op] ?? a.op
  const then = a.op === 'set'
    ? `Set ${a.value ?? ''}`
    : `${verb}${a.value ?? ''}${pct ? '%' : ''}`
  const scoped = a.target ? `${then} (${a.target})` : then
  return ifs ? `${ifs} → ${scoped}` : scoped
}

function ruleToRow(rule: Record<string, unknown>): RuleRow {
  const a = (Array.isArray(rule.actions) ? rule.actions[0] : null) as
    { control?: string; schedule?: { frequency?: string; time?: string } } | null
  const s = a?.schedule ?? {}
  const t = s.time ?? '00:00'
  const h = Number(t.split(':')[0]) || 0
  const label = h === 0 ? '12:00 AM'
    : h < 12 ? `${String(h).padStart(2, '0')}:00 AM`
    : h === 12 ? '12:00 PM'
    : `${String(h - 12).padStart(2, '0')}:00 PM`
  return {
    id: String(rule.id),
    name: String(rule.name ?? 'Untitled'),
    automation: a?.control === 'automate',
    criteria: summariseRule(rule as never),
    freqDay: s.frequency ?? 'Daily',
    freqTime: label,
  }
}

type BulkKind = 'automation' | 'delete'

export interface RulesGridProps {
  /** the `RULE_TAB_ACTION_TYPES` key — membership and the tab badge share it */
  tabKey: string
  /** singular, Title Case: "Bid Rule" → "Showing 0 Bid Rules" / "Viewing 1-2 of 2 Bid Rules" */
  noun: string
  /** the builder route for this type; the name links here with `?ruleId=` */
  builderHref: string
  /** H10's empty-state sentence, verbatim per type */
  emptyLine: string
}

export function RulesGrid({ tabKey, noun, builderHref, emptyLine }: RulesGridProps) {
  const [rows, setRows] = useState<RuleRow[]>([])
  const [raw, setRaw] = useState<Map<string, Record<string, unknown>>>(new Map())
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<{ kind: BulkKind; ids: string[] } | null>(null)
  const [historyRule, setHistoryRule] = useState<{ id: string; name: string } | null>(null)
  const nounLower = noun.toLowerCase()

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => {
        if (!alive) return
        const all = (Array.isArray(j?.rules) ? j.rules : Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []) as Array<Record<string, unknown>>
        const mine = all.filter((r) => ruleBelongsToTab(r.actions, tabKey))
        setRows(mine.map(ruleToRow))
        setRaw(new Map(mine.map((r) => [String(r.id), r])))
        setErr(null)
      })
      .catch((e) => { if (alive) setErr((e as Error).message || 'failed') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [tabKey])

  /** PATCH `actions[0].control`; optimistic, reverted on failure. Builder rules only. */
  const setAutomation = useCallback(async (id: string, on: boolean): Promise<boolean> => {
    const rule = raw.get(id)
    if (!rule || !Array.isArray(rule.actions)) return false
    const actions = (rule.actions as Array<Record<string, unknown>>).map((a, i) =>
      (i === 0 ? { ...a, control: on ? 'automate' : 'manual' } : a))
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
  }, [raw])

  const applyBulk = async (kind: BulkKind, ids: string[], payload?: { on?: boolean }) => {
    setBulk(null)
    if (kind === 'delete') {
      const deleted: string[] = []
      for (const id of ids) {
        try {
          const res = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'DELETE' })
          if (res.ok) deleted.push(id)
        } catch { /* the row stays — visibly not deleted, rather than vanishing locally */ }
      }
      setRows((rs) => rs.filter((r) => !deleted.includes(r.id)))
      setRaw((m) => { const n = new Map(m); for (const id of deleted) n.delete(id); return n })
      setSel(new Set())
      return
    }
    for (const id of ids) await setAutomation(id, !!payload?.on)
    setSel(new Set())
  }

  const columns: GridColumn<RuleRow>[] = useMemo(() => [
    {
      key: 'automation', label: 'Automation', metric: false, sortable: false,
      render: (r) => {
        const builder = isBuilderRule(raw.get(r.id))
        return (
          <button
            type="button"
            className={`h10-bktoggle ${r.automation ? 'on' : ''}`}
            role="switch"
            aria-checked={r.automation}
            aria-label={`Automation for ${r.name}`}
            disabled={!builder}
            title={builder
              ? 'On = Automate (the rule applies its own actions). Off = Manual (it proposes them for approval).'
              : 'This rule’s mode is set on the Automations page'}
            onClick={() => { if (builder) void setAutomation(r.id, !r.automation) }}
          ><span /></button>
        )
      },
    },
    { key: 'criteria', label: 'Criteria', metric: false, sortable: false, render: (r) => <span className="h10-nt-crit">{r.criteria}</span> },
    {
      key: 'frequency', label: 'Frequency', metric: false, sortable: false,
      render: (r) => <span className="h10-nt-freq"><b>{r.freqDay}</b><span>{r.freqTime}</span></span>,
    },
  ], [raw, setAutomation])

  const renderFirst = (r: RuleRow): ReactNode => {
    const href = `${builderHref}?ruleId=${r.id}`
    return (
      <span className="h10-nt-namew">
        <a className="h10-nt-name" href={href}>{r.name}</a>
        <span className="h10-nt-acts">
          <a className="h10-nt-open" href={href} onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Open</a>
          <button type="button" className="h10-nt-open hist" onClick={(e) => { e.stopPropagation(); setHistoryRule({ id: r.id, name: r.name }) }}>
            <Clock size={11} /> History
          </button>
        </span>
      </span>
    )
  }

  // ② a failed read is its own state — never the empty state.
  const emptyNode = err != null ? (
    <span className="h10-rr-empty">
      <b><AlertTriangle size={14} aria-hidden /> The rule list failed to load {err}</b>
      <span className="sub">This is a failed read, not an empty list. Reload the page; if it persists the rules API is down.</span>
    </span>
  ) : (
    <span className="h10-rr-empty">
      <NoDataIllus size={104} />
      <b>{emptyLine}</b>
      <a className="h10-am-btn" href={builderHref}>Create Rule</a>
    </span>
  )

  return (
    <>
      <AdsDataGrid<RuleRow>
        rows={rows}
        loading={loading}
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
        emptyNode={emptyNode}
        toolbarRight={<a className="h10-am-btn primary" href={builderHref}><Plus size={13} aria-hidden /> Rule</a>}
        selectionActions={(ids) => (
          <span className="h10-bulkrow">
            <button type="button" className="h10-am-btn bulk" onClick={() => setBulk({ kind: 'automation', ids })}>Automation</button>
            <button type="button" className="h10-am-btn bulk" onClick={() => setBulk({ kind: 'delete', ids })}><Trash2 size={13} /> Delete</button>
          </span>
        )}
      />
      {bulk && (
        <BulkModal
          kind={bulk.kind}
          count={bulk.ids.length}
          nounLower={nounLower}
          engineCount={bulk.ids.filter((id) => !isBuilderRule(raw.get(id))).length}
          onApply={(p) => void applyBulk(bulk.kind, bulk.ids, p)}
          onClose={() => setBulk(null)}
        />
      )}
      {historyRule && <HistoryDrawer rule={historyRule} onClose={() => setHistoryRule(null)} />}
    </>
  )
}

function BulkModal({ kind, count, nounLower, engineCount, onApply, onClose }: {
  kind: BulkKind; count: number; nounLower: string
  /** selected rows that are ENGINE rules — Automation cannot touch them (their mode lives on Automations) */
  engineCount: number
  onApply: (p?: { on?: boolean }) => void
  onClose: () => void
}) {
  const [on, setOn] = useState(true)
  const TITLE: Record<BulkKind, string> = { automation: 'Set Automation', delete: 'Delete Rules' }
  const ruleNoun = count === 1 ? nounLower : `${nounLower}s`
  return (
    <div className="h10-ntm-back" onClick={onClose}>
      <div className="h10-ntm" role="dialog" aria-modal="true" aria-label={TITLE[kind]} onClick={(e) => e.stopPropagation()}>
        <div className="h10-ntm-h"><b>{TITLE[kind]}</b></div>
        <div className="h10-ntm-sub">
          {kind === 'delete'
            // The warning says the whole cost: AutomationRuleExecution rows cascade with the rule,
            // so its history — the evidence of what it did — is destroyed with it.
            ? `Delete ${count} ${ruleNoun}? This deletes the rule AND its execution history, and cannot be undone.`
            : `Apply to ${count} selected ${ruleNoun}.`}
          {kind === 'automation' && engineCount > 0 && ` ${engineCount} of them ${engineCount === 1 ? 'is an engine rule' : 'are engine rules'} whose mode is set on the Automations page — ${engineCount === 1 ? 'it' : 'they'} will be skipped.`}
        </div>
        <div className="h10-ntm-b">
          {kind === 'automation' && (
            <label className="h10-ntm-tog">
              <button type="button" className={`h10-bktoggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label="Automation" onClick={() => setOn((v) => !v)}><span /></button>
              {' '}Automation {on ? 'On' : 'Off'}
            </label>
          )}
        </div>
        <div className="h10-ntm-f">
          <button type="button" className="cancel" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <button type="button" className={`apply ${kind === 'delete' ? 'danger' : ''}`} onClick={() => onApply(kind === 'automation' ? { on } : undefined)}>
            {kind === 'delete' ? 'Delete' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}
