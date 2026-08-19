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
 * ① **Membership is `ruleBelongsToTab`** — the SAME predicate the tab badge counts with. Sharing a
 *    predicate is not sharing a fetch, though: the badges are one per-session fetch refreshed by
 *    `ads.rule.changed`, so every write here emits it (U3 — measured: a delete left the grid at 0
 *    and the badge at 1). `keyword-tracker`, `dayparting` and `budget-schedules` still have NO
 *    entry in `RULE_TAB_ACTION_TYPES`, so this grid is empty-by-construction on them until their
 *    unit adds one, the way U3 added `share-of-voice`. Check before mounting it there.
 * ② **A failed read never renders as an empty list.** RuleListTab caught its fetch and set `[]`,
 *    so a 500 looked exactly like "no rules yet" — the operator's standing law that "never ran"
 *    and "nothing to do" must never render the same. The error is now its own state, and the
 *    skeleton (`loading`) covers the fetch so the empty state is only ever the truth.
 * ③ **The Automation toggle WRITES, for BOTH rule shapes.** A builder rule's mode is
 *    `actions[0].control` ('automate' | 'manual'), PATCHed on `/automation-rules/:id`. An engine
 *    rule has no such field — its mode is `autonomyLevel` — so it goes through
 *    `PATCH /advertising/autonomy/rules/:id` instead, the same route the Automations page's mode
 *    dial uses. Both are optimistic and revert on failure.
 *
 *    🔴 Until 2026-08-19 the engine branch did not exist: the toggle rendered `disabled` and
 *    called that honesty. It was not — **zero builder rules exist in this account** (measured on
 *    prod: 51 of 51 rules are engine rules), so the column was inert on every row of all eleven
 *    tabs, and the operator's read was simply "the toggle is broken". A control that is dead for
 *    100% of the data is not a careful refusal, it is a missing feature.
 *
 *    On = `AUTO` (acts on its own, inside its daily cap and the write gate). Off = `PROPOSE`
 *    (queues suggestions; nothing reaches Amazon until accepted) — the same two words the builder
 *    branch means by automate/manual, so one column means one thing.
 *
 *    ⚠ Two properties of that route, both deliberate and neither ours to override: it keeps
 *    `enabled` and `dryRun` in step with the level (so `level !== 'OFF'` ENABLES a disabled rule —
 *    the toggle says so before you click), and it refuses a level above the rule's graduation
 *    ceiling with a 409. Structural actions — creating keywords, negatives, pausing — are capped
 *    below AUTO by policy, so those toggles render disabled carrying the ceiling's own sentence
 *    rather than failing on click. 14 of 51 rules are capped that way today.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Clock, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'
import { ruleBelongsToTab, RULE_TAB_ACTION_TYPES } from './tabs'
import { RULE_TYPES } from './ruleTypes'
import { NoDataIllus } from './NoDataIllus'
import { HistoryDrawer } from '../tabs/RuleListTab'
import { emitAdsChange } from './adsBus'

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
  // U5 — the last three the account actually uses. Measured on prod: the enum has twelve values and
  // this map had nine, so `SEARCH_TERM_CONVERTING` rendered as a bare lower-case "search term
  // converting" beside neighbours reading "On wasted spend".
  SEARCH_TERM_CONVERTING: 'On a converting term', KEYWORD_HIGH_ACOS: 'On high ACoS',
  FBA_AGE_THRESHOLD_REACHED: 'On stock ageing',
}
/** An unmapped trigger still reads like its neighbours rather than shouting its enum. */
const humanTrigger = (t: string) => TRIGGER_LABEL[t] ?? (t ? `On ${t.toLowerCase().replace(/_/g, ' ')}` : 'No trigger')

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

/**
 * The Criteria cell — one line for either shape, the way H10 truncates it ("PPC Orders>=1, S…").
 *
 * 🔴 `tabKey` decides WHICH action is summarised, and it matters on a multi-action rule. Membership
 * is "any action belongs to this tab", so "Daily automation digest" — actions `[bid_to_target_acos,
 * harvest_and_negate, alert_operator]` — lists on Negative Targeting because of its SECOND action,
 * and summarising `actions[0]` had it explaining a bid change on the negatives tab (measured on
 * prod, U5). The line now describes the action that put the rule on the tab you are looking at;
 * the same rule therefore reads differently on Bid and on Negative Targeting, which is correct —
 * it does both.
 */
