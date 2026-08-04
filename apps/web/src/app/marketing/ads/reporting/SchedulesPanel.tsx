'use client'

/**
 * RPT.6 — scheduled deliveries, on the Reporting landing page.
 *
 * Lives here rather than behind a new rail entry: scheduling is something you do
 * to a report you already have, so it belongs beside the library.
 *
 * The delivery log is the reason this panel exists at all. A scheduled report
 * that silently stops — or keeps arriving built on week-old data — is worse than
 * no report, because it is trusted. Every attempt is shown, including dry runs
 * and failures, and a stale-data warning is surfaced next to the row rather than
 * buried in the file.
 */
import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, Play, Trash2, AlertTriangle, ChevronDown } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Pill } from '@/design-system/primitives/Pill'
import type { Tone } from '@/design-system/primitives/tone'
import {
  createSchedule, deleteSchedule, listDeliveries, listSchedules, runScheduleNow,
  WINDOW_MODES, type Delivery, type Schedule,
} from './schedules-api'
import { listSaved, type SavedReport } from './saved-api'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const STATUS_TONE: Record<string, Tone> = {
  SENT: 'success', DRY_RUN: 'info', FAILED: 'danger',
}

/** "Every Monday at 08:00" — the schedule in the operator's own words. */
function cadence(s: Schedule): string {
  const at = `${String(s.hourLocal).padStart(2, '0')}:00`
  if (s.frequency === 'daily') return `Every day at ${at}`
  if (s.frequency === 'weekly') return `Every ${DAYS[(s.dayOfWeek ?? 1) - 1]} at ${at}`
  return `Day ${s.dayOfMonth ?? 1} of each month at ${at}`
}

