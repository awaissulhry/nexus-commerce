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
  /** engine rules only — the autonomy level the toggle is reporting */
  level: string
  enabled: boolean
  criteria: string
  freqDay: string
  freqTime: string
}

/**
 * 🔴 TWO rule shapes live behind one grid, and rendering either as the other invents facts.
 * Measured on prod 2026-08-16 (all 18 bid rules are engine rules; zero builder rules exist yet):
 *
 * · **Builder rule** (made in `/builder/<slug>`): `conditions` is a list of GROUPS
 *   `{conditions:[{metric,op,value}], action:{op,value}}`; `actions[0]` carries `control`
 *   ('manual'|'automate') and `schedule` {frequency,time}. Frequency is a real, stored fact.
 * · **Engine rule** (the fleet's own rows): `conditions` is FLAT — `{field,op,value}` — `actions[0]`
 *   is a real action type with its own parameters, there is **no `control` and no `schedule`**, and
 *   the mode is `autonomyLevel`. Its cadence is the engine's cron, named by `trigger`.
 *
 * The first cut of this grid read only the builder shape, so on prod it printed "—" as the Criteria
 * of all 18 rows and a fabricated "Daily · 12:00 AM" as the Frequency of rules that have no
 * schedule at all — [[reference_fleet_stale_constant_class]] exactly. Both cells now read what the
 * row actually stores, and say so when it stores nothing.
 */
const OP_SYM: Record<string, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }
const ACTION_VERB: Record<string, string> = { set: 'Set', incPct: '+', decPct: '−', incAbs: '+€', decAbs: '−€' }

/** `campaign.acos` → `ACoS`; `adTarget.spendCents` → `spend`. The stored field, made readable. */
const FIELD_LABEL: Record<string, string> = {
  'campaign.acos': 'ACoS', 'campaign.roas': 'ROAS', 'campaign.spendCents': 'campaign spend',
  'campaign.budgetUtilization': 'budget used', 'adTarget.spendCents': 'spend',
  'adTarget.salesCents': 'sales', 'adTarget.impressions': 'impressions', 'adTarget.ctr': 'CTR',
  'adTarget.clicks': 'clicks', 'adTarget.ordersCount': 'orders', 'searchTerm.orders': 'search-term orders',
  'profit.netCents': 'net profit', 'budget.monthlySpendCents': 'monthly spend',
  'fbaAge.daysToLtsThreshold': 'days to LTS',
}
/** The action type, as the sentence H10 puts in the Criteria cell after the arrow. */
const ACTION_LABEL: Record<string, string> = {
  bid_to_target_acos: 'bid to target ACoS', bid_up: 'raise bid', bid_down: 'lower bid',
  lower_bid_to_floor: 'lower bid to floor', raise_bids_for_rank_defense: 'raise bids to defend rank',
  adjust_ad_budget: 'adjust budget', set_placement_multiplier: 'set placement modifier',
  defend_top_of_search: 'defend top of search', promote_to_exact: 'promote to exact',
  harvest_and_negate: 'harvest and negate', add_negative_exact: 'add negative exact',
  add_negative_phrase: 'add negative phrase', sync_negatives_across_campaigns: 'sync negatives',
  archive_keyword: 'archive keyword', pause_campaign: 'pause campaign', pause_ad_group: 'pause ad group',
  pause_all_campaigns: 'pause every campaign', refresh_dayparting: 'refresh dayparting',
  create_amazon_promotion: 'create promotion', retail_guard: 'retail guard',
  notify: 'notify', alert_operator: 'alert the operator',
}
/** An engine rule's cadence is its trigger, not a schedule. */
const TRIGGER_LABEL: Record<string, string> = {
  SCHEDULE: 'On schedule', CAC_SPIKE: 'On CAC spike', CVR_DROP: 'On CVR drop',
  AD_TARGET_UNDERPERFORMING: 'On underperformance', KEYWORD_LOW_CTR: 'On low CTR',
  KEYWORD_WASTED_SPEND: 'On wasted spend', KEYWORD_ZERO_IMPRESSIONS: 'On zero impressions',
  AD_SPEND_PROFITABILITY_BREACH: 'On profit breach', CAMPAIGN_PERFORMANCE_BUDGET: 'On budget pressure',
}
const humanTrigger = (t: string) => TRIGGER_LABEL[t] ?? t.toLowerCase().replace(/_/g, ' ')

const money = (cents: number) => `€${(cents / 100).toLocaleString('en-IE', { maximumFractionDigits: 2 })}`

/**
 * 🔴 A ratio field is stored BOTH ways and the grid must not pick one.
 * Measured on prod 2026-08-16: `bid_to_target_acos.targetAcos` is `0.3` on most rules and **`30`**
 * on "AIREON — Target ACoS bidding" — the same 30-as-a-whole-number that
 * `PUT /campaigns/:id/goal` already refuses ([[project_bid_page_bid_series]]). Multiplying blindly
 * printed "3000%". `> 1` therefore means "already a percentage"; `<= 1` means a fraction.
 * Small fractions keep their decimals: a CTR floor of 0.002 is 0.2%, not the "0%" a round() gives.
 */
const asPercent = (n: number): string => {
  const p = n > 1 ? n : n * 100
  const s = p >= 10 ? p.toFixed(0) : p.toFixed(2).replace(/\.?0+$/, '')
  return `${s}%`
}
const isRatioField = (raw: string) => /acos|ctr|cvr|utilization|roas/i.test(raw)

