import { QUEUED_ACTIONS, type FloorSyncKind } from '@nexus/factory-domain/floor-sync/kinds'
import type { ScanIdKind } from '@nexus/factory-domain/numbering/kinds'
import type { ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { discardRefused, fetchMine, sendQueue, type MineAnswer } from './api'
import { applyAnswers, applyClosed, isLow, nextSend, pruned, remainingOf, takeNumber, withBlocks, type ClockCheck, type Numbers, type QueueItem, type StorageState } from './model'
import { EMPTY_META, type Meta, type QueueStorage } from './storage'

/**
 * The tablet's offline queue at run time (B-W0-30; PLT-237, PLT-239, PLT-240, PLT-242; design floor.sync): every floor
 * action that may queue (factory-domain floor-sync QUEUED_ACTIONS) is saved here first — "Saved on this tablet", one
 * tick — and sent in the queue's order when the network is there; the server's answer moves it to "Recorded by the
 * office" (two ticks), or to the refused list with its reason and one fix. Sends happen when the network comes back,
 * when the screen comes back into view, after each new action, and on a timer while anything waits; one at a time.
 * A label the action prints offline takes its number from the tablet's own block (the queue tops the blocks up with
 * each send). Actions that need a number from the office at once (receipts, inspections, releases) never come here:
 * their screens hold them while offline.
 */

export type QueueProblem = 'signedOut' | 'unavailable' | null

/** With nothing to send, the person's refused list is read again at most this often (the office may discard one). */
const REFRESH_EVERY_MS = 5 * 60_000

export interface QueueSnapshot {
  /** The stored queue was read. */
  readonly ready: boolean
  readonly online: boolean
  /** A send is in flight. */
  readonly sending: boolean
  readonly items: readonly QueueItem[]
  /** The server's last answer to a send. */
  readonly lastSentAt: string | null
  /** The tablet's clock against the server's, at the last send (PLT-240). */
  readonly clock: ClockCheck | null
  readonly numbers: Numbers
  /** The person's open refused actions on the server, and other people's counted (refreshed when online). */
  readonly server: MineAnswer | null
  readonly storage: StorageState & { readonly durable: boolean }
  /** Why the last send did not reach the office. */
  readonly problem: QueueProblem
}

export interface QueueContext {
  readonly deviceId: string | null
  /** The person signed in (null: nobody; nothing is sent). */
  readonly workerId: string | null
  /** The label kinds this tablet numbers offline (its permissions: making bundles → BUNDLE). */
  readonly numberKinds: readonly ScanIdKind[]
}

export interface QueueOptions {
  readonly now?: () => Date
  readonly newId?: () => string
}

export class FloorQueue {
  private snapshot: QueueSnapshot
  private meta: Meta = EMPTY_META
  private readonly listeners = new Set<() => void>()
  private context: QueueContext = { deviceId: null, workerId: null, numberKinds: [] }
  private flight: Promise<void> | null = null
  private again = false
  /** When the refused list was last read from the server (ms). */
  private refreshedAt = 0
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(
    private readonly storage: QueueStorage,
    private readonly api: ApiClient,
    options: QueueOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.snapshot = { ready: false, online: true, sending: false, items: [], lastSentAt: null, clock: null, numbers: EMPTY_META.numbers, server: null, storage: { persisted: null, freeMb: null, durable: storage.durable }, problem: null }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): QueueSnapshot => this.snapshot

  private set(next: Partial<QueueSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  /** Reads the stored queue (once); old recorded actions leave. A browser that refuses its storage starts empty, and says so. */
  async start(): Promise<void> {
    let stored: { items: QueueItem[]; meta: Meta }
    try {
      stored = await this.storage.load()
    } catch {
      this.set({ ready: true, storage: { ...this.snapshot.storage, durable: false } })
      return
    }
    const { items, meta } = stored
    const kept = pruned(items, this.now())
    const gone = items.filter((item) => !kept.includes(item)).map((item) => item.clientEventId)
    if (gone.length > 0) await this.storage.remove(gone)
    this.meta = meta
    this.set({ ready: true, items: kept, lastSentAt: meta.lastSentAt, numbers: meta.numbers })
  }

  setContext(context: QueueContext): void {
    const changed = context.deviceId !== this.context.deviceId || context.workerId !== this.context.workerId
    this.context = context
    if (changed && context.workerId) void this.sync()
  }

  setOnline(online: boolean): void {
    if (online === this.snapshot.online) return
    this.set({ online })
    if (online) void this.sync()
  }

  setStorage(storage: StorageState): void {
    this.set({ storage: { ...storage, durable: this.snapshot.storage.durable } })
  }

  private async persist(changed: readonly QueueItem[], items: readonly QueueItem[], meta: Partial<Meta> = {}): Promise<void> {
    this.meta = { ...this.meta, ...meta }
    await this.storage.save(changed, this.meta)
    this.set({ items, numbers: this.meta.numbers, lastSentAt: this.meta.lastSentAt })
  }

  /**
   * Saves one action on the tablet ("Saved on this tablet") and sends the queue when it can. A label the action prints
   * offline takes the next number of the tablet's own block (`ticketCode` of a bundle), unless the screen gave one.
   */
  async enqueue(kind: FloorSyncKind, payload: Readonly<Record<string, unknown>>): Promise<QueueItem> {
    const { deviceId, workerId } = this.context
    if (!deviceId || !workerId) throw new Error('A floor action is saved for the person signed in on an enrolled tablet.')
    let body: Record<string, unknown> = { ...payload }
    let numbered: QueueItem['numbered'] = null
    let numbers = this.meta.numbers
    const kindOfNumber = QUEUED_ACTIONS[kind].numbers
    if (kindOfNumber && body.ticketCode === undefined) {
      const taken = takeNumber(numbers, kindOfNumber)
      if (taken) {
        numbers = taken.numbers
        numbered = { kind: kindOfNumber, code: taken.code, blockId: taken.blockId, ref: taken.ref }
        body = { ...body, ticketCode: taken.code }
      }
      // No number left on the tablet: the office numbers the ticket when the action arrives.
    }
    const item: QueueItem = {
      clientEventId: this.newId(),
      seq: this.meta.nextSeq,
      kind,
      payload: body,
      occurredAt: this.now().toISOString(),
      workerId,
      deviceId,
      state: 'waiting',
      attempts: 0,
      refusal: null,
      recordedAt: null,
      result: null,
      numbered,
    }
    await this.persist([item], [...this.snapshot.items, item], { nextSeq: this.meta.nextSeq + 1, numbers })
    void this.sync()
    return item
  }

  /** Sends the queue now (one send at a time; a call during a send sends once more after it, before it resolves). */
  sync(): Promise<void> {
    if (this.flight) {
      this.again = true
      return this.flight
    }
    this.flight = (async () => {
      try {
        do {
          this.again = false
          await this.run()
        } while (this.again)
      } finally {
        this.flight = null
      }
    })()
    return this.flight
  }

  private async run(): Promise<void> {
    const { deviceId, workerId, numberKinds } = this.context
    if (!this.snapshot.ready || !this.snapshot.online || !deviceId || !workerId) return
    // Nothing to send and no label numbers to top up: only the refused list is read again now and then.
    const due = (numbers: Numbers) => numberKinds.filter((kind) => !numbers.scanTag || isLow(numbers, kind))
    if (nextSend(this.snapshot.items, deviceId).length === 0 && due(this.meta.numbers).length === 0) {
      if (this.now().getTime() - this.refreshedAt >= REFRESH_EVERY_MS || this.snapshot.items.some((item) => item.state === 'refused')) await this.refresh().catch(() => undefined)
      return
    }
    this.set({ sending: true })
    try {
      for (let round = 0; round < 20; round++) {
        const batch = nextSend(this.snapshot.items, deviceId)
        // The tablet's own counts only for the kinds running low (or before it knows its blocks): each top-up is audited.
        const blocks = due(this.meta.numbers).map((kind) => ({ kind, remaining: remainingOf(this.meta.numbers, kind) }))
        if (batch.length === 0 && (round > 0 || blocks.length === 0)) break
        const answer = await sendQueue(this.api, {
          sentAt: this.now().toISOString(),
          events: batch.map((item) => ({ clientEventId: item.clientEventId, seq: item.seq, kind: item.kind, occurredAt: item.occurredAt, workerId: item.workerId, payload: item.payload })),
          ...(blocks.length > 0 ? { blocks } : {}),
        })
        const items = applyAnswers(this.snapshot.items, answer.events)
        const changed = items.filter((item, index) => item !== this.snapshot.items[index])
        const numbers = answer.blocks ? withBlocks(this.meta.numbers, answer.blocks.scanTag, answer.blocks.blocks) : this.meta.numbers
        await this.persist(changed, items, { lastSentAt: answer.serverTime, numbers })
        this.set({ clock: answer.clock, problem: null })
        // Everything answered was taken; another round only when the send was full.
        if (batch.length < 50 || answer.events.every((event) => event.status === 'waiting')) break
      }
      await this.refresh()
    } catch (error) {
      this.set({ problem: isApiError(error) && error.kind === 'signed_out' ? 'signedOut' : 'unavailable' })
    } finally {
      this.set({ sending: false })
    }
  }

  /** Reads the person's refused actions from the server; ones the office discarded leave this tablet's list. */
  async refresh(): Promise<void> {
    if (!this.snapshot.online || !this.context.workerId) return
    const server = await fetchMine(this.api)
    this.refreshedAt = this.now().getTime()
    const open = new Set(server.refused.map((row) => row.id))
    const shareAll = server.subject === 'STATION'
    const closed = new Map<string, 'DISCARDED'>()
    for (const item of this.snapshot.items) {
      const mine = shareAll || item.workerId === this.context.workerId
      if (item.state === 'refused' && mine && item.refusal?.id && !open.has(item.refusal.id)) closed.set(item.refusal.id, 'DISCARDED')
    }
    if (closed.size > 0) {
      const items = applyClosed(this.snapshot.items, closed)
      await this.persist(items.filter((item, index) => item !== this.snapshot.items[index]), items)
    }
    this.set({ server })
  }

  /** "Discard" (design sync.discard): the refused action will not be recorded; the team leader sees it was discarded. */
  async discard(clientEventId: string): Promise<boolean> {
    const item = this.snapshot.items.find((entry) => entry.clientEventId === clientEventId)
    const refusedId = item?.refusal?.id
    if (!item || item.state !== 'refused' || !refusedId || !this.snapshot.online) return false
    await discardRefused(this.api, refusedId)
    const items = this.snapshot.items.map((entry) => (entry === item ? { ...entry, state: 'discarded' as const } : entry))
    await this.persist([items.find((entry) => entry.clientEventId === clientEventId)!], items)
    await this.refresh().catch(() => undefined)
    return true
  }

  /** "Discard" of a refused action the server keeps and this tablet no longer holds (after a data loss). */
  async discardServer(refusedId: string): Promise<void> {
    await discardRefused(this.api, refusedId)
    await this.refresh()
  }
}
