/**
 * RPT.6 — scheduled delivery of saved reports.
 *
 * Two things here do the real work:
 *
 * 1. **Relative windows.** A saved report stores absolute dates. Mailing that on
 *    a cron would deliver the same frozen fortnight every week forever — the
 *    classic way a scheduled report becomes wallpaper. `windowMode` re-resolves
 *    the range at send time, and every mode ends YESTERDAY, never today: ads data
 *    lags at least a day, so "today" is always a partial figure that would make
 *    every report look like a collapse.
 *
 * 2. **Freshness recorded at send time.** A file that arrived on schedule can
 *    still be built on week-old data. Every delivery stores the per-market
 *    freshest day, and a stale market produces a warning IN THE EMAIL BODY as
 *    well as in the log — because by the time anyone questions the number, the
 *    screen that could have explained it has moved on.
 *
 * Sending is gated by the shared transport's NEXUS_ENABLE_OUTBOUND_EMAILS flag,
 * so with it unset every run is a full dry run: the report is really built, the
 * file is really produced, the delivery is really logged — nothing leaves the
 * building. That makes "does my schedule work?" answerable without mailing
 * anyone.
 */
import prisma from '../../db.js'
import { sendEmail } from '../email/transport.js'
import { exportReport, type ExportFormat } from './ads-report-export.service.js'
import { reportFreshness } from './ads-report-runner.service.js'
import { toReportQuery, type SavedQuery } from './ads-saved-reports.service.js'

export type WindowMode =
  | 'saved' | 'last7' | 'last30' | 'last90'
  | 'prevWeek' | 'prevMonth' | 'monthToDate'

export const WINDOW_MODES: Array<{ value: WindowMode; label: string }> = [
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'prevWeek', label: 'Previous week (Mon–Sun)' },
  { value: 'prevMonth', label: 'Previous calendar month' },
  { value: 'monthToDate', label: 'Month to date' },
  { value: 'saved', label: 'Fixed dates from the saved report' },
]

const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: Date, n: number) => {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() + n)
  return x
}

/**
 * Resolve a relative window against a reference day.
 *
 * Every mode ends on `yesterday` rather than `now`: the daily ads feed lands a
 * day or more behind, so including today would append a partial day and make
 * every scheduled report show a phantom drop at the end.
 */
export function resolveWindow(
  mode: WindowMode,
  saved: SavedQuery,
  now: Date,
): { from: string | null; to: string | null } {
  if (mode === 'saved') return { from: saved.from, to: saved.to }

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const yesterday = addDays(today, -1)

  switch (mode) {
    case 'last7': return { from: iso(addDays(yesterday, -6)), to: iso(yesterday) }
    case 'last30': return { from: iso(addDays(yesterday, -29)), to: iso(yesterday) }
    case 'last90': return { from: iso(addDays(yesterday, -89)), to: iso(yesterday) }
    case 'prevWeek': {
      // ISO week: Monday start. getUTCDay() is 0=Sunday, so map Sunday to 7.
      const dow = today.getUTCDay() === 0 ? 7 : today.getUTCDay()
      const thisMonday = addDays(today, -(dow - 1))
      return { from: iso(addDays(thisMonday, -7)), to: iso(addDays(thisMonday, -1)) }
    }
    case 'prevMonth': {
      const firstThis = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      const lastPrev = addDays(firstThis, -1)
      return { from: iso(new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1))), to: iso(lastPrev) }
    }
    case 'monthToDate': {
      const firstThis = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      // A schedule firing on the 1st has no month-to-date yet — fall back to the
      // previous month rather than sending an empty file.
      if (yesterday < firstThis) return resolveWindow('prevMonth', saved, now)
      return { from: iso(firstThis), to: iso(yesterday) }
    }
    default: return { from: saved.from, to: saved.to }
  }
}

/** Lag past which a daily feed is behind. Matches the library's daily threshold. */
const STALE_AFTER_DAYS = 3

function staleNoteFor(
  freshness: Array<{ marketplace: string; lastDay: string | null; rows: number }>,
  windowTo: string | null,
): string | null {
  if (!windowTo) return null
  const target = Date.parse(`${windowTo}T00:00:00Z`)
  if (Number.isNaN(target)) return null
  const behind = freshness
    .filter((f) => f.lastDay && f.rows > 0)
    .map((f) => ({ m: f.marketplace, lag: Math.round((target - Date.parse(`${f.lastDay}T00:00:00Z`)) / 86_400_000) }))
    .filter((f) => f.lag > STALE_AFTER_DAYS)
    .sort((a, b) => b.lag - a.lag)
  if (!behind.length) return null
  return behind.map((b) => `${b.m} is ${b.lag} days behind the end of this window`).join('; ')
}

export interface RunResult {
  status: 'SENT' | 'DRY_RUN' | 'FAILED'
  rows: number
  fileName: string | null
  fileBytes: number | null
  windowFrom: string | null
  windowTo: string | null
  staleNote: string | null
  error: string | null
  durationMs: number
  deliveryId: string
}