/** One stored condition → one readable clause, in the units the field is stored in. */
function clause(c: { field?: string; metric?: string; op?: string; value?: unknown }): string {
  const raw = String(c.field ?? c.metric ?? '')
  if (!raw) return ''
  const label = FIELD_LABEL[raw] ?? raw.split('.').pop() ?? raw
  const n = typeof c.value === 'number' ? c.value : Number(c.value)
  const v = Number.isFinite(n)
    ? (/Cents$/i.test(raw) ? money(n)
      : /roas/i.test(raw) ? String(n)
      : isRatioField(raw) ? asPercent(n)
      : String(n))
    : String(c.value ?? '')
  return `${label} ${OP_SYM[String(c.op)] ?? String(c.op ?? '')} ${v}`.trim()
}

interface BuilderGroup { conditions?: Array<{ metric?: string; op?: string; value?: string }>; action?: { op?: string; value?: string; target?: string } }

/** The Criteria cell — one line for either shape, the way H10 truncates it ("PPC Orders>=1, S…"). */
function summariseRule(rule: Record<string, unknown>): string {
  const conds = Array.isArray(rule.conditions) ? rule.conditions : []
  const a0 = (Array.isArray(rule.actions) ? rule.actions[0] : null) as Record<string, unknown> | null
  const nested = conds.length > 0 && !!conds[0] && typeof conds[0] === 'object' && 'conditions' in (conds[0] as object)

  if (nested) {
    const g = conds[0] as BuilderGroup
    const ifs = (g.conditions ?? []).map((c) => clause(c)).filter(Boolean).join(', ')
    const a = g.action
    if (!a?.op) return ifs || 'No conditions'
    const pct = a.op === 'incPct' || a.op === 'decPct'
    const then = a.op === 'set' ? `Set ${a.value ?? ''}` : `${ACTION_VERB[a.op] ?? a.op}${a.value ?? ''}${pct ? '%' : ''}`
    return ifs ? `${ifs} → ${then}` : then
  }

  // engine shape: flat conditions + a real action type with its own parameters
  const ifs = (conds as Array<{ field?: string; op?: string; value?: unknown }>).map((c) => clause(c)).filter(Boolean).join(', ')
  const type = String(a0?.type ?? '')
  let then = ACTION_LABEL[type] ?? type.replace(/_/g, ' ')
  if (type === 'bid_to_target_acos' && typeof a0?.targetAcos === 'number') then += ` ${asPercent(a0.targetAcos as number)}`
  if (type === 'bid_up' && a0?.bidUpPct != null) then += ` +${a0.bidUpPct}%`
  if (type === 'bid_down' && a0?.bidDownPct != null) then += ` −${a0.bidDownPct}%`
  if (!ifs) return then ? `Always → ${then}` : 'No conditions'
  return then ? `${ifs} → ${then}` : ifs
}

function ruleToRow(rule: Record<string, unknown>): RuleRow {
  const a = (Array.isArray(rule.actions) ? rule.actions[0] : null) as
    { type?: string; control?: string; schedule?: { frequency?: string; time?: string } } | null
  const builder = isBuilderRule(rule)
  const s = a?.schedule
  let freqDay = ''
  let freqTime = ''
  if (s) {
    const t = s.time ?? '00:00'
    const h = Number(t.split(':')[0]) || 0
    freqDay = s.frequency ?? 'Daily'
    freqTime = h === 0 ? '12:00 AM'
      : h < 12 ? `${String(h).padStart(2, '0')}:00 AM`
      : h === 12 ? '12:00 PM'
      : `${String(h - 12).padStart(2, '0')}:00 PM`
  } else {
    // No stored schedule. An engine rule runs when its trigger fires; printing "Daily · 12:00 AM"
    // here would be a constant nobody reads.
    freqDay = humanTrigger(String(rule.trigger ?? ''))
    freqTime = 'engine cadence'
  }
  return {
    id: String(rule.id),
    name: String(rule.name ?? 'Untitled'),
    // Builder rule: the mode IS actions[0].control. Engine rule: the mode is autonomyLevel, and a
    // disabled rule is off whatever its level says.
    automation: builder ? a?.control === 'automate' : rule.enabled !== false && rule.autonomyLevel === 'AUTO',
    level: String(rule.autonomyLevel ?? ''),
    enabled: rule.enabled !== false,
    criteria: summariseRule(rule),
    freqDay,
    freqTime,
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
              : !r.enabled
                ? 'This is an engine rule and it is disabled — it is never evaluated. Its mode is set on the Automations page.'
                : `This is an engine rule: its mode is ${r.level || 'unset'}, set on the Automations page. On here means AUTO — it writes on its own.`}
            onClick={() => { if (builder) void setAutomation(r.id, !r.automation) }}
          ><span /></button>
        )
      },
    },
    { key: 'criteria', label: 'Criteria', metric: false, sortable: false, render: (r) => <span className="h10-nt-crit" title={r.criteria}>{r.criteria}</span> },
    {
      key: 'frequency', label: 'Frequency', metric: false, sortable: false,
      render: (r) => (
        <span
          className="h10-nt-freq"
          title={r.freqTime === 'engine cadence'
            ? 'This rule stores no schedule — it is an engine rule and runs when its trigger fires, on the engine’s own cron.'
            : undefined}
        ><b>{r.freqDay}</b><span>{r.freqTime}</span></span>
      ),
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
