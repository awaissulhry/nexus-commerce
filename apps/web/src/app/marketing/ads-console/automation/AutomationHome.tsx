'use client'

/**
 * RC6.1 — Automation Home. The guided landing that replaces "drop the user on the
 * 86-automation Library with no guidance": start-here paths, what's running at a
 * glance, quick wins, and the safety reminder. Uses the hub's already-loaded
 * rules / recommendations / engine state.
 */

import { BookOpen, PenTool, CheckSquare, Zap, ShieldCheck, TrendingUp, ChevronRight, Sparkles } from 'lucide-react'

interface Rule { enabled: boolean; dryRun: boolean; trigger: string }
interface Rec { id: string; title: string; estImpactCents?: number }
interface State { autonomy?: string; halted?: boolean; effectivelyStopped?: boolean }

export function AutomationHome({ rules, recs, state, onTab }: { rules: Rule[]; recs: Rec[]; state: State | null; onTab: (k: string) => void }) {
  const active = rules.filter(r => r.enabled)
  const live = active.filter(r => !r.dryRun)
  const dry = active.length - live.length
  const topRecs = recs.slice(0, 3)
  const posture = state?.effectivelyStopped ? 'Halted' : state?.autonomy ?? 'AUTO'

  return (
    <div className="az-ah" style={{ paddingTop: 4 }}>
      <div className="az-ah-sec">
        <h3 className="az-ah-h"><Sparkles size={15} /> Start here</h3>
        <div className="az-ah-start">
          <button type="button" className="az-ah-card" onClick={() => onTab('library')}>
            <BookOpen size={20} /><span className="t">Browse the library</span><span className="d">86 ready-made automations + playbooks — add in a click, starts safe</span><ChevronRight size={14} className="go" />
          </button>
          <button type="button" className="az-ah-card" onClick={() => onTab('builder')}>
            <PenTool size={20} /><span className="t">Build a custom rule</span><span className="d">Your own trigger, conditions &amp; actions — guided, or advanced for full control</span><ChevronRight size={14} className="go" />
          </button>
          <button type="button" className="az-ah-card" onClick={() => onTab('active')}>
            <CheckSquare size={20} /><span className="t">Manage active rules</span><span className="d">{active.length} running — toggle, test, take live</span><ChevronRight size={14} className="go" />
          </button>
        </div>
      </div>

      <div className="az-ah-sec">
        <h3 className="az-ah-h"><Zap size={15} /> What&apos;s running</h3>
        {active.length === 0
          ? <div className="az-ah-empty">Nothing automated yet. Add one from the <button type="button" className="az-link" onClick={() => onTab('library')}>Library</button> — it starts <b>disabled + dry-run</b> until you turn it on.</div>
          : <div className="az-ah-running">
            <span className="pill live">{live.length} live</span>
            <span className="pill dry">{dry} dry-run</span>
            <span className="pill posture">Autonomy: {posture}</span>
            {state?.halted && <span className="pill halt">⚠ kill-switch on</span>}
            <button type="button" className="az-link" onClick={() => onTab('active')}>Manage →</button>
          </div>}
      </div>

      {topRecs.length > 0 && (
        <div className="az-ah-sec">
          <h3 className="az-ah-h"><TrendingUp size={15} /> Quick wins</h3>
          <div className="az-ah-wins">
            {topRecs.map(r => <div key={r.id} className="az-ah-win"><span className="t">{r.title}</span>{r.estImpactCents ? <span className="v">€{Math.round(r.estImpactCents / 100)}/mo</span> : null}</div>)}
            <button type="button" className="az-link" onClick={() => onTab('recs')}>See all recommendations →</button>
          </div>
        </div>
      )}

      <div className="az-ah-safe"><ShieldCheck size={14} /> Everything stays safe: new automations start <b>disabled + dry-run</b>, writes are gated, and there&apos;s a kill-switch in <button type="button" className="az-link" onClick={() => onTab('safety')}>Safety</button>.</div>
    </div>
  )
}
