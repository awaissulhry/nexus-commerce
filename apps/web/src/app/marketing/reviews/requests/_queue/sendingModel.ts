/**
 * Reviews › Requests › Queue — the sending banner (`GET /api/review-queue/sending`): sending on (next run, last run in
 * words) or paused (who, when, why, what waits); what "Run now" will do, listed before it runs (a sent request cannot
 * be taken back); the pause reason's check; a run's result in words. Pure; tested in sendingModel.vitest.test.ts.
 *
 * Times are the viewer's own clock unless `timeZone` is given (the tests pass one).
 */
import type { Tone } from '@/design-system/primitives'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'
import { channelLabel } from '@/app/listings/_readiness/marketChips'
import type { SendingState } from './queueDatasource'

export const PAUSE_REASON_MAX = 300

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-IE')} ${n === 1 ? one : many}`

/** "14:00" */
export function clockWords(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
}

/** "25 Oct at 18:40" */
export function dateTimeWords(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone })} at ${clockWords(iso, timeZone)}`
}

/** "Italy 7, Germany 3": biggest first, then by name. */
export function splitWords(counts: Record<string, number>, name: (key: string) => string): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || name(a[0]).localeCompare(name(b[0])))
    .map(([key, n]) => `${name(key)} ${n.toLocaleString('en-IE')}`)
    .join(', ')
}

const marketName = (code: string) => (code === '—' || !code ? 'no market' : COUNTRY_NAMES[code] ?? code)

export function dueTotal(s: Pick<SendingState, 'due'>): number {
  return s.due.amazon.total + s.due.email.total
}

export interface SendingBannerView {
  state: 'on' | 'paused'
  tone: Tone
  title: string
  detail: string
  /** Why Run now is held, or null. */
  runHeld: string | null
}

/** The banner above the tiles. */
export function sendingBannerView(s: SendingState, timeZone?: string): SendingBannerView {
  const due = dueTotal(s)
  if (s.paused) {
    const who = `Paused by ${s.paused.by}${s.paused.at ? ` on ${dateTimeWords(s.paused.at, timeZone)}` : ''}`
    const why = s.paused.reason ? ` · reason: “${s.paused.reason}”` : ''
    const waits = due > 0 ? `${plural(due, 'request is', 'requests are')} due and ${due === 1 ? 'waits' : 'wait'}` : 'nothing is due now'
    return {
      state: 'paused',
      tone: 'warning',
      title: 'Sending is paused — nothing goes out until you resume',
      detail: `${who}${why}. Requests keep their place; ${waits}. Amazon’s day-30 limit still counts while paused.`,
      runHeld: s.runHeld ?? 'Sending is paused. Resume first, then run.',
    }
  }
  const title = s.nextRunAt ? `Sending is on — next run ${clockWords(s.nextRunAt, timeZone)}` : 'Sending is on'
  const last = s.lastRun?.at
    ? `Last run ${dateTimeWords(s.lastRun.at, timeZone)} by ${s.lastRun.by} — ${s.lastRun.words}.`
    : 'No run yet.'
  const healthy = !!s.nextRunAt && (s.lastRun?.ok ?? true)
  return {
    state: 'on',
    tone: healthy ? 'info' : 'warning',
    title,
    detail: `${s.hourly}. ${last}`,
    runHeld: s.runHeld,
  }
}

export interface RunConfirm {
  title: string
  confirmLabel: string
  consequences: string[]
  sideEffects: string[]
}

/** What "Run now" will do, from what is due now: listed before anything is sent. */
export function runConfirm(s: SendingState, timeZone?: string): RunConfirm {
  const amazon = s.due.amazon
  const email = s.due.email
  const total = amazon.total + email.total
  const consequences: string[] = []
  // Due requests whose rule asks "How was it?" first get that e-mail now, not the request (audit B19).
  const amazonCheck = Math.min(amazon.checkFirst ?? 0, amazon.total)
  const emailCheck = Math.min(email.checkFirst ?? 0, email.total)
  if (amazon.total - amazonCheck > 0) {
    consequences.push(`Asks Amazon to send ${plural(amazon.total - amazonCheck, 'review request', 'review requests')}${amazonCheck ? '' : ` (${splitWords(amazon.byMarket, marketName)})`}`)
  }
  if (email.total - emailCheck > 0) {
    consequences.push(`Sends our review email to ${plural(email.total - emailCheck, 'buyer', 'buyers')}${emailCheck ? '' : ` (${splitWords(email.byChannel, channelLabel)})`}`)
  }
  if (amazonCheck + emailCheck > 0) {
    consequences.push(`Sends our “How was it?” email first to ${plural(amazonCheck + emailCheck, 'buyer', 'buyers')} — their review request follows their answer, or 5 days`)
  }
  if (total === 0) consequences.push('Nothing is due right now')
  consequences.push('Adds orders delivered since the last run to the queue')
  consequences.push('A sent request cannot be taken back.')
  const sideEffects: string[] = []
  if (amazon.total > 0) sideEffects.push('Amazon may answer “too early” for some — they try again tomorrow')
  sideEffects.push(s.nextRunAt ? `The sender also runs on its own every hour — next at ${clockWords(s.nextRunAt, timeZone)}` : 'The sender also runs on its own every hour')
  return {
    title: 'Send the due requests now?',
    confirmLabel: total > 0 ? `Run now — ${plural(total, 'request', 'requests')}` : 'Run now',
    consequences,
    sideEffects,
  }
}

/** Why "Pause sending" cannot go yet: the reason is required and short. */
export function pauseReasonHeld(reason: string): string | null {
  const r = reason.trim()
  if (!r) return 'Say why sending is paused — the reason shows on this page'
  if (r.length > PAUSE_REASON_MAX) return `Keep the reason under ${PAUSE_REASON_MAX} characters (${r.length} now)`
  return null
}

export interface RunResult {
  sent?: number
  failed?: number
  skipped?: number
  tooEarly?: number
  paused?: boolean
}

/** A finished run in words (the toast after Run now). */
export function runResultWords(r: RunResult | null | undefined): string {
  if (!r) return 'The run finished'
  if (r.paused) return 'Nothing went out: sending is paused'
  const parts = [`${r.sent ?? 0} sent`]
  if (r.tooEarly) parts.push(`${r.tooEarly} too early (they try again tomorrow)`)
  parts.push(`${r.failed ?? 0} failed`)
  return `Run finished: ${parts.join(', ')}`
}
