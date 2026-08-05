/**
 * ACR.4.2 — the weekly digest as an email, and the two gates it honours.
 *
 * Rides the SAME rail RPT.6 built and the same discipline, deliberately:
 *
 *   NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON — whether the dispatcher runs at all
 *   NEXUS_ENABLE_OUTBOUND_EMAILS          — whether anything actually leaves
 *
 * Measured on Railway prod 2026-08-05: the first is NOT SET, so `startAdsReportScheduleCron`
 * returns early and no scheduled ads email has ever dispatched; the second IS set. Neither is
 * flipped here. The operator was asked and chose to decide from the panel after reading a real
 * digest, so the Control Room shows both flags live and this file changes nothing about them.
 *
 * With the second gate unset every run is a full rehearsal: the digest is really built, really
 * rendered, really logged — and nothing is mailed. That is what makes "is my digest right?"
 * answerable without mailing anyone, and it is why the send path and the preview path are the
 * same code rather than a convenient approximation of each other.
 *
 * ── Why there is no new table ───────────────────────────────────────────────────────────────
 * RPT.6 records deliveries in `ReportDelivery`, which hangs off a `ReportSchedule` and therefore
 * off a `SavedReport`. This digest is not a saved report — there are zero of those on prod — so
 * that row cannot be written. Rather than migrate a shared database mid-session for two fields,
 * idempotency and the log both come from `CronRun`, which already records every tick with a
 * summary string. "Have I sent this week's?" is then the same question as "did this job succeed
 * in this ISO week", asked of a table that already exists.
 */
import prisma from '../../db.js'
import { sendEmail } from '../email/transport.js'
import { logger } from '../../utils/logger.js'
import { getWeeklyDigest, digestWindow, type WeeklyDigest } from './ads-weekly-digest.service.js'

const JOB_NAME = 'ads-weekly-digest'
/** Monday, 08:00 Europe/Rome — the digest is the week's opening move, not a Friday postscript. */
const SEND_DOW = 1
const SEND_HOUR = 8