function summariseRule(rule: Record<string, unknown>, tabKey?: string): string {
  const conds = Array.isArray(rule.conditions) ? rule.conditions : []
  const actions = (Array.isArray(rule.actions) ? rule.actions : []) as Array<Record<string, unknown>>
  const want = tabKey ? RULE_TAB_ACTION_TYPES[tabKey] : undefined
  const a0 = (want ? actions.find((a) => want.includes(String(a?.type ?? ''))) ?? actions[0] : actions[0]) ?? null
  const nested = conds.length > 0 && !!conds[0] && typeof conds[0] === 'object' && 'conditions' in (conds[0] as object)

  if (nested) {
    const g = conds[0] as BuilderGroup
    const ifs = (g.conditions ?? []).map((c) => clause(c)).filter(Boolean).join(', ')
    const a = g.action
    if (!a?.op) return ifs || 'No conditions'
    // The THEN value's unit comes from the rule TYPE, not the operator: a placement rule sets a
    // percentage where every other builder type sets money. "Set 0.30" (no unit) is the kind of
    // number an operator has to guess at, so the unit is always printed.
    const pctOp = a.op === 'incPct' || a.op === 'decPct'
    const pctType = String(a0?.type ?? '') === 'placement'
    const v = String(a.value ?? '')
    const then = a.op === 'set'
      ? (pctType ? `Set ${v}%` : `Set €${v}`)
      : pctOp ? `${ACTION_VERB[a.op]}${v}%`
      : `${ACTION_VERB[a.op] ?? a.op}${v}`
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

function ruleToRow(rule: Record<string, unknown>, tabKey: string): RuleRow {
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
    criteria: summariseRule(rule, tabKey),
    freqDay,
    freqTime,
  }
}

/**
 * What Automation OFF means for an ENGINE rule.
 *
 * PROPOSE, not OFF. OFF would disable the rule outright — a different switch, the one the row's
 * "off" chip reports — and would throw away the suggestions the operator still wants to see.
 * PROPOSE is the exact counterpart of a builder rule's `manual`: the rule keeps running and
 * queues its actions, and nothing reaches Amazon until someone accepts them.
 *
 * ⚠ Asymmetry worth knowing before you change this: because the route ties `enabled` to
 * `level !== 'OFF'`, turning a DISABLED rule on and then off again leaves it enabled at PROPOSE
 * rather than disabled. That is the route's contract, the toggle's tooltip says so before the
 * first click, and re-disabling is one control away on Automations.
 */
const ENGINE_OFF_LEVEL = 'PROPOSE'

/** The four levels, as the words an operator reads rather than the enum. */
const LEVEL_WORD: Record<string, string> = { OFF: 'Off', OBSERVE: 'Observe', PROPOSE: 'Propose', AUTO: 'Auto' }

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
  /**
   * How far each rule is ALLOWED to be trusted, by rule id. Second, parallel, non-blocking read —
   * the grid renders from `/automation-rules` and this only refines the Automation toggle when it
   * lands. If it never lands the toggle still works: the same policy is enforced server-side and
   * arrives as the 409 below, so a failed ceiling read costs a pre-emptive tooltip, not a control.
   */
  const [ceilings, setCeilings] = useState<Map<string, { ceiling: string; reason: string }>>(new Map())
  /** Rows with a mode write in flight — a second click must not race the first. */
  const [pending, setPending] = useState<Set<string>>(new Set())
  /** The last refusal, in the server's own words. Cleared when the next write is attempted. */
  const [notice, setNotice] = useState<string | null>(null)
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
        setRows(mine.map((r) => ruleToRow(r, tabKey)))
        setRaw(new Map(mine.map((r) => [String(r.id), r])))
        setErr(null)
      })
      .catch((e) => { if (alive) setErr((e as Error).message || 'failed') })
      .finally(() => { if (alive) setLoading(false) })

    // The graduation ceiling, from the board the Automations page already reads. Deliberately NOT
    // awaited with the read above: it groups a week of executions and measured 1.0-2.9s on prod,
    // and the grid must not wait on it to paint.
    fetch(`${getBackendUrl()}/api/advertising/autonomy/rules`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { items?: Array<Record<string, unknown>>; rules?: Array<Record<string, unknown>> } | null) => {
        if (!alive || !j) return
        const items = j.items ?? j.rules ?? []
        setCeilings(new Map(items.map((r) => [String(r.id), {
          ceiling: String(r.ceiling ?? 'AUTO'),
          reason: String(r.ceilingReason ?? ''),
        }])))
      })
      .catch(() => { /* the 409 carries the same sentence; see `setAutomation` */ })
    return () => { alive = false }
  }, [tabKey])

  /**
   * Set a rule's Automation mode. ONE entry point, TWO write paths — which one is used is decided
   * by the rule's own shape, never by the caller, so nothing upstream has to know the difference.
   *
   * · **Builder rule** — PATCH `actions[0].control` on `/automation-rules/:id`.
   * · **Engine rule** — PATCH `{ level }` on `/advertising/autonomy/rules/:id`, the Automations
   *   page's own route. AUTO for on, PROPOSE for off; that route keeps `enabled` and `dryRun` in
   *   step with the level, and returns the stored row, so the grid re-derives from what LANDED
   *   rather than from what it hoped for — the "off" chip beside the name moves with it.
   *
   * Optimistic, reverted on failure, and a failure is never silent: a 409 is the graduation
   * ceiling refusing, which is policy rather than breakage, so it is shown in the policy's own
   * words ([[reference_ads_delivery_model]] — a refusal is never a failure).
   *
   * `silent` suppresses the bus emit so the bulk path can emit once after its loop instead of
   * once per row (adsBus rule 1 — 40 rows × 11 open tabs is 440 refetches for one click).
   */
  const setAutomation = useCallback(async (id: string, on: boolean, silent = false): Promise<boolean> => {
    const rule = raw.get(id)
    if (!rule) return false
    const builder = isBuilderRule(rule)
    if (builder && !Array.isArray(rule.actions)) return false
    setNotice(null)
    setPending((s) => new Set(s).add(id))
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, automation: on } : r)))
    try {
      let next: Record<string, unknown>
      if (builder) {
        const actions = (rule.actions as Array<Record<string, unknown>>).map((a, i) =>
          (i === 0 ? { ...a, control: on ? 'automate' : 'manual' } : a))
        const res = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions }),
        })
        if (!res.ok) throw new Error(`Could not change Automation (${res.status}).`)
        next = { ...rule, actions }
      } else {
        const level = on ? 'AUTO' : ENGINE_OFF_LEVEL
        const res = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }),
        })
        const j = (await res.json().catch(() => ({}))) as
          { ok?: boolean; error?: string; message?: string; rule?: Record<string, unknown> }
        if (!res.ok || j.ok === false) {
          // 409 is the ceiling, and the route puts its reason on `message`. Reading `error` first
          // would have printed the enum `above_ceiling` at an operator forever.
          throw new Error(res.status === 409
            ? (j.message ?? `“${rule.name ?? id}” cannot be set to Auto — it is above this rule’s ceiling.`)
            : (j.error ?? `Could not change Automation (${res.status}).`))
        }
        next = {
          ...rule,
          autonomyLevel: j.rule?.autonomyLevel ?? level,
          enabled: j.rule?.enabled ?? true,
          dryRun: j.rule?.dryRun ?? level !== 'AUTO',
        }
      }
      setRaw((m) => { const n = new Map(m); n.set(id, next); return n })
      // Re-derive the whole row from what was stored, not just the switch: an engine rule that
      // was disabled is enabled by this write, and the row carries that as its "off" chip.
      setRows((rs) => rs.map((r) => (r.id === id ? ruleToRow(next, tabKey) : r)))
      /**
       * 🔴 Emit AFTER the write settles, so the tab badges (and any other open tab) refetch.
       * Measured on prod 2026-08-18: deleting the only SOV rule left the grid at 0 and the badge
       * at 1 — the counts provider refreshes on `ads.rule.changed`, the builder emits it on save,
       * and this grid did not. Badge and grid share the membership predicate, but sharing a
       * predicate is not sharing a fetch.
       *
       * A single-row toggle emits here; the bulk path emits once after its loop, never per row.
       */
      if (!silent) emitAdsChange('ads.rule.changed')
      return true
    } catch (e) {
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, automation: !on } : r)))
      setNotice((e as Error).message)
      return false
    } finally {
      setPending((s) => { const n = new Set(s); n.delete(id); return n })
    }
  }, [raw, tabKey])

  /** Held below AUTO by the graduation ceiling — so Automation can be turned off, never on. */
  const isCapped = useCallback((id: string): boolean =>
    !isBuilderRule(raw.get(id)) && (ceilings.get(id)?.ceiling ?? 'AUTO') !== 'AUTO', [raw, ceilings])

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
      // Once per logical operation, after the loop settled — never once per row (adsBus rule 1).
      if (deleted.length) emitAdsChange('ads.rule.changed')
      return
    }
    const on = !!payload?.on
    // Turning ON a rule above its ceiling is a 409 per row. The modal said how many, and they are
    // left exactly as they were rather than each producing its own failure. Turning OFF is never
    // capped, so nothing is skipped on that side.
    const targets = on ? ids.filter((id) => !isCapped(id)) : ids
    let failed = 0
    for (const id of targets) if (!(await setAutomation(id, on, true))) failed += 1
    setSel(new Set())
    emitAdsChange('ads.rule.changed')
    const skipped = ids.length - targets.length
    // \U0001f534 A bulk verb that silently does less than it was asked is the defect this whole page
    // was rebuilt to stop. The count that did NOT move is stated, always.
    if (skipped || failed) {
      setNotice([
        `${targets.length - failed} of ${ids.length} ${ids.length === 1 ? nounLower : `${nounLower}s`} set to Automation ${on ? 'On' : 'Off'}.`,
        skipped ? `${skipped} left unchanged — above the graduation ceiling, which only Automations can raise.` : '',
        failed ? `${failed} failed to write.` : '',
      ].filter(Boolean).join(' '))
    }
  }

  const columns: GridColumn<RuleRow>[] = useMemo(() => [
    {
      key: 'automation', label: 'Automation', metric: false, sortable: false,
      render: (r) => {
        const builder = isBuilderRule(raw.get(r.id))
        const cap = ceilings.get(r.id)
        // A rule whose actions CREATE or DESTROY something is held below AUTO by policy, and the
        // server refuses it with a 409. Say so on the control instead of letting the click fail —
        // a disabled notch that keeps its reason is the pattern the mode dial already uses.
        const capped = !builder && !!cap && cap.ceiling !== 'AUTO'
        const busy = pending.has(r.id)
        return (
          <button
            type="button"
            className={`h10-bktoggle ${r.automation ? 'on' : ''}`}
            role="switch"
            aria-checked={r.automation}
            aria-label={`Automation for ${r.name}`}
            // Capped rules can still be turned OFF — the refusal is about reaching AUTO, not about
            // leaving it — but no rule above its ceiling should be at AUTO in the first place.
            disabled={busy || (capped && !r.automation)}
            title={builder
              ? 'On = Automate (the rule applies its own actions). Off = Manual (it proposes them for approval).'
              : capped
                ? `${cap!.reason} Its ceiling is ${LEVEL_WORD[cap!.ceiling] ?? cap!.ceiling} — Automation cannot be turned on for this rule.`
                : `On = Auto (it acts on its own, inside its daily cap and the write gate). Off = Propose (it queues suggestions; nothing reaches Amazon until you accept them). Currently ${LEVEL_WORD[r.level] ?? (r.level || 'unset')}.${r.enabled ? '' : ' This rule is disabled — turning Automation on will also enable it.'}`}
            onClick={() => { if (!busy && !(capped && !r.automation)) void setAutomation(r.id, !r.automation) }}
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
  ], [raw, ceilings, pending, setAutomation])

  const renderFirst = (r: RuleRow): ReactNode => {
    const href = `${builderHref}?ruleId=${r.id}`
    // `h10-rg-namew` scopes the truncation cap added at the end of rules-automation.css to THIS
    // grid: the class it sits beside, `h10-nt-namew`, is also used by the Budget Pacing page's
    // schedules section, and capping a neighbour's column is not this unit's business.
    return (
      <span className="h10-nt-namew h10-rg-namew">
        {/* title: the cap above truncates long names (rank rules carry the whole ASIN title), so
            the full name has to stay readable without opening the rule. */}
        <a className="h10-nt-name" href={href} title={r.name}>{r.name}</a>
        {/* 🔴 `enabled` and the Automation mode are two different switches, and a row that shows
            "Automate" while the rule is disabled reads as armed when it can do nothing. Measured on
            prod 2026-08-16: a rule created in the builder is stored `enabled: false`, so it never
            runs until it is enabled on Automations. The row says so rather than implying it acts. */}
        {!r.enabled && (
          <span className="h10-bd7-posture off" title="This rule is disabled — it is never evaluated, whatever its Automation mode says. Enable it on the Automations page.">off</span>
        )}
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
      {/* A refused or failed mode write, in the server's own words. Amber, not red: the common
          case is the graduation ceiling declining to trust a rule that creates or destroys
          things, which is policy working rather than anything breaking. Same lifecycle as the
          Automations page's banner — it is replaced by the next write and never dismissed by
          hand, so there is no state that can outlive what it describes. */}
      {notice && (
        <div className="h10-au-banner warn" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>{notice}</span>
        </div>
      )}
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
          cappedCount={bulk.ids.filter(isCapped).length}
          onApply={(p) => void applyBulk(bulk.kind, bulk.ids, p)}
          onClose={() => setBulk(null)}
        />
      )}
      {historyRule && <HistoryDrawer rule={historyRule} onClose={() => setHistoryRule(null)} />}
    </>
  )
}

function BulkModal({ kind, count, nounLower, cappedCount, onApply, onClose }: {
  kind: BulkKind; count: number; nounLower: string
  /** selected rows held below AUTO by the graduation ceiling — they can be turned off, never on */
  cappedCount: number
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
          {kind === 'automation' && on && cappedCount > 0 && ` ${cappedCount} of them ${cappedCount === 1 ? 'creates or destroys something and is held below Auto' : 'create or destroy something and are held below Auto'} by the graduation ceiling — ${cappedCount === 1 ? 'it' : 'they'} will be left unchanged.`}
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
