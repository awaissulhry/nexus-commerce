'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { pdfPageImage } from '../../pdf/pdf-page'
import { readFromStore } from '../../../record-panels/store'
import { cardKindOf, type CardPreview, type OrderFile } from './model'

/**
 * F-OP-126 (order page plan N7 "files like Gmail"; 10-order-page §9.2; review R-14) — the cards' previews, lazily:
 *   - only the cards in view (the body reports them: an IntersectionObserver, 200 px ahead) are asked, ≤ 24 ids a call, through the
 *     order's own walled batch route (POST …/files/previews) — never the generic per-file preview route, never a presign of every file;
 *   - a picture: its ~320 px small preview, kept per `fileId:versionNo` until its address expires (less 5 s), asked again on expiry
 *     while still in view; none made yet (a HEIC, still in the worker): the kind's icon, asked again a minute later while in view;
 *   - a PDF at most 3 MiB: page 1 drawn in the browser from the inline address the same answer carries (no open call per PDF), at
 *     most 2 at a time, kept in a session LRU of 60 pages; a larger one: "Large PDF: open it to see it" (not asked at all);
 *   - body data and anything else (Word, Excel, a ZIP …) are never asked: the lock card, the kind's card;
 *   - an answer that says `later` (the call's addresses were spent) is asked again a moment after.
 * The container gives it the order's files and its route; the body draws `previews` and reports what is in view.
 */

export const PREVIEW_BATCH_MAX = 24
/** The route draws page 1 of a PDF up to this size (R-14); the web asks none above it. */
export const PDF_DRAWABLE_MAX_BYTES = 3 * 1024 * 1024
export const PDF_DRAWS_AT_ONCE = 2
export const PDF_PAGES_KEPT = 60
export const EXPIRY_MARGIN_MS = 5_000
/** A picture whose small preview is not made yet is asked again this long after, while in view. */
export const NOT_MADE_AGAIN_MS = 60_000
/** A `later` answer is asked again this long after. */
export const LATER_AGAIN_MS = 1_000
/** A card's PDF page is drawn this wide (the card is 176 px; twice for a sharp screen). */
export const PAGE_WIDTH = 360

/** One answer of the route, as the container's call gives it (the small address through the browser's path; the inline one as signed). */
export interface PreviewAnswer {
  readonly fileId: string
  readonly versionNo: number
  readonly kind: 'PICTURE' | 'PDF' | 'OTHER' | 'LOCKED'
  readonly small: { readonly url: string; readonly expiresAt: string } | null
  readonly pdfDrawable: boolean
  readonly inline: { readonly url: string; readonly expiresAt: string } | null
  readonly later: boolean
  /** F-OF-104 (B-OF-006): a picture that will never get a small — asked once, never again (F7-B4). */
  readonly never?: boolean
}

/** What the cache keeps of one file at one version: what the card shows, and until when (a picture's address expires). */
export interface Kept {
  readonly preview: CardPreview
  /** Epoch ms after which it is asked again while in view (Infinity: never — a page drawn here, a large PDF). */
  readonly until: number
}

export const keyOf = (file: Pick<OrderFile, 'id' | 'versionNo'>): string => `${file.id}:${file.versionNo}`

/** Whether a card is ever asked: a picture or a PDF the route draws; never body data, a large PDF or anything else. */
export function asksPreview(file: Pick<OrderFile, 'contentType' | 'bodyData' | 'sizeBytes'>): boolean {
  const kind = cardKindOf(file)
  return kind === 'PICTURE' || (kind === 'PDF' && file.sizeBytes <= PDF_DRAWABLE_MAX_BYTES)
}

/** What a card shows without asking: a large PDF says so; the rest wait for their answer (the kind's icon meanwhile). */
export const knownWithoutAsking = (file: Pick<OrderFile, 'contentType' | 'bodyData' | 'sizeBytes'>): CardPreview | null => (cardKindOf(file) === 'PDF' && file.sizeBytes > PDF_DRAWABLE_MAX_BYTES ? { kind: 'largePdf' } : null)

/** A kept preview still good at `now` (a picture until its address expires, less the margin). */
export const freshOf = (kept: Kept | undefined, now: number): kept is Kept => !!kept && kept.until > now