const eur = (cents: number) => `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * Rule names on this account are not short labels — several are whole product titles, e.g.
 * "Hold top rank ≥ 45% — XAVIA GALE Giacca Da Uomo - Giubbotto Moto Impermeabile E Ventilata
 * Con Protezione Di Livello 2 | Per Tutte Le Stagioni (IT)" at 145 characters. A table cell
 * cannot shrink below its content's minimum width, so ONE of those drags the whole table past
 * the 680px body and every email client then either scrolls sideways or shrinks the text to
 * fit. Truncating the label is the only lever that keeps the layout; the full name is a click
 * away in the Control Room.
 */
const RULE_NAME_MAX = 44
const shortName = (s: string) => (s.length <= RULE_NAME_MAX ? s : `${s.slice(0, RULE_NAME_MAX - 1).trimEnd()}…`)

/** Recipients, operator-controlled. No default: mailing someone who never asked is worse than
 *  not mailing at all, and an empty list is a state the panel can show and fix. */
export function digestRecipients(): string[] {
  return (process.env.NEXUS_ADS_DIGEST_RECIPIENTS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
}

export function renderWeeklyDigest(d: WeeklyDigest): string {
  const t = d.totals
  const g = d.graduation
  const c = d.coverage

  const ruleRows = d.rules.slice(0, 12).map((r) => `
    <tr>
      <td style="padding:4px 12px 4px 0;color:#1c2530" title="${esc(r.name)}">${esc(shortName(r.name))}</td>
      <td style="padding:4px 10px 4px 0;color:#5b6573;font-size:12px">${esc(r.level)}</td>
      <td style="padding:4px 10px 4px 0;text-align:right">${r.acted.toLocaleString('en-IE')}</td>
      <td style="padding:4px 10px 4px 0;text-align:right">${r.proposed.toLocaleString('en-IE')}</td>
      <td style="padding:4px 10px 4px 0;text-align:right">${r.applied || '—'}</td>
      <td style="padding:4px 0;text-align:right;color:${r.failed > 0 ? '#c0392b' : '#5b6573'}">${r.failed || '—'}</td>
    </tr>`).join('')

  // The lede is what changed and what is waiting, in that order. A digest that opens with
  // activity counts teaches the reader that the numbers are ambient; one that opens with money
  // and a decision teaches them it is worth reading.
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1c2530;max-width:680px">
  <h2 style="margin:0 0 2px;font-size:17px">Advertising — week of ${esc(d.window.label)}</h2>
  <p style="margin:0 0 16px;color:#5b6573;font-size:13px">
    ${d.window.complete ? 'A complete week.' : 'Week to date — the current week is still running.'}
    ${t.acted.toLocaleString('en-IE')} actions taken · ${t.proposed.toLocaleString('en-IE')} proposed
  </p>

  ${d.breaker.tripsThisWeek.length > 0 ? `
  <div style="padding:12px 14px;border-left:3px solid #a3342b;background:#fdf6f5;margin:0 0 16px">
    <b>The breaker tripped ${d.breaker.tripsThisWeek.length === 1 ? 'once' : `${d.breaker.tripsThisWeek.length} times`} this week — automation was HALTED.</b>
    ${d.breaker.tripsThisWeek.map((t) => `<div style="margin-top:3px">${esc(new Date(t.at).toISOString().slice(0, 16).replace('T', ' '))} — ${esc(t.reason)}</div>`).join('')}
    <div style="color:#5b6573;font-size:12.5px;margin-top:4px">${esc(d.breaker.tripNote)}</div>
  </div>` : ''}

  ${d.breaker.spendThresholdIsDefault ? `
  <div style="padding:12px 14px;border-left:3px solid #b87503;background:#fdf9f2;margin:0 0 16px">
    <b>Ad spend has no operator-set hourly limit.</b>
    <div style="color:#5b6573;font-size:12.5px;margin-top:4px">${esc(d.breaker.spendNote)}</div>
  </div>` : ''}

  ${d.proposals.pending > 0 ? `
  <div style="padding:12px 14px;border-left:3px solid ${d.proposals.recoverableCents > 0 ? '#c0392b' : '#8d97a6'};background:#fbfcfd;margin:0 0 16px">
    <b>${d.proposals.pending} proposals are waiting on you.</b><br>
    ${d.proposals.priced} of them price out to <b>${eur(d.proposals.spendAtStakeCents)}</b> of trailing spend at stake,
    of which <b>${eur(d.proposals.recoverableCents)}</b> produced no sales at all — the part that is pure recovery.
    <div style="color:#5b6573;font-size:12.5px;margin-top:4px">
      "At stake" is spend the action would redirect, not money it would save. Only the no-sales part is recovery.
    </div>
  </div>` : ''}

  ${g.ready > 0 ? `
  <div style="padding:12px 14px;border-left:3px solid #14724d;background:#f4fbf8;margin:0 0 16px">
    <b>${g.ready} rule${g.ready === 1 ? '' : 's'} ready to graduate to Auto.</b><br>
    ${esc(g.readyNames.join(' · '))}
    <div style="color:#5b6573;font-size:12.5px;margin-top:4px">You applied their proposals unchanged, repeatedly, with no failures. Graduating is one click and reversible.</div>
  </div>` : ''}

  ${g.unseen > 0 ? `
  <div style="padding:12px 14px;border-left:3px solid #b87503;background:#fdf9f2;margin:0 0 16px">
    <b>${g.unseen} rule${g.unseen === 1 ? '' : 's'} ${g.unseen === 1 ? 'has' : 'have'} never queued a proposal.</b><br>
    ${esc(g.unseenNames.join(' · '))}
    <div style="color:#5b6573;font-size:12.5px;margin-top:4px">${g.unseen === 1 ? 'It has' : 'They have'} matched repeatedly without ever showing you a decision, so no evidence can accumulate and ${g.unseen === 1 ? 'it' : 'they'} will sit at Propose indefinitely looking healthy.</div>
  </div>` : ''}

  <h3 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573">What it changed</h3>
  <p style="margin:0 0 4px">
    Daily budget moved <b style="color:${d.effect.budgetDeltaCents < 0 ? '#14724d' : '#1c2530'}">${d.effect.budgetDeltaCents >= 0 ? '+' : '−'}${eur(Math.abs(d.effect.budgetDeltaCents))}</b>/day
    across ${d.effect.budgetMoves.toLocaleString('en-IE')} change${d.effect.budgetMoves === 1 ? '' : 's'}.
  </p>
  <p style="margin:0 0 4px;color:#5b6573;font-size:13px">
    ${d.effect.bidMoves.toLocaleString('en-IE')} bid changes · ${d.effect.placementMoves.toLocaleString('en-IE')} placement changes — counted, not priced.
  </p>
  <p style="margin:0 0 14px;color:#8a93a1;font-size:12px">${esc(d.effect.note)}</p>

  ${c ? `
  <h3 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573">Coverage</h3>
  <p style="margin:0 0 4px">
    ${c.share != null ? `<b>${(c.share * 100).toFixed(2)}%</b> impression share` : 'Impression share not measurable'}
    across ${c.terms.toLocaleString('en-IE')} tracked terms in ${esc(c.marketplace)}${c.week ? `, week of ${esc(c.week)}` : ''}.
    ${c.deltaPct != null ? `<span style="color:${c.deltaPct >= 0 ? '#14724d' : '#c0392b'}">${c.deltaPct >= 0 ? '+' : ''}${c.deltaPct.toFixed(2)}pp</span> vs ${esc(c.priorWeek ?? 'the prior week')}.` : ''}
  </p>
  <p style="margin:0 0 14px;color:#8a93a1;font-size:12px">${esc(c.note)}</p>` : ''}

  <h3 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573">Per rule</h3>
  <!-- Explicit widths: table-layout:fixed splits six columns EVENLY, which gave the rule name
       ~113px of a 680px body and wrapped every label over three lines. The name needs the room;
       the counts are at most four digits. -->
  <table style="border-collapse:collapse;font-size:13px;width:100%;max-width:680px;table-layout:fixed">
    <tr style="text-align:left;color:#5b6573;font-size:12px">
      <th style="padding:0 12px 4px 0;width:40%">Rule</th><th style="padding:0 10px 4px 0;width:12%">Mode</th>
      <th style="padding:0 10px 4px 0;text-align:right;width:10%">Acted</th>
      <th style="padding:0 10px 4px 0;text-align:right;width:13%">Proposed</th>
      <th style="padding:0 10px 4px 0;text-align:right;width:14%">You applied</th>
      <th style="padding:0 0 4px;text-align:right;width:11%">Failed</th>
    </tr>
    ${ruleRows}
  </table>
  ${d.rules.length > 12 ? `<p style="margin:6px 0 0;color:#8a93a1;font-size:12px">${d.rules.length - 12} more in the Control Room.</p>` : ''}

  ${t.declined > 0 ? `<p style="margin:14px 0 0;color:#8a93a1;font-size:12px">
    ${t.declined.toLocaleString('en-IE')} runs were declined by the engine's own daily cap. That is the engine refusing itself, not a failure and not your decision — it is listed apart for that reason.
  </p>` : ''}
  ${(d.delivery.failedWrites > 0 || d.delivery.deadLetters > 0) ? `<p style="margin:10px 0 0;color:#c0392b;font-size:12.5px">
    ${d.delivery.failedWrites} write${d.delivery.failedWrites === 1 ? '' : 's'} Amazon refused${d.delivery.deadLetters > 0 ? ` · ${d.delivery.deadLetters} dead-lettered` : ''} this week.
  </p>` : ''}

  <p style="margin:20px 0 0;color:#8a93a1;font-size:12px">
    Built ${esc(d.generatedAt.slice(0, 16).replace('T', ' '))} UTC. Every figure here is recomputed at send time from the same
    service the Control Room reads, so the screen and this email cannot disagree.
  </p>
</div>`
}

