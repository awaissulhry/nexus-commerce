import { isApiError, issuePath } from '../../lib/api/errors'
import { formatNumber } from '../../lib/i18n/format'
import type { Locale } from '../../lib/i18n/locales'
import type { FileSet, PayrollFiles } from './api'

/**
 * SCR-272 — files by link (design links.file; links.document sec:set, sec:password, sec:newer; COL-051, MES-274): pure
 * rules, so the tests hold them. One page for three kinds of link:
 *
 *   secure    SECURE_FILE of a set of files: opening never counts, EACH DOWNLOAD uses the link ("5 downloads left"),
 *             never shown in the browser, an optional password sent apart, the receipt "I received these files".
 *   shared    DOCUMENT_VIEW of a set of files (links.document W2b): each OPEN counts (the landing's), downloads are
 *             logged, never counted; a PDF or a picture can be read in the page; the optional password; a newer
 *             version named, never swapped in.
 *   payroll   DOCUMENT_VIEW of a PayrollExport (B-W2b-54's routes): the hours file and its summary for the labour
 *             consultant — each download counts; no password, no receipt (the API has none for it). Pay figures
 *             never go by link: the office's Send refuses a month with amounts (409 PAY_FIGURES).
 *
 * Every word on screen is the page's own (link-files catalogue) from codes, numbers and days: never the API's English.
 */

export type FileLinkKind = 'secure' | 'shared' | 'payroll'

export interface PageFile {
  readonly id: string
  readonly position: number
  readonly name: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly contentType: string
  /** Can be read in the page (shared: a PDF or a picture). */
  readonly preview: boolean
  /** Still there to download (a file deleted since stays listed, not downloadable). */
  readonly available: boolean
  /** A later version replaced it: its number, when, and its id when it is on this link too. */
  readonly newer: { readonly versionNo: number | null; readonly replacedAt: string; readonly sharedFileId: string | null } | null
  /** The payroll file's part: the data file for the consultant's software, or the summary to read. */
  readonly payrollKind: 'DATA' | 'SUMMARY' | null
}

export interface FilePage {
  readonly kind: FileLinkKind
  readonly sender: string
  readonly expiresAt: string
  readonly usesLeft: number
  readonly password: { readonly asked: boolean; readonly unlocked: boolean; readonly heldUntil: string | null }
  readonly receipt: { readonly asked: boolean; readonly at: string | null; readonly name: string | null }
  /** How many files were sent (known before the password). */
  readonly count: number
  /** Listed once the password was given (or when there is none). */
  readonly files: readonly PageFile[]
  readonly payroll: { readonly month: string; readonly number: string | null; readonly revision: number } | null
}

/** A set of files as the page reads it (GET /link/files). */
export function pageOfSet(set: FileSet): FilePage {
  return {
    kind: set.link.purpose === 'SECURE_FILE' ? 'secure' : 'shared',
    sender: set.sender.companyName,
    expiresAt: set.link.expiresAt,
    usesLeft: set.link.usesLeft,
    password: set.link.password,
    receipt: set.link.receipt,
    count: set.count,
    files: [...set.files]
      .sort((a, b) => a.position - b.position)
      .map((file) => ({
        id: file.id,
        position: file.position,
        name: file.name,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        contentType: file.contentType,
        preview: file.preview === 'inline',
        available: file.available,
        newer: file.newer ? { versionNo: file.newer.versionNo, replacedAt: file.newer.replacedAt, sharedFileId: file.newer.sharedFileId } : null,
        payrollKind: null,
      })),
    payroll: null,
  }
}

/** The payroll file as the page reads it (GET /people/payroll/link/files): the data file first, then the summary. */
export function pageOfPayroll(read: PayrollFiles): FilePage {
  const order = (kind: 'DATA' | 'SUMMARY') => (kind === 'DATA' ? 0 : 1)
  const files = [...read.files].sort((a, b) => order(a.kind) - order(b.kind))
  return {
    kind: 'payroll',
    sender: read.sender,
    expiresAt: read.link.expiresAt,
    usesLeft: read.link.usesLeft,
    password: { asked: false, unlocked: false, heldUntil: null },
    receipt: { asked: false, at: null, name: null },
    count: files.length,
    files: files.map((file, index) => ({
      id: file.id,
      position: index + 1,
      name: file.name,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      contentType: file.kind === 'SUMMARY' ? 'application/pdf' : 'application/octet-stream',
      preview: false,
      available: true,
      newer: null,
      payrollKind: file.kind,
    })),
    payroll: { month: read.month, number: read.number, revision: read.revision },
  }
}

