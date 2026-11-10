import { readPublicDocCode } from '@nexus/factory-domain/compliance/public-doc/code'
import type { CareLine, PublicDocFile, PublicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { brandingTokensOf } from '../../lib/api/branding'
import { issuePath, type ApiError } from '../../lib/api/errors'
import type { LinkSender } from '../../shell/links/view/LinkFrameView'

/**
 * SCR-102 — the public DoC page (design links.doc; B-W2b-166), pure: what the page shows from the API's page, the reader's
 * languages and the lookup form. The page speaks its own words from codes, numbers and days; the declaration is read in
 * the reader's language when it is published in it (the browser's languages first, then the page's, then English, then
 * Italian: B-W1-49's chain begun with the reader's own), and every published language stays one choice away.
 */

/** What the page is doing. `lookup`: the Type the code card is the page (no code in the address, or the code missed). */
export type PageKind = 'loading' | 'found' | 'lookup' | 'error'

/** Why the lookup card speaks: nothing typed, not a code, unknown, the network must wait, the device check failed. */
export type LookupProblem = 'required' | 'format' | 'unknown' | 'checkFailed'

export interface WaitParts {
  readonly unit: 'seconds' | 'minutes'
  readonly count: number
}

export interface LookupModel {
  readonly text: string
  readonly problem: LookupProblem | null
  /** Asking again waits this long (a 429): the button is held with why. */
  readonly wait: WaitParts | null
  /** A lookup is under way (the button says so). */
  readonly busy: boolean
  /** The device check runs (a 429 `challenge` after many requests from the network). */
  readonly checking: boolean
}

export interface PdfState {
  readonly fileId: string
  readonly state: 'loading' | 'ready' | 'failed'
  readonly data: Uint8Array | null
}

export interface PublicDocViewModel {
  readonly kind: PageKind
  /** Whose page it is, for the frame's head and foot (frameSender of the page); null until a page is read. */
  readonly sender: LinkSender | null
  /** "Still loading…" after about a second. */
  readonly slow: boolean
  readonly page: PublicDocPage | null
  /** The reader's languages, in order (the browser's, the page's, en, it). */
  readonly readerLanguages: readonly string[]
  /** The declaration's language chosen (null: none published). */
  readonly language: string | null
  readonly pdf: PdfState | null
  readonly lookup: LookupModel
  readonly timeZone?: string
  /** B-W2b-236: design cases only — the picture's address drawn from made-up data (the page uses the API's stripped copy). */
  readonly pictureSrc?: string
}

export interface PublicDocActions {
  onLanguage?(language: string): void
  onRetry?(): void
  onRetryPdf?(): void
  onLookupText?(text: string): void
  onLookupSubmit?(): void
  /** Another record under the same code (rare): open match `n`. */
  onPick?(n: number): void
}

export const EMPTY_LOOKUP: LookupModel = { text: '', problem: null, wait: null, busy: false, checking: false }

/** ISO 639-1 primary subtags of the browser's languages, then the page's, then English and Italian, each once. */
export function readerLanguages(browser: readonly string[], pageLocale: string): string[] {
  const primary = (tag: string) => tag.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return [...new Set([...browser.map(primary), primary(pageLocale), 'en', 'it'].filter((language) => /^[a-z]{2}$/.test(language)))]
}

/** The first of the reader's languages a file is published in; else the first published; null when none is. */
export function chooseLanguage(files: readonly Pick<PublicDocFile, 'language'>[], chain: readonly string[]): string | null {
  return chain.find((language) => files.some((file) => file.language === language)) ?? files[0]?.language ?? null
}

/** The file of a language, else the first. */
export function fileIn(files: readonly PublicDocFile[], language: string | null): PublicDocFile | null {
  return files.find((file) => file.language === language) ?? files[0] ?? null
}

/** The files with the reader's language first, the others in the API's order (the label's languages first). */
export function readerFirst(files: readonly PublicDocFile[], chain: readonly string[]): PublicDocFile[] {
  const first = chooseLanguage(files, chain)
  return [...files].sort((a, b) => Number(b.language === first) - Number(a.language === first))
}

/** A care line's text in the reader's languages, else any it has, else its symbol. */
export function careText(line: CareLine, chain: readonly string[]): string {
  for (const language of chain) {
    const text = line.text[language]
    if (text) return text
  }
  return Object.values(line.text)[0] ?? line.symbol
}

/** What is wrong with a typed code before it is sent (null: send it). */
export function codeProblem(text: string): Extract<LookupProblem, 'required' | 'format'> | null {
  if (text.trim() === '') return 'required'
  return readPublicDocCode(text) === null ? 'format' : null
}

/** The style's name in the reader's language (the office's translation), else its name. */
export function styleName(page: Pick<PublicDocPage, 'product'>, chain: readonly string[]): string {
  const names = page.product.style.names
  for (const language of chain) if (names[language]) return names[language]!
  return page.product.style.name
}

// ── what the API said ─────────────────────────────────────────────────────────────────────────────────────────────────────

const pathsOf = (error: ApiError): string[] => error.issues.map(issuePath)

/** A 429 that asks for a solved check first (proof of work, after suspicious traffic). */
export const wantsChallenge = (error: ApiError): boolean => error.kind === 'rate_limited' && pathsOf(error).includes('challenge')

/** How long a 429 says to wait, in ms (the issue `retryAfter` carries seconds); a minute when it says nothing. */
export function retryAfterMs(error: ApiError): number | null {
  if (error.kind !== 'rate_limited') return null
  const issue = error.issues.find((entry) => issuePath(entry) === 'retryAfter')
  const seconds = Number(issue?.message)
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) * 1000 : 60_000
}