/**
 * The ids to ask now: in view, asked at all, not kept fresh, not on their way — in view order, at most 24 (the rest at the next turn).
 */
export function wantedOf(visible: readonly string[], files: ReadonlyMap<string, Pick<OrderFile, 'id' | 'versionNo' | 'contentType' | 'bodyData' | 'sizeBytes'>>, kept: ReadonlyMap<string, Kept>, asking: ReadonlySet<string>, now: number): string[] {
  const out: string[] = []
  for (const id of visible) {
    const file = files.get(id)
    if (!file || !asksPreview(file) || asking.has(id) || freshOf(kept.get(keyOf(file)), now)) continue
    out.push(id)
    if (out.length === PREVIEW_BATCH_MAX) break
  }
  return out
}

/**
 * A picture's answer as the card keeps it. F-OF-104 (F7-B3): a small preview, once drawn, is kept while the page stays (the browser holds
 * the picture; it is never fetched again every minute) — a card drawn again after its address expired asks again (`stale`). None made
 * yet: the icon, asked again a minute later; F-OF-104 (F7-B4): one that will never be made (`never`): the icon, never asked again.
 */
export function keptPicture(answer: Pick<PreviewAnswer, 'small' | 'never'>, now: number): Kept {
  if (answer.small) return { preview: { kind: 'picture', src: answer.small.url }, until: Infinity }
  return { preview: { kind: 'icon' }, until: answer.never ? Infinity : now + NOT_MADE_AGAIN_MS }
}

/** A session LRU (the PDF pages drawn here): the newest `max` kept; reading one makes it the newest. */
export class Lru<V> {
  private readonly entries = new Map<string, V>()
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }
  set(key: string, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string)
  }
  get size(): number {
    return this.entries.size
  }
}

/** At most `limit` jobs at a time (the PDF pages drawn: each is a download and a canvas); the rest wait their turn, in order. */
export function queueOf(limit: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []
  const next = () => {
    if (running >= limit) return
    const start = waiting.shift()
    if (start) start()
  }
  return <T,>(job: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        running += 1
        job()
          .then(resolve, reject)
          .finally(() => {
            running -= 1
            next()
          })
      })
      next()
    })
}

// The session's PDF pages (every order page of this tab shares them) and the one drawing queue.
const pages = new Lru<string>(PDF_PAGES_KEPT)
const drawQueue = queueOf(PDF_DRAWS_AT_ONCE)

/** Page 1 of a PDF at its inline address, drawn small (its bytes once, by the store's reader; nothing kept but the picture). */
async function drawFirstPage(inline: { readonly url: string; readonly expiresAt: string }): Promise<string> {
  const bytes = await readFromStore({ method: 'GET', url: inline.url, headers: {}, expiresAt: inline.expiresAt })
  return (await pdfPageImage(bytes, 1, PAGE_WIDTH)).src
}

/**
 * The previews of the cards: `files` the order's files (null: not read), `ask` the route (null: none — the portal's face). Returns what
 * each card shows and the body's report of the cards in view.
 */
