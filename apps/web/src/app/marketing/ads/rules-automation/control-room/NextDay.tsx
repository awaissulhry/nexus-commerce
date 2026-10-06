'use client'

/**
 * CR rebuild 6 — History › Next 24 hours (was the Foresight tab), on the design system.
 *
 * Rank hand-overs are commitments — the hour is known and each one is a bid write — so they get the hour list, and
 * only the hours that hold one (the old tab drew 24 identical rows). Engine runs are opportunities — the run will
 * happen, what it writes depends on data that does not exist yet — so they get a cadence list and no claim about the
 * outcome. The server's notes are said in plain words; its own sentences, with their variable names, are kept under
 * Technical details.
 *
 * CR review: the account level holds this view too. At Ask me (or Off, or stopped) nothing here changes the ads by
 * itself, so the view says so and counts no engine as able to — the same meaning as the top tile "Runs alone".
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button, Pill } from '@/design-system/primitives'
import { Banner, Card, Disclosure, KeyValue, MetricStrip } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { getBackendUrl } from '@/lib/backend-url'
import {
  accountHoldWords, busyHours, cadenceIn, engineCanWords, enginesThatCan, hhmm, hourFlags, plainNotes, schedulesWords, zoneWords,
  type AccountHold, type Foresight, type ForesightEngine, type ForesightHour,
} from './historyWords'
import styles from './history.module.css'

/** `account`: the account level and stop (the levers endpoint's `global`); absent or null = the server's view alone. */
export function NextDay({ account }: { account?: AccountHold | null }) {
  const [f, setF] = useState<Foresight | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/control-room/foresight`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`The plan for the next 24 hours could not be read (${r.status}).`)
      setF((await r.json()) as Foresight)
      setErr(null)
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const recheck = <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={13} aria-hidden /> {loading ? 'Checking…' : 'Check again'}</Button>

  if (err) return <Banner tone="danger" title="Nothing to show" action={recheck}>{err}</Banner>
  if (!f) return <span className={styles.muted}>Reading…</span>

  const tz = f.timezone
  const busy = busyHours(f.hours)
  const nowAt = f.hours[0]?.at
  const notes = plainNotes(f.notes)
  const canWrite = enginesThatCan(f.engines, account)
  const hold = accountHoldWords(account, f.accountStopped)
  const blocked = f.engines.filter((e) => e.blockedReason && /\bNEXUS_[A-Z0-9_]+/.test(e.blockedReason))

  const hourColumns: Array<Column<ForesightHour>> = [
    { key: 'hour', label: 'Hour', render: (h) => <>{String(h.hour).padStart(2, '0')}:00{h.at === nowAt ? ' · now' : ''}</> },
    { key: 'changes', label: 'Bid changes', numeric: true, render: (h) => <>{h.bidChanges.toLocaleString('en-IE')}</> },
    {
      key: 'targets', label: 'Plan targets',
      render: (h) => (h.targets.length
        ? <span className={styles.chips}>{h.targets.map((t) => <Pill key={t.key} tone={t.key === 'pause' ? 'neutral' : t.key.includes('allout') ? 'warning' : 'info'} size="sm">{t.name} ×{t.schedules}</Pill>)}</span>
        : <>—</>),
    },
    {
      key: 'flags', label: 'Notes',
      render: (h) => {
        const flags = hourFlags(h)
        return flags.length ? <span className={styles.chips}>{flags.map((x) => <span key={x.label} title={x.title}><Pill tone={x.tone} size="sm">{x.label}</Pill></span>)}</span> : <>—</>
      },
    },
    {
      key: 'runs', label: 'Engine runs', numeric: true,
      render: (h) => <span title={h.engineRuns.map((r) => `${r.name} ×${r.fires}`).join('\n')}>{h.engineRuns.reduce((a, r) => a + r.fires, 0)}</span>,
    },
  ]

  const engineColumns: Array<Column<ForesightEngine>> = [
    { key: 'name', label: 'Engine', render: (e) => <>{e.name}</> },
    { key: 'cadence', label: 'How often', render: (e) => <span title={`${e.cron} (UTC) — shown in ${zoneWords(tz)}`}>{cadenceIn(e, tz)}</span> },
    {
      key: 'can', label: 'Can change your ads now',
      render: (e) => {
        const w = engineCanWords(e, account)
        return <span className={styles.wrap}><Pill tone={w.tone} size="sm">{w.label}</Pill>{w.why && <span className={styles.sub}>{w.why}</span>}</span>
      },
    },
    { key: 'fires', label: 'Runs in 24 h', numeric: true, render: (e) => <>{e.fires}</> },
    {
      key: 'next', label: 'Next runs',
      render: (e) => <>{e.nextFires.length ? `${e.nextFires.slice(0, 3).map((t) => hhmm(t, tz)).join(' · ')}${e.fires > 3 ? ` and ${e.fires - 3} more` : ''}` : '—'}</>,
    },
  ]

  return (
    <div className={styles.stack}>
      <Card header="Next 24 hours" description={`Times are ${zoneWords(tz)}.`} headerAction={recheck}>
        <div className={styles.stack}>
          <MetricStrip
            metrics={[
              {
                label: 'Planned bid changes',
                value: f.scheduledBidChanges == null ? '—' : f.scheduledBidChanges.toLocaleString('en-IE'),
                hint: schedulesWords(f.schedulesConsidered),
                accent: 'var(--nds-info)',
              },
              { label: 'Hours with a change', value: busy.length, hint: 'of the next 24', accent: 'var(--nds-border-strong)' },
              {
                label: 'Engines that can change your ads',
                value: canWrite,
                hint: `of the ${f.engines.length} ${f.engines.length === 1 ? 'engine' : 'engines'} listed below`,
                accent: canWrite > 0 ? 'var(--nds-success)' : 'var(--nds-border-strong)',
              },
            ]}
          />
          {hold && <Banner tone="warning" title={hold.title}>{hold.text}</Banner>}
          {notes.plain.map((n) => <Banner key={n} tone="info">{n}</Banner>)}
        </div>
      </Card>

      <Card header="Planned bid changes, hour by hour" description="Each planned bid change comes from an hourly bid plan.">
        {busy.length === 0
          ? <span className={styles.muted}>No bid change is planned in the next 24 hours.</span>
          : <DataGrid<ForesightHour> ariaLabel="Planned bid changes, hour by hour" rows={busy} rowKey={(h) => h.at} columns={hourColumns} />}
      </Card>

      <Card header="Engines" description="When each one runs — not what it will decide, which depends on data that does not exist yet.">
        <DataGrid<ForesightEngine>
          ariaLabel="When each engine runs"
          rows={f.engines}
          rowKey={(e) => e.key}
          columns={engineColumns}
          emptyState="No engine runs in the next 24 hours."
        />
      </Card>

      {(notes.technical.length > 0 || blocked.length > 0 || f.accountStoppedReason) && (
        <Disclosure summary="Technical details">
          <KeyValue
            items={[
              ...notes.technical.map((n, i) => ({ label: `Server note ${i + 1}`, value: n })),
              ...blocked.map((e) => ({ label: e.name, value: e.blockedReason ?? '' })),
              ...(f.accountStoppedReason ? [{ label: 'Why it is stopped', value: f.accountStoppedReason }] : []),
            ]}
          />
        </Disclosure>
      )}

      <p className={`${styles.para} ${styles.muted}`}>
        This plan comes from the same code the engines run, so it shows what they will do.
      </p>
    </div>
  )
}