/** The wait in words' units: seconds under a minute, else whole minutes (rounded up). */
export function waitParts(ms: number): WaitParts {
  if (ms < 60_000) return { unit: 'seconds', count: Math.max(1, Math.ceil(ms / 1000)) }
  return { unit: 'minutes', count: Math.ceil(ms / 60_000) }
}

/** What a failed lookup turns the page into: the lookup card (unknown, wait, check failed) or the error card. */
export function lookupRefusal(error: ApiError, challenged: boolean): { kind: 'lookup'; problem: LookupProblem | null; waitMs: number | null } | { kind: 'error' } {
  if (error.kind === 'not_found' || error.kind === 'invalid') return { kind: 'lookup', problem: 'unknown', waitMs: null }
  if (error.kind === 'rate_limited') return wantsChallenge(error) ? { kind: 'lookup', problem: 'checkFailed', waitMs: null } : { kind: 'lookup', problem: null, waitMs: retryAfterMs(error) }
  if (challenged) return { kind: 'lookup', problem: 'checkFailed', waitMs: null }
  return { kind: 'error' }
}

// ── days and months ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A calendar day `YYYY-MM-DD` as the instant at its noon UTC (formatting it never moves it to another day). */
export const dayInstant = (day: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00Z` : day)

/** "settembre 2026" / "September 2026". */
export function monthOf(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(dayInstant(day)))
}

/** A batch span in months: one month when both ends fall in it. */
export function spanMonths(span: { readonly first: string; readonly last: string }, locale: string): { one: string } | { from: string; to: string } {
  const from = monthOf(span.first, locale)
  const to = monthOf(span.last, locale)
  return from === to ? { one: from } : { from, to }
}

/** The language's own name in the page's language ("tedesco"), else its code. */
export function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code)
    if (name && name.toLowerCase() !== code.toLowerCase()) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)
  } catch {
    // An unknown code or an old browser: the code itself.
  }
  return code.toUpperCase()
}

/** The frame's sender: the company's name, logo and colour (its branding), and whom to ask (its conversation address). */
export function frameSender(page: Pick<PublicDocPage, 'sender' | 'contact'>): LinkSender {
  return { ...brandingTokensOf(page.sender, 'company'), contact: page.contact.email ? { name: page.sender.companyName, email: page.contact.email } : null }
}

/**
 * A PDF's permanent address through the web's API proxy (`/api` → the factory API): the page's viewer reads it, a new
 * tab opens it, `download` saves it under its own name (the API's `?download=1`).
 */
export function publicDocFileUrl(code: string, fileId: string, download = false): string {
  return `/api/public/doc/${encodeURIComponent(code)}/files/${encodeURIComponent(fileId)}${download ? '?download=1' : ''}`
}

/** The download's file name: the file's own, ending in .pdf. */
export const pdfName = (name: string): string => (/\.pdf$/i.test(name) ? name : `${name}.pdf`)
