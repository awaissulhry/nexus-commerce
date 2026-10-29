import type { FloorSyncKind } from '@nexus/factory-domain/floor-sync/kinds'
import { MAX_SYNC_EVENTS } from '@nexus/factory-domain/floor-sync/rules'
import { LOW_WATER, SCAN_TYPE_OF } from '@nexus/factory-domain/numbering/blocks'
import type { ScanIdKind } from '@nexus/factory-domain/numbering/kinds'
import { formatScanId } from '@nexus/factory-domain/numbering/scan-id'

/**
 * The tablet's offline queue, as rules without storage or network (B-W0-30; PLT-237, PLT-239, PLT-240; design
 * floor.sync SCR-023, "two ticks": saved on this tablet / recorded by the office). Pure, so the tests hold them.
 *
 * An action done on the tablet becomes an event: the tablet's own id for it (`clientEventId`), its place in the queue
 * (`seq`, FIFO), the tablet's clock (`occurredAt`), who did it (`workerId`) and the module's body (`payload`). It is
 * WAITING until the server answers: RECORDED (accepted, or recorded before), REFUSED (with its reason, one fix, and
 * whether it may pass later: a refusal that is not final stays in the queue and is sent again by itself), or still
 * WAITING (another person's action while someone else is signed in). A discarded refusal leaves the list.
 * Waiting actions cannot be edited or deleted here (no loss by mistake).
 */

export const ITEM_STATES = ['waiting', 'refused', 'recorded', 'discarded'] as const
export type ItemState = (typeof ITEM_STATES)[number]

export interface Refusal {
  /** The server's kept refused action (null: not kept, e.g. another person's action that waits for them). */
  readonly id: string | null
  readonly code: string
  readonly message: string
  readonly fix: string
  readonly final: boolean
}

export interface QueueItem {
  readonly clientEventId: string
  readonly seq: number
  readonly kind: FloorSyncKind
  readonly payload: Readonly<Record<string, unknown>>
  /** When it was done, by the tablet's clock. */
  readonly occurredAt: string
  /** Who did it (the worker signed in then). */
  readonly workerId: string
  /** The tablet it was done on: a queue never sends another tablet's actions. */
  readonly deviceId: string
  readonly state: ItemState
  /** Sends that reached the server without recording it. */
  readonly attempts: number
  readonly refusal: Refusal | null
  /** The server's time when it recorded it. */
  readonly recordedAt: string | null
  readonly result: { readonly type: string; readonly id: string } | null
  /** A label number it took from the tablet's own block (printed offline). */
  readonly numbered: { readonly kind: ScanIdKind; readonly code: string; readonly blockId: string; readonly ref: number } | null
}

/** What the sync answers per event (apps/factory-api platform/floor-sync contract). */
export interface EventAnswer {
  readonly clientEventId: string
  readonly status: 'accepted' | 'duplicate' | 'refused' | 'waiting'
  readonly serverTime: string | null
  readonly result: { readonly type: string; readonly id: string } | null
  readonly refusal: Refusal | null
}

/** The events of the next send: this tablet's waiting ones and the refused ones that may pass later, in queue order. */
export function nextSend(items: readonly QueueItem[], deviceId: string, max = MAX_SYNC_EVENTS): QueueItem[] {
  return items
    .filter((item) => item.deviceId === deviceId && (item.state === 'waiting' || (item.state === 'refused' && item.refusal !== null && !item.refusal.final)))
    .sort((a, b) => a.seq - b.seq)
    .slice(0, max)
}

/** The queue after the server's answers. */
export function applyAnswers(items: readonly QueueItem[], answers: readonly EventAnswer[]): QueueItem[] {
  const byId = new Map(answers.map((answer) => [answer.clientEventId, answer]))
  return items.map((item) => {
    const answer = byId.get(item.clientEventId)
    if (!answer) return item
    switch (answer.status) {
      case 'accepted':
      case 'duplicate':
        return { ...item, state: 'recorded', refusal: null, recordedAt: answer.serverTime, result: answer.result }
      case 'refused':
        return { ...item, state: 'refused', refusal: answer.refusal, attempts: item.attempts + 1 }
      case 'waiting':
        return { ...item, state: 'waiting', refusal: answer.refusal }
    }
  })
}

/** The server's word on a refused action: discarded (by the office, or here), or recorded after all. */
export function applyClosed(items: readonly QueueItem[], closed: ReadonlyMap<string, 'DISCARDED' | 'RESOLVED'>): QueueItem[] {
  return items.map((item) => {
    if (item.state !== 'refused' || !item.refusal?.id) return item
    const status = closed.get(item.refusal.id)
    if (status === 'DISCARDED') return { ...item, state: 'discarded' }
    if (status === 'RESOLVED') return { ...item, state: 'recorded', refusal: null }
    return item
  })
}

