import { escapeHtml } from '../../email/footer'
import type { ExportLocale } from '../exports'

/**
 * The e-mail of a finished export (B-W2b-11; design shell.lists pop:export-job "You can close this window — we'll e-mail
 * you a link", toolbar "Large exports run in the background and e-mail a link"). Pure: when the link is due and the
 * mail's words; apps/factory-api platform/exports/mail.ts sends it.
 *
 * WHEN: an export that ran long enough for the person to have closed its window — DONE at least EXPORT_MAIL.afterMs
 * after it was asked (waiting in the queue counts: the person asked and went on). A quick export, finished while its
 * window is surely open, is not mailed (quiet by default, PLT-142); its file waits under Export › My recent exports.
 * A failed export is not mailed: the window and My recent exports say why. Once per job (ExportJob.emailedAt).
 *
 * WHAT: a LINK, never the file: the list's own page with `?export=<job>` opens the job's window there, behind sign-in,
 * where the person's rights are checked again before the download. The mail names the list's title, the view's name,
 * the number of rows and the day the file is deleted; no cell of the list (no money, no names) is ever in it.
 */

export const EXPORT_MAIL = Object.freeze({
  /** A DONE export at least this long after it was asked is mailed. */
  afterMs: 15_000,
  /** The template key of the outbound mail (EmailOutbound.templateKey). */
  templateKey: 'exports.ready',
})

export interface MailFacts {
  readonly status: string
  readonly createdAt: Date
  readonly finishedAt: Date | null
  readonly emailedAt: Date | null
}

/** True when a finished export's link is due by e-mail (see the module comment). */
export function exportMailDue(job: MailFacts): boolean {
  if (job.status !== 'DONE' || job.emailedAt !== null || job.finishedAt === null) return false
  return job.finishedAt.getTime() - job.createdAt.getTime() >= EXPORT_MAIL.afterMs
}

/** The address that opens the job on its list: `<web>/w/<company code>/<page>?export=<job>` (no company: the web's start). */
export function exportLink(webOrigin: string, companyCode: string | null, page: string, jobId: string): string {
  const origin = webOrigin.replace(/\/+$/, '')
  if (!companyCode) return `${origin}/`
  const path = page.startsWith('/') ? page : `/${page}`
  return `${origin}/w/${encodeURIComponent(companyCode)}${path}?export=${encodeURIComponent(jobId)}`
}

export interface MailInput {
  readonly locale: ExportLocale
  /** The person's name, for the greeting. */
  readonly name: string
  /** The list's title, as the screen called it. */
  readonly title: string
  readonly viewName: string | null
  readonly rows: number
  readonly format: 'CSV' | 'XLSX' | 'XLSX_REIMPORT'
  readonly link: string
  /** The day the file is deleted (YYYY-MM-DD, the site's day). */
  readonly deletedOn: string
}

const FORMAT_WORDS = {
  it: { CSV: 'CSV', XLSX: 'Excel', XLSX_REIMPORT: 'Excel per la reimportazione' },
  en: { CSV: 'CSV', XLSX: 'Excel', XLSX_REIMPORT: 'Excel for re-import' },
} as const

/** `2026-11-07` → `07/11/2026` (it) / `7 Nov 2026` (en). */
function dayWords(day: string, locale: ExportLocale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return day
  if (locale === 'it') return `${match[3]}/${match[2]}/${match[1]}`
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(match[2]) - 1] ?? match[2]
  return `${Number(match[3])} ${month} ${match[1]}`
}

/** 1240 → `1.240` (it) / `1,240` (en): grouped by thousands, the same on every server (no ICU rule). */
const grouped = (value: number, locale: ExportLocale): string => String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'it' ? '.' : ',')

const rowsWords = (rows: number, locale: ExportLocale): string => {
  const number = grouped(rows, locale)
  if (locale === 'it') return rows === 1 ? '1 riga' : `${number} righe`
  return rows === 1 ? '1 row' : `${number} rows`
}

/** The mail's subject and body (plain text and safe HTML), in the person's language. */
export function exportMailText(input: MailInput): { readonly subject: string; readonly text: string; readonly html: string } {
  const it = input.locale === 'it'
  const what = input.viewName ? `${input.title} · ${input.viewName}` : input.title
  const subject = it ? `La tua esportazione è pronta: ${what}` : `Your export is ready: ${what}`
  const greeting = it ? `Ciao ${input.name},` : `Hello ${input.name},`
  const ready = it
    ? `il file di "${what}" (${FORMAT_WORDS.it[input.format]}, ${rowsWords(input.rows, 'it')}) è pronto.`
    : `the file of "${what}" (${FORMAT_WORDS.en[input.format]}, ${rowsWords(input.rows, 'en')}) is ready.`
  const open = it ? 'Aprilo nella fabbrica (dopo l’accesso):' : 'Open it in the factory (after you sign in):'
  const kept = it ? `Il file resta disponibile fino al ${dayWords(input.deletedOn, 'it')}, poi viene cancellato.` : `The file stays there until ${dayWords(input.deletedOn, 'en')}, then it is deleted.`
  const why = it ? 'Ricevi questa e-mail perché hai chiesto questa esportazione.' : 'You receive this e-mail because you asked for this export.'
  const text = [greeting, ready, '', open, input.link, '', kept, why].join('\n')
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(ready)}</p>`,
    `<p>${escapeHtml(open)}<br><a href="${escapeHtml(input.link)}">${escapeHtml(input.link)}</a></p>`,
    `<p>${escapeHtml(kept)}</p>`,
    `<p style="color:#666666">${escapeHtml(why)}</p>`,
  ].join('')
  return { subject, text, html }
}
