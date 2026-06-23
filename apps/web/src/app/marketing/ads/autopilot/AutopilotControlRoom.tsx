'use client'

/**
 * AC P-D — Autopilot control room. Plan picker + goal/autonomy controls + the React Flow control
 * canvas + the real-time decision feed (SSE). Reads/writes AutopilotPlans; toggling a module node
 * PATCHes the plan; the live feed streams AutopilotDecisions (ours + mirrored harvest/negate).
 */
import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Play, Radio, LineChart } from 'lucide-react'
import { AutopilotCanvas, type CanvasConfig } from './AutopilotCanvas'
import { getBackendUrl } from '@/lib/backend-url'
import './control-room.css'

interface Plan { id: string; name: string; goal: string; autonomy: string; modules: Record<string, { on?: boolean }>; marketplace: string; campaignIds: string[]; lastDecisionAt?: string | null }
interface Decision { id: string; at: string; module: string; action: string; reason: string; status: string; source: string; campaignId?: string | null }

const GOALS = ['LAUNCH', 'PROFIT', 'BALANCED', 'LIQUIDATE', 'DEFEND_RANK']
const GOAL_LABEL: Record<string, string> = { LAUNCH: 'Launch', PROFIT: 'Profit', BALANCED: 'Balanced', LIQUIDATE: 'Liquidate', DEFEND_RANK: 'Defend Rank' }
const AUTONOMY = ['OFF', 'SUGGEST', 'AUTO']
const AUT_LABEL: Record<string, string> = { OFF: 'Off', SUGGEST: 'Suggest', AUTO: 'Automate' }

export function AutopilotControlRoom() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [sel, setSel] = useState('')
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(false)
  const [backtest, setBacktest] = useState<{ summary?: { byType: Record<string, number>; currentDailyBudgetCents: number; projectedDailyBudgetCents: number }; hasData?: boolean; days?: number } | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/autopilot-plans`).then((r) => r.json())
        const items = (j.items ?? []) as Plan[]
        if (!alive) return
        setPlans(items)
        if (items[0]) setSel(items[0].id)
      } catch { /* backend/migration not live yet */ } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  const plan = plans.find((p) => p.id === sel)

  // initial decisions + real-time SSE stream for the selected plan
  useEffect(() => {
    if (!sel) return
    let alive = true
    ;(async () => { try { const j = await fetch(`${getBackendUrl()}/api/advertising/autopilot-plans/${sel}/decisions?limit=100`).then((r) => r.json()); if (alive) setDecisions((j.items ?? []) as Decision[]) } catch { /* ignore */ } })()
    const es = new EventSource(`${getBackendUrl()}/api/advertising/autopilot-plans/${sel}/decisions/stream`)
    es.onopen = () => setLive(true)
    es.onerror = () => setLive(false)
    es.onmessage = (e) => { try { const d = JSON.parse(e.data) as Decision; setDecisions((cur) => [d, ...cur.filter((x) => x.id !== d.id)].slice(0, 200)) } catch { /* heartbeat */ } }
    return () => { alive = false; es.close(); setLive(false) }
  }, [sel])

  const config: CanvasConfig | null = plan ? { goal: plan.goal, modules: Object.fromEntries(Object.entries(plan.modules ?? {}).map(([k, v]) => [k, (v as { on?: boolean })?.on !== false])) } : null
  const activeModules = useMemo(() => [...new Set(decisions.slice(0, 12).map((d) => d.module))], [decisions])

  const patchPlan = async (patch: Partial<Plan>) => {
    if (!plan) return
    setPlans((ps) => ps.map((p) => (p.id === plan.id ? { ...p, ...patch } : p)))
    try { await fetch(`${getBackendUrl()}/api/advertising/autopilot-plans/${plan.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }) } catch { /* ignore */ }
  }
  const toggleModule = (key: string) => {
    if (!plan) return
    const cur = (plan.modules ?? {}) as Record<string, { on?: boolean }>
    patchPlan({ modules: { ...cur, [key]: { on: !(cur[key]?.on !== false) } } })
  }
  const runNow = async () => { if (plan) { try { await fetch(`${getBackendUrl()}/api/advertising/autopilot-plans/${plan.id}/run`, { method: 'POST' }) } catch { /* ignore */ } } }
  const runBacktest = async () => { if (!plan) return; try { const j = await fetch(`${getBackendUrl()}/api/advertising/autopilot-plans/${plan.id}/backtest?days=30`).then((r) => r.json()); setBacktest(j) } catch { /* ignore */ } }

  return (
    <div className="apr">
      <header className="apr-head">
        <div className="l"><Sparkles size={18} /><div><h1>AI Control · Autopilot</h1><p>Goal-driven autonomous control of your campaigns — every decision is write-gated, audited, reversible.</p></div></div>
      </header>

      {loading ? <div className="apr-empty">Loading plans…</div>
        : plans.length === 0 ? <div className="apr-empty"><b>No Autopilot plans yet.</b><span>Launch a campaign set with <b>AI Control</b> in the SP Super Wizard to create one.</span></div>
        : (
          <>
            <div className="apr-bar">
              <label className="f"><span>Plan</span><select value={sel} onChange={(e) => setSel(e.target.value)}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label className="f"><span>Goal</span><select value={plan?.goal ?? 'BALANCED'} onChange={(e) => patchPlan({ goal: e.target.value })}>{GOALS.map((g) => <option key={g} value={g}>{GOAL_LABEL[g]}</option>)}</select></label>
              <label className="f"><span>Autonomy</span><select value={plan?.autonomy ?? 'SUGGEST'} onChange={(e) => patchPlan({ autonomy: e.target.value })}>{AUTONOMY.map((a) => <option key={a} value={a}>{AUT_LABEL[a]}</option>)}</select></label>
              <span className="grow" />
              <span className={`apr-live ${live ? 'on' : ''}`}><Radio size={13} /> {live ? 'Live' : 'Offline'}</span>
              <button type="button" className="apr-run" onClick={runNow}><Play size={14} /> Run now (dry-run)</button>
              <button type="button" className="apr-run" onClick={runBacktest}><LineChart size={14} /> Backtest 30d</button>
            </div>

            {backtest?.summary && (
              <div className="apr-backtest">
                <b>Projection</b>
                <span>{Object.entries(backtest.summary.byType).map(([k, v]) => `${v}× ${k}`).join(' · ') || 'no actions proposed'}</span>
                <span>Daily budget €{(backtest.summary.currentDailyBudgetCents / 100).toFixed(0)} → €{(backtest.summary.projectedDailyBudgetCents / 100).toFixed(0)}</span>
                <span className="muted">{backtest.hasData ? `${backtest.days}d hourly history` : 'no hourly history yet (AMS not provisioned)'}</span>
              </div>
            )}

            <div className="apr-grid">
              {config && <AutopilotCanvas config={config} activeModules={activeModules} onToggleModule={toggleModule} />}
              <aside className="apr-feed">
                <div className="hd"><b>Decisions</b><span>{decisions.length}</span></div>
                {decisions.length === 0 ? <div className="empty">No decisions yet — run the Conductor or wait for the next 15-min cycle.</div>
                  : <ul>{decisions.map((d) => (
                      <li key={d.id} className={`m-${d.module}`}>
                        <span className="tag">{d.module}</span>
                        <span className="act">{d.action}</span>
                        <span className="rsn" title={d.reason}>{d.reason}</span>
                        <span className={`st ${d.status.toLowerCase()}`}>{d.status}{d.source === 'rule-setting' ? ' · rule' : ''}</span>
                      </li>
                    ))}</ul>}
              </aside>
            </div>
          </>
        )}
    </div>
  )
}