export function useFilePreviews(input: { readonly files: readonly OrderFile[] | null; readonly ask: ((fileIds: readonly string[]) => Promise<readonly PreviewAnswer[]>) | null }): { previews: Readonly<Record<string, CardPreview>>; visible: (fileIds: readonly string[]) => void; /* F-OF-104 */ stale: (fileId: string) => void } {
  const { files, ask } = input
  const [kept, setKept] = useState<ReadonlyMap<string, Kept>>(new Map())
  const keptRef = useRef(kept)
  keptRef.current = kept
  const visibleRef = useRef<readonly string[]>([])
  const asking = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const byId = useRef(new Map<string, OrderFile>())
  byId.current = new Map((files ?? []).map((file) => [file.id, file]))
  const askRef = useRef(ask)
  askRef.current = ask

  const keep = useCallback((key: string, value: Kept) => setKept((known) => new Map(known).set(key, value)), [])

  const turn = useCallback(() => {
    const call = askRef.current
    if (!call) return
    const now = Date.now()
    // A PDF page drawn earlier this session is kept for good: no call for it.
    for (const id of visibleRef.current) {
      const file = byId.current.get(id)
      const page = file ? pages.get(keyOf(file)) : undefined
      if (file && page && !freshOf(keptRef.current.get(keyOf(file)), now)) keep(keyOf(file), { preview: { kind: 'page', src: page }, until: Infinity })
    }
    const next = () => wantedOf(visibleRef.current, byId.current, keptRef.current, asking.current, now).filter((id) => !pages.get(keyOf(byId.current.get(id)!)))
    let ids = next()
    if (ids.length === 0) return schedule()
    // F-OF-104 (F7-B2): every card in view is asked now, ≤ 24 a call — the 25th on no longer waits for the next scroll.
    while (ids.length > 0) {
      askBatch(call, ids)
      ids = next()
    }
  }, [keep])

  /** One call of ≤ 24 ids: what comes back is kept (a picture, PDF page 1 drawn here, "Large PDF", the icon). */
  const askBatch = (call: (fileIds: readonly string[]) => Promise<readonly PreviewAnswer[]>, ids: readonly string[]) => {
    for (const id of ids) asking.current.add(id)
    call(ids)
      .then((answers) => {
        const at = Date.now()
        let later = false
        for (const answer of answers) {
          const key = `${answer.fileId}:${answer.versionNo}`
          if (answer.later) {
            later = true
            continue
          }
          if (answer.kind === 'PICTURE') keep(key, keptPicture(answer, at))
          else if (answer.kind === 'PDF' && answer.pdfDrawable && answer.inline) {
            const inline = answer.inline
            void drawQueue(() => drawFirstPage(inline))
              .then((src) => {
                pages.set(key, src)
                keep(key, { preview: { kind: 'page', src }, until: Infinity })
              })
              .catch(() => keep(key, { preview: { kind: 'icon' }, until: Date.now() + NOT_MADE_AGAIN_MS }))
          } else keep(key, { preview: answer.kind === 'PDF' ? { kind: 'largePdf' } : { kind: 'icon' }, until: Infinity })
        }
        if (later) schedule(LATER_AGAIN_MS)
      })
      .catch(() => undefined)
      .finally(() => {
        for (const id of ids) asking.current.delete(id)
        schedule()
      })
  }

  // The next turn: soon (`later`, or more than one batch in view), else when the first kept picture in view expires.
  const schedule = (after?: number) => {
    if (timer.current) clearTimeout(timer.current)
    const now = Date.now()
    const due = after ?? Math.min(...visibleRef.current.map((id) => byId.current.get(id)).flatMap((file) => (file ? [keptRef.current.get(keyOf(file))?.until ?? Infinity] : [])).filter((until) => Number.isFinite(until)).map((until) => Math.max(0, until - now)), Infinity)
    if (Number.isFinite(due)) timer.current = setTimeout(() => turnRef.current(), due)
  }
  const turnRef = useRef(turn)
  turnRef.current = turn

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const visible = useCallback((fileIds: readonly string[]) => {
    visibleRef.current = fileIds
    turnRef.current()
  }, [])

  // F-OF-104 (F7-B3): a card's picture that no longer loads (drawn again after its address expired) is asked again — once a minute at
  // most (a second failure inside the minute keeps the icon until then).
  const failedAt = useRef(new Map<string, number>())
  const stale = useCallback(
    (fileId: string) => {
      const file = byId.current.get(fileId)
      if (!file) return
      const now = Date.now()
      const last = failedAt.current.get(fileId)
      failedAt.current.set(fileId, now)
      if (last !== undefined && now - last < NOT_MADE_AGAIN_MS) return keep(keyOf(file), { preview: { kind: 'icon' }, until: now + NOT_MADE_AGAIN_MS })
      setKept((known) => {
        const left = new Map(known)
        left.delete(keyOf(file))
        return left
      })
      schedule(LATER_AGAIN_MS)
    },
    [keep],
  )

  const previews: Record<string, CardPreview> = {}
  for (const file of files ?? []) {
    const known = knownWithoutAsking(file) ?? kept.get(keyOf(file))?.preview
    if (known) previews[file.id] = known
  }
  return { previews, visible, stale }
}
