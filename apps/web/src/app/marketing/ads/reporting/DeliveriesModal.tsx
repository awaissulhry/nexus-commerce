'use client'

/**
 * R6 — one place for everything that leaves this console.
 *
 * Export, share links and scheduled email were three unrelated surfaces in two places. The
 * worst of it was scheduling: the panel lived on the LIBRARY page, so to schedule the report
 * you were looking at you had to save it, leave the runner, go back to the library, scroll to
 * the bottom and find it again in a dropdown — five steps across two pages for one intent. And
 * a share link, once minted, appeared only inside the modal that minted it; there was nowhere
 * to see what was still live, or revoke it.
 *
 * They are all one question — *get this report to someone* — so they are now one menu on the
 * report itself, and this modal is where the standing ones are managed. The landing page went
 * back to being a chooser.
 *
 * Three views, one modal, rather than modals opening modals: the list, the create form, and one
 * schedule's delivery log. The log is the reason any of this is trustworthy — a scheduled report
 * that silently stops, or keeps arriving built on week-old data, is worse than no report,
 * because it is believed. Every attempt shows, dry runs and failures included, and a stale-data
 * warning sits beside the row rather than buried in the file.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, CalendarClock, Link2, Play, Trash2 } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Pill } from '@/design-system/primitives/Pill'
import type { Tone } from '@/design-system/primitives/tone'
import { Input } from '@/design-system/primitives/Input'
import { Select } from '@/design-system/primitives/Select'
import { ToolbarButton } from '@/design-system/primitives/ToolbarButton'
import {
  createSchedule, deleteSchedule, listDeliveries, listSchedules, runScheduleNow,
  WINDOW_MODES, type Delivery, type Schedule,
} from './schedules-api'
import { listShareLinks, revokeShareLink, type ShareLink } from './shares-api'
import { listSaved, type SavedReport } from './saved-api'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const STATUS_TONE: Record<string, Tone> = { SENT: 'success', DRY_RUN: 'info', FAILED: 'danger' }

/** "Every Monday at 08:00" — the schedule in the operator's own words. */
function cadence(s: Schedule): string {
  const at = `${String(s.hourLocal).padStart(2, '0')}:00`
  if (s.frequency === 'daily') return `Every day at ${at}`
  if (s.frequency === 'weekly') return `Every ${DAYS[(s.dayOfWeek ?? 1) - 1]} at ${at}`
  return `Day ${s.dayOfMonth ?? 1} of each month at ${at}`
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

export type DeliveriesView = 'list' | 'new'

export function DeliveriesModal({
  open, onClose, initialView = 'list', reportId,
}: {
  open: boolean
  onClose: () => void
  initialView?: DeliveriesView
  /** Preselects a saved definition of the report you are looking at, when there is one. */
  reportId?: string
}) {
  const [view, setView] = useState<DeliveriesView | 'log'>(initialView)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [shares, setShares] = useState<ShareLink[]>([])
  const [saved, setSaved] = useState<SavedReport[]>([])
  const [logFor, setLogFor] = useState<Schedule | null>(null)
  const [log, setLog] = useState<Delivery[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [form, setForm] = useState({
    savedReportId: '', recipients: '', format: 'xlsx',
    windowMode: 'last30', frequency: 'weekly', hourLocal: 8, dayOfWeek: 1, dayOfMonth: 1,
  })

  const reload = useCallback(() => {
    Promise.all([listSchedules(), listShareLinks(), listSaved()])
      .then(([sc, sh, sv]) => {
        setSchedules(sc)
        setShares(sh)
        setSaved(sv)
        setForm((f) => (f.savedReportId ? f : {
          ...f,
          // Default to a saved definition OF THIS REPORT when one exists, so the common case
          // needs no thought; otherwise the first saved report, as before.
          savedReportId: sv.find((s) => s.reportId === reportId)?.id ?? sv[0]?.id ?? '',
        }))
      })
      .catch((e: unknown) => setError((e as Error).message))
  }, [reportId])

  useEffect(() => { if (open) { setView(initialView); setError(null); reload() } }, [open, initialView, reload])

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
    setView('list'); reload()
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
    setLog(await listDeliveries(s.id)); setLogFor(s); setView('log')
  })

  const title = view === 'new' ? 'Schedule a report'
    : view === 'log' ? `Delivery log — ${logFor?.savedReportName ?? ''}`
      : 'Deliveries'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={view === 'new' ? (
        <>
          <Button variant="secondary" onClick={() => setView('list')}>Back</Button>
          <Button disabled={busy || !form.savedReportId || !form.recipients.trim()} onClick={submit}>
            Create schedule
          </Button>
        </>
      ) : view === 'log' ? (
        <Button variant="secondary" onClick={() => setView('list')}>Back</Button>
      ) : (
        <Button variant="secondary" onClick={onClose}>Close</Button>
      )}
    >
      {view === 'list' && (
        <>
          <h4 className="rpt-dl-h">
            <CalendarClock size={13} aria-hidden /> Scheduled email
            <span className="n">{schedules.length}</span>
          </h4>

          {schedules.length === 0 && (
            <p className="rpt-modal-p">
              Nothing scheduled. A schedule sends a saved report by email on a cadence you set.
            </p>
          )}

          {schedules.map((s) => (
            <div key={s.id} className={`rpt-sched-row${s.isActive ? '' : ' is-off'}`}>
              <div className="main">
                <div className="nm">
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
                    <span>{when(s.lastDelivery.createdAt)} · {s.lastDelivery.rows.toLocaleString('en-GB')} rows</span>
                    {s.lastDelivery.staleNote && (
                      <span className="stale"><AlertTriangle size={11} aria-hidden /> {s.lastDelivery.staleNote}</span>
                    )}
                    {s.lastDelivery.error && <span className="err">{s.lastDelivery.error}</span>}
                  </div>
                )}
              </div>
              <div className="acts">
                <Button size="sm" disabled={busy} onClick={() => sendNow(s)}>
                  <Play size={12} aria-hidden /> Run now
                </Button>
                <Button size="sm" disabled={busy} onClick={() => showLog(s)}>
                  Log
                </Button>
                <ToolbarButton
                  icon={<Trash2 size={13} />}
                  label={`Delete the schedule for ${s.savedReportName}`}
                  disabled={busy}
                  onClick={() => guard(async () => { await deleteSchedule(s.id); reload() })}
                />
              </div>
            </div>
          ))}

          <div className="rpt-sched-foot">
            <Button size="sm" variant="secondary" disabled={busy || saved.length === 0} onClick={() => setView('new')}>
              <CalendarClock size={13} aria-hidden /> New schedule
            </Button>
            {saved.length === 0 && (
              <span className="rpt-sched-empty">Save a report first — the bar above the grid does it.</span>
            )}
          </div>

          <h4 className="rpt-dl-h">
            <Link2 size={13} aria-hidden /> Share links
            <span className="n">{shares.filter((s) => s.isActive).length}</span>
          </h4>

          {shares.length === 0 && (
            <p className="rpt-modal-p">
              No links minted. A share link is read-only and expires on its own.
            </p>
          )}

          {shares.map((s) => (
            <div key={s.id} className={`rpt-sched-row${s.isActive ? '' : ' is-off'}`}>
              <div className="main">
                <div className="nm">
                  <b>{s.label || s.reportId}</b>
                  {!s.isActive && (
                    <Pill tone="neutral">{s.revokedAt ? 'Revoked' : 'Expired'}</Pill>
                  )}
                </div>
                <div className="sub">
                  {s.reportId} · expires {when(s.expiresAt)}
                  {' · '}{s.viewCount} {s.viewCount === 1 ? 'view' : 'views'}
                  {s.lastViewedAt ? `, last ${when(s.lastViewedAt)}` : ''}
                </div>
              </div>
              <div className="acts">
                {s.isActive && (
                  <Button
                    size="sm" variant="danger" disabled={busy}
                    onClick={() => guard(async () => { await revokeShareLink(s.id); reload() })}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      {view === 'new' && (
        <>
          <p className="rpt-modal-p">
            The window is re-resolved on every send, so a weekly report keeps moving forward
            instead of mailing the same fixed dates for ever.
          </p>
          <div className="rpt-form">
            <label className="rpt-field">
              <span>Saved report</span>
              <Select value={form.savedReportId}
                onChange={(e) => setForm((f) => ({ ...f, savedReportId: e.target.value }))}>
                {saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </label>
            <label className="rpt-field">
              <span>Recipients</span>
              <Input placeholder="you@example.com, ops@example.com"
                value={form.recipients}
                onChange={(e) => setForm((f) => ({ ...f, recipients: e.target.value }))} />
            </label>
            <label className="rpt-field">
              <span>Window</span>
              <Select value={form.windowMode}
                onChange={(e) => setForm((f) => ({ ...f, windowMode: e.target.value }))}>
                {WINDOW_MODES.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </Select>
            </label>
            <label className="rpt-field">
              <span>Format</span>
              <Select value={form.format}
                onChange={(e) => setForm((f) => ({ ...f, format: e.target.value }))}>
                <option value="xlsx">Excel — formatted, with manifest</option>
                <option value="csv">CSV — raw numbers</option>
              </Select>
            </label>
            <label className="rpt-field">
              <span>Frequency</span>
              <Select value={form.frequency}
                onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value }))}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </label>
            <label className="rpt-field">
              <span>Hour (Rome)</span>
              <Select value={form.hourLocal}
                onChange={(e) => setForm((f) => ({ ...f, hourLocal: Number(e.target.value) }))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                ))}
              </Select>
            </label>
            {form.frequency === 'weekly' && (
              <label className="rpt-field">
                <span>Day</span>
                <Select value={form.dayOfWeek}
                  onChange={(e) => setForm((f) => ({ ...f, dayOfWeek: Number(e.target.value) }))}>
                  {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
                </Select>
              </label>
            )}
            {form.frequency === 'monthly' && (
              <label className="rpt-field">
                <span>Day of month</span>
                <Select value={form.dayOfMonth}
                  onChange={(e) => setForm((f) => ({ ...f, dayOfMonth: Number(e.target.value) }))}>
                  {Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                </Select>
              </label>
            )}
          </div>
        </>
      )}

      {view === 'log' && (
        <>
          <Button variant="link" onClick={() => setView('list')}>
            <ArrowLeft size={14} aria-hidden /> All deliveries
          </Button>
          {log.length === 0 && <p className="rpt-modal-p">Nothing sent yet.</p>}
          <ol className="rpt-versions">
            {log.map((d) => (
              <li key={d.id}>
                <div className="hd">
                  <Pill tone={STATUS_TONE[d.status] ?? 'neutral'}>
                    {d.status === 'DRY_RUN' ? 'Dry run' : d.status}
                  </Pill>
                  <span className="when">{when(d.createdAt)}</span>
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
        </>
      )}

      {error && <p className="rpt-sched-msg" role="status">{error}</p>}
    </Modal>
  )
}
