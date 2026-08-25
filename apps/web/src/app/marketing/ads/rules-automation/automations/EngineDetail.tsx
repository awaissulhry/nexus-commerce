'use client'

/**
 * AUTO.A3 (engine half) — the drawer for an ENGINE actor row.
 *
 * Deliberately lighter than `RuleDetail`: an engine has no conditions tree, no scope form and no
 * mode dial here — its posture is owned by env flags and its own service, and a governance panel
 * that quietly edits another programme's registry is the defect HV.6 refused to ship. This drawer
 * SHOWS the engine's own facts (posture + why, halt behaviour, cadence, last run, week health,
 * writes) and links to the Control Room, which owns the levers.
 *
 * Reuses `RuleDetail`'s drawer shell classes (`h10-au-back/drawer/dh/db/def*`) so the two drawers
 * cannot drift visually.
 */
import { useEffect } from 'react'
import { ToolbarButton } from '@/design-system/primitives'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'
import type { Level } from './ModeNotches'

export interface EngineActor {
  kind: 'engine'
  key: string
  name: string
  what: string
  posture: Level
  postureReason: string
  haltBehaviour: 'honours' | 'gated' | 'exempt'
  scope: string | null
  cron: string | null
  schedule: string | null
  lastRunAt: string | null
  lastRunStatus: string | null
  lastRunSummary: string | null
  runs7d: number
  failures7d: number
  warning: string | null
  writes7d: number
}

export interface ObservedActor {
  kind: 'observed'
  actor: string
  label: string
  writes7d: number
  lastWriteAt: string | null
}

const LEVEL_WORD: Record<Level, string> = { OFF: 'Off', OBSERVE: 'Observe', PROPOSE: 'Propose', AUTO: 'Auto' }
const HALT_WORD: Record<EngineActor['haltBehaviour'], string> = {
  honours: 'Honours the account halt — stands down before doing any work',
  gated: 'Runs while halted, but every write it produces is refused at the gate',
  exempt: 'Runs regardless, by design (the breaker must keep evaluating; the reconcile is read-only)',
}
const num = (n: number) => n.toLocaleString('en-IE')
const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

export function EngineDetail({ engine, onClose }: { engine: EngineActor; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])

  return (
    <div className="h10-au-back" onClick={onClose}>
      <div className="h10-au-drawer" role="dialog" aria-modal="true" aria-label={`Engine — ${engine.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="h10-au-dh">
          <div>
            <b>
              <span className="h10-au-kindtag engine" aria-hidden>engine</span>
              {engine.name}
            </b>
            <span>{engine.scope ?? 'account-wide'}</span>
          </div>
          <ToolbarButton className="h10-au-close" icon={<X size={18} aria-hidden />} label="Close" tooltip={false} onClick={onClose} />
        </div>
        <div className="h10-au-db">
          {engine.warning && (
            <p className="h10-au-conf" role="alert"><AlertTriangle size={13} aria-hidden /> {engine.warning}</p>
          )}
          <section className="h10-au-def">
            <div className="h10-au-defrow"><span className="k">What</span><span className="v">{engine.what}</span></div>
            <div className="h10-au-defrow">
              <span className="k">Posture</span>
              <span className="v"><b>{LEVEL_WORD[engine.posture]}</b> — {engine.postureReason}</span>
            </div>
            <div className="h10-au-defrow"><span className="k">Halt</span><span className="v">{HALT_WORD[engine.haltBehaviour]}</span></div>
            {engine.scope && <div className="h10-au-defrow"><span className="k">Governs</span><span className="v">{engine.scope}</span></div>}
            {(engine.schedule ?? engine.cron) && (
              <div className="h10-au-defrow"><span className="k">Cadence</span><span className="v">{engine.schedule ?? engine.cron}</span></div>
            )}
            <div className="h10-au-defrow">
              <span className="k">This week</span>
              <span className="v">
                {num(engine.runs7d)} runs{engine.failures7d > 0 && <> · <i className="bad">{num(engine.failures7d)} failed</i></>} · {num(engine.writes7d)} writes attributed to it
              </span>
            </div>
            <div className="h10-au-defrow">
              <span className="k">Last run</span>
              <span className="v">
                {ago(engine.lastRunAt)}
                {engine.lastRunStatus && <> · {engine.lastRunStatus}</>}
                {engine.lastRunSummary && <em className="h10-au-runsum"> — {engine.lastRunSummary}</em>}
              </span>
            </div>
          </section>
          <p className="h10-au-enginenote">
            An engine's posture is set by its own flags, not by this page — the levers live on the{' '}
            <a href="/marketing/ads/rules-automation/control-room">Control Room <ExternalLink size={11} aria-hidden /></a>.
          </p>
        </div>
      </div>
    </div>
  )
}