export interface DigestSendResult {
  status: 'SENT' | 'DRY_RUN' | 'SKIPPED' | 'FAILED'
  recipients: string[]
  window: string
  reason: string | null
  messageId: string | null
}

/**
 * Build and deliver one digest. The cron and the operator's "Send me a test" both land here —
 * one path, so a manual test exercises exactly what Monday will do.
 */
export async function sendWeeklyDigest(opts: {
  mode?: 'current' | 'previous'
  to?: string[]
  now?: Date
} = {}): Promise<DigestSendResult> {
  const mode = opts.mode ?? 'previous'
  const now = opts.now ?? new Date()
  const recipients = opts.to?.length ? opts.to : digestRecipients()
  const win = digestWindow(mode, now)

  if (recipients.length === 0) {
    return {
      status: 'SKIPPED', recipients: [], window: win.label, messageId: null,
      reason: 'No recipients configured. Set NEXUS_ADS_DIGEST_RECIPIENTS, or send yourself a test from the Control Room.',
    }
  }

  try {
    const digest = await getWeeklyDigest(mode, now)
    const send = await sendEmail({
      to: recipients,
      subject: `Advertising · week of ${win.label}`,
      tag: 'ads-weekly-digest',
      html: renderWeeklyDigest(digest),
    })
    return {
      status: send.dryRun ? 'DRY_RUN' : send.ok ? 'SENT' : 'FAILED',
      recipients,
      window: win.label,
      messageId: send.messageId ?? null,
      reason: send.dryRun
        ? 'Built and logged, nothing mailed — NEXUS_ENABLE_OUTBOUND_EMAILS is not true.'
        : send.ok ? null : (send.error ?? 'send failed'),
    }
  } catch (err) {
    return {
      status: 'FAILED', recipients, window: win.label, messageId: null,
      reason: (err as Error).message,
    }
  }
}

