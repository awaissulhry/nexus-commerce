'use client'

/**
 * AC P-C — the SP Super Wizard "AI Control" step (replaces the old stub note). The operator
 * picks ONE goal + autonomy + guardrails + which control modules the AI manages; on launch this
 * becomes an AutopilotPlan that the Conductor (ad-autopilot.job) drives. Harvesting & negation
 * are delegated to the shared Rule-Setting engine (labelled accordingly). The React Flow control
 * canvas (P-D) renders/edit this same config. See docs/ai-control-autopilot-spec.md.
 */
import { Megaphone, Target, Scale, ShoppingCart, Trophy, Sparkles } from 'lucide-react'
import { RadioCard } from '@/design-system/primitives'
import { InfoTip } from '../../campaigns/InfoTip'
import './ai-control.css'

export type AiGoal = 'LAUNCH' | 'PROFIT' | 'BALANCED' | 'LIQUIDATE' | 'DEFEND_RANK'
export type AiAutonomy = 'OFF' | 'SUGGEST' | 'AUTO'
export interface AiGuardrails { targetAcosPct: string; bidMinEur: string; bidMaxEur: string; budgetMinEur: string; budgetMaxEur: string; maxDailySpendEur: string; rampPct: string; neverPause: boolean }
export interface AiModules { bid: boolean; budget: boolean; placement: boolean; rank: boolean; dayparting: boolean; harvest: boolean; negate: boolean }
export interface AiControlConfig { goal: AiGoal; autonomy: AiAutonomy; guardrails: AiGuardrails; modules: AiModules }

export const defaultAiControl = (): AiControlConfig => ({
  goal: 'BALANCED', autonomy: 'SUGGEST',
  guardrails: { targetAcosPct: '30', bidMinEur: '0.05', bidMaxEur: '3.00', budgetMinEur: '1', budgetMaxEur: '500', maxDailySpendEur: '', rampPct: '25', neverPause: true },
  modules: { bid: true, budget: true, placement: true, rank: false, dayparting: false, harvest: true, negate: true },
})

/** UI (€/%) → backend Guardrails (cents/percent) for the AutopilotPlan payload. */
export const aiGuardrailsToCents = (g: AiGuardrails) => ({
  targetAcosPct: Number(g.targetAcosPct) || 30,
  bidMinCents: Math.round((Number(g.bidMinEur) || 0.05) * 100),
  bidMaxCents: Math.round((Number(g.bidMaxEur) || 3) * 100),
  budgetMinCents: Math.round((Number(g.budgetMinEur) || 1) * 100),
  budgetMaxCents: Math.round((Number(g.budgetMaxEur) || 500) * 100),
  maxDailySpendCents: g.maxDailySpendEur.trim() ? Math.round(Number(g.maxDailySpendEur) * 100) : 0,
  rampPct: Number(g.rampPct) || 25,
  neverPause: g.neverPause,
})

const GOALS: Array<{ key: AiGoal; label: string; desc: string; Icon: typeof Target }> = [
  { key: 'LAUNCH', label: 'Launch', desc: 'Maximise impressions & rank for a new product — looser ACoS, fast ramp.', Icon: Megaphone },
  { key: 'PROFIT', label: 'Profit', desc: 'Protect margin — profit-native target ACoS, conservative ramp, tight caps.', Icon: Target },
  { key: 'BALANCED', label: 'Balanced', desc: 'Scale efficiently at your target ACoS with sensible defaults.', Icon: Scale },
  { key: 'LIQUIDATE', label: 'Liquidate', desc: 'Clear inventory — max orders, high budgets, inventory-aware.', Icon: ShoppingCart },
  { key: 'DEFEND_RANK', label: 'Defend Rank', desc: 'Hold Top-of-Search impression share within an ACoS cap.', Icon: Trophy },
]
const AUTONOMY: Array<{ key: AiAutonomy; label: string; desc: string }> = [
  { key: 'SUGGEST', label: 'Suggest', desc: 'AI proposes changes; you approve them. Recommended.' },
  { key: 'AUTO', label: 'Automate', desc: 'AI applies changes automatically, within your guardrails.' },
  { key: 'OFF', label: 'Off', desc: 'Pause the AI — nothing changes until you turn it on.' },
]
const MODULES: Array<{ key: keyof AiModules; label: string; note?: string }> = [
  { key: 'bid', label: 'Bid optimization' },
  { key: 'budget', label: 'Budget pacing' },
  { key: 'placement', label: 'Placement tuning' },
  { key: 'rank', label: 'Rank defense' },
  { key: 'dayparting', label: 'Dayparting' },
  { key: 'harvest', label: 'Keyword harvesting', note: 'via Rule Setting' },
  { key: 'negate', label: 'Negative targeting', note: 'via Rule Setting' },
]
const Field = ({ label, value, onChange, suffix, placeholder }: { label: string; value: string; onChange: (v: string) => void; suffix: string; placeholder?: string }) => (
  <label className="h10-ai-field"><span className="lbl">{label}</span><span className="inp"><input inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /><span className="sfx">{suffix}</span></span></label>
)

