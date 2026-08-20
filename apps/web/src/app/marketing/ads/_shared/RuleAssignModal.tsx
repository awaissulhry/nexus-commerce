'use client'

/**
 * ── "Budget rules — <campaign>" ─────────────────────────────────────────────────────────────────
 *
 * Assign the budget rules that may move a campaign's daily budget, and create one without leaving.
 *
 * ── D3a (2026-08-20) — rebuilt to the design handoff ────────────────────────────────────────────
 * Built from `~/Downloads/design_handoff_budget_rules_modal` — the README plus the live prototype
 * in `reference/`, which I served and interacted with before writing this, as the handoff asks.
 * Every rule is a two-line row that reads as one sentence — toggle · name + mode word ·
 * `condition → delta` in mono — and scanning moves from columns to live controls: type-to-filter
 * and mode segments.
 *
 * 🔴 **Built through the DS, not by transcribing the prototype's inline styles**, per the handoff.
 * `Modal`, `Input`, `SegmentedControl`, `Toggle` and `Button` are all `design-system` primitives —
 * already used 97 times inside `marketing/ads`, so this is existing practice here, not a new
 * dependency. Every colour the handoff names as a hex resolves to an existing `--h10-*` token
 * (checked: all 14), so the CSS uses tokens and never the literals.
 *
 * ── Three places the handoff did not match the repo, and what I did ─────────────────────────────
 * 1. It places the modal at `rules-automation/budget/BudgetRulesModal.tsx`. That path holds the
 *    Budget TAB — page header, tabs, rules grid — and mounts no modal at all; there is no 920px
 *    column-based modal anywhere in the tree. The budget-rules assignment modal is THIS file,
 *    mounted from Apply Rules, so the design was applied here. Building it where nothing mounts it
 *    would have shipped a file the operator could never open.
 * 2. The README says *"`OFF` is not rendered as a word when the row is off"*, but the prototype
 *    renders all six mode words including `OFF` at `#aeb6c2` — which is also what the handoff's own
 *    state table specifies for an unassigned row. Followed the prototype and the table.
 * 3. The prototype has no create flow. The operator asked for one explicitly — *"I should be able
 *    to create new rules directly from the modal"* — and it works, so it is KEPT, opened by the
 *    handoff's own `New rule` footer button.
 *
 * The handoff's `Unassign all` note is honoured: not a third footer button. It sits with the
 * assigned context, appearing only when something is assigned.
 *
 * ⚠️ Width: the handoff specifies 720px; the DS `Modal` offers 440/560/660/920. `size="lg"` plus a
 * width override in `ads.css` — the one deviation from "prefer the primitive", and it is a single
 * declaration rather than a reimplemented modal.
 */
import { useMemo, useState } from 'react'
import { Search, X, Plus } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Input } from '@/design-system/primitives/Input'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { Toggle } from '@/design-system/primitives/Toggle'
import { Button } from '@/design-system/primitives/Button'
import { Select } from '@/design-system/primitives/Select'
import { getBackendUrl } from '@/lib/backend-url'
import { filterBudgetRules, type RuleSegment } from './useBudgetRuleFilter'

export interface AssignableRule {
  id: string
  name: string
  enabled: boolean
  /** the rule's own mode — AUTO / PROPOSE / OFF — independent of whether it is assigned here */
  level: string
  percent: number | null
  conditionsText?: string | null
}

/** The metrics the engine really has for a campaign-budget rule. */
const METRICS: Array<{ field: string; label: string; unit: string }> = [
  { field: 'campaign.acos', label: 'ACoS', unit: '0.4 = 40%' },
  { field: 'campaign.roas', label: 'ROAS', unit: '4 = 4×' },
  { field: 'campaign.budgetUtilization', label: 'Budget used', unit: '0.85 = 85%' },
  { field: 'campaign.spendCents', label: 'Spend', unit: 'cents, 5000 = €50' },
]

const SEGMENTS: Array<{ value: RuleSegment; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'on', label: 'Active' },
  { value: 'AUTO', label: 'Auto' },
  { value: 'PROPOSE', label: 'Propose' },
]

