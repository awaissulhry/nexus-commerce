'use client'

/**
 * TD.0 — Autonomy Control Center. One strip to see + control the whole ad-
 * automation engine: the OFF / SUGGEST / AUTO dial, the circuit-breaker state
 * (halt/resume + why), and the anomaly-guard thresholds. Backed by
 * /api/advertising/automation/{state,autonomy,halt,resume}. Self-contained so it
 * drops into the Automation page without touching the rest of it.
 */
import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { ShieldCheck, ShieldAlert, Ban, Play } from 'lucide-react'

interface AutoState {
  autonomy: 'OFF' | 'SUGGEST' | 'AUTO'
  halted: boolean
  haltReason: string | null
  haltedBy: string | null
  haltedAt: string | null
  effectivelyStopped: boolean
  lastCheckedAt: string | null
  maxActionsPerHour: number | null
  maxHourlySpendCentsEur: number | null
}

const LEVELS: Array<{ key: 'OFF' | 'SUGGEST' | 'AUTO'; label: string; hint: string; color: string }> = [
  { key: 'OFF', label: 'Off', hint: 'Nothing runs', color: 'var(--slate, #64748b)' },
  { key: 'SUGGEST', label: 'Suggest', hint: 'Propose only (dry-run)', color: 'var(--amber, #f59e0b)' },
  { key: 'AUTO', label: 'Auto', hint: 'Apply within guardrails', color: 'var(--green, #10b981)' },
]

export function AutonomyControlCenter() {
  const [s, setS] = useState<AutoState | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/automation/state`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
    if (r?.autonomy) setS(r as AutoState)
  }, [])
  useEffect(() => { void load() }, [load])
  const post = useCallback(async (path: string, body?: object) => {
    setBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((x) => x.json()).catch(() => null)
      if (r?.autonomy) setS(r as AutoState)
    } finally { setBusy(false) }
  }, [])
  if (!s) return null

  const maxActions = s.maxActionsPerHour ?? 250
  const maxSpendEur = (s.maxHourlySpendCentsEur ?? 50_000) / 100

  return (
    <div style={{ border: '1px solid var(--line, #e2e8f0)', borderRadius: 10, padding: '10px 12px', marginBottom: 12, background: 'var(--card, #fff)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
        {s.halted ? <ShieldAlert size={15} color="#ef4444" /> : <ShieldCheck size={15} color="var(--green, #10b981)" />}
        Autonomy
      </div>

      {/* OFF / SUGGEST / AUTO dial */}
      <div role="group" aria-label="Autonomy level" style={{ display: 'inline-flex', border: '1px solid var(--line, #e2e8f0)', borderRadius: 8, overflow: 'hidden' }}>
        {LEVELS.map((l) => {
          const on = s.autonomy === l.key
          return (
            <button key={l.key} disabled={busy} title={l.hint} aria-pressed={on}
              onClick={() => !on && post('autonomy', { level: l.key })}
              style={{ padding: '5px 12px', fontSize: 12, fontWeight: on ? 700 : 500, border: 'none', cursor: busy ? 'default' : 'pointer', background: on ? l.color : 'transparent', color: on ? '#fff' : 'var(--ink, #334155)' }}>
              {l.label}
            </button>
          )
        })}
      </div>

      {/* Circuit-breaker state */}
      {s.halted ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 8, background: 'rgba(239,68,68,0.10)', color: '#b91c1c', fontSize: 12 }}>
          <Ban size={14} />
          <span><b>Halted</b>{s.haltReason ? ` — ${s.haltReason}` : ''}{s.haltedBy ? ` (${s.haltedBy})` : ''}</span>
          <button disabled={busy} onClick={() => post('resume')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 6, border: 'none', background: 'var(--green, #10b981)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            <Play size={12} /> Resume
          </button>
        </div>
      ) : (
        <button disabled={busy} onClick={() => { if (confirm('Halt ALL ad automation now? Rules stop applying until you resume.')) void post('halt', { reason: 'Operator halt' }) }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: '#dc2626', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          <Ban size={13} /> Halt all
        </button>
      )}

      {/* Anomaly-guard thresholds */}
      <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted, #94a3b8)', textAlign: 'right' }}>
        Circuit-breaker: ≤{maxActions} actions/hr · ≤€{maxSpendEur.toLocaleString()}/hr
        {s.lastCheckedAt && <div>checked {new Date(s.lastCheckedAt).toLocaleTimeString()}</div>}
      </div>
    </div>
  )
}
