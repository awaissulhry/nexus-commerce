'use client'

/**
 * ── D2b (2026-08-20) — "Budget rules for <campaign>", a real modal ─────────────────────────────
 *
 * 🔴 **Operator instruction:** *"rebuild the modal that appears when I click on the Add button. It
 * must be slightly bigger so that all the information is easily readable. I should be able to
 * create new rules directly from the modal, and it should be properly wired."*
 *
 * What it replaces: a 300–380px popover anchored under the cell's pencil, listing rule names
 * ellipsised to nothing, with an empty state that told the operator to leave — *"Create one on the
 * Budget tab and it appears here."* Both complaints were fair. This is H10's centred modal
 * chassis at 640px, every rule showing its own **conditions** as well as its name, and a create
 * form that makes a real rule and assigns it without leaving the page.
 *
 * ── The chassis is H10's own, not a copy of it ──────────────────────────────────────────────────
 * `h10-rtm*` — the "Select a Rule Type" modal's box, header, body and footer — is reused verbatim,
 * so this is the same object H10's rule-type dialog is. Only the ROWS and the create form are new
 * (`h10-ram-*`, in `ads.css`).
 *
 * ⚠️ **Before mounting this outside `/rules-automation` (D6, the Ad Manager), the `h10-rtm*` block
 * must move from `rules-automation.css` to `ads.css`.** Only the rules-automation layout loads that
 * stylesheet, so the chassis would render unstyled anywhere else. It was NOT moved today because
 * `rules-automation.css` is another session's work in progress and restructuring it would collide;
 * the widening is safe on its own (`ads.css` is a parent layout, so no page loses anything).
 *
 * ── Creating a rule here is a real create, and deliberately a NARROW one ────────────────────────
 * `POST /advertising/automation-rules` with the `CAMPAIGN_PERFORMANCE_BUDGET` shape the six
 * existing budget rules use: flat engine-native `conditions`, an `adjust_ad_budget` action. The
 * route stores every new advertising rule **disabled + dry-run** — an operator opts into live
 * writes deliberately, and that is not overridden here. So a rule created in this modal is
 * assigned immediately and acts on nothing until it is armed on the Automations tab; the footer
 * says so rather than letting the operator infer it.
 *
 * Anything richer than "one metric, one threshold, one percentage" belongs in the full builder,
 * which is one link away. A modal that tried to be the builder would be a second builder to keep
 * in step with the first.
 */