/** Each download uses the link (secure, payroll); a shared set counts its opens and only logs its downloads. */
export const downloadsCount = (page: Pick<FilePage, 'kind'>): boolean => page.kind !== 'shared'

/** The password stands between the person and the files (asked, not given yet in this visit). */
export const locked = (page: Pick<FilePage, 'password'>): boolean => page.password.asked && !page.password.unlocked

/** The files that can still be downloaded. */
export const availableFiles = (page: Pick<FilePage, 'files'>): PageFile[] => page.files.filter((file) => file.available)

// ---- the page's state ----------------------------------------------------------------------------------------------

/** loading · valid · used (the page's own last download used the link up) · expired (passed while open) · unavailable
 *  (the one 404: used, expired or withdrawn) · error. */
export type FileLinkState = 'loading' | 'valid' | 'used' | 'expired' | 'unavailable' | 'error'

export type PasswordProblem =
  /** Send held: nothing typed. */
  | { readonly kind: 'empty' }
  /** Wrong: how many tries are left before the 15-minute hold (null: the answer did not say). */
  | { readonly kind: 'wrong'; readonly triesLeft: number | null }
  /** Five wrong ones: the link is held until then (for everyone who holds it). */
  | { readonly kind: 'held'; readonly until: string }
  /** The 30 minutes a right password opens the files for passed: type it again. */
  | { readonly kind: 'relock' }
  /** The check did not reach us. */
  | { readonly kind: 'failed' }

export type DownloadState = 'busy' | 'done' | 'failed' | 'gone'

export interface FileLinkViewModel {
  link: FileLinkState
  page: FilePage | null
  /** The read takes longer than about a second: "Still loading…". */
  slow: boolean
  password: { value: string; shown: boolean; busy: boolean; problem: PasswordProblem | null }
  /** This visit's downloads, by file. */
  downloads: Readonly<Record<string, DownloadState>>
  /** Download all, file after file: how far it got. */
  all: { busy: boolean; done: number; of: number } | null
  /** The receipt as typed here (SECURE_FILE); the page's `receipt` says whether it was given (`confirmedHere`: just now). */
  receipt: { name: string; busy: boolean; failed: boolean; confirmedHere?: boolean }
  /** A shared file read in the page (memory only, this visit). */
  preview: { fileId: string; state: 'loading' | 'ready' | 'failed'; data: Uint8Array | null; contentType: string } | null
  /** The row the page points at ("Go to version 4"). */
  focus: string | null
  /** When the link expired, as the page saw it pass. */
  expiredAt?: string | null
  /** The sender's time zone for days and times (default Europe/Rome). */
  timeZone?: string
  /** The clock for the held states (fixtures fix it; the page passes nothing and the view reads the device's). */
  now?: string
}

export interface FileLinkActions {
  onPassword?: (value: string) => void
  onShowPassword?: () => void
  onUnlock?: () => void
  onDownload?: (fileId: string) => void
  onDownloadAll?: () => void
  onPreview?: (fileId: string) => void
  onClosePreview?: () => void
  onGoTo?: (fileId: string) => void
  onReceiptName?: (value: string) => void
  onReceipt?: () => void
  onRetry?: () => void
}

export const emptyModel = (): FileLinkViewModel => ({
  link: 'loading',
  page: null,
  slow: false,
  password: { value: '', shown: false, busy: false, problem: null },
  downloads: {},
  all: null,
  receipt: { name: '', busy: false, failed: false },
  preview: null,
  focus: null,
})

/** A phrase of the page's catalogue (`link-files`). */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

// ---- the password -----------------------------------------------------------------------------------------------------

/** The longest a password may be as typed (factory-domain LINK_PASSWORD.maxLength × 4, the API's own bound). */
export const PASSWORD_MAX = 512
/** Wrong passwords before the 15-minute hold (factory-domain LINK_PASSWORD.tries). */
export const PASSWORD_TRIES = 5