/** U+2212, not a hyphen — the same glyph the criteria formatter uses. */
const deltaOf = (percent: number | null): string =>
  percent == null ? '' : `${percent > 0 ? '+' : '−'}${Math.abs(percent)}%`

export function RuleAssignModal({ campaignName, rules: rulesOrNull, selected, onToggle, onSetAll, onCreated, onClose }: {
  campaignName: string
  /**
   * 🔴 `null` means the catalogue did not load; `[]` means it loaded and there are none. Collapsing
   * the two is what made this modal announce "No budget rule exists yet" while six existed, on the
   * day its endpoint 500'd.
   */
  rules: AssignableRule[] | null
  selected: string[]
  onToggle: (ruleId: string) => void
  onSetAll: (ruleIds: string[]) => void
  onCreated: (rule: { id: string; name: string }) => void
  onClose: () => void
}) {
  const failed = rulesOrNull === null
  const all = useMemo(() => rulesOrNull ?? [], [rulesOrNull])
  const [query, setQuery] = useState('')
  const [segment, setSegment] = useState<RuleSegment>('all')
  const [creating, setCreating] = useState(false)
  const [madeOne, setMadeOne] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [field, setField] = useState(METRICS[0].field)
  const [op, setOp] = useState<'gte' | 'lte'>('gte')
  const [value, setValue] = useState('')
  const [percent, setPercent] = useState('')

  /**
   * 🔴 Mode order, matching the reference. The prototype lists AUTO · AUTO · PROPOSE · PROPOSE ·
   * OFF · OFF — armed first — while our catalogue arrives alphabetical, which put PROPOSE above
   * AUTO on prod. The README does not mention sorting; the reference is the artefact the handoff
   * calls final, so this follows it. Stable within a band, so alphabetical still shows through.
   */
  const RANK: Record<string, number> = { AUTO: 0, PROPOSE: 1, OBSERVE: 2, OFF: 3 }

  const shown = useMemo(() => {
    const shaped = [...all].sort((a, b) => (RANK[a.level] ?? 9) - (RANK[b.level] ?? 9)).map((r) => ({
      ...r,
      condition: r.conditionsText || 'No conditions — matches every context',
      delta: deltaOf(r.percent),
    }))
    return filterBudgetRules(shaped, query, segment, (id) => selected.includes(id))
  }, [all, query, segment, selected])

  const metric = METRICS.find((m) => m.field === field) ?? METRICS[0]
  const pctNum = Number(percent)
  const valNum = Number(value)
  const valid = name.trim() !== ''
    && value.trim() !== '' && Number.isFinite(valNum)
    && percent.trim() !== '' && Number.isFinite(pctNum) && pctNum !== 0 && Math.abs(pctNum) <= 100

  const create = async () => {
    setBusy(true); setErr(null)
    try {
      const sym = op === 'gte' ? '≥' : '≤'
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: `Created from Apply Rules. When ${metric.label} ${sym} ${valNum}, change the daily budget by ${pctNum > 0 ? '+' : ''}${pctNum}%.`,
          trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
          conditions: [{ field, op, value: valNum }],
          actions: [{ type: 'adjust_ad_budget', percent: pctNum, reason: `${metric.label} ${sym} ${valNum} — budget ${pctNum > 0 ? '+' : ''}${pctNum}%` }],
        }),
      })
      const j = await r.json().catch(() => ({}))
      // The route names an untranslatable metric explicitly; its message beats "failed".
      if (!r.ok || !j?.rule?.id) throw new Error(String(j?.message ?? j?.error ?? `HTTP ${r.status}`))
      onCreated({ id: String(j.rule.id), name: String(j.rule.name ?? name.trim()) })
      setCreating(false); setMadeOne(true); setName(''); setValue(''); setPercent('')
    } catch (e) {
      setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  const activeCount = all.filter((r) => selected.includes(r.id)).length

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      className="h10-ram"
      title={<span className="h10-ram-title">Budget rules <span className="camp">{campaignName}</span></span>}
      footer={
        <>
          <span className="h10-ram-count">{activeCount} of {all.length} rules active</span>
          {madeOne && <span className="h10-ram-note">Created rules are assigned but not armed.</span>}
          <span className="h10-ram-grow" />
          <Button variant="secondary" onClick={() => { setCreating(true); setErr(null) }}>
            <Plus size={13} aria-hidden /> New rule
          </Button>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="h10-ram-bar">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter rules, metrics or thresholds"
          aria-label="Filter rules"
          fieldClassName="h10-ram-search"
          leadingIcon={<Search size={14} aria-hidden />}
          suffix={query !== '' ? (
            <button type="button" className="h10-ram-clear" aria-label="Clear" onClick={() => setQuery('')}>
              <X size={13} aria-hidden />
            </button>
          ) : undefined}
        />
        <SegmentedControl options={SEGMENTS} value={segment} onChange={(v) => setSegment(v as RuleSegment)} />
      </div>

      <div className="h10-ram-list">
        {failed && <p className="h10-ram-broke" role="status">Could not load the rules — this list is incomplete.</p>}
        {!failed && all.length === 0 && <p className="h10-ram-none">No budget rule exists yet.</p>}
        {!failed && all.length > 0 && shown.length === 0 && (
          <p className="h10-ram-none">
            {query.trim() !== '' ? <>No rules match “{query.trim()}”</> : 'No rules in this view'}
          </p>
        )}

        {shown.map((r) => {
          const on = selected.includes(r.id)
          const mode = (r.level || 'OFF').toUpperCase()
          return (
            <div key={r.id} className={`h10-ram-row ${on ? 'on' : 'off'} m-${mode.toLowerCase()}`}>
              <Toggle checked={on} onChange={() => onToggle(r.id)} aria-label={r.name} />
              <div className="b">
                <div className="l1">
                  {/* Truncated, so the full string stays reachable — handoff accessibility note. */}
                  <span className="nm" title={r.name}>{r.name}</span>
                  {/* A bare word, deliberately: no chip, no pill, no fill. The handoff's replacement
                      for the old Automation column of chips. */}
                  <span className="md">{mode}</span>
                </div>
                <div className="l2">
                  <span className="cond" title={r.condition}>{r.condition}</span>
                  {r.delta !== '' && <span className="arw" aria-hidden>→</span>}
                  {r.delta !== '' && <span className={`dl ${(r.percent ?? 0) > 0 ? 'up' : 'down'}`}>{r.delta}</span>}
                </div>
              </div>
            </div>
          )
        })}

        {/* Not a third footer button, per the handoff — it sits with the assigned context. */}
        {!creating && activeCount > 0 && (
          <div className="h10-ram-sub">
            <Button variant="ghost" onClick={() => onSetAll([])}>Unassign all</Button>
          </div>
        )}

        {creating && (
          <div className="h10-ram-new">
            <div className="row">
              <label className="f">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Trim on weak ACoS" aria-label="Rule name" />
              </label>
            </div>
            <div className="row">
              <label className="f narrow">
                <span>When</span>
                <Select value={field} onChange={(e) => setField(e.target.value)} aria-label="Metric">
                  {METRICS.map((m) => <option key={m.field} value={m.field}>{m.label}</option>)}
                </Select>
              </label>
              <label className="f narrow">
                <span>is</span>
                <Select value={op} onChange={(e) => setOp(e.target.value as 'gte' | 'lte')} aria-label="Comparison">
                  <option value="gte">≥</option>
                  <option value="lte">≤</option>
                </Select>
              </label>
              <label className="f narrow">
                <span>{metric.unit}</span>
                <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Threshold" />
              </label>
              <label className="f narrow">
                <span>budget %</span>
                <input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} aria-label="Budget change percent" placeholder="-15" />
              </label>
            </div>
            {err && <p className="err" role="status">{err}</p>}
            <div className="acts">
              <span className="h10-ram-grow" />
              <Button variant="secondary" onClick={() => { setCreating(false); setErr(null) }}>Cancel</Button>
              <Button variant="primary" disabled={!valid || busy} aria-disabled={!valid || busy} onClick={() => void create()}>
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
