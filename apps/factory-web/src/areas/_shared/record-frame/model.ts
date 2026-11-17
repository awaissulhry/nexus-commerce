import type { DockWidth } from '../../../lib/record-thread/head/model'
import type { ThreadFile } from '../../../lib/record-thread/files/model' // B-TH-264 follow-up

/**
 * B-TH-213 — RecordFrame, one place for the thread on a record page (threads plan PL1, PL4; design kit §2; lead pick P2). The pure
 * part: where the thread sits at a width and how wide it is.
 *
 * - From 1280 px the thread is DOCKED on the right, open by default, sticky while the body scrolls, its own scroll, the box at its
 *   foot: a 3 : 2 grid of the page (gap 16), so 40 % at every width (1440 → 519 px, 1920 → 711 px). One third on a wide grid tab
 *   (the lines, a BOM, sizes, cost, cutting) under 1600 px, unless the person chose a width; 50 % or full from the Head's width
 *   menu (Esc from full goes back); ⌘J hides and shows it; the width is remembered per person and record type on this device.
 * - Below 1280 px the band's "Thread" button opens the thread as a full-width view; Back returns to the same tab and scroll.
 * - Below 720 px (the phone, PL4) the same full page, with the band's details behind its "i".
 * - ONE thread per page; banners stay in the body column, never above the thread.
 */

/** From this width the thread docks beside the body. */
export const DOCK_FROM = 1280
/** Below this width a wide grid tab gives the thread one third (the grid needs the room). */
export const THIRD_BELOW = 1600
/** Below this width the page is the phone's (PL4). */
export const PHONE_BELOW = 720

/** How the page shows the thread at a width: docked beside the body, or behind the band's button (a full-width view). */
export type FrameMode = 'docked' | 'stacked'

export function frameMode(viewport: number): FrameMode {
  return viewport >= DOCK_FROM ? 'docked' : 'stacked'
}

/**
 * The dock's width now: the person's choice when they made one; else 40 %, or one third on a wide grid tab under 1600 px (the
 * picture's rule R-18: no sideways scroll on Lines at 1440 with the thread open).
 */
export function dockWidth(input: { readonly chosen: DockWidth; readonly remembered: boolean; readonly wideTab: boolean; readonly viewport: number }): DockWidth {
  if (input.remembered) return input.chosen
  return input.wideTab && input.viewport < THIRD_BELOW ? 'third' : input.chosen
}

/** The body : thread columns of each width (the gap is the grid's). Full leaves the body out. */
export const DOCK_COLUMNS: Readonly<Record<DockWidth, string>> = {
  third: 'minmax(0, 2fr) minmax(0, 1fr)',
  forty: 'minmax(0, 3fr) minmax(0, 2fr)',
  half: 'minmax(0, 1fr) minmax(0, 1fr)',
  full: 'minmax(0, 1fr)',
}

/** The thread's share of the page at a width (for the design numbers: 40 % of 1794 px is the picture's 711 px with the gap). */
export function threadPixels(content: number, width: DockWidth, gap = 16): number {
  if (width === 'full') return content
  const [body, thread] = width === 'third' ? [2, 1] : width === 'forty' ? [3, 2] : [1, 1]
  return Math.round(((content - gap) * thread) / (body + thread))
}

/**
 * What an address asks of the frame on arrival (R-8: every old address keeps working): `?tab=activity` opens the thread (its tools
 * moved to the thread's "⋯"); `panel=approvals` also opens "Ask a partner to approve". Anything else: nothing.
 */
export function arrivalOf(search: string | { get(name: string): string | null } | null | undefined): { readonly openThread: boolean; readonly door: 'approve' | null } {
  if (!search) return { openThread: false, door: null }
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search : `?${search}`) : search
  const activity = params.get('tab') === 'activity'
  const approvals = params.get('panel') === 'approvals'
  // B-TH-230: a list's New messages cell (`?thread=new`) opens the thread, which opens at "New since your last visit" (B-TH-229).
  const fresh = params.get('thread') === 'new'
  return { openThread: activity || approvals || fresh, door: approvals ? 'approve' : null }
}