/** The tries left, from the API's answer to a wrong password ("… 3 tries left."): its one number, else null. */
export function triesLeftOf(message: string | undefined): number | null {
  const found = /(\d+)/.exec(message ?? '')
  if (!found) return null
  const value = Number(found[1])
  return Number.isInteger(value) && value >= 0 && value < PASSWORD_TRIES ? value : null
}

/** Until when a held answer (429 `password/HELD`) holds the link: the issue's instant, else now + Retry-After. */
export function heldUntilOf(error: unknown, now: Date): string | null {
  if (!isApiError(error) || error.kind !== 'rate_limited') return null
  const held = error.issues.find((issue) => issuePath(issue) === 'password/HELD')?.message
  if (held && Number.isFinite(Date.parse(held))) return new Date(Date.parse(held)).toISOString()
  const seconds = Number(error.issues.find((issue) => issuePath(issue) === 'retryAfter')?.message)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(now.getTime() + seconds * 1000).toISOString() : null
}

/** What a refused password means for the form. */
export function passwordProblemOf(error: unknown, now: Date): PasswordProblem {
  if (isApiError(error)) {
    if (error.kind === 'invalid') {
      const issue = error.issues.find((entry) => issuePath(entry) === 'body/password')
      return { kind: 'wrong', triesLeft: triesLeftOf(issue?.message ?? error.message) }
    }
    const until = heldUntilOf(error, now)
    if (until) return { kind: 'held', until }
  }
  return { kind: 'failed' }
}

/** Held now? (a hold that passed is not). */
export const isHeld = (until: string | null | undefined, now: Date): boolean => !!until && Date.parse(until) > now.getTime()

/** The hold that stands for the form: the answer's, else the page's (read on arrival). */
export function standingHold(model: Pick<FileLinkViewModel, 'password'>, page: Pick<FilePage, 'password'> | null, now: Date): string | null {
  const own = model.password.problem?.kind === 'held' ? model.password.problem.until : null
  if (isHeld(own, now)) return own
  return page && isHeld(page.password.heldUntil, now) ? page.password.heldUntil : null
}

/** Why "Open the files" cannot run now, or null. */
export function unlockHeld(model: Pick<FileLinkViewModel, 'password'>, page: Pick<FilePage, 'password'> | null, now: Date): Phrase | null {
  if (model.password.busy) return phrase('password.held.busy')
  if (standingHold(model, page, now)) return phrase('password.held.wait')
  if (model.password.value.length === 0) return phrase('password.held.empty')
  return null
}

// ---- downloads --------------------------------------------------------------------------------------------------------

/** Why one file's Download cannot run now, or null. */
export function downloadHeld(page: FilePage, model: Pick<FileLinkViewModel, 'downloads' | 'all'>, fileId: string): Phrase | null {
  if (model.all?.busy) return phrase('download.held.all')
  if (model.downloads[fileId] === 'busy') return phrase('download.held.busy')
  if (downloadsCount(page) && page.usesLeft <= 0) return phrase('download.held.none')
  return null
}

/**
 * Why "Download all" cannot run now, or null. Each download of a counted link is a use: all of them need as many uses
 * as files, so with fewer left it is held and says so (one by one still works).
 */
export function downloadAllHeld(page: FilePage, model: Pick<FileLinkViewModel, 'downloads' | 'all'>): Phrase | null {
  const files = availableFiles(page)
  if (model.all?.busy) return phrase('all.held.busy', { done: model.all.done, of: model.all.of })
  if (Object.values(model.downloads).includes('busy')) return phrase('download.held.busy')
  if (downloadsCount(page) && page.usesLeft < files.length) return phrase('all.held.uses', { count: files.length, left: page.usesLeft })
  return null
}

/** "Download all" is offered: two files or more can still be downloaded (one file has its own Download). */
export const offersDownloadAll = (page: FilePage): boolean => availableFiles(page).length >= 2

/** The next download is the link's last (a counted link with one use left): the page says so before it. */
export const lastDownload = (page: FilePage): boolean => downloadsCount(page) && page.usesLeft === 1

