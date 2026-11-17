import type { FileKind, QuarantineReason } from '../../../record-panels/model'

/**
 * B-TH-211 — the thread's shared pop-ups (threads plan T-POP; features T-POP-F01, F02, F05, F06, F08): the pure part. One
 * file viewer for every place a file is opened (the files line, a message card, the Files view, a Picture cell), the
 * original e-mail in a sandbox, the send-check window, "Leave with unsent text?", "Close thread?" and one count popover.
 * No React, no API: the views draw what this decides, the container fetches the signed addresses.
 *
 * Brand wall (W20, W22, W25): the viewer lists only the files the reader may open (the rest are counted, never named);
 * a held file shows its lock and reason and no download; the original e-mail is drawn with no script, no form, no
 * remote picture until the person asks, and its links as plain text.
 */

/** A file as the viewer opens it. The container fills `src` and `downloadHref` with the API's 60-second signed links. */
export interface ViewerFile {
  readonly id: string
  readonly name: string
  readonly contentType: string
  readonly kind: FileKind
  readonly sizeBytes: number
  /** AVAILABLE opens; QUARANTINED shows its lock and reason (no download); PENDING_UPLOAD is still on its way. */
  readonly status: 'AVAILABLE' | 'QUARANTINED' | 'PENDING_UPLOAD'
  readonly quarantineReason: QuarantineReason | null
  /** What the viewer shows (a photo's or a PDF's signed address; a PDF may also be bytes); null while it is fetched. */
  readonly src: string | Uint8Array | null
  /** A real download link (the signed address with an attachment disposition); null while it is fetched. */
  readonly downloadHref: string | null
  /** The reader may open it. A file they may not open is counted ("One file you cannot open"), never listed. */
  readonly mayOpen: boolean
  /** The message it came with: "Go to message". */
  readonly messageId?: string | null
  /** v2, v3 … when the file has earlier versions. */
  readonly versionNo?: number | null
}

/** How the viewer shows a file: a photo (the DS Lightbox), PDF pages (the DS PdfViewer), a card with Download, or held. */
export type ViewerShow = 'photo' | 'pdf' | 'card' | 'held'

/** Pictures a browser draws (HEIC is not one: it gets the card with Download). */
const DRAWN_PICTURES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export function viewerShow(file: Pick<ViewerFile, 'status' | 'contentType'>): ViewerShow {
  if (file.status === 'QUARANTINED') return 'held'
  const type = file.contentType.toLowerCase()
  if (DRAWN_PICTURES.has(type)) return 'photo'
  if (type === 'application/pdf') return 'pdf'
  return 'card'
}

/** The files the viewer walks (← / →): those the reader may open and that have arrived; the others counted. */
export function viewerList(files: readonly ViewerFile[]): { readonly items: readonly ViewerFile[]; readonly cannotOpen: number } {
  const items = files.filter((file) => file.mayOpen && file.status !== 'PENDING_UPLOAD')
  return { items, cannotOpen: files.filter((file) => !file.mayOpen).length }
}

/** The photos of the list, and where the file at `index` sits among them (the Lightbox walks photos only). */
export function photoRun(items: readonly ViewerFile[], index: number): { readonly photos: readonly ViewerFile[]; readonly at: number } {
  const photos = items.filter((file) => viewerShow(file) === 'photo')
  const current = items[index]
  return { photos, at: current ? Math.max(0, photos.indexOf(current)) : 0 }
}

/** The next index in the walk, or null at either end (no wrap: the DS's rule). */
export function walk(index: number, count: number, direction: -1 | 1): number | null {
  const next = index + direction
  return next < 0 || next >= count ? null : next
}

/** The card's words for a file the viewer does not draw: HEIC, an Office file, a voice note, anything else. */
export function cardWordKey(file: Pick<ViewerFile, 'contentType' | 'kind'>): string {
  const type = file.contentType.toLowerCase()
  if (type === 'image/heic' || type === 'image/heif') return 'viewer.card.heic'
  if (file.kind === 'AUDIO' || type.startsWith('audio/')) return 'viewer.card.audio'
  if (/officedocument|opendocument|msword|ms-excel/.test(type)) return 'viewer.card.office'
  return 'viewer.card.other'
}

