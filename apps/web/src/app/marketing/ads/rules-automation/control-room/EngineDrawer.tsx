'use client'

/**
 * CR rebuild 2 — one engine, opened from its Who acts row. Replaces the old lever drawer (ACR.1.2b) on the design
 * system, in plain words.
 *
 * In the order the questions get asked: what it may do now and why · its level for this business (every move asks
 * first) · Run now (asks first) · its last runs · what it changed. The server's own sentences, with their variable
 * names, stay under Technical details for whoever needs them.
 *
 * "No rows" is the normal case for most engines, so the drawer says which of the three reasons it is: the engine writes
 * no per-entity rows by design, it has written nothing in the window, or it has never run.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Pill, type Tone } from '@/design-system/primitives'
import { Banner, Card, Disclosure, Drawer, KeyValue } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { usePermission } from '@/lib/auth/AuthProvider'
import { sendCommand, useCommandKey } from '@/lib/command-key'
import { getBackendUrl } from '@/lib/backend-url'
import { Play } from 'lucide-react'
import { LeverConfirm } from './LeverConfirm'
import { LeverSwitchSection } from './LeverSwitch'
import { runNowImpact, switchStep, type LeverMode, type SwitchEvent, type SwitchState } from './lever-control'
import { LEVEL_WORD, withoutServerNames } from './levelWords'
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import type { ActorRow, Engine } from './whoActs'
import { agoWords, whenWords } from './timeWords'
import styles from './room.module.css'

interface EngineRun {
  id: string; startedAt: string; finishedAt: string | null; status: string
  triggeredBy: string | null; summary: string | null; durationMs: number | null
}
interface EvidenceRow {
  id: string; at: string; actionType: string; entityType: string | null; entityId: string | null
  campaignName: string | null; status: string | null; reason: string | null
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

const dur = (ms: number | null) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`)

const STATUS_TONE: Record<string, Tone> = { SUCCESS: 'success', FAILED: 'danger', RUNNING: 'info' }
const statusPill = (status: string | null) => (
  <Pill tone={STATUS_TONE[status ?? ''] ?? 'neutral'} size="sm">{status ? status.charAt(0) + status.slice(1).toLowerCase() : '—'}</Pill>
)

const RUN_COLUMNS: Array<Column<EngineRun>> = [
  { key: 'when', label: 'When', render: (r) => <>{whenWords(r.startedAt)}{r.triggeredBy === 'manual' ? ' · by hand' : ''}</> },
  { key: 'status', label: 'Result', render: (r) => statusPill(r.status) },
  { key: 'took', label: 'Took', align: 'right', render: (r) => <>{dur(r.durationMs)}</> },
  { key: 'output', label: 'What it said', render: (r) => <span className={styles.wrapText}>{r.summary ?? '—'}</span> },
]

const EVIDENCE_COLUMNS: Array<Column<EvidenceRow>> = [
  { key: 'when', label: 'When', render: (e) => <>{whenWords(e.at)}</> },
  { key: 'action', label: 'Change', render: (e) => <>{e.actionType.replace(/_/g, ' ').toLowerCase()}</> },
  {
    key: 'campaign', label: 'Campaign',
    render: (e) => (
      <span className={styles.wrapText}>
        {e.campaignName ?? e.entityId ?? '—'}
        {e.reason && <span className={styles.cellSub}>{e.reason}</span>}
      </span>
    ),
  },
  { key: 'result', label: 'Result', render: (e) => statusPill(e.status) },
]

export function EngineDrawer({ row, onClose, onChanged }: {
  row: ActorRow & { engine: Engine }
  onClose: () => void
  /** The list reloads after a level move or a manual run, so its row cannot disagree with the drawer. */
  onChanged: () => void
}) {
  const engine = row.engine
  const [d, setD] = useState<EngineDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canSwitch = usePermission('ads.automation.manage')
  // The manual trigger is the sync hub's, behind its own permission (permissions-manifest.ts): say so before the tick.
  const canRun = usePermission('sync.manage')
  const switchKey = useCommandKey()
  const [switchState, setSwitchState] = useState<SwitchState>({ pending: null })
  const [runAsk, setRunAsk] = useState<ActionImpact | null>(null)
  const control = engine.control

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/control-room/engine/${engine.key}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`The engine's record could not be read (${r.status}).`)
      setD((await r.json()) as EngineDetail)
    } catch (e) { setErr((e as Error).message) }
  }, [engine.key])
  useEffect(() => { void load() }, [load])

  const moveSwitch = async (to: LeverMode, confirmed: boolean) => {
    if (!control || busy) return
    setBusy(true); setErr(null); setDone(null)
    try {
      const { response, body } = await sendCommand<{ ok?: boolean; error?: string }>(
        switchKey,
        `${getBackendUrl()}/api/advertising/automation/engine-switch/${engine.key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: to, ...(confirmed ? { confirm: true } : {}) }) },
      )
      if (!response.ok) throw new Error(body?.error ?? `Could not change the level (${response.status}).`)
      setDone(`${engine.name} is at ${LEVEL_WORD[to]} for this business from its next run.`)
      onChanged()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  // One step function (lever-control.ts `switchStep`) decides what the switch shows and sends; its tests drive it too.
  const step = (event: SwitchEvent) => {
    const next = switchStep(switchState, event)
    setSwitchState(next.state)
    if (next.send) void moveSwitch(next.send.to, next.send.confirm)
  }
  const cancelAsk = useCallback(() => { setSwitchState({ pending: null }); setRunAsk(null) }, [])

  /** The platform's own manual trigger (the sync hub's); 202 means started, never done. */
  const runNow = async () => {
    if (busy || !d?.run.jobName) return
    setRunAsk(null); setBusy(true); setErr(null); setDone(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/sync-logs/cron/${d.run.jobName}/trigger`, { method: 'POST' })
      if (!r.ok) throw new Error(r.status === 403 ? 'Running an engine by hand needs the sync permission.' : `Could not start it (${r.status}).`)
      setDone('Started. Its run shows in Last runs below as it goes.')
      onChanged()
      setTimeout(() => { void load() }, 1500)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const ask = switchState.pending?.impact ?? runAsk
  const onConfirm = () => { if (runAsk) void runNow(); else step({ type: 'confirm' }) }

  return (
    <Drawer
      open
      onClose={onClose}
      title={engine.name}
      subtitle={engine.what}
      width="min(760px, 94vw)"
      overlay={ask ? <LeverConfirm impact={ask} onCancel={cancelAsk} onConfirm={onConfirm} /> : undefined}
    >
      {/* While a confirmation is open the drawer behind it is inert: Tab stays in the confirmation. */}
      <div className={styles.stack} inert={ask ? true : undefined}>
        {err && <Banner tone="danger" title="Something went wrong">{err}</Banner>}
        {done && <Banner tone="success" title={done} />}
        {row.problem && <Banner tone="warning" title="Needs a look">{row.problem}</Banner>}

        <KeyValue
          columns={2}
          items={[
            { label: 'May do now', value: LEVEL_WORD[row.inForce], hint: row.why },
            { label: 'Runs', value: engine.schedule ?? '—' },
            { label: 'Last run', value: agoWords(engine.lastRunAt), hint: engine.lastRunSummary ?? undefined },
            { label: 'Last 7 days', value: row.week },
          ]}
        />

        {control && (
          <Card header="Level">
            <LeverSwitchSection
              control={control}
              canSwitch={canSwitch}
              busy={busy}
              onChoose={(to) => step({ type: 'choose', to, engineName: engine.name, control })}
            />
          </Card>
        )}

        <Card header="Run it now">
          {!d ? <span className={styles.muted}>Reading…</span> : d.run.available ? (
            <div className={styles.stack}>
              <span className={styles.muted}>It runs the work its schedule runs, once. Every change still passes your limits.</span>
              <div>
                <Button size="sm" variant="secondary" disabled={busy || !canRun} onClick={() => setRunAsk(runNowImpact(engine.name))}>
                  <Play size={14} aria-hidden /> Run now…
                </Button>
              </div>
              {!canRun && <span className={styles.muted}>Running an engine by hand needs the sync permission.</span>}
            </div>
          ) : (
            <span className={styles.muted}>{withoutServerNames(d.run.why, 'It cannot be run by hand while the server keeps it off.')}</span>
          )}
        </Card>

        <Card header="Last runs" description={d ? `Last 14 days: ${d.health.runs14d} ${d.health.runs14d === 1 ? 'run' : 'runs'}${d.health.failures14d ? ` · ${d.health.failures14d} failed` : ''} · ${d.health.manual14d} by hand` : undefined}>
          {!d ? <span className={styles.muted}>Reading…</span> : d.runs.length === 0
            ? <span className={styles.muted}>It has never run.{engine.mode === 'OFF' ? ' It is off, so that is expected.' : ' It is not off, so that is worth a look.'}</span>
            : <DataGrid<EngineRun> rows={d.runs} rowKey={(r) => r.id} columns={RUN_COLUMNS} />}
        </Card>

        <Card header="What it changed">
          {!d ? <span className={styles.muted}>Reading…</span> : d.evidence.length === 0
            ? <span className={styles.muted}>{withoutServerNames(d.evidenceNote, 'Nothing recorded.')}</span>
            : <DataGrid<EvidenceRow> rows={d.evidence} rowKey={(e) => e.id} columns={EVIDENCE_COLUMNS} />}
        </Card>

        <Disclosure summary="Technical details">
          <KeyValue
            items={[
              { label: 'Job', value: engine.cron ?? '—' },
              { label: 'What the server says', value: engine.modeReason || '—' },
              ...(control ? [{ label: 'Server setting', value: control.env.reason || '—' }] : []),
              ...(d?.run.why ? [{ label: 'Run now', value: d.run.why }] : []),
              ...(d?.evidenceNote ? [{ label: 'What it changed', value: d.evidenceNote }] : []),
              { label: 'When the account is stopped', value: engine.haltBehaviour === 'exempt' ? 'It keeps running (it only reads or watches).' : engine.haltBehaviour === 'gated' ? 'It keeps checking, and its changes are refused.' : 'It stops.' },
            ]}
          />
        </Disclosure>
      </div>
    </Drawer>
  )
}