/** "Download all" would use every download left (two or more): the link closes after it, so the page says so first. */
export const allClosesLink = (page: FilePage): boolean => downloadsCount(page) && page.usesLeft > 1 && page.usesLeft === availableFiles(page).length

/** After a download: the uses the API says are left. */
export const withUsesLeft = (page: FilePage, usesLeft: number): FilePage => ({ ...page, usesLeft: Math.max(0, usesLeft) })

/** The link is used up by the page's own download (a counted link, nothing left). */
export const usedUp = (page: FilePage): boolean => downloadsCount(page) && page.usesLeft <= 0

// ---- the receipt ------------------------------------------------------------------------------------------------------

/** The longest typed name the API keeps (receivedName ≤ 200 after trimming; the body takes 400). */
export const RECEIPT_NAME_MAX = 200

/** The receipt is asked here and not given yet. */
export const receiptOpen = (page: FilePage): boolean => page.receipt.asked && page.receipt.at === null

/** Why "I received these files" cannot run now, or null. */
export function receiptHeld(model: Pick<FileLinkViewModel, 'receipt'>, page: FilePage): Phrase | null {
  if (model.receipt.busy) return phrase('receipt.held.busy')
  if (locked(page)) return phrase('receipt.held.locked')
  if ([...model.receipt.name].length > RECEIPT_NAME_MAX) return phrase('receipt.held.long', { max: RECEIPT_NAME_MAX })
  return null
}

// ---- a newer version --------------------------------------------------------------------------------------------------

/** The newer version's row when the sender shared it on this link too, else null. */
export function newerOnLink(page: Pick<FilePage, 'files'>, file: PageFile): PageFile | null {
  const id = file.newer?.sharedFileId
  return id ? (page.files.find((entry) => entry.id === id) ?? null) : null
}

// ---- reading ----------------------------------------------------------------------------------------------------------

/** The page's state for a failed read: the one 404 of a dead link (used up, withdrawn, expired), else an error. */
export function stateOfReadError(error: unknown): Extract<FileLinkState, 'unavailable' | 'error'> {
  return isApiError(error) && error.kind === 'not_found' ? 'unavailable' : 'error'
}

/** A call refused because the unlock passed (403 at `password`): the form comes back. */
export const unlockPassed = (error: unknown): boolean => isApiError(error) && error.kind === 'forbidden' && error.issues.some((issue) => issuePath(issue) === 'password')

/** The link died: its expiry is past by the device's clock. */
export function isExpired(expiresAt: string, now: Date): boolean {
  const at = Date.parse(expiresAt)
  return Number.isFinite(at) && at <= now.getTime()
}

/** The longest a timer waits in one go (setTimeout's limit); the page checks again when it fires. */
export const MAX_TIMER_MS = 2_147_483_647

/** How long until an instant passes (0 when it has; capped at the timer's limit). */
export function msUntil(at: string, now: Date): number {
  const time = Date.parse(at)
  if (!Number.isFinite(time)) return MAX_TIMER_MS
  return Math.min(MAX_TIMER_MS, Math.max(0, time - now.getTime()))
}

// ---- words ------------------------------------------------------------------------------------------------------------

/** A file's size as people read it: "65 KB", "2,4 MB". */
export function sizeText(bytes: number, locale: Locale): string {
  return bytes >= 1024 * 1024
    ? formatNumber(bytes / (1024 * 1024), locale, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })
    : formatNumber(Math.max(1, Math.round(bytes / 1024)), locale, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 })
}

/** The checksum the page shows short: the first 12 of the 64 hex digits (the whole one is in the row's title). */
export const shortChecksum = (sha256: string): string => sha256.slice(0, 12)

/** A payroll month ("2026-10") in the reader's language: "ottobre 2026", "October 2026". */
export function monthWords(month: string, locale: Locale): string {
  const found = /^(\d{4})-(\d{2})$/.exec(month)
  if (!found) return month
  const date = new Date(Date.UTC(Number(found[1]), Number(found[2]) - 1, 15))
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
}

/** The download's file name: the file's own, or a plain one when it has none. */
export const fileNameOf = (file: Pick<PageFile, 'name'>): string => file.name.trim() || 'file'

/** A picture (read in the page as an image) or a PDF (in the viewer). */
export const isPicture = (contentType: string): boolean => /^image\//i.test(contentType)
