import type { Locale } from '../../../../lib/i18n/locales'
import type { ApiErrorKind, ApiIssue } from '../../../../lib/api/errors'
import type { CustomerDocument, DocumentFile } from './api'

/**
 * The document pop-up's rules (design portal.customer.documents pop:preview and portal.customer.home pop:document-preview;
 * lifted from Home by B-W2b-195), pure: which file a document opens, whether it can be shown in place, its versions
 * ("v3 replaced v2 on 12 Oct", newest first), the next or previous document (J / K), and a refused open in our words.
 */

export const PREVIEW_NS = 'portal-documents'

/** The languages a document names in our words; another one shows as its code ("DE"). */
export const DOCUMENT_LANGUAGES = ['it', 'en', 'de', 'fr', 'es'] as const
export const languageKey = (code: string): string | null => {
  const lower = code.trim().toLowerCase()
  return (DOCUMENT_LANGUAGES as readonly string[]).includes(lower) ? `language.${lower}` : null
}
export const languageWords = (t: (key: string) => string, code: string): string => {
  const key = languageKey(code)
  return key ? t(key) : code.trim().toUpperCase()
}

/** A PDF (or a picture) can be shown in place; an XML or another file is downloaded. */
const PREVIEWABLE = /^(application\/pdf|image\/(png|jpe?g|webp|gif))\b/i

export const isPicture = (contentType: string): boolean => /^image\/(png|jpe?g|webp|gif)$/i.test(contentType.split(';')[0]!.trim())
export const isPdf = (contentType: string): boolean => contentType.split(';')[0]!.trim().toLowerCase() === 'application/pdf'
export const isPreviewable = (contentType: string): boolean => PREVIEWABLE.test(contentType)

/** The file a document opens: its PDF (an invoice's courtesy copy), else its first file. */
export const mainFileOf = (document: Pick<CustomerDocument, 'files'>): DocumentFile | null => document.files.find((file) => file.format === 'PDF') ?? document.files[0] ?? null

/** What the pop-up shows of a document, in the page's language. */
export interface PreviewRow {
  readonly id: string
  readonly title: string
  readonly kind: string
  /** The order (their PO first, our number), else the record's label. */
  readonly forOrder: string | null
  readonly forLabel: string | null
  readonly date: string
  readonly version: number
  readonly fingerprint: string
  readonly language: string | null
  readonly current: boolean
  /** An earlier version: the one that replaced it. */
  readonly replacedBy: { readonly id: string | null; readonly version: number } | null
  readonly fileName: string
  readonly contentType: string | null
  readonly previewable: boolean
}

/** "PO-77 · SO-2026-0042" (their reference first) or our number alone. */
export const orderWords = (order: { number: string; customerRef: string | null }): string => (order.customerRef ? `${order.customerRef} · ${order.number}` : order.number)

export function previewRowOf(document: CustomerDocument, locale: Locale): PreviewRow {
  const file = mainFileOf(document)
  const order = document.for?.order ?? null
  return {
    id: document.id,
    title: document.title[locale],
    kind: document.kind,
    forOrder: order ? orderWords(order) : null,
    forLabel: order ? null : (document.for?.label ?? null),
    date: document.date,
    version: document.version,
    fingerprint: document.fingerprint,
    language: document.language,
    current: document.current,
    replacedBy: document.replacedBy ? { id: document.replacedBy.id, version: document.replacedBy.version } : null,
    fileName: file?.name ?? document.title[locale],
    contentType: file?.contentType ?? null,
    previewable: file ? isPreviewable(file.contentType) : false,
  }
}

/** One line of the versions ("v3 replaced v2 on 12 Oct"), newest first. */
export interface VersionLine {
  readonly id: string
  readonly version: number
  readonly previous: number | null
  readonly date: string
  readonly current: boolean
}

export function versionLines(versions: readonly Pick<CustomerDocument, 'id' | 'version' | 'date' | 'current'>[]): VersionLine[] {
  const sorted = [...versions].sort((a, b) => b.version - a.version)
  return sorted.map((entry, index) => ({ id: entry.id, version: entry.version, previous: sorted[index + 1]?.version ?? null, date: entry.date, current: entry.current }))
}

/** The document after or before this one in the list (J / K in the pop-up), or null at an end. */
export function neighbourOf(ids: readonly string[], id: string, step: 1 | -1): string | null {
  const at = ids.indexOf(id)
  if (at < 0) return null
  return ids[at + step] ?? null
}

/** A refused open in our words (a key of `portal-documents`): a withdrawn version names the newer one. */
export function openRefusal(error: { kind: ApiErrorKind; issues: readonly ApiIssue[] } | null): { key: string; withdrawn: boolean } {
  if (!error) return { key: 'preview.problem.failed', withdrawn: false }
  const withdrawn = error.issues.some((issue) => issue.path === 'document/WITHDRAWN' || (Array.isArray(issue.path) && issue.path.join('/') === 'document/WITHDRAWN'))
  if (error.kind === 'conflict' && withdrawn) return { key: 'preview.problem.withdrawn', withdrawn: true }
  switch (error.kind) {
    case 'not_found':
      return { key: 'preview.problem.gone', withdrawn: false }
    case 'forbidden':
      return { key: 'preview.problem.forbidden', withdrawn: false }
    case 'conflict':
      return { key: 'preview.problem.notReady', withdrawn: false }
    case 'unavailable':
    case 'rate_limited':
      return { key: 'preview.problem.unavailable', withdrawn: false }
    default:
      return { key: 'preview.problem.failed', withdrawn: false }
  }
}
