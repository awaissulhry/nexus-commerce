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
 *   F-SA-263: a page may name each tab's own default (`defaultWidth`) and keep the choice per tab and "hidden" (`dockTab`).
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

// ---- F-SA-263 (sales page plan N6, P11; 10-order-page §5): each tab its own default width (replaces the `wide` boolean).
/**
 * A tab's dock width when the person chose none: one width, or `grid` — a wide grid tab (the lines, a BOM, sizes, cost, cutting):
 * one third under 1600 px, 40 % from 1600 (the picture's rule R-18: no sideways scroll on Lines at 1440 with the thread open).
 */
export type DockDefault = DockWidth | 'grid'

/** A tab's default at a viewport: `grid` is one third under 1600 px and 40 % from 1600; any other default is itself. */
export function defaultWidthAt(value: DockDefault, viewport: number): DockWidth {
  if (value === 'grid') return viewport < THIRD_BELOW ? 'third' : 'forty'
  return value
}

/**
 * The dock's width now: the person's choice when they made one (for this record type, or this tab of it); else the tab's own default
 * (40 % when the page names none).
 */
export function dockWidth(input: { readonly chosen: DockWidth | null; readonly defaultWidth?: DockDefault; readonly viewport: number }): DockWidth {
  if (input.chosen) return input.chosen
  return defaultWidthAt(input.defaultWidth ?? 'forty', input.viewport)
}

/**
 * On arrival, the address shows a docked thread the person had hidden (10-order-page §6.3): an old `?tab=activity`, `panel=approvals`
 * or any `?thread=` (the New messages cell's `new`, a dock scope). ⌘J and the band's button show it too.
 */
export function showsOnArrival(search: string | { get(name: string): string | null } | null | undefined): boolean {
  if (!search) return false
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search : `?${search}`) : search
  return arrivalOf(params).openThread || params.get('thread') !== null
}
// ---- end F-SA-263

// ---- F-SA-262 (10-order-page §6.1): the narrow page's full-width conversation is open while the address names it — `?thread=open`,
// or a dock scope the page's pick keeps there (`general`, `project:<id>`, `wo:<id>`, `all`); `new` is an arrival the frame takes.
export function viewOpenOf(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value !== '' && value !== 'new'
}
// ---- end F-SA-262

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
  /** F-OP-212: the thread whose viewer opens them (absent: the page's own record; the frame fills it in). */
  readonly record?: FrameRecord | null
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

// ---- F-SA-265 (sales page plan N2, N4, N6; picks P2, P9, R10; 10-order-page §6.4): Discuss — a row of the body opens the record's
// conversation about it. The body names the part (its kind and id when the conversation can keep the reference: a line, a shipment,
// an invoice, a deposit request, a gate, a change request, a work order of THIS order — B-SA-061's list), the chip's words for an
// office note and for a message to the customer (null: office only — the chip goes on a reply), and, for a part the conversation
// cannot keep, the note's first line in words.
export const DISCUSS_KINDS = ['SalesOrderLine', 'Shipment', 'Invoice', 'DepositRequest', 'OrderGate', 'OrderChangeRequest', 'WorkOrder'] as const
export type DiscussKind = (typeof DISCUSS_KINDS)[number]

export interface DiscussAbout {
  readonly ref: { readonly kind: DiscussKind; readonly id: string } | null
  /** The chip's words in an office note ("SO-2026-0142 · line 2"). */
  readonly office: string
  /** The chip's words in a message to the customer ("your order · line 2": its own words, no price, no work-order number); null: office only. */
  readonly customer: string | null
  /** A part the conversation cannot keep: the office note's first line, in words. */
  readonly line?: string
}

/** What the body asks the conversation: discuss this part (on this record's own conversation). */
export interface DiscussAsk {
  readonly record: { readonly type: string; readonly id: string }
  readonly about: DiscussAbout
}

/** What the body asks the conversation: show the history step of a change of this record (the step nearest `at`). */
export interface ShowInThreadAsk {
  readonly record: { readonly type: string; readonly id: string }
  readonly at: string
}

/**
 * The frame's doors into the conversation (B-TH-262's approve, F-SA-265's followers; F-OP-212, review N-1: `owner` — the door to
 * choose who answers the customer, the thread's owner dialog, for the order's Overview "Answers the customer · Change…").
 */
export type FrameDoor = 'approve' | 'followers' | 'owner'