export function AiControlPanel({ value, onChange }: { value: AiControlConfig; onChange: (v: AiControlConfig) => void }) {
  const set = (patch: Partial<AiControlConfig>) => onChange({ ...value, ...patch })
  const setG = (patch: Partial<AiGuardrails>) => onChange({ ...value, guardrails: { ...value.guardrails, ...patch } })
  const toggleM = (k: keyof AiModules) => onChange({ ...value, modules: { ...value.modules, [k]: !value.modules[k] } })
  const g = value.guardrails

  return (
    <>
      <div className="h10-spw-card">
        <h3><Sparkles size={16} /> AI Goal <InfoTip tip="Pick one outcome. The AI configures every control module — bids, budgets, placements, rank, dayparting — to pursue it within your guardrails." /></h3>
        <p className="h10-spw-desc">Choose the goal for this campaign set. You can change it any time from the control canvas.</p>
        <div className="h10-ai-goals">
          {GOALS.map((go) => <RadioCard key={go.key} name="ai-goal" title={go.label} description={go.desc} selected={value.goal === go.key} checked={value.goal === go.key} onChange={() => set({ goal: go.key })} />)}
        </div>
      </div>

      <div className="h10-spw-card">
        <h3>Autonomy</h3>
        <p className="h10-spw-desc">How much the AI does on its own.</p>
        <div className="h10-ai-autonomy">
          {AUTONOMY.map((a) => <RadioCard key={a.key} name="ai-autonomy" title={a.label} description={a.desc} selected={value.autonomy === a.key} checked={value.autonomy === a.key} onChange={() => set({ autonomy: a.key })} />)}
        </div>
        {value.autonomy === 'AUTO' && <div className="h10-ai-warn">Automate applies live changes within your guardrails once live-writes are enabled for these campaigns — otherwise it stays in propose-only.</div>}
      </div>

      <div className="h10-spw-card">
        <h3>Guardrails <InfoTip tip="Hard limits the AI can never cross. Breaches suppress bids rather than pausing." /></h3>
        <div className="h10-ai-guards">
          <Field label="Target ACoS" value={g.targetAcosPct} onChange={(v) => setG({ targetAcosPct: v })} suffix="%" />
          <Field label="Min bid" value={g.bidMinEur} onChange={(v) => setG({ bidMinEur: v })} suffix="€" />
          <Field label="Max bid" value={g.bidMaxEur} onChange={(v) => setG({ bidMaxEur: v })} suffix="€" />
          <Field label="Min daily budget" value={g.budgetMinEur} onChange={(v) => setG({ budgetMinEur: v })} suffix="€" />
          <Field label="Max daily budget" value={g.budgetMaxEur} onChange={(v) => setG({ budgetMaxEur: v })} suffix="€" />
          <Field label="Max daily ad spend" value={g.maxDailySpendEur} onChange={(v) => setG({ maxDailySpendEur: v })} suffix="€" placeholder="No cap" />
          <Field label="Max change / cycle" value={g.rampPct} onChange={(v) => setG({ rampPct: v })} suffix="%" />
          <label className="h10-ai-toggle"><button type="button" className={`h10-ai-sw ${g.neverPause ? 'on' : ''}`} role="switch" aria-checked={g.neverPause} aria-label="Never pause" onClick={() => setG({ neverPause: !g.neverPause })}><span /></button> Never pause (suppress instead)</label>
        </div>
      </div>

      <div className="h10-spw-card">
        <h3>Control modules</h3>
        <p className="h10-spw-desc">Which levers the AI manages. Harvesting & negation run through the shared Rule&nbsp;Setting engine — the AI sets their thresholds.</p>
        <div className="h10-ai-modules">
          {MODULES.map((m) => (
            <label key={m.key} className={`h10-ai-mod ${value.modules[m.key] ? 'on' : ''}`}>
              <input type="checkbox" checked={value.modules[m.key]} onChange={() => toggleM(m.key)} />
              <span>{m.label}{m.note && <span className="note">{m.note}</span>}</span>
            </label>
          ))}
        </div>
      </div>

    </>
  )
}