export interface Counts {
  /** Mine, not yet recorded (waiting, and refused ones that are sent again by themselves). */
  readonly waiting: number
  /** Mine, refused. */
  readonly refused: number
  /** Mine, recorded today. */
  readonly recordedToday: number
  /** Other people's, waiting for them: counted, never shown (Statuto dei Lavoratori art. 4). */
  readonly othersWaiting: number
  readonly othersRefused: number
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export const dayOf = (instant: string | Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(typeof instant === 'string' ? new Date(instant) : instant)

/**
 * The counts the banner and the queue screen show for the person signed in (`workerId`; null: nobody, so every action
 * is someone else's). `shareAll`: the site records the station only, so every action of the tablet is the tablet's.
 */
export function countsFor(items: readonly QueueItem[], viewer: { readonly workerId: string | null; readonly shareAll?: boolean }, today: { readonly now: Date; readonly timeZone: string }): Counts {
  const own = (item: QueueItem) => viewer.shareAll === true || (viewer.workerId !== null && item.workerId === viewer.workerId)
  const day = dayOf(today.now, today.timeZone)
  let waiting = 0
  let refused = 0
  let recordedToday = 0
  let othersWaiting = 0
  let othersRefused = 0
  for (const item of items) {
    const mine = own(item)
    if (item.state === 'waiting') mine ? waiting++ : othersWaiting++
    else if (item.state === 'refused') mine ? refused++ : othersRefused++
    else if (item.state === 'recorded' && mine && item.recordedAt && dayOf(item.recordedAt, today.timeZone) === day) recordedToday++
  }
  return { waiting, refused, recordedToday, othersWaiting, othersRefused }
}

/** Keeps the tablet small: recorded and discarded actions older than two days leave. */
export function pruned(items: readonly QueueItem[], now: Date): QueueItem[] {
  const limit = now.getTime() - 2 * 24 * 3_600_000
  return items.filter((item) => (item.state === 'recorded' || item.state === 'discarded' ? Date.parse(item.recordedAt ?? item.occurredAt) >= limit : true))
}

// ---- the tablet's number blocks (numbering DEVICE blocks: labels printed offline) ------------------------------------------------

export interface Block {
  readonly id: string
  readonly kind: ScanIdKind
  readonly fromRef: number
  readonly toRef: number
  /** The highest number the server saw used (null: none). */
  readonly highestUsedRef: number | null
  readonly status: 'ACTIVE' | 'CLOSED'
}

/** The tablet's blocks and the numbers it took itself (labels printed, maybe not yet sent). */
export interface Numbers {
  readonly scanTag: string | null
  readonly blocks: readonly Block[]
  /** Per block: the highest number this tablet took. */
  readonly taken: Readonly<Record<string, number>>
}

export const NO_NUMBERS: Numbers = Object.freeze({ scanTag: null, blocks: [], taken: {} })

/** The first number of a block still free here: after what the server saw used and what this tablet took. */
const nextRef = (block: Block, taken: Numbers['taken']): number => Math.max(block.fromRef, (block.highestUsedRef ?? 0) + 1, (taken[block.id] ?? 0) + 1)

/** Numbers of a kind still free on this tablet (labels printed and not yet sent count as used). */
export function remainingOf(numbers: Numbers, kind: ScanIdKind): number {
  return numbers.blocks.filter((block) => block.kind === kind && block.status === 'ACTIVE').reduce((sum, block) => sum + Math.max(0, block.toRef - nextRef(block, numbers.taken) + 1), 0)
}

/** Fewer numbers left than the kind's low-water mark: a top-up is due (and offline, the operator is told). */
export const isLow = (numbers: Numbers, kind: ScanIdKind): boolean => remainingOf(numbers, kind) < LOW_WATER[kind]

/** The next label number of a kind from the lowest open block, or null when the tablet has none left. */
export function takeNumber(numbers: Numbers, kind: ScanIdKind): { readonly numbers: Numbers; readonly code: string; readonly blockId: string; readonly ref: number } | null {
  if (!numbers.scanTag) return null
  const open = numbers.blocks.filter((block) => block.kind === kind && block.status === 'ACTIVE').sort((a, b) => a.fromRef - b.fromRef)
  for (const block of open) {
    const ref = nextRef(block, numbers.taken)
    if (ref > block.toRef) continue
    return { numbers: { ...numbers, taken: { ...numbers.taken, [block.id]: ref } }, code: formatScanId({ type: SCAN_TYPE_OF[kind], tenantTag: numbers.scanTag, ref }), blockId: block.id, ref }
  }
  return null
}

/** The server's open blocks replace the tablet's list; what the tablet took stays (a closed block's numbers are refused). */
export const withBlocks = (numbers: Numbers, scanTag: string, blocks: readonly Block[]): Numbers => ({ scanTag, blocks: [...blocks], taken: numbers.taken })

// ---- the clock (PLT-240) and the storage (PLT-242) -------------------------------------------------------------------------------

export interface ClockCheck {
  readonly skewSeconds: number
  readonly off: boolean
  readonly flagged: boolean
}

/** Whole minutes the tablet's clock is off (for the words), at least 1 when it is off. */
export const minutesOff = (clock: ClockCheck): number => Math.max(1, Math.round(Math.abs(clock.skewSeconds) / 60))

export interface StorageState {
  /** The browser promised to keep the tablet's data (navigator.storage.persist). */
  readonly persisted: boolean | null
  /** Megabytes free for this app, when the browser says. */
  readonly freeMb: number | null
}

/** What the screen says of the tablet's storage: kept, space low (under 200 MB free), or the browser may clear it. */
export function storageWord(storage: StorageState): 'kept' | 'low' | 'mayClear' | null {
  if (storage.freeMb !== null && storage.freeMb < 200) return 'low'
  if (storage.persisted === false) return 'mayClear'
  return storage.persisted === true ? 'kept' : null
}