/**
 * Build and deliver one schedule now. Used by the cron AND by the operator's
 * "Send now" button — one path, so a manual test exercises exactly what the
 * cron will do rather than a convenient approximation.
 */
export async function runSchedule(scheduleId: string, now = new Date()): Promise<RunResult> {
  const started = Date.now()
  const schedule = await prisma.reportSchedule.findUnique({
    where: { id: scheduleId },
    include: { savedReport: true },
  })
  if (!schedule) throw new Error(`Schedule ${scheduleId} not found`)

  const saved = schedule.savedReport.query as unknown as SavedQuery
  const win = resolveWindow(schedule.windowMode as WindowMode, saved, now)
  const query = { ...saved, from: win.from, to: win.to }
  const format = (schedule.format === 'csv' ? 'csv' : 'xlsx') as ExportFormat
  const recipients = schedule.recipients.split(',').map((s) => s.trim()).filter(Boolean)

  let result: RunResult = {
    status: 'FAILED', rows: 0, fileName: null, fileBytes: null,
    windowFrom: win.from, windowTo: win.to, staleNote: null,
    error: null, durationMs: 0, deliveryId: '',
  }

  try {
    if (!recipients.length) throw new Error('No recipients configured')

    const [out, fresh] = await Promise.all([
      exportReport(toReportQuery(query, null), format),
      reportFreshness(toReportQuery(query, null)),
    ])
    const staleNote = staleNoteFor(fresh.byMarket, win.to)

    const windowLabel = `${win.from ?? 'any'} → ${win.to ?? 'any'}`
    const send = await sendEmail({
      to: recipients,
      subject: `${schedule.savedReport.name} · ${windowLabel}`,
      tag: 'ads-report-schedule',
      attachments: [{ filename: out.filename, content: out.body, contentType: out.contentType }],
      html: renderBody({
        name: schedule.savedReport.name,
        windowLabel,
        rows: out.manifest.rows,
        actualWindow: out.manifest.actualDataWindow,
        freshness: fresh.byMarket,
        staleNote,
        groupedBy: out.manifest.groupedBy,
        filters: [
          out.manifest.markets !== 'all' ? `markets ${out.manifest.markets}` : null,
          out.manifest.adProducts !== 'all' ? `ad products ${out.manifest.adProducts}` : null,
          out.manifest.search !== 'none' ? `search "${out.manifest.search}"` : null,
        ].filter(Boolean) as string[],
      }),
    })

    result = {
      status: send.dryRun ? 'DRY_RUN' : send.ok ? 'SENT' : 'FAILED',
      rows: out.manifest.rows,
      fileName: out.filename,
      fileBytes: out.body.length,
      windowFrom: win.from,
      windowTo: win.to,
      staleNote,
      error: send.ok ? null : (send.error ?? 'send failed'),
      durationMs: Date.now() - started,
      deliveryId: '',
    }

    const delivery = await prisma.reportDelivery.create({
      data: {
        scheduleId, status: result.status, format, recipients: recipients.join(', '),
        rows: result.rows, fileName: result.fileName, fileBytes: result.fileBytes,
        windowFrom: win.from, windowTo: win.to,
        freshness: fresh.byMarket as unknown as object,
        staleNote, messageId: send.messageId ?? null, error: result.error,
        durationMs: result.durationMs,
      },
    })
    result.deliveryId = delivery.id
  } catch (err) {
    result.error = (err as Error).message
    result.durationMs = Date.now() - started
    // A failure is a delivery too. Silence is the worst outcome for a scheduled
    // report: nobody notices a file that never arrived until a decision is made
    // without it.
    const delivery = await prisma.reportDelivery.create({
      data: {
        scheduleId, status: 'FAILED', format, recipients: schedule.recipients,
        rows: 0, windowFrom: win.from, windowTo: win.to,
        error: result.error, durationMs: result.durationMs,
      },
    })
    result.deliveryId = delivery.id
  }

  await prisma.reportSchedule.update({
    where: { id: scheduleId },
    data: { lastSentAt: now, lastStatus: result.status },
  })
  return result
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function renderBody(d: {
  name: string
  windowLabel: string
  rows: number
  actualWindow: string
  freshness: Array<{ marketplace: string; lastDay: string | null; rows: number }>
  staleNote: string | null
  groupedBy: string
  filters: string[]
}): string {
  const rowsFmt = d.rows.toLocaleString('en-GB')
  const freshRows = d.freshness
    .map((f) => `<tr><td style="padding:2px 10px 2px 0">${esc(f.marketplace)}</td><td style="padding:2px 10px 2px 0">${esc(f.lastDay ?? '—')}</td><td style="padding:2px 0">${f.rows.toLocaleString('en-GB')}</td></tr>`)
    .join('')
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1c2530">
  <h2 style="margin:0 0 4px;font-size:17px">${esc(d.name)}</h2>
  <p style="margin:0 0 14px;color:#5b6573">${esc(d.windowLabel)} · <b>${rowsFmt}</b> rows · grouped by ${esc(d.groupedBy)}</p>
  ${d.filters.length ? `<p style="margin:0 0 14px;color:#5b6573">Filters: ${esc(d.filters.join(' · '))}</p>` : ''}
  ${d.staleNote
    ? `<p style="margin:0 0 14px;padding:10px 12px;border-left:3px solid #b87503;background:#fdf6e8">
         <b>Read this before acting on the numbers.</b><br>${esc(d.staleNote)}.
         The file covers ${esc(d.windowLabel)}, but the data behind it only reaches ${esc(d.actualWindow)}.
       </p>`
    : `<p style="margin:0 0 14px;color:#5b6573">Data window in the file: ${esc(d.actualWindow)}.</p>`}
  <p style="margin:0 0 6px;color:#5b6573">Freshest day per market at the moment this was generated:</p>
  <table style="border-collapse:collapse;font-size:13px;color:#5b6573;margin:0 0 16px">
    <tr style="text-align:left"><th style="padding:2px 10px 2px 0">Market</th><th style="padding:2px 10px 2px 0">Newest day</th><th>Rows</th></tr>
    ${freshRows}
  </table>
  <p style="margin:0;color:#8a93a1;font-size:12px">The attached file carries a full manifest — filters, units and freshness — on its own sheet.</p>
</div>`
}

/**
 * Which schedules are due at this tick.
 *
 * Mirrors the dashboard-digest rule so the two behave identically: the current
 * Europe/Rome hour must match, and the previous send must fall in a different
 * calendar day / ISO week / month. That comparison — rather than "more than 24h
 * ago" — is what stops a schedule drifting an hour later every day.
 */
export interface ZonedNow {
  hour: number
  /** 1 = Monday … 7 = Sunday. */
  dayOfWeek: number
  dayOfMonth: number
  date: string // YYYY-MM-DD
  isoWeek: string // YYYY-Www
  yearMonth: string // YYYY-MM
}

const OPERATOR_TIMEZONE = 'Europe/Rome'

/**
 * The operator's civil clock, via Intl — the same approach dashboard-digest.job
 * uses, deliberately not `new Date(d.toLocaleString(...))`. That round-trip
 * re-parses a formatted string with the RUNTIME's locale rules and silently
 * yields Invalid Date under a non-US locale, which for a scheduler means it
 * quietly never fires.
 */
export function zonedNow(at: Date = new Date()): ZonedNow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0'
  const y = Number(get('year'))
  const m = Number(get('month'))
  const d = Number(get('day'))
  const hour = Number(get('hour')) === 24 ? 0 : Number(get('hour'))

  const probe = new Date(Date.UTC(y, m - 1, d))
  const dow = probe.getUTCDay() || 7
  const thursday = new Date(probe)
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)

  return {
    hour,
    dayOfWeek: dow,
    dayOfMonth: d,
    date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    isoWeek: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`,
    yearMonth: `${y}-${String(m).padStart(2, '0')}`,
  }
}

