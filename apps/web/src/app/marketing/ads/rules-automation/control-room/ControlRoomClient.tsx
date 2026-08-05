'use client'

/**
 * ACR.1 — the Control Room.
 *
 * Replaces the autonomy board's framing, not just its layout. That board listed
 * `AutomationRule` rows, which is a minority of what moves money here: rank-defend applied
 * 5,311 mutations in 90 days and never appeared on it, and neither did dayparting, budget
 * enforcement, pool rebalancing or the anomaly breaker. Reading it, you saw a handful of
 * dials and reasonably concluded the machine was small. It was not small — it was off-screen.
 *
 * So the unit here is the ENGINE, and rules are one engine among several. Every row answers
 * the same four questions in the same order: what it does · what it is allowed to do right
 * now · WHY it is in that state · what it has actually been doing.
 *
 * The third question is the one the old board could not answer. "Why can't I turn this on"
 * needs an answer on screen, not in a codebase.
 *
 * Deliberately light: the ads console pins itself light (`.h10-shell` sets `color-scheme:
 * light`), so this stylesheet carries no dark rules rather than half-theming a surface that
 * renders inside a light shell. Operator decision, 2026-08-05.
 */

import { useCallback, useEffect, useState } from 'react'
import { Zap, Eye, MessageSquare, Power, AlertTriangle, ShieldAlert, Play, Square, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import './control-room.css'

type Mode = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'
type HaltBehaviour = 'honours' | 'gated' | 'exempt'

const MODE_META: Record<Mode, { label: string; Icon: typeof Zap; hint: string }> = {
  OFF: { label: 'Off', Icon: Power, hint: 'Does not run.' },
  OBSERVE: { label: 'Observe', Icon: Eye, hint: 'Runs and records. Cannot write.' },
  PROPOSE: { label: 'Propose', Icon: MessageSquare, hint: 'Queues a suggestion for you.' },
  AUTO: { label: 'Auto', Icon: Zap, hint: 'Acts on its own, inside the write gate.' },
}

interface Engine {
  key: string; name: string; what: string
  mode: Mode; modeReason: string
  scope: string | null; cron: string | null; schedule: string | null
  lastRunAt: string | null; lastRunStatus: string | null; lastRunSummary: string | null
  runs7d: number; failures7d: number
  warning: string | null; haltBehaviour: HaltBehaviour
}
interface Global { autonomy: string; halted: boolean; degraded: boolean; envKill: boolean }

const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

export function ControlRoomClient() {
  const [engines, setEngines] = useState<Engine[] | null>(null)
  const [global, setGlobal] = useState<Global | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/control-room/levers`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`levers: ${r.status}`)
      const j = await r.json()
      setEngines(Array.isArray(j?.engines) ? (j.engines as Engine[]) : [])
      setGlobal((j?.global ?? null) as Global | null)
      setErr(null)
    } catch (e) { setErr((e as Error).message); setEngines([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  // The kill switch. Both endpoints already existed and had no UI anywhere in this console —
  // the halt was reachable only by the anomaly guard tripping it.
  const setHalt = async (halt: boolean) => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      const path = halt ? 'halt' : 'resume'
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(halt ? { reason: 'Stopped from the Control Room' } : {}),
      })
      if (!r.ok) throw new Error(`${path}: ${r.status}`)
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const stopped = !!global && (global.halted || global.envKill || global.autonomy === 'OFF')
  const acting = (engines ?? []).filter((e) => e.mode === 'AUTO').length
  const warnings = (engines ?? []).filter((e) => e.warning).length

  return (
    <div className="acr">
      <header className="acr-head">
        <div>
          <h1>Control Room</h1>
          <p className="acr-sub">
            Every automation that can change this account — engines and rules, one list.
          </p>
        </div>
        <button type="button" className="acr-refresh" onClick={() => void load()} aria-label="Refresh">
          <RefreshCw size={14} /> Refresh
        </button>
      </header>

      {err && <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>}

      {global && (
        <section className={`acr-status ${stopped ? 'stopped' : 'running'}`} aria-label="Account automation state">
          <div className="acr-status-main">
            <span className={`acr-dot ${stopped ? 'stopped' : 'running'}`} aria-hidden />
            <div>
              <strong>{stopped ? 'Automation is stopped' : 'Automation is running'}</strong>
              <div className="acr-status-detail">
                {global.envKill
                  ? 'NEXUS_ADS_AUTOMATION_KILL is set — this cannot be cleared from here.'
                  : global.halted
                    ? 'Halted. No engine can write to Amazon until it resumes.'
                    : global.autonomy === 'SUGGEST'
                      ? 'Account dial is SUGGEST — writes are demoted to proposals.'
                      : `${acting} of ${engines?.length ?? 0} engines are acting on their own.`}
              </div>
            </div>
          </div>
          <div className="acr-status-actions">
            {!global.envKill && (
              stopped
                ? <button type="button" className="acr-btn go" disabled={busy} onClick={() => void setHalt(false)}><Play size={14} /> Resume</button>
                : <button type="button" className="acr-btn stop" disabled={busy} onClick={() => void setHalt(true)}><Square size={14} /> Stop everything</button>
            )}
          </div>
        </section>
      )}

      {global?.degraded && (
        <div className="acr-banner warn">
          <ShieldAlert size={15} /> The safety state could not be read. What you see below is the
          fail-safe assumption, not a setting anyone chose.
        </div>
      )}

      {warnings > 0 && (
        <div className="acr-banner warn">
          <AlertTriangle size={15} /> {warnings} {warnings === 1 ? 'engine needs' : 'engines need'} attention — see the flagged rows.
        </div>
      )}

      {engines === null ? (
        <div className="acr-empty">Loading…</div>
      ) : engines.length === 0 ? (
        <div className="acr-empty">No engines resolved. The API returned an empty list.</div>
      ) : (
        <ul className="acr-list">
          {engines.map((e) => {
            const M = MODE_META[e.mode]
            return (
              <li key={e.key} className={`acr-row ${e.warning ? 'flagged' : ''}`}>
                <div className="acr-row-main">
                  <div className="acr-row-name">
                    <strong>{e.name}</strong>
                    <span className={`acr-mode ${e.mode.toLowerCase()}`} title={M.hint}>
                      <M.Icon size={12} /> {M.label}
                    </span>
                    {e.haltBehaviour === 'exempt' && (
                      <span className="acr-tag" title="Runs regardless of the account halt — correctly. The breaker must keep evaluating, and read-only work has nothing to stop.">
                        halt-exempt
                      </span>
                    )}
                  </div>
                  <p className="acr-what">{e.what}</p>
                  {/* Always present. The old board could not say why a lever was where it was. */}
                  <p className="acr-why">{e.modeReason}</p>
                  {e.warning && <p className="acr-warn"><AlertTriangle size={13} /> {e.warning}</p>}
                </div>
                <dl className="acr-facts">
                  <div><dt>Governs</dt><dd>{e.scope ?? '—'}</dd></div>
                  <div><dt>Runs</dt><dd>{e.schedule ?? '—'}</dd></div>
                  <div><dt>Last run</dt><dd title={e.lastRunSummary ?? undefined}>{ago(e.lastRunAt)}</dd></div>
                  <div>
                    <dt>7 days</dt>
                    <dd className={e.failures7d > 0 ? 'bad' : undefined}>
                      {e.runs7d} run{e.runs7d === 1 ? '' : 's'}{e.failures7d > 0 ? ` · ${e.failures7d} failed` : ''}
                    </dd>
                  </div>
                </dl>
              </li>
            )
          })}
        </ul>
      )}

      <p className="acr-foot">
        Every write also passes the gate: a per-campaign allowlist, entity bid bounds, protected
        terms, and a per-payload cap. A mode here decides whether an engine acts; the gate decides
        whether the account lets it.
      </p>
    </div>
  )
}