/** The words of a held file's reason (the virus scan has three of its own; the store's checks share one). */
export function heldWordKey(reason: QuarantineReason | null): string {
  if (reason === 'scan_pending') return 'viewer.held.scanPending'
  if (reason === 'virus_found') return 'viewer.held.infected'
  if (reason === 'scan_failed') return 'viewer.held.scanFailed'
  return 'viewer.held.checks'
}

// ── the original e-mail ─────────────────────────────────────────────────────────────────────────────────────────────

/** factory-domain email-in/rules.ts MAIL_VERDICTS. */
export const MAIL_VERDICTS = ['PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED', 'DISABLED'] as const
export type MailVerdict = (typeof MAIL_VERDICTS)[number]
export type SenderCheck = 'spf' | 'dkim' | 'dmarc'
export const SENDER_CHECKS: readonly SenderCheck[] = ['spf', 'dkim', 'dmarc']

/** One sender check in words: a key of `record-thread-popups` and its tone. */
export function checkWords(check: SenderCheck, verdict: MailVerdict): { readonly key: string; readonly tone: 'success' | 'danger' | 'neutral' } {
  if (verdict === 'PASS') return { key: `original.check.${check}.pass`, tone: 'success' }
  if (verdict === 'FAIL') return { key: `original.check.${check}.fail`, tone: 'danger' }
  if (verdict === 'GRAY') return { key: 'original.check.gray', tone: 'neutral' }
  return { key: 'original.check.notChecked', tone: 'neutral' }
}

/** How many remote pictures the sanitised HTML holds (each waits in `data-remote-src` until the person allows them). */
export function remotePictures(html: string | null): number {
  return html ? (html.match(/\sdata-remote-src=/gi) ?? []).length : 0
}

/**
 * The page the sandboxed frame shows: the API's sanitised HTML with a strict content security policy (no script, no
 * form, no frame, no connection; pictures only when allowed, and then only https ones), no referrer, and every link
 * turned into its text (proof of what arrived, nothing to follow). The frame is `sandbox=""`: the second wall after
 * the API's sanitiser. Drawn on paper white in both themes, as mail programs do.
 */
export function originalDocument(html: string, options: { readonly allowPictures: boolean }): string {
  const withoutLinks = html.replace(/\s(href|action|formaction|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  const body = options.allowPictures ? withoutLinks.replace(/\sdata-remote-src=/gi, ' src=') : withoutLinks
  const images = options.allowPictures ? 'https: data:' : 'data:'
  const csp = `default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="referrer" content="no-referrer">',
    '<style>:root{color-scheme:light}body{margin:0;padding:12px;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:inherit;text-decoration:none;cursor:text}</style>',
    `</head><body>${body}</body></html>`,
  ].join('')
}

/** The sandbox the original e-mail's frame gets: nothing allowed (no scripts, no same origin, no forms, no pop-ups). */
export const ORIGINAL_SANDBOX = ''

// ── leaving with unsent text ────────────────────────────────────────────────────────────────────────────────────────

/** There is something the person would lose: words in the box (not only spaces) or files waiting in it. */
export function hasUnsent(draft: { readonly text: string; readonly files?: number }): boolean {
  return draft.text.trim().length > 0 || (draft.files ?? 0) > 0
}

// ── the count popovers ──────────────────────────────────────────────────────────────────────────────────────────────

/** The record's counts the Head shows as chips (when not zero): each opens one popover with one action. */
export type CountKind = 'tasks' | 'approvals' | 'partners' | 'followers'
export const COUNT_KINDS: readonly CountKind[] = ['tasks', 'approvals', 'partners', 'followers']

/** A count popover: its lines (already in the reader's words, as far as they may see them) and its one action. */
export interface CountPopoverModel {
  readonly kind: CountKind
  readonly count: number
  readonly lines: readonly { readonly id: string; readonly label: string; readonly meta?: string | null }[]
  /** Why the one action is held now, already in the reader's words (the host's catalogue), or null. */
  readonly held?: string | null
}

/** At most this many lines in a popover; the rest are counted ("and 3 more"). */
export const COUNT_LINES_MAX = 5
