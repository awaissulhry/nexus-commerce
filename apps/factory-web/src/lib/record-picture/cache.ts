import { BATCH_MAX, BATCH_WAIT_MS, recordKey, RETRY_AFTER_MS, untilOf, type PictureAnswer, type PictureSource } from './model'

/**
 * F-SA-211 — the ONE picture cache and batch queue of the office (12-lists-board §2.4). Module-level, shared by every list, board
 * and record page of the tab:
 *
 *   by file    the small preview's address per FILE id, used until shortly before it expires (EXPIRY_MARGIN_MS): ten orders of
 *              one style share one address (one presign); a card that moves lanes finds its address again; a new main picture is
 *              a new file id, so the cache can never show the old photo.
 *   last drawn the address last drawn per file id: when it expired, the part keeps showing it while the fresh one is read and
 *              swaps only when the fresh one has loaded (stale-while-reading: a re-mounted card never flashes the placeholder).
 *   by record  the answer per record (absent: null), for a place whose rows name no picture of their own (the week board).
 *   the queue  every mount asks `want(source, record)`; asks of one source made within BATCH_WAIT_MS go out as ONE call of at
 *              most BATCH_MAX ids; a record asked again while its read is out waits for that read. A failed read answers
 *              `failed` (the placeholder) and is asked again only at a mount after RETRY_AFTER_MS (no retry storm).
 */

/** The read itself (the page's own API client): POST /sales/<source>/pictures with the ids; the answer's pictures. */
export type ReadPictures = (source: PictureSource, ids: readonly string[]) => Promise<readonly PictureAnswer[]>

/** What one record's ask comes back with. */
export type Wanted = { readonly answer: PictureAnswer | null } | { readonly failed: true }

interface Small {
  readonly url: string
  readonly until: number
}

const byFile = new Map<string, Small>()
const lastDrawn = new Map<string, string>()
const byRecord = new Map<string, { readonly answer: PictureAnswer | null; readonly until: number }>()
const failedUntil = new Map<string, number>()
const inflight = new Map<string, Promise<Wanted>>()

interface Pending {
  readonly read: ReadPictures
  readonly waiters: Map<string, Array<(wanted: Wanted) => void>>
  timer: ReturnType<typeof setTimeout> | null
}
const pending = new Map<PictureSource, Pending>()

/** How long a record's answer is kept: its address's life; without an address the API's 60 seconds. */
const recordUntil = (answer: PictureAnswer | null, now: number): number => (answer?.small ? untilOf(answer.small.expiresAt) : now + 60_000 - 5_000)

/** The fresh small address of a file, or null. */
export function smallOf(fileId: string | null | undefined, now = Date.now()): string | null {
  if (!fileId) return null
  const known = byFile.get(fileId)
  return known && known.until > now ? known.url : null
}

/** The address last drawn for a file (maybe expired: shown while the fresh one is read). */
export function staleOf(fileId: string | null | undefined): string | null {
  return fileId ? (lastDrawn.get(fileId) ?? null) : null
}

/** The part drew this address for this file. */
export function drawn(fileId: string | null | undefined, url: string): void {
  if (fileId) lastDrawn.set(fileId, url)
}

/** A caller that already holds a file's small address (the order read's lines) gives it to the cache. */
export function keepSmall(fileId: string, small: { readonly url: string; readonly expiresAt: string }): void {
  byFile.set(fileId, { url: small.url, until: untilOf(small.expiresAt) })
}

/** The answer kept for a record (null: absent for this reader), or undefined when not known (or no longer fresh). */
export function recordOf(source: PictureSource, recordId: string, now = Date.now()): PictureAnswer | null | undefined {
  const known = byRecord.get(recordKey(source, recordId))
  return known && known.until > now ? known.answer : undefined
}

/** A read failed for this record and its wait is not over: the part shows its placeholder without asking. */
export function failedRecently(source: PictureSource, recordId: string, now = Date.now()): boolean {
  return (failedUntil.get(recordKey(source, recordId)) ?? 0) > now
}

function settle(source: PictureSource, ids: readonly string[], answers: readonly PictureAnswer[] | null, now: number): Map<string, Wanted> {
  const out = new Map<string, Wanted>()
  if (answers === null) {
    for (const id of ids) {
      failedUntil.set(recordKey(source, id), now + RETRY_AFTER_MS)
      out.set(id, { failed: true })
    }
    return out
  }
  const byId = new Map(answers.map((answer) => [answer.id, answer]))
  for (const id of ids) {
    const answer = byId.get(id) ?? null
    if (answer?.fileId && answer.small) keepSmall(answer.fileId, answer.small)
    byRecord.set(recordKey(source, id), { answer, until: recordUntil(answer, now) })
    failedUntil.delete(recordKey(source, id))
    out.set(id, { answer })
  }
  return out
}

async function flush(source: PictureSource): Promise<void> {
  const batch = pending.get(source)
  if (!batch) return
  pending.delete(source)
  if (batch.timer) clearTimeout(batch.timer)
  const ids = [...batch.waiters.keys()]
  let answers: readonly PictureAnswer[] | null
  try {
    answers = await batch.read(source, ids)
  } catch {
    answers = null
  }
  const settled = settle(source, ids, answers, Date.now())
  for (const [id, waiters] of batch.waiters) {
    inflight.delete(recordKey(source, id))
    for (const waiter of waiters) waiter(settled.get(id) ?? { answer: null })
  }
}

/**
 * Ask for a record's picture (its style, its file, its small address). Asks of one source within BATCH_WAIT_MS are one call
 * (a full batch goes out at once); a record whose read is out waits for it; a record whose read failed less than RETRY_AFTER_MS
 * ago answers `failed` without asking.
 */
export function want(source: PictureSource, recordId: string, read: ReadPictures, now = Date.now()): Promise<Wanted> {
  const key = recordKey(source, recordId)
  if (failedRecently(source, recordId, now)) return Promise.resolve({ failed: true })
  const out = inflight.get(key)
  if (out) return out
  const promise = new Promise<Wanted>((resolve) => {
    let batch = pending.get(source)
    if (!batch) {
      batch = { read, waiters: new Map(), timer: null }
      pending.set(source, batch)
      batch.timer = setTimeout(() => void flush(source), BATCH_WAIT_MS)
    }
    const waiters = batch.waiters.get(recordId)
    if (waiters) waiters.push(resolve)
    else batch.waiters.set(recordId, [resolve])
    if (batch.waiters.size >= BATCH_MAX) void flush(source)
  })
  inflight.set(key, promise)
  return promise
}

/** Forget everything (tests; a sign-out reloads the page). */
export function resetPictureCache(): void {
  for (const batch of pending.values()) if (batch.timer) clearTimeout(batch.timer)
  byFile.clear()
  lastDrawn.clear()
  byRecord.clear()
  failedUntil.clear()
  inflight.clear()
  pending.clear()
}