/**
 * B-TH-229 (band-F05, PL1-F04): the band's Thread button — "Thread", or "Thread · 2 new" with the reader's own new messages (99+
 * above 99), the same number as the thread's Head; the screen reader hears "Thread, 2 new messages".
 */
export function threadButtonWords(count: number): { readonly key: 'thread.button' | 'thread.buttonNew' | 'thread.buttonMany'; readonly count?: number; readonly label: { readonly key: 'thread.buttonNewLabel'; readonly count: number } | null } {
  if (count <= 0) return { key: 'thread.button', label: null }
  const shown = Math.min(count, 99)
  return { key: count > 99 ? 'thread.buttonMany' : 'thread.buttonNew', count: shown, label: { key: 'thread.buttonNewLabel', count: shown } }
}

/** ⌘J (Ctrl J on other systems): show or hide the docked thread, open or close the full-width one. Never with Alt or Shift. */
export function isThreadKey(event: { readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean }): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j'
}

/** The keys a record page lists in its band menu's "Keyboard" line (PR-14: never a "?" overlay in the thread). */
export const FRAME_KEYS: readonly { readonly keys: readonly string[]; readonly words: string }[] = [
  { keys: ['⌘', 'J'], words: 'keys.thread' },
  { keys: ['⌘', '↵'], words: 'keys.step' },
  { keys: ['J', 'K'], words: 'keys.walk' },
  { keys: ['R'], words: 'keys.reply' },
  { keys: ['N'], words: 'keys.note' },
  { keys: ['Esc'], words: 'keys.esc' },
]

// ---- B-TH-264 follow-up (TH-6 part B): a body part opens ITS files in the docked thread's ONE file viewer (the shipment's Documents:
// the travelling documents and the packing lists) — the files it lists, the one clicked first; the viewer walks them with ← / →.
/** A file a body part lists (its id, the name it shows, its type when known: the viewer draws a PDF or a photo, else a card). */
export interface FrameFile {
  readonly id: string
  readonly name: string
  readonly contentType?: string | null
  readonly sizeBytes?: number | null
}
/** What the body asks the thread's viewer: the files it lists (in its order) and the one to show first. */
export interface FrameFilesAsk {
  readonly files: readonly FrameFile[]
  readonly fileId: string
  readonly returnTo?: HTMLElement | null
}

/**
 * The files the thread's viewer walks for a body's ask: each listed file as the thread knows it (one of the record's own files: its
 * kind, size, state, version), else as the body names it — a file of another record the body lists (a certificate travelling with a
 * shipment): its address is asked by its id, and the file store's answer decides whether this reader may open it (a refusal says
 * so in the viewer, never another record's details). The body's order is kept; the first file asked shows first.
 */
export function askedFiles(ask: FrameFilesAsk, known: readonly ThreadFile[], record: { readonly type: string; readonly id: string }): { readonly files: readonly ThreadFile[]; readonly index: number } {
  const seen = new Set<string>()
  const files: ThreadFile[] = []
  for (const file of ask.files) {
    if (seen.has(file.id)) continue
    seen.add(file.id)
    const own = known.find((candidate) => candidate.id === file.id)
    files.push(
      own ?? {
        id: file.id,
        recordType: record.type,
        recordId: record.id,
        name: file.name,
        contentType: file.contentType ?? 'application/octet-stream',
        kind: (file.contentType ?? '').toLowerCase().startsWith('image/') ? 'PHOTO' : 'DOCUMENT',
        sizeBytes: file.sizeBytes ?? 0,
        status: 'AVAILABLE',
        quarantineReason: null,
        visibility: [],
        partyId: null,
        createdAt: '',
        previewUrl: null,
      },
    )
  }
  return { files, index: Math.max(0, files.findIndex((file) => file.id === ask.fileId)) }
}
// ---- end B-TH-264 follow-up