export function isDue(
  s: { frequency: string; hourLocal: number; dayOfWeek: number | null; dayOfMonth: number | null; lastSentAt: Date | null },
  now: Date,
): boolean {
  const t = zonedNow(now)
  if (t.hour !== s.hourLocal) return false
  if (s.frequency === 'weekly' && s.dayOfWeek && t.dayOfWeek !== s.dayOfWeek) return false
  if (s.frequency === 'monthly' && s.dayOfMonth && t.dayOfMonth !== s.dayOfMonth) return false

  if (!s.lastSentAt) return true
  const last = zonedNow(s.lastSentAt)
  // Compare calendar PERIODS, not elapsed hours: "more than 24h ago" lets a
  // schedule drift an hour later every day until it walks off its slot.
  if (s.frequency === 'daily') return last.date !== t.date
  if (s.frequency === 'weekly') return last.isoWeek !== t.isoWeek
  return last.yearMonth !== t.yearMonth
}

/** One cron tick: run every due schedule. Returns a summary for the run log. */
export async function runDueSchedules(now = new Date()): Promise<{ due: number; sent: number; failed: number }> {
  const active = await prisma.reportSchedule.findMany({ where: { isActive: true } })
  const due = active.filter((s) => isDue(s, now))
  let sent = 0
  let failed = 0
  for (const s of due) {
    // Sequential on purpose: each run builds a full export, and a burst of
    // hundred-thousand-row queries in parallel would be felt by the console.
    const r = await runSchedule(s.id, now).catch((e: unknown) => ({ status: 'FAILED', error: (e as Error).message } as RunResult))
    if (r.status === 'FAILED') failed++
    else sent++
  }
  return { due: due.length, sent, failed }
}