export function SchedulesPanel() {
  const [items, setItems] = useState<Schedule[]>([])
  const [saved, setSaved] = useState<SavedReport[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [logFor, setLogFor] = useState<Schedule | null>(null)
  const [log, setLog] = useState<Delivery[]>([])

  const [form, setForm] = useState({
    savedReportId: '', recipients: '', format: 'xlsx',
    windowMode: 'last30', frequency: 'weekly', hourLocal: 8, dayOfWeek: 1, dayOfMonth: 1,
  })

  const reload = useCallback(() => {
    Promise.all([listSchedules(), listSaved()])
      .then(([s, sv]) => { setItems(s); setSaved(sv) })
      .catch((e: unknown) => setError((e as Error).message))
  }, [])
  useEffect(() => { reload() }, [reload])

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const submit = () => guard(async () => {
    await createSchedule({
      ...form,
      dayOfWeek: form.frequency === 'weekly' ? form.dayOfWeek : null,
      dayOfMonth: form.frequency === 'monthly' ? form.dayOfMonth : null,
    })
    setOpen(false); reload()
  })

  const sendNow = (s: Schedule) => guard(async () => {
    const r = await runScheduleNow(s.id)
    setError(
      r.status === 'DRY_RUN'
        ? `Dry run complete — ${r.rows.toLocaleString('en-GB')} rows built into ${r.fileName}. Nothing was emailed: outbound email is off.`
        : r.status === 'SENT'
          ? `Sent — ${r.rows.toLocaleString('en-GB')} rows to ${s.recipients}.`
          : `Failed — ${r.error}`,
    )
    reload()
  })

  const showLog = (s: Schedule) => guard(async () => {
    setLog(await listDeliveries(s.id)); setLogFor(s)
  })

  return (
    <section className="rpt-group">
      <h2 className="rpt-group-hd">
        Scheduled deliveries <span className="count">{items.length}</span>
      </h2>

      <div className="rpt-sched">
        {items.length === 0 && (
          <p className="rpt-sched-empty">
            No schedules yet. Save a report first, then schedule it to arrive by email.
          </p>
        )}

        {items.map((s) => (
          <div key={s.id} className={`rpt-sched-row${s.isActive ? '' : ' is-off'}`}>
            <div className="main">
              <div className="nm">
                <CalendarClock size={13} aria-hidden />
                <b>{s.savedReportName}</b>
                {!s.isActive && <Pill tone="neutral">Paused</Pill>}
              </div>
              <div className="sub">
                {cadence(s)} · {WINDOW_MODES.find((w) => w.value === s.windowMode)?.label ?? s.windowMode}
                {' · '}{s.format.toUpperCase()} to {s.recipients}
              </div>
              {s.lastDelivery && (
                <div className="last">
                  <Pill tone={STATUS_TONE[s.lastDelivery.status] ?? 'neutral'}>
                    {s.lastDelivery.status === 'DRY_RUN' ? 'Dry run' : s.lastDelivery.status}
                  </Pill>
                  <span>
                    {new Date(s.lastDelivery.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                    {' · '}{s.lastDelivery.rows.toLocaleString('en-GB')} rows
                  </span>
                  {s.lastDelivery.staleNote && (
                    <span className="stale">
                      <AlertTriangle size={11} aria-hidden /> {s.lastDelivery.staleNote}
                    </span>
                  )}
                  {s.lastDelivery.error && <span className="err">{s.lastDelivery.error}</span>}
                </div>
              )}
            </div>
            <div className="acts">
              <button type="button" className="rpt-restore" disabled={busy} onClick={() => sendNow(s)}>
                <Play size={11} aria-hidden /> Run now
              </button>
              <button type="button" className="rpt-restore" disabled={busy} onClick={() => showLog(s)}>
                <ChevronDown size={11} aria-hidden /> Log
              </button>
              <button
                type="button"
                className="rpt-restore danger"
                disabled={busy}
                onClick={() => guard(async () => { await deleteSchedule(s.id); reload() })}
              >
                <Trash2 size={11} aria-hidden />
              </button>
            </div>
          </div>
        ))}

        <div className="rpt-sched-foot">
          <Button size="sm" variant="secondary" disabled={busy || saved.length === 0} onClick={() => {
            setForm((f) => ({ ...f, savedReportId: saved[0]?.id ?? '' }))
            setOpen(true)
          }}>
            <CalendarClock size={13} aria-hidden /> New schedule
          </Button>
          {saved.length === 0 && <span className="rpt-sched-empty">Save a report first.</span>}
        </div>

        {error && <p className="rpt-sched-msg" role="status">{error}</p>}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Schedule a report"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={busy || !form.savedReportId || !form.recipients.trim()} onClick={submit}>
              Create schedule
            </Button>
          </>
        }
      >
        <p className="rpt-modal-p">
          The window is re-resolved on every send, so a weekly report keeps moving forward
          instead of mailing the same fixed dates for ever.
        </p>
        <div className="rpt-form">
          <label className="rpt-field">
            <span>Saved report</span>
            <select className="rpt-input" value={form.savedReportId}
              onChange={(e) => setForm((f) => ({ ...f, savedReportId: e.target.value }))}>
              {saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="rpt-field">
            <span>Recipients</span>
            <input className="rpt-input" placeholder="you@example.com, ops@example.com"
              value={form.recipients}
              onChange={(e) => setForm((f) => ({ ...f, recipients: e.target.value }))} />
          </label>
          <label className="rpt-field">
            <span>Window</span>
            <select className="rpt-input" value={form.windowMode}
              onChange={(e) => setForm((f) => ({ ...f, windowMode: e.target.value }))}>
              {WINDOW_MODES.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          </label>
          <label className="rpt-field">
            <span>Format</span>
            <select className="rpt-input" value={form.format}
              onChange={(e) => setForm((f) => ({ ...f, format: e.target.value }))}>
              <option value="xlsx">Excel — formatted, with manifest</option>
              <option value="csv">CSV — raw numbers</option>
            </select>
          </label>
          <label className="rpt-field">
            <span>Frequency</span>
            <select className="rpt-input" value={form.frequency}
              onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value }))}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label className="rpt-field">
            <span>Hour (Rome)</span>
            <select className="rpt-input" value={form.hourLocal}
              onChange={(e) => setForm((f) => ({ ...f, hourLocal: Number(e.target.value) }))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
          </label>
          {form.frequency === 'weekly' && (
            <label className="rpt-field">
              <span>Day</span>
              <select className="rpt-input" value={form.dayOfWeek}
                onChange={(e) => setForm((f) => ({ ...f, dayOfWeek: Number(e.target.value) }))}>
                {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
              </select>
            </label>
          )}
          {form.frequency === 'monthly' && (
            <label className="rpt-field">
              <span>Day of month</span>
              <select className="rpt-input" value={form.dayOfMonth}
                onChange={(e) => setForm((f) => ({ ...f, dayOfMonth: Number(e.target.value) }))}>
                {Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
              </select>
            </label>
          )}
        </div>
      </Modal>

      <Modal
        open={!!logFor}
        onClose={() => setLogFor(null)}
        title={logFor ? `Delivery log — ${logFor.savedReportName}` : 'Delivery log'}
        footer={<Button variant="secondary" onClick={() => setLogFor(null)}>Close</Button>}
      >
        {log.length === 0 && <p className="rpt-modal-p">Nothing sent yet.</p>}
        <ol className="rpt-versions">
          {log.map((d) => (
            <li key={d.id}>
              <div className="hd">
                <Pill tone={STATUS_TONE[d.status] ?? 'neutral'}>
                  {d.status === 'DRY_RUN' ? 'Dry run' : d.status}
                </Pill>
                <span className="when">
                  {new Date(d.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                <b style={{ marginLeft: 'auto' }}>{d.rows.toLocaleString('en-GB')} rows</b>
              </div>
              <div className="note">
                {d.windowFrom} → {d.windowTo}
                {d.fileName ? ` · ${d.fileName}` : ''}
                {d.durationMs ? ` · ${d.durationMs} ms` : ''}
                {d.staleNote && <><br /><b>Stale:</b> {d.staleNote}</>}
                {d.error && <><br /><b>Error:</b> {d.error}</>}
              </div>
            </li>
          ))}
        </ol>
      </Modal>
    </section>
  )
}
