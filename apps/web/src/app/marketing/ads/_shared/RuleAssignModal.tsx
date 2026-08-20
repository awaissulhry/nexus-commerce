'use client'

/**
 * ── "Budget rules for <campaign>" ───────────────────────────────────────────────────────────────
 *
 * Assign the budget rules that may move a campaign's daily budget, and create one without leaving.
 *
 * ── D2c (2026-08-20) — one button vocabulary, and far less prose ────────────────────────────────
 * 🔴 **Operator:** *"The buttons are inconsistent. There is a lot of text, unnecessary text."*
 * Both were true. D2b's version carried **four** button idioms in one dialog — a bespoke dashed
 * `h10-ram-newbtn` invented here, `h10-am-btn primary`, `h10-am-link`, and the chassis footer's
 * classless `.cancel`/`.next` — plus five blocks of prose that were on screen whether or not they
 * were relevant.
 *
 * **Every labelled button here is now `h10-am-btn`**, with `primary` on the one main action in
 * each context. That is the tree's own vocabulary, not a new one: measured across `marketing/ads`,
 * `h10-am-btn` and its modifiers account for **257** uses against a long tail of one-offs. The
 * header's `×` stays as the chassis's close affordance — an icon, not a labelled button.
 * ⚠️ `RuleTypeModal` still uses the chassis's `.cancel`/`.next`. Converging it is a small change
 * and was NOT made here: that file is another session's active work.
 *
 * **Text appears when it is needed, not permanently.** The standing lede, the "full builder"
 * escape hatch and the always-on footer note are gone; the one fact an operator cannot infer —
 * that a rule created here is assigned but not armed — now shows only after they create one.
 * `scripts/check-button-vocabulary.mjs` ratchets the button half so a fifth idiom cannot arrive
 * quietly.
 *
 * ── Chassis ─────────────────────────────────────────────────────────────────────────────────────
 * `h10-rtm*` — the "Select a Rule Type" modal's box, header, body and footer — reused verbatim.
 * ⚠️ Before mounting outside `/rules-automation` (D6, the Ad Manager) that block must move from
 * `rules-automation.css` to `ads.css`; only the rules-automation layout loads it. A strict
 * widening, not done yet because that file is another session's work in progress.
 *
 * ── Creating a rule ─────────────────────────────────────────────────────────────────────────────
 * `POST /advertising/automation-rules` with the `CAMPAIGN_PERFORMANCE_BUDGET` shape the existing
 * budget rules use. Deliberately narrow — one metric, one threshold, one percentage; anything
 * richer belongs in the builder rather than in a second builder kept in step with the first.
 * The route stores every new advertising rule **disabled + dry-run** and that is not overridden.
 */
import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
// The DS select for this tree. `marketing/ads` being allowlisted from the DS ratchet is a reason
// not to be FAILED by it, not a licence to hand-roll a native <select>.
import { H10Select } from '../campaigns/FilterDropdown'

export interface AssignableRule {
  id: string
  name: string
  enabled: boolean
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
  const rules = rulesOrNull ?? []
  const failed = rulesOrNull === null
  const [creating, setCreating] = useState(false)
  const [madeOne, setMadeOne] = useState(false)
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
      // The route names an untranslatable metric explicitly; its message beats "failed".
      if (!r.ok || !j?.rule?.id) throw new Error(String(j?.message ?? j?.error ?? `HTTP ${r.status}`))
      onCreated({ id: String(j.rule.id), name: String(j.rule.name ?? name.trim()) })
      setCreating(false); setMadeOne(true); setName(''); setValue(''); setPercent('')
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
          {failed && (
            <p className="h10-ram-broke" role="status">Could not load the rules — this list is incomplete.</p>
          )}
          {!failed && rules.length === 0 && (
            <p className="h10-ram-empty">No budget rule exists yet.</p>
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

          {!creating ? (
            <div className="h10-ram-acts">
              <button type="button" className="h10-am-btn sm" onClick={() => { setCreating(true); setErr(null) }}>
                <Plus size={13} aria-hidden /> New rule
              </button>
              {selected.length > 0 && (
                <button type="button" className="h10-am-btn sm" onClick={() => onSetAll([])}>Unassign all</button>
              )}
            </div>
          ) : (
            <div className="h10-ram-new">
              <div className="row">
                <label className="f">
                  <span>Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Trim on weak ACoS" aria-label="Rule name" />
                </label>
              </div>
              <div className="row">
                <span className="f">
                  <span>When</span>
                  <H10Select options={METRICS.map((m) => ({ value: m.field, label: m.label }))} value={field} onChange={setField} ariaLabel="Metric" width={160} />
                </span>
                <span className="f narrow">
                  <span>is</span>
                  <H10Select options={[{ value: 'gte', label: '≥' }, { value: 'lte', label: '≤' }]} value={op} onChange={(v) => setOp(v as 'gte' | 'lte')} ariaLabel="Comparison" width={70} />
                </span>
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
                <span className="grow" />
                <button type="button" className="h10-am-btn" onClick={() => { setCreating(false); setErr(null) }}>Cancel</button>
                <button type="button" className="h10-am-btn primary" disabled={!valid || busy} aria-disabled={!valid || busy} onClick={() => void create()}>
                  {busy ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="h10-rtm-f h10-ram-f">
          {/* Shown only once they have made one — the single fact that cannot be inferred, at the
              moment it becomes true, rather than permanently. */}
          {madeOne && <span className="note">Created rules are assigned but not armed.</span>}
          <span className="grow" />
          <button type="button" className="h10-am-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