/**
 * One tick of the hourly ads-schedule cron.
 *
 * Due when it is Monday 08:00 on the operator's clock AND the last successful run falls in a
 * different ISO week. Comparing calendar PERIODS rather than "more than 168 hours ago" is what
 * stops a weekly job drifting an hour later every week until it walks off its slot — the same
 * rule `isDue` uses for report schedules.
 */
export async function dispatchWeeklyDigestIfDue(now = new Date()): Promise<DigestSendResult | null> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now)
  const num = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0')
  const hour = num('hour') === 24 ? 0 : num('hour')
  const dow = new Date(Date.UTC(num('year'), num('month') - 1, num('day'))).getUTCDay() || 7
  if (dow !== SEND_DOW || hour !== SEND_HOUR) return null

  // Idempotency without a new table: the last successful CronRun for this job. A digest sent
  // twice in one morning is not harmless — it teaches the reader that the mail is noise.
  const last = await prisma.cronRun.findFirst({
    where: { jobName: JOB_NAME, status: 'SUCCESS' },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  }).catch(() => null)
  if (last && sameIsoWeek(last.startedAt, now)) return null

  const result = await sendWeeklyDigest({ mode: 'previous', now })
  logger.info('[ads-weekly-digest] dispatched', { status: result.status, window: result.window, recipients: result.recipients.length })
  return result
}

function sameIsoWeek(a: Date, b: Date): boolean {
  const key = (d: Date) => {
    const p = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    const dow = p.getUTCDay() || 7
    p.setUTCDate(p.getUTCDate() + 4 - dow)
    const ys = new Date(Date.UTC(p.getUTCFullYear(), 0, 1))
    return `${p.getUTCFullYear()}-${Math.ceil(((p.getTime() - ys.getTime()) / 86_400_000 + 1) / 7)}`
  }
  return key(a) === key(b)
}

export const DIGEST_JOB_NAME = JOB_NAME
