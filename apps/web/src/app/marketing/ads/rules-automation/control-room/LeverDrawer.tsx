'use client'

/**
 * ACR.1.2b — one engine's own record, opened from its Levers row.
 *
 * The Levers row answers "what is this allowed to do". This answers "what has it actually
 * been doing", which is the question an operator asks second and could previously only
 * answer by reading logs.
 *
 * Three panels, in the order the questions get asked:
 *   · Run now + the last summary — the thing you came to do, and what happened last time.
 *   · Run history — 25 ticks with status, duration, and each one's own output line. A FAILED
 *     row shows its error here, because a failure with a blank output line is the failure
 *     being hidden a second time.
 *   · Evidence — the rows this engine actually wrote, with the campaign NAMED rather than
 *     identified by cuid.
 *
 * The empty state is the part worth care. Measured on prod 2026-08-05, most of these engines
 * have written nothing recently and two have never written anything at all — `auto-bid`
 * proposes nothing today and `tos-defense`'s cron has never been armed. So "no rows" is the
 * normal case, and the drawer distinguishes the three reasons it can happen instead of
 * rendering one blank list that reads like a bug: the engine writes no per-entity rows by
 * design, the engine has written nothing in the window, or the engine has never run.
 *
 * Own classes, own stylesheet. The console's other drawers use `h10-hist-*` from
 * `rules-automation.css`, which reaches here only because a parent layout happens to import
 * it — the same borrowed-classes coupling that shipped the Coverage page unstyled. This
 * drawer styles itself.
 *
 * Light only, like the rest of this stylesheet.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Drawer } from '@/design-system/components'
import { usePermission } from '@/lib/auth/AuthProvider'
import { sendCommand, useCommandKey } from '@/lib/command-key'
import { switchStep, type LeverControl, type LeverMode, type SwitchEvent, type SwitchState } from './lever-control'
import { LeverSwitchSection } from './LeverSwitch'
import { Play, AlertTriangle, CheckCircle2, CircleSlash, Loader2 } from 'lucide-react'
import { LeverConfirm } from './LeverConfirm'
import { getBackendUrl } from '@/lib/backend-url'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'

interface EngineRun {
  id: string
  startedAt: string
  finishedAt: string | null
  status: string
  triggeredBy: string | null
  summary: string | null
  durationMs: number | null
}
interface EvidenceRow {
  id: string
  at: string
  actionType: string
  entityType: string | null
  entityId: string | null
  campaignName: string | null
  status: string | null
  reason: string | null
}
interface EngineDetail {
  key: string
  cron: string | null
  run: { available: boolean; jobName: string | null; why: string | null }
  runs: EngineRun[]
  health: { runs14d: number; failures14d: number; manual14d: number }
  lastSummary: string | null
  evidence: EvidenceRow[]
  evidenceNote: string | null
  writesEntities: boolean
}

const when = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
const dur = (ms: number | null) => {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

/** The engine's run log and its evidence, as DS `DataGrid` columns. */
const RUN_COLUMNS: Array<Column<EngineRun>> = [
  { key: 'when', label: 'When', render: (r) => (<>{when(r.startedAt)}{r.triggeredBy === 'manual' && <span className="acr-dw-manual">by hand</span>}</>) },
  { key: 'status', label: 'Status', render: (r) => <span className={`acr-dw-st ${r.status.toLowerCase()}`}>{r.status}</span> },
  { key: 'took', label: 'Took', align: 'right', render: (r) => <>{dur(r.durationMs)}</> },
  { key: 'output', label: 'Output', render: (r) => <span className="acr-dw-sum">{r.summary ?? '—'}</span> },
]

const EVIDENCE_COLUMNS: Array<Column<EvidenceRow>> = [
  { key: 'when', label: 'When', render: (e) => <>{when(e.at)}</> },
  { key: 'action', label: 'Action', render: (e) => <span className="acr-dw-act">{e.actionType}</span> },
  {
    key: 'campaign', label: 'Campaign',
    render: (e) => (
      <span className="acr-dw-ent" title={e.campaignName ?? e.entityId ?? undefined}>
        {e.campaignName ?? e.entityId ?? '—'}
        {e.reason && <span className="acr-dw-why">{e.reason}</span>}
      </span>
    ),
  },
  {
    key: 'result', label: 'Result',
    render: (e) => (
      <span className={`acr-dw-st ${e.status === 'SUCCESS' ? 'success' : e.status === 'FAILED' ? 'failed' : ''}`}>{e.status ?? '—'}</span>
    ),
  },
]