/** The history step a change of the record is (the newest step within `withinMs` of it), or null: not in the conversation's history. */
export function stepNearest(events: readonly { readonly id: string; readonly at: string }[], at: string, withinMs = 10 * 60_000): string | null {
  const target = Date.parse(at)
  if (Number.isNaN(target)) return null
  let best: { id: string; gap: number } | null = null
  for (const event of events) {
    const gap = Math.abs(Date.parse(event.at) - target)
    if (Number.isNaN(gap) || gap > withinMs) continue
    if (!best || gap < best.gap) best = { id: event.id, gap }
  }
  return best?.id ?? null
}
// ---- end F-SA-265

// ---- F-SA-244 (sales page plan P5, P24; 14-change-flow §3.1 "Order thread | the ask message's card Answer… | the same address (the
// dock asks the frame: a NEW door kind beside openDoor('approve'))"): the conversation asks the PAGE to open its ONE review window on
// a customer's request. The page gives the door (the order page: its door hook's `?open=<request id>`); a page without one gives none,
// and the card offers no Answer….
export interface FrameAnswer {
  /** Open the review window on the request (the page's own address word; the tab and scroll kept). */
  readonly open: (requestId: string) => void
  /** The address that opens it (a real link: ⌘-click opens it in a new tab); null: none for this request. */
  readonly href: (requestId: string) => string | null
}
// ---- end F-SA-244

// ---- F-OP-212 (order page plan N4; 11-dock §5; review N-1, D5): every frame ask names its record. A page hands the frame its own
// record (`RecordFrame record={{ type, id }}`: the order, the customer, the work order); the frame fills it into every ask that names
// none (files, a door, compose); Discuss and Show already name one. A docked thread takes an ask only when it is for its own record,
// so a file opened from the body while the dock shows All of <customer>, General or a work order's notes never opens in the wrong
// thread (nor waits there to fire later): the host moves its pick to that record's thread first, keeping the view as it is, and that
// thread takes it. A page that names no record of its own keeps today's rule (its one thread takes every ask).

/** The record a frame ask is for (the thread it opens in). */
export interface FrameRecord {
  readonly type: string
  readonly id: string
}

/** A door of the conversation the body opens, and the thread it is for (null: the page names no record — its one thread). */
export interface FrameDoorAsk {
  readonly door: FrameDoor
  readonly record: FrameRecord | null
}

/**
 * Answer / Reply in the thread (F-OP-103's "Reply in the thread", F-OP-207's Answer on a line of All of <customer>): the thread of
 * `record` opens at `messageId` with the box focused — `reply` answers that message (the card's own Reply: the customer reads it),
 * `note` is an office note.
 */
export interface ComposeAsk {
  /** The thread to write in (absent: the page's own record; the frame fills it in). */
  readonly record?: FrameRecord | null
  /** The message the thread opens at (null: the box only). */
  readonly messageId: string | null
  readonly mode: 'reply' | 'note'
}

/** The same record (type and id). */
export const sameRecord = (a: FrameRecord | null | undefined, b: FrameRecord | null | undefined): boolean => !!a && !!b && a.type === b.type && a.id === b.id

/** An ask's record: the one it names, else the page's own; null where neither is known (a page without a record of its own). */
export function askRecordOf(asked: FrameRecord | null | undefined, page: FrameRecord | null | undefined): FrameRecord | null {
  const record = asked ?? page ?? null
  return record ? { type: record.type, id: record.id } : null
}

/** Whether the thread of `key` takes an ask for `record`: only its own record's; an ask that names none (no page record): any thread. */
export function takesAsk(record: FrameRecord | null | undefined, key: FrameRecord): boolean {
  return !record || sameRecord(record, key)
}

/** The asks the frame holds for its thread (RecordFrameState's), each null when none waits. */
export interface FrameAsks {
  readonly composeAsk?: ComposeAsk | null
  readonly discussAsk?: DiscussAsk | null
  readonly showAsk?: ShowInThreadAsk | null
  readonly filesAsk?: FrameFilesAsk | null
  readonly door?: FrameDoorAsk | null
}

/**
 * The ask waiting for a thread now, with its record (the host moves its pick to that record's thread first; the ask itself is the
 * key of that move: once per ask). Null: none waits, or the one waiting names no record.
 */
export function pendingAskOf(asks: FrameAsks | null | undefined): { readonly ask: object; readonly record: FrameRecord } | null {
  if (!asks) return null
  for (const ask of [asks.composeAsk, asks.discussAsk, asks.showAsk, asks.filesAsk, asks.door]) {
    if (ask?.record) return { ask, record: ask.record }
  }
  return null
}
// ---- end F-OP-212