import { useState } from 'react'
import { X, Plus, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
// The DS select for this tree. A native <select> is the idiom the conformance ratchet exists to
// remove; `marketing/ads` is allowlisted from that ratchet as the H10 pixel-match world, which is
// a reason not to be FAILED by it, not a reason to hand-roll one.
import { H10Select } from '../campaigns/FilterDropdown'

export interface AssignableRule {
  id: string
  name: string
  enabled: boolean
  level: string
  percent: number | null
  conditionsText?: string | null
  description?: string | null
}

/** The metrics the engine really has for a campaign-budget rule. */
const METRICS: Array<{ field: string; label: string; hint: string }> = [
  { field: 'campaign.acos', label: 'ACoS', hint: 'a fraction — 0.4 is 40%' },
  { field: 'campaign.roas', label: 'ROAS', hint: 'a multiple — 4 is 4×' },
  { field: 'campaign.budgetUtilization', label: 'Budget used', hint: 'a fraction — 0.85 is 85%' },
  { field: 'campaign.spendCents', label: 'Spend (cents)', hint: '5000 is €50' },
]

export function RuleAssignModal({ campaignName, rules: rulesOrNull, selected, onToggle, onSetAll, onCreated, onClose, builderHref }: {
  campaignName: string
  /**
   * 🔴 `null` means the catalogue did not load; `[]` means it loaded and there are none. Collapsing
   * the two is what made this modal announce "No budget rule exists yet" while six existed, on the
   * day its endpoint 500'd — the same broke-vs-empty distinction the grid's four empty states keep.
   */
  rules: AssignableRule[] | null
  /** The ids currently selected — staged, not necessarily saved. */
  selected: string[]
  onToggle: (ruleId: string) => void
  onSetAll: (ruleIds: string[]) => void
  /** A rule was created; the caller refreshes its catalogue and selects it. */
  onCreated: (rule: { id: string; name: string }) => void
  onClose: () => void
  builderHref: string
}) {
  const rules = rulesOrNull ?? []
  const failed = rulesOrNull === null
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [field, setField] = useState(METRICS[0].field)
  const [op, setOp] = useState<'gte' | 'lte'>('gte')
  const [value, setValue] = useState('')
  const [percent, setPercent] = useState('')

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
      // The route names an untranslatable metric explicitly; surfacing its message beats "failed".
      if (!r.ok || !j?.rule?.id) throw new Error(String(j?.message ?? j?.error ?? `HTTP ${r.status}`))
      onCreated({ id: String(j.rule.id), name: String(j.rule.name ?? name.trim()) })
      setCreating(false); setName(''); setValue(''); setPercent('')
    } catch (e) {
      setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <div className="h10-rtm-back" onClick={onClose}>
      <div className="h10-rtm h10-ram" role="dialog" aria-modal="true" aria-label={`Budget rules for ${campaignName}`} onClick={(e) => e.stopPropagation()}>
        <div className="h10-rtm-h">
          <b>Budget rules — {campaignName}</b>
          <button type="button" className="x" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="h10-rtm-b">
          <p className="h10-ram-lede">
            A budget rule may only move this campaign’s daily budget once it is assigned here.
            Unassign everything and nothing may move it.
          </p>

          {failed && (
            <p className="h10-ram-broke" role="status">
              The budget rules could not be loaded, so this list is incomplete. Nothing here says
              there are none — close and reopen to try again.
            </p>
          )}
          {!failed && rules.length === 0 && (
            <p className="h10-ram-empty">No budget rule exists yet. Create the first one below.</p>
          )}

          {rules.map((r) => {
            const on = selected.includes(r.id)
            return (
              <label key={r.id} className={`h10-ram-opt ${on ? 'on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => onToggle(r.id)} />
                <span className="b">
                  <span className="hd">
                    <span className="t">{r.name}</span>
                    {/* The state travels with the name: assigning a disabled rule governs nothing,
                        and two of these rules share a name — the state is what tells them apart. */}
                    <span className={`lv ${r.enabled ? '' : 'off'}`}>{r.level}</span>
                    {r.percent != null && <span className="pc">{r.percent > 0 ? '+' : ''}{r.percent}%</span>}
                  </span>
                  <span className="d">{r.conditionsText || 'No conditions — matches every context'}</span>
                </span>
              </label>
            )
          })}

          {/* ── create ─────────────────────────────────────────────────────────────────────── */}
          {!creating ? (
            <button type="button" className="h10-ram-newbtn" onClick={() => { setCreating(true); setErr(null) }}>
              <Plus size={14} aria-hidden /> New budget rule
            </button>
          ) : (
            <div className="h10-ram-new">
              <label className="f">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Trim budget on weak ACoS" aria-label="Rule name" />
              </label>
              <div className="row">
                <span className="f">
                  <span>When</span>
                  <H10Select
                    options={METRICS.map((m) => ({ value: m.field, label: m.label }))}
                    value={field} onChange={setField} ariaLabel="Metric" width={168}
                  />
                </span>
                <span className="f narrow">
                  <span>is</span>
                  <H10Select
                    options={[{ value: 'gte', label: '≥' }, { value: 'lte', label: '≤' }]}
                    value={op} onChange={(v) => setOp(v as 'gte' | 'lte')} ariaLabel="Comparison" width={72}
                  />
                </span>
                <label className="f narrow">
                  <span>value</span>
                  <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Threshold" />
                </label>
                <label className="f narrow">
                  <span>budget</span>
                  <span className="pct"><input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} aria-label="Budget change percent" /><i>%</i></span>
                </label>
              </div>
              <p className="hint">{metric.hint}. A negative percentage cuts the budget, a positive one raises it.</p>
              {err && <p className="err" role="status">{err}</p>}
              <div className="acts">
                <button type="button" className="h10-am-link" onClick={() => { setCreating(false); setErr(null) }}>Cancel</button>
                <span className="grow" />
                <a className="h10-am-link" href={builderHref}><ExternalLink size={12} aria-hidden /> Full builder</a>
                <button type="button" className="h10-am-btn primary" disabled={!valid || busy} aria-disabled={!valid || busy} onClick={() => void create()}>
                  {busy ? 'Creating…' : 'Create and assign'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="h10-rtm-f h10-ram-f">
          <button type="button" className="cancel" onClick={() => onSetAll([])}>Unassign all</button>
          <span className="grow" />
          {/* Said once, here, because it is true of anything created above: the create route stores
              every new advertising rule disabled + dry-run. */}
          <span className="note">A newly created rule is assigned but not armed — arm it on Automations.</span>
          <button type="button" className="next" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
