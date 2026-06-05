'use client'

/**
 * RC4.7 — Automate station. The "customize the automation" surface: shows the
 * global autonomy posture, lets you create the key rank rule (Hold Top-of-Search
 * IS — absorbs the old ToS-IS mode) with editable guardrails, and lists the
 * advertising rules with enable/disable, dry-run↔live, and a dry-run test-fire.
 * Rules are created disabled + dry-run; going live is an explicit, confirmed step.
 */

import { useCallback, useEffect, useState } from 'react'
import { Bot, ShieldCheck, Loader2, Check, ChevronDown, ChevronRight, FlaskConical, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Rule { id: string; name: string; enabled: boolean; dryRun: boolean; trigger: string; scopeMarketplace: string | null; maxExecutionsPerDay: number | null }
interface Status { killSwitch: boolean; rules: { total: number; enabled: number; live: number; dryRun: number; disabled: number } }

export function AutomateStation({ market, onChanged }: { market: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [rules, setRules] = useState<Rule[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [targetIS, setTargetIS] = useState(60)
  const [maxAcos, setMaxAcos] = useState(25)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    const [r, s] = await Promise.all([
      fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store', signal }).then(x => x.json()).catch(() => ({ items: [] })),
      fetch(`${getBackendUrl()}/api/advertising/autonomy/status`, { cache: 'no-store', signal }).then(x => x.json()).catch(() => null),
    ])
    if (!signal?.aborted) { setRules((r.items ?? []) as Rule[]); setStatus(s as Status) }
  }, [])
  useEffect(() => { if (!open) return; const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [open, load])

  const createDefend = useCallback(async () => {
    setBusy('create'); setMsg('')
    try {
      await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Hold Top-of-Search IS ≥ ${targetIS}% (${market})`,
          description: `Holds top-of-search impression share at ≥ ${targetIS}% by tuning PLACEMENT_TOP (±15%/run, ≤900%), bounded by ${maxAcos}% ACOS — raise while below target and in budget, ease off once above target or over ACOS.`,
          trigger: 'SCHEDULE', conditions: [],
          actions: [
            { type: 'defend_top_of_search', targetIS: targetIS / 100, targetAcos: maxAcos / 100, marketplace: market },
            { type: 'notify', target: 'operator', message: `Top-of-Search IS defense holding ≥ ${targetIS}%` },
          ],
          scopeMarketplace: market, maxExecutionsPerDay: 48,
        }),
      })
      setMsg('Rule created — disabled + dry-run. Enable it below to start (still audit-only until you go live).')
      await load(); onChanged()
    } catch { setMsg('Could not create the rule.') }
    setBusy(null)
  }, [targetIS, maxAcos, market, load, onChanged])

  const patchRule = useCallback(async (id: string, body: Record<string, unknown>, goingLive = false) => {
    if (goingLive && !window.confirm('Take this rule LIVE? It will make real bid/placement changes on Amazon on its schedule.')) return
    setBusy(id)
    try { await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await load(); onChanged() } catch { /* ignore */ }
    setBusy(null)
  }, [load, onChanged])

  const testRule = useCallback(async (id: string) => {
    setBusy(id); setMsg('')
    try { const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}/test`, { method: 'POST' }).then(x => x.json()); setMsg(`Test fire (dry-run): ${r.status ?? r.outcome ?? 'done'}${typeof r.matched === 'boolean' ? ` · ${r.matched ? 'would act' : 'no action'}` : ''}.`) } catch { setMsg('Test failed.') }
    setBusy(null)
  }, [])

  const posture = !status ? '…' : status.killSwitch ? 'OFF (kill switch)' : status.rules.live > 0 ? `AUTO · ${status.rules.live} live` : status.rules.enabled > 0 ? `SUGGEST · ${status.rules.enabled} dry-run` : 'No rules running'

  return (
    <div className="az-station">
      <button type="button" className="az-station-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} <Bot size={15} /> <b>Advanced rules</b>
        <span className="sub">custom hands-off automation · {posture}</span>
      </button>
      {open && (
        <div className="az-station-body">
          <div className="az-auto-pointer">Set your <b>rank goal</b> in the <b>Rank plan</b> (§② above) — that owns the goal, the schedule, and Auto-defend. These are custom rules for power users.</div>
          {status?.killSwitch && <div className="az-auto-halt"><AlertTriangle size={13} /> Automation kill-switch is ON — no rule will act until it&apos;s cleared.</div>}
          <div className="az-auto-card">
            <div className="az-auto-title"><ShieldCheck size={14} /> Hold Top-of-Search rank ({market})</div>
            <div className="az-auto-row">
              Keep Top-of-Search share ≥ <input type="number" min={1} max={100} value={targetIS} onChange={e => setTargetIS(Math.max(1, Math.min(100, Number(e.target.value))))} />% while ACOS stays under <input type="number" min={1} max={200} value={maxAcos} onChange={e => setMaxAcos(Math.max(1, Math.min(200, Number(e.target.value))))} />%
              <span style={{ flex: 1 }} />
              <button type="button" className="az-btn dark" disabled={busy === 'create'} onClick={() => void createDefend()}>{busy === 'create' ? <><Loader2 size={14} className="az-spin" /> …</> : <><Check size={14} /> Create rule</>}</button>
            </div>
            <div className="az-cockpit-note">Created <b>disabled + dry-run</b> — it won&apos;t touch Amazon until you enable it and take it live. Raises/eases PLACEMENT_TOP ±15%/run to win the slot for the least cost.</div>
          </div>

          <div className="az-auto-rules">
            {rules.length === 0 ? <div className="az-cockpit-sub">No advertising rules yet — create one above.</div> : rules.map(r => (
              <div key={r.id} className="az-auto-rule">
                <span className="nm">{r.name}</span>
                <span className={`st ${r.enabled ? (r.dryRun ? 'dry' : 'live') : 'off'}`}>{r.enabled ? (r.dryRun ? 'Dry-run' : 'LIVE') : 'Off'}</span>
                {r.scopeMarketplace && <span className="mk">{r.scopeMarketplace}</span>}
                <span style={{ flex: 1 }} />
                <button type="button" className="az-mini" disabled={busy === r.id} onClick={() => void patchRule(r.id, { enabled: !r.enabled })}>{r.enabled ? 'Disable' : 'Enable'}</button>
                {r.enabled && <button type="button" className="az-mini" disabled={busy === r.id} onClick={() => void patchRule(r.id, { dryRun: !r.dryRun }, r.dryRun)}>{r.dryRun ? 'Go live' : 'Dry-run'}</button>}
                <button type="button" className="az-mini" disabled={busy === r.id} onClick={() => void testRule(r.id)} title="Dry-run test fire" aria-label={`Dry-run test fire: ${r.name}`}><FlaskConical size={11} /></button>
              </div>
            ))}
          </div>
          {msg && <div className="az-cockpit-sub" style={{ marginTop: 8 }} role="status" aria-live="polite">{msg}</div>}
        </div>
      )}
    </div>
  )
}
