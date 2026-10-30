import { isApiError } from '../../lib/api/errors'
import type { LinkDocument, LinkDocumentKind, LinkDocuments } from './api'

/**
 * SCR-101 — the shipment's documents by link (design links.document, W1; LOG-020, COL-051): pure rules, so the tests hold
 * them. Which document is shown, the other languages of the same document, the link's "works until … · N opens left",
 * the expiry passing while the page is open, and the dead states (expired, withdrawn) that offer "Ask for a new link".
 */

/** The page's state: reading, ready, or why the link shows nothing any more (each says so in this page's words). */
export type DocumentLinkState = 'loading' | 'valid' | 'expired' | 'unavailable' | 'error'

/** The chosen document's PDF as this visit read it (memory only: never stored on the device). */
export interface DocumentPdf {
  readonly fileId: string
  readonly state: 'loading' | 'ready' | 'failed'
  readonly data: Uint8Array | null
}

/** "Ask for a new link": not asked, on its way, passed on (the one answer), or the request did not reach us. */
export type AskState = 'idle' | 'busy' | 'done' | 'failed'

export interface DocumentLinkViewModel {
  link: DocumentLinkState
  /** The link's documents as read (null before the first read, or when it failed). */
  documents: LinkDocuments | null
  /** The file the person chose (null: the first of the list). */
  chosen: string | null
  pdf: DocumentPdf | null
  /** The read takes longer than about a second: "Still loading…". */
  slow: boolean
  ask: AskState
  /** When the link expired, as the page saw it pass (the expired state names the time). */
  expiredAt?: string | null
  /** The sender's time zone for dates and times (default Europe/Rome). */
  timeZone?: string
}

export interface DocumentLinkActions {
  onChoose?: (fileId: string) => void
  onDownload?: () => void
  onRetry?: () => void
  onRetryPdf?: () => void
  onAskNewLink?: () => void
}

/** The list's order: the DDT first (it travels with the goods), then the declarations and leaflets per style, the rest. */
const KIND_ORDER: Readonly<Record<LinkDocumentKind, number>> = { DDT: 0, DECLARATION_OF_CONFORMITY: 1, USER_INFORMATION: 2, OTHER: 3 }

export function sortedDocuments(documents: readonly LinkDocument[]): LinkDocument[] {
  return [...documents].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.style?.code ?? '').localeCompare(b.style?.code ?? '') ||
      (b.style?.revision ?? 0) - (a.style?.revision ?? 0) ||
      (a.language ?? '').localeCompare(b.language ?? '') ||
      a.originalName.localeCompare(b.originalName),
  )
}

/** The document on screen: the one chosen when the link still shows it, else the first of the list; null when none. */
export function shownDocument(documents: readonly LinkDocument[], chosen: string | null): LinkDocument | null {
  const sorted = sortedDocuments(documents)
  return sorted.find((document) => document.fileId === chosen) ?? sorted[0] ?? null
}

/** The same document in other languages: the same kind, style and revision (never for a DDT or an unknown file). */
export function languageVersions(documents: readonly LinkDocument[], document: LinkDocument): LinkDocument[] {
  if (document.kind === 'DDT' || document.kind === 'OTHER' || !document.style || !document.language) return [document]
  return sortedDocuments(
    documents.filter(
      (other) => other.kind === document.kind && other.style?.code === document.style?.code && other.style?.revision === document.style?.revision && other.language !== null,
    ),
  )
}

/**
 * The list the page shows: one row per document, with its other languages folded into it (the row opens the version in
 * the page's language when there is one, else the first). A DDT and an unknown file are always rows of their own.
 */
export function documentRows(documents: readonly LinkDocument[], pageLanguage: string): { readonly document: LinkDocument; readonly versions: readonly LinkDocument[] }[] {
  const seen = new Set<string>()
  const rows: { document: LinkDocument; versions: LinkDocument[] }[] = []
  for (const document of sortedDocuments(documents)) {
    if (seen.has(document.fileId)) continue
    const versions = languageVersions(documents, document)
    versions.forEach((version) => seen.add(version.fileId))
    rows.push({ document: versions.find((version) => version.language === pageLanguage) ?? versions[0] ?? document, versions })
  }
  return rows
}

/** The row a document belongs to (its language versions), for the chosen one. */
export function rowOf(rows: ReturnType<typeof documentRows>, fileId: string): (typeof rows)[number] | null {
  return rows.find((row) => row.versions.some((version) => version.fileId === fileId)) ?? null
}

/** The link died while the page was open: its expiry is past by the device's clock. */
export function isExpired(link: { readonly expiresAt: string }, now: Date): boolean {
  const at = Date.parse(link.expiresAt)
  return Number.isFinite(at) && at <= now.getTime()
}

/** The longest a timer waits in one go (setTimeout's limit); the page checks again when it fires. */
export const MAX_TIMER_MS = 2_147_483_647

/** How long until the expiry passes (0 when it has; capped at the timer's limit). */
export function msUntilExpiry(link: { readonly expiresAt: string }, now: Date): number {
  const at = Date.parse(link.expiresAt)
  if (!Number.isFinite(at)) return MAX_TIMER_MS
  return Math.min(MAX_TIMER_MS, Math.max(0, at - now.getTime()))
}

/** The page's state for a failed read: the one 404 of a dead link (used up, withdrawn, expired), else an error. */
export function stateOfReadError(error: unknown): Extract<DocumentLinkState, 'unavailable' | 'error'> {
  return isApiError(error) && error.kind === 'not_found' ? 'unavailable' : 'error'
}

/** The state of a link that answered its documents: expired by the clock, else valid. */
export function stateOfDocuments(documents: LinkDocuments, now: Date): Extract<DocumentLinkState, 'valid' | 'expired'> {
  return isExpired(documents.link, now) ? 'expired' : 'valid'
}

/** The link's opens left, in words chosen by count: none, the last one, a few, many. */
export function opensLeftTone(usesLeft: number): 'warning' | 'neutral' {
  return usesLeft <= 3 ? 'warning' : 'neutral'
}

/** A language's name in the page's language ("Inglese", "English"); the code in capitals when the browser cannot say. */
export function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code)
    if (name && name.toLowerCase() !== code.toLowerCase()) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)
  } catch {
    // An unknown code or an old browser: the code itself.
  }
  return code.toUpperCase()
}

/** The download's file name: the file's own name, ending in .pdf when it is a PDF. */
export function fileNameOf(document: Pick<LinkDocument, 'originalName' | 'contentType'>): string {
  const name = document.originalName.trim() || 'document'
  return document.contentType === 'application/pdf' && !/\.pdf$/i.test(name) ? `${name}.pdf` : name
}

/** A file the page reads in the viewer (a PDF); anything else is downloaded only. */
export const isPdf = (document: Pick<LinkDocument, 'contentType'>): boolean => document.contentType === 'application/pdf'

/** A business day (YYYY-MM-DD) at noon UTC, so no zone moves it a day. */
export const dayInstant = (day: string): string => `${day}T12:00:00Z`
