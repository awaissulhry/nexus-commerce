'use client'

/**
 * Guardrails — the safety envelope every automation runs inside. Shows the
 * autonomy level (set on Control Room since 1g), sets hard spend/action
 * ceilings per hour (POST /automation/thresholds), and the global kill-switch
 * (POST /automation/halt|resume). Reads current posture from /automation/state.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Gauge, Pause, Play, Save, ShieldCheck } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, Input } from '@/design-system/primitives'

interface State { autonomy?: string; halted?: boolean; haltReason?: string | null; maxHourlySpendCentsEur?: number | null; maxActionsPerHour?: number | null; effectivelyStopped?: boolean }
const LEVELS = [
  { k: 'OFF', label: 'Manual', desc: 'Engine suggests nothing acts on its own. You drive everything.' },
  { k: 'SUGGEST', label: 'Suggest', desc: 'Engine surfaces recommendations; you approve each one.' },
  { k: 'AUTO', label: 'Auto', desc: 'Enabled live rules act within these guardrails. Dry-run rules still only preview.' },
]
const post = (path: string, body?: unknown) => fetch(`${getBackendUrl()}/api/advertising/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : '{}' })

export function GuardrailsTab() {
  const [s, setS] = useState<State | null>(null)
  const [hourly, setHourly] = useState('')
  const [actions, setActions] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = () => void fetch(`${getBackendUrl()}/api/advertising/automation/state`, { cache: 'no-store' }).then((r) => r.json()).then((d) => { setS(d); setHourly(d?.maxHourlySpendCentsEur != null ? String(d.maxHourlySpendCentsEur / 100) : ''); setActions(d?.maxActionsPerHour != null ? String(d.maxActionsPerHour) : '') }).catch(() => {})
  useEffect(load, [])

  const saveThresholds = async () => { setBusy(true); setMsg(''); try { const r = await post('automation/thresholds', { maxHourlySpendCentsEur: hourly === '' ? null : Math.round(Number(hourly) * 100), maxActionsPerHour: actions === '' ? null : Number(actions) }); setMsg(r.ok ? 'Guardrails saved' : 'Could not save'); load() } finally { setBusy(false) } }
  const toggleHalt = async () => { setBusy(true); try { await post(s?.halted ? 'automation/resume' : 'automation/halt', s?.halted ? undefined : { reason: 'Manual halt from console' }); load() } finally { setBusy(false) } }

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4><Gauge size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Autonomy level</h4>
        {/* 1g — the dial moves only on Control Room, behind a confirm. This old console used to post a
            field the route ignored, so these cards never did anything; they now say where the dial is. */}
        <p>
          How much the engine is allowed to do without you. Current: <b>{LEVELS.find((l) => l.k === s?.autonomy)?.label ?? s?.autonomy ?? '—'}</b>.
          {' '}Change it with the account dial on <Link href="/marketing/ads/rules-automation/control-room">Control Room</Link>; it asks before every change.
        </p>
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4><ShieldCheck size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Hard ceilings</h4>
        <p>Absolute limits the engine can never exceed in an hour — a backstop above every rule’s own guardrails.</p>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12, color: 'var(--ink2)' }}>Max spend affected / hour<br /><Input type="number" prefix="€" value={hourly} placeholder="no limit" onChange={(e) => setHourly(e.target.value)} style={{ width: 110 }} /></label>
          <label style={{ fontSize: 12, color: 'var(--ink2)' }}>Max actions / hour<br /><Input type="number" value={actions} placeholder="no limit" onChange={(e) => setActions(e.target.value)} style={{ width: 140 }} /></label>
          <Button variant="primary" disabled={busy} onClick={() => void saveThresholds()}><Save size={14} />Save guardrails</Button>
          {msg && <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{msg}</span>}
        </div>
      </div>

      <div className="az-eng-card" style={{ borderColor: s?.halted ? '#f4c7c0' : undefined }}>
        <h4>Global kill-switch</h4>
        <p>Engine is <b style={{ color: s?.effectivelyStopped ? '#cc1100' : 'var(--green)' }}>{s?.effectivelyStopped ? 'HALTED' : 'running'}</b>{s?.haltReason ? ` — ${s.haltReason}` : ''}. One click stops/starts every automation instantly.</p>
        {s?.halted
          ? <Button variant="primary" disabled={busy} onClick={() => void toggleHalt()}><Play size={14} />Resume all automation</Button>
          : <Button variant="danger" disabled={busy} onClick={() => void toggleHalt()}><Pause size={14} />Halt all automation</Button>}
      </div>
    </div>
  )
}