export function LeverDrawer({ engine, onClose, onRan }: {
  engine: { key: string; name: string; what: string; cron: string | null; mode: string; control?: LeverControl }
  onClose: () => void
  /** Let the parent refresh its rows once a manual run (or a switch move) has been accepted. */
  onRan?: () => void
}) {
  const [d, setD] = useState<EngineDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [ran, setRan] = useState<string | null>(null)

  // R16 — this business's own switch, set here directly (down at once; up after a confirmation, never past the env).
  const canSwitch = usePermission('ads.automation.manage')
  const switchKey = useCommandKey()
  const [control, setControl] = useState<LeverControl | undefined>(engine.control)
  useEffect(() => { setControl(engine.control) }, [engine.control])
  const [switching, setSwitching] = useState(false)
  const [switchState, setSwitchState] = useState<SwitchState>({ raise: null })
  const raise = switchState.raise
  const moveSwitch = async (to: LeverMode, confirmed: boolean) => {
    if (!control || switching) return
    setSwitching(true); setErr(null); setRan(null)
    try {
      const { response, body } = await sendCommand<{ ok?: boolean; mode?: LeverMode; error?: string }>(
        switchKey,
        `${getBackendUrl()}/api/advertising/automation/engine-switch/${engine.key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: to, ...(confirmed ? { confirm: true } : {}) }) },
      )
      if (!response.ok) throw new Error(body?.error ?? `Could not switch (${response.status})`)
      setControl({ ...control, switch: to === control.levels[control.levels.length - 1] ? null : { mode: to, setBy: 'user:you', setAt: new Date().toISOString(), reason: null } })
      setRan(`${engine.name} is ${to} for this business from its next run.`)
      onRan?.()
    } catch (e) { setErr((e as Error).message) } finally { setSwitching(false) }
  }
  // One step function (lever-control.ts `switchStep`) decides what the switch shows and sends; its tests drive it too.
  const step = (event: SwitchEvent) => {
    const next = switchStep(switchState, event)
    setSwitchState(next.state)
    if (next.send) void moveSwitch(next.send.to, next.send.confirm)
  }
  const chooseSwitch = (to: LeverMode) => { if (control) step({ type: 'choose', to, engineName: engine.name, control }) }

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/control-room/engine/${engine.key}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`engine: ${r.status}`)
      setD((await r.json()) as EngineDetail)
      setErr(null)
    } catch (e) { setErr((e as Error).message) }
  }, [engine.key])
  useEffect(() => { void load() }, [load])

  // Escape, the Tab trap and focus (in on open, back to the row that opened it on close) are the design system's
  // Drawer's; an open up-confirmation owns Escape itself (LeverConfirm).
  const cancelRaise = useCallback(() => setSwitchState({ raise: null }), [])

  /**
   * The manual trigger is the platform's existing generic one — the same endpoint the sync
   * hub uses, validated against the same registry this drawer asked about. No ads-specific
   * trigger route was invented for it; a second door to the same job is how the two
   * eventually behave differently.
   */
  const runNow = async () => {
    if (running || !d?.run.jobName) return
    setRunning(true); setErr(null); setRan(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/sync-logs/cron/${d.run.jobName}/trigger`, { method: 'POST' })
      if (!r.ok) throw new Error(`Could not start (${r.status})`)
      // 202 Accepted — the run is fire-and-forget, so this says "started", never "done".
      // Claiming completion here would be the same lie as an enqueued write reported as
      // "saved to Amazon".
      setRan('Started. The run writes its own row below as it progresses.')
      onRan?.()
      // Give the RUNNING row a moment to land, then show it.
      setTimeout(() => { void load() }, 1500)
    } catch (e) { setErr((e as Error).message) } finally { setRunning(false) }
  }

  const failing = d && d.health.runs14d > 0 && d.health.failures14d / d.health.runs14d > 0.2

  return (
    <Drawer
      open
      onClose={onClose}
      title={engine.name}
      subtitle={engine.what}
      width="min(760px, 94vw)"
      overlay={raise ? (
        <LeverConfirm
          impact={raise.impact}
          onCancel={cancelRaise}
          onConfirm={() => step({ type: 'confirm' })}
        />
      ) : undefined}
    >
        {/* While the up-confirmation is open the drawer behind it is inert: Tab stays in the confirmation. */}
        <div className="acr-dw-b" inert={raise ? true : undefined}>
          {engine.cron && <code className="acr-dw-cron">{engine.cron}</code>}
          {err && <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>}
          {ran && <div className="acr-banner ok" role="status"><CheckCircle2 size={15} /> {ran}</div>}

          {/* R16 — what decides it: the server setting (the outer limit) and this business's own switch under it. */}
          {control && <LeverSwitchSection control={control} inForce={engine.mode as LeverMode} canSwitch={canSwitch} busy={switching} onChoose={chooseSwitch} />}

          {!d ? <div className="acr-empty">Loading…</div> : <>
            {/* ── run now + the headline health ── */}
            <section className="acr-dw-sec">
              <div className="acr-dw-runbar">
                {d.run.available ? (
                  <Button variant="success" size="sm" disabled={running} onClick={() => void runNow()}>
                    {running ? <Loader2 size={14} className="acr-spin" /> : <Play size={14} />}
                    {running ? 'Starting…' : 'Run now'}
                  </Button>
                ) : (
                  <span className="acr-dw-norun">
                    <CircleSlash size={13} /> {d.run.why ?? 'No manual trigger for this engine.'}
                  </span>
                )}
                <dl className="acr-dw-health">
                  <div><dt>14 days</dt><dd className={failing ? 'bad' : undefined}>
                    {d.health.runs14d} run{d.health.runs14d === 1 ? '' : 's'}
                    {d.health.failures14d > 0 ? ` · ${d.health.failures14d} failed` : ''}
                  </dd></div>
                  <div><dt>By hand</dt><dd>{d.health.manual14d}</dd></div>
                </dl>
              </div>
              {/* A manual run of a live-write engine does exactly what its tick does. Saying so
                  beside the button is cheaper than an operator discovering it afterwards. */}
              {d.run.available && (
                <p className="acr-dw-hint">
                  Runs the same work the schedule runs. Every write still passes the gate — the
                  account halt, the allowlist, the bid bounds and any authority pins all bind a
                  manual run identically.
                </p>
              )}
              {d.lastSummary && (
                <p className="acr-dw-last"><span>Last output</span><code>{d.lastSummary}</code></p>
              )}
            </section>

            {/* ── run history ── */}
            <div className="acr-sec-head">
              <h2>Run history</h2>
              <span className="acr-sec-count">{d.runs.length ? `last ${d.runs.length}` : ''}</span>
            </div>
            {d.runs.length === 0 ? (
              <div className="acr-dw-none">
                This engine has never run. {engine.mode === 'OFF'
                  ? 'It is off, so that is expected.'
                  : 'It is not off, which is worth a look.'}
              </div>
            ) : (
              <DataGrid<EngineRun>
                className="acr-dw-tbl"
                rows={d.runs}
                rowKey={(r) => r.id}
                rowClassName={(r) => (r.status === 'FAILED' ? 'bad' : undefined)}
                columns={RUN_COLUMNS}
              />
            )}

            {/* ── evidence ── */}
            <div className="acr-sec-head">
              <h2>What it changed</h2>
              <span className="acr-sec-count">{d.evidence.length ? `last ${d.evidence.length}` : ''}</span>
            </div>
            {d.evidence.length === 0 ? (
              // The distinction that keeps this honest: an engine that writes no entity rows
              // is not an engine that failed to write any.
              <div className="acr-dw-none">{d.evidenceNote ?? 'Nothing recorded.'}</div>
            ) : (
              <DataGrid<EvidenceRow>
                className="acr-dw-tbl"
                rows={d.evidence}
                rowKey={(e) => e.id}
                columns={EVIDENCE_COLUMNS}
              />
            )}
          </>}
        </div>
    </Drawer>
  )
}
