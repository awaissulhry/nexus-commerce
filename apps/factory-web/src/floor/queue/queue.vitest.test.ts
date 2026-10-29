import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { formatScanId } from '@nexus/factory-domain/numbering/scan-id'
import type { ApiClient, HttpMethod, RequestOptions } from '../../lib/api/client'
import { ApiError } from '../../lib/api/errors'
import { shellQueueOf } from '../shell/banner'
import { heldWorkOf, numberKindsOf } from './actions'
import { applyAnswers, countsFor, isLow, minutesOff, nextSend, pruned, remainingOf, storageWord, takeNumber, type Numbers, type QueueItem } from './model'
import { FloorQueue } from './queue'
import { indexedDbStorage, memoryStorage } from './storage'

const DEVICE = '0192f1a2-7b3c-7d4e-8f50-0000000000d1'
const ADA = '0192f1a2-7b3c-7d4e-8f50-0000000000a1'
const BEA = '0192f1a2-7b3c-7d4e-8f50-0000000000b2'
const TAG = '7K'

const item = (seq: number, extra: Partial<QueueItem> = {}): QueueItem => ({
  clientEventId: `evt-0000000${seq}`,
  seq,
  kind: 'production.scan.report',
  payload: { code: `BN-${TAG}-00012${seq}-M`, good: 10 },
  occurredAt: '2026-10-29T08:00:00.000Z',
  workerId: ADA,
  deviceId: DEVICE,
  state: 'waiting',
  attempts: 0,
  refusal: null,
  recordedAt: null,
  result: null,
  numbered: null,
  ...extra,
})

const refusal = (final: boolean, id = 'r-1') => ({ id, code: final ? 'REPLACED' : 'PREVIOUS_NOT_REPORTED', message: 'words', fix: 'fix', final })

describe('the queue in order (PLT-237)', () => {
  it("sends this tablet's waiting actions and the refusals that may pass later, by seq", () => {
    const items = [item(3), item(1), item(2, { state: 'refused', refusal: refusal(true) }), item(4, { state: 'refused', refusal: refusal(false) }), item(5, { deviceId: 'other-tablet' }), item(6, { state: 'recorded' })]
    expect(nextSend(items, DEVICE).map((entry) => entry.seq)).toEqual([1, 3, 4])
    expect(nextSend(items, DEVICE, 2).map((entry) => entry.seq)).toEqual([1, 3])
  })

  it('moves each answered action: recorded (two ticks), refused with its fix, or still waiting for its person', () => {
    const items = [item(1), item(2), item(3)]
    const after = applyAnswers(items, [
      { clientEventId: 'evt-00000001', status: 'accepted', serverTime: '2026-10-29T08:01:00.000Z', result: { type: 'OperationScan', id: 's1' }, refusal: null },
      { clientEventId: 'evt-00000002', status: 'refused', serverTime: null, result: null, refusal: refusal(true) },
      { clientEventId: 'evt-00000003', status: 'waiting', serverTime: null, result: null, refusal: { ...refusal(false), id: null, code: 'OTHER_WORKER' } },
    ])
    expect(after.map((entry) => [entry.state, entry.recordedAt, entry.attempts])).toEqual([
      ['recorded', '2026-10-29T08:01:00.000Z', 0],
      ['refused', null, 1],
      ['waiting', null, 0],
    ])
  })

  it("counts the person's own actions; other people's are counted apart (Statuto dei Lavoratori art. 4)", () => {
    const now = new Date('2026-10-29T10:00:00.000Z')
    const items = [item(1), item(2, { workerId: BEA }), item(3, { state: 'refused', refusal: refusal(true) }), item(4, { state: 'refused', workerId: BEA, refusal: refusal(true) }), item(5, { state: 'recorded', recordedAt: '2026-10-29T09:00:00.000Z' }), item(6, { state: 'recorded', recordedAt: '2026-10-27T09:00:00.000Z' })]
    expect(countsFor(items, { workerId: ADA }, { now, timeZone: 'Europe/Rome' })).toEqual({ waiting: 1, refused: 1, recordedToday: 1, othersWaiting: 1, othersRefused: 1 })
    // A site that records the station only: every action of the tablet is the tablet's.
    expect(countsFor(items, { workerId: ADA, shareAll: true }, { now, timeZone: 'Europe/Rome' })).toMatchObject({ waiting: 2, refused: 2, othersWaiting: 0 })
    // Nobody signed in: nothing is anyone's own.
    expect(countsFor(items, { workerId: null }, { now, timeZone: 'Europe/Rome' })).toMatchObject({ waiting: 0, othersWaiting: 2 })
  })

  it('keeps the tablet small: recorded actions older than two days leave, waiting ones never', () => {
    const now = new Date('2026-10-29T10:00:00.000Z')
    const kept = pruned([item(1, { occurredAt: '2026-10-01T08:00:00.000Z' }), item(2, { state: 'recorded', recordedAt: '2026-10-25T08:00:00.000Z' }), item(3, { state: 'recorded', recordedAt: '2026-10-28T08:00:00.000Z' })], now)
    expect(kept.map((entry) => entry.seq)).toEqual([1, 3])
  })
})

describe("the tablet's own label numbers (DEVICE blocks)", () => {
  const numbers: Numbers = { scanTag: TAG, blocks: [{ id: 'b2', kind: 'BUNDLE', fromRef: 201, toRef: 260, highestUsedRef: null, status: 'ACTIVE' }, { id: 'b1', kind: 'BUNDLE', fromRef: 1, toRef: 10, highestUsedRef: 8, status: 'ACTIVE' }, { id: 'b0', kind: 'BUNDLE', fromRef: 500, toRef: 900, highestUsedRef: null, status: 'CLOSED' }], taken: {} }

  it('takes numbers from the lowest open block, after what the server saw used and what the tablet took', () => {
    const first = takeNumber(numbers, 'BUNDLE')!
    expect(first).toMatchObject({ blockId: 'b1', ref: 9, code: formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 9 }) })
    const second = takeNumber(first.numbers, 'BUNDLE')!
    expect(second.ref).toBe(10)
    const third = takeNumber(second.numbers, 'BUNDLE')!
    expect(third).toMatchObject({ blockId: 'b2', ref: 201 })
    expect(remainingOf(third.numbers, 'BUNDLE')).toBe(59)
    expect(isLow(numbers, 'BUNDLE')).toBe(false)
    expect(isLow(third.numbers, 'HIDE')).toBe(true)
    expect(takeNumber({ ...numbers, blocks: [] }, 'BUNDLE')).toBeNull()
  })

  it('numbers offline only the labels of actions the person may do', () => {
    expect(numberKindsOf(['floor.work', 'production.bundles'])).toEqual(['BUNDLE'])
    expect(numberKindsOf(['floor.work', 'production.scan'])).toEqual([])
    expect([heldWorkOf('warehouse'), heldWorkOf('inspection'), heldWorkOf('packing'), heldWorkOf('cutting'), heldWorkOf('sewing')]).toEqual(['receive', 'inspect', 'serials', null, null])
  })
})

describe('the clock and the storage (PLT-240, PLT-242)', () => {
  it('says how many minutes off, and whether the data is kept', () => {
    expect(minutesOff({ skewSeconds: -421, off: true, flagged: false })).toBe(7)
    expect(minutesOff({ skewSeconds: 20, off: false, flagged: false })).toBe(1)
    expect(storageWord({ persisted: true, freeMb: 2400 })).toBe('kept')
    expect(storageWord({ persisted: true, freeMb: 120 })).toBe('low')
    expect(storageWord({ persisted: false, freeMb: 2400 })).toBe('mayClear')
    expect(storageWord({ persisted: null, freeMb: null })).toBeNull()
  })
})

describe('IndexedDB keeps the queue (PLT-237, PLT-242)', () => {
  it('saves, reads back and removes actions and the meta', async () => {
    const storage = indexedDbStorage(indexedDB)
    expect(await storage.load()).toEqual({ items: [], meta: { nextSeq: 1, numbers: { scanTag: null, blocks: [], taken: {} }, lastSentAt: null } })
    await storage.save([item(1), item(2)], { nextSeq: 3, numbers: { scanTag: TAG, blocks: [], taken: { b1: 9 } }, lastSentAt: null })
    // A second handle (a reload) reads the same.
    const again = await indexedDbStorage(indexedDB).load()
    expect(again.items.map((entry) => entry.seq).sort()).toEqual([1, 2])
    expect(again.meta).toMatchObject({ nextSeq: 3, numbers: { taken: { b1: 9 } } })
    await storage.remove(['evt-00000001'])
    expect((await storage.load()).items.map((entry) => entry.seq)).toEqual([2])
  })
})

// ---- the queue at run time, against a made-up API --------------------------------------------------------------------------------

type Call = { method: HttpMethod; path: string; body: unknown; key: string | undefined }
function fakeApi(answer: (call: Call) => unknown) {
  const calls: Call[] = []
  const request = async <T,>(method: HttpMethod, path: string, options: RequestOptions<T> = {}): Promise<T> => {
    const call = { method, path, body: options.body, key: options.idempotencyKey }
    if (path !== '/auth/csrf') calls.push(call)
    const value = answer(call)
    if (value instanceof Error) throw value
    return (options.schema ? options.schema.parse(value) : value) as T
  }
  const api: ApiClient = { request, get: (path, options) => request('GET', path, options), post: (path, options) => request('POST', path, options) }
  return { api, calls }
}

const mine = { serverTime: '2026-10-29T08:00:00.000Z', lastRecordedAt: null, subject: 'WORKER', refused: [], othersRefused: 0 }

function syncAnswer(call: Call, status: (seq: number) => 'accepted' | 'refused' | 'waiting' = () => 'accepted') {
  const body = call.body as { events: { clientEventId: string; seq: number; kind: string }[]; blocks?: unknown[] }
  return {
    serverTime: '2026-10-29T08:05:00.000Z',
    clock: { deviceSentAt: '2026-10-29T08:05:00.000Z', skewSeconds: 3, off: false, flagged: false },
    events: body.events.map((event) => {
      const s = status(event.seq)
      return { clientEventId: event.clientEventId, seq: event.seq, kind: event.kind, status: s, serverTime: s === 'accepted' ? '2026-10-29T08:05:00.000Z' : null, result: s === 'accepted' ? { type: 'OperationScan', id: `scan-${event.seq}` } : null, refusal: s === 'refused' ? { id: `refused-${event.seq}`, code: 'REPLACED', message: 'words', fix: 'fix', final: true } : null }
    }),
    blocks: body.blocks ? { scanTag: TAG, blocks: [{ id: 'b1', kind: 'BUNDLE', fromRef: 1, toRef: 200, highestUsedRef: null, status: 'ACTIVE' }] } : null,
  }
}

let ids = 0
const queueWith = (answer: (call: Call) => unknown) => {
  const fake = fakeApi(answer)
  const queue = new FloorQueue(memoryStorage(), fake.api, { now: () => new Date('2026-10-29T08:00:00.000Z'), newId: () => `evt-${String(++ids).padStart(8, '0')}` })
  return { queue, calls: fake.calls }
}

describe('the queue at run time', () => {
  it('offline: saves each action on the tablet and sends nothing; back online: one send, in order, then the refused list', async () => {
    const { queue, calls } = queueWith((call) => (call.path === '/floor/sync' && call.method === 'POST' ? syncAnswer(call) : mine))
    await queue.start()
    queue.setOnline(false)
    queue.setContext({ deviceId: DEVICE, workerId: ADA, numberKinds: [] })
    await queue.enqueue('production.scan.report', { code: 'BN-7K-000123-M', good: 18 })
    await queue.enqueue('production.scan.undo', { undoesClientScanId: 'x' })
    expect(calls).toEqual([])
    expect(queue.getSnapshot().items.map((entry) => [entry.seq, entry.state])).toEqual([
      [1, 'waiting'],
      [2, 'waiting'],
    ])
    queue.setOnline(true)
    await queue.sync()
    const sends = calls.filter((call) => call.path === '/floor/sync' && call.method === 'POST')
    expect(sends).toHaveLength(1)
    expect((sends[0]!.body as { events: { seq: number; workerId: string }[] }).events.map((event) => [event.seq, event.workerId])).toEqual([
      [1, ADA],
      [2, ADA],
    ])
    expect(sends[0]!.key).toMatch(/.{8,}/)
    expect(queue.getSnapshot().items.every((entry) => entry.state === 'recorded')).toBe(true)
    expect(queue.getSnapshot().lastSentAt).toBe('2026-10-29T08:05:00.000Z')
    expect(calls.some((call) => call.method === 'GET' && call.path === '/floor/sync')).toBe(true)
  })

  it('a resend carries the same client event id: a refusal that may pass later is sent again, a final one is not', async () => {
    let round = 0
    const kept = (id: string) => ({ id, clientEventId: 'x', kind: 'production.scan.report', deviceSeq: 1, code: 'PREVIOUS_NOT_REPORTED', message: 'm', fix: 'f', final: false, summary: {}, deviceTime: null, serverTime: '2026-10-29T08:05:00.000Z', status: 'OPEN' })
    const { queue, calls } = queueWith((call) => {
      // The server still keeps both refusals open (a refresh must not drop them).
      if (call.path !== '/floor/sync' || call.method !== 'POST') return { ...mine, refused: [kept('r-1'), kept('r-2')] }
      round++
      const body = call.body as { events: { clientEventId: string; seq: number; kind: string }[] }
      return {
        ...syncAnswer(call),
        events: body.events.map((event) => ({ clientEventId: event.clientEventId, seq: event.seq, kind: event.kind, status: 'refused', serverTime: null, result: null, refusal: { id: `r-${event.seq}`, code: 'PREVIOUS_NOT_REPORTED', message: 'm', fix: 'f', final: event.seq === 1 } })),
      }
    })
    await queue.start()
    queue.setContext({ deviceId: DEVICE, workerId: ADA, numberKinds: [] })
    await queue.enqueue('production.scan.report', { code: 'BN-7K-000123-M', good: 1 })
    await queue.enqueue('production.scan.report', { code: 'BN-7K-000124-P', good: 1 })
    await queue.sync()
    const before = round
    await queue.sync()
    const sends = calls.filter((call) => call.path === '/floor/sync' && call.method === 'POST')
    const last = sends[sends.length - 1]!.body as { events: { clientEventId: string; seq: number }[] }
    expect(round).toBeGreaterThan(before)
    expect(last.events.map((event) => event.seq)).toEqual([2])
    expect(last.events[0]!.clientEventId).toBe(queue.getSnapshot().items[1]!.clientEventId)
  })

  it("numbers a bundle's ticket from the tablet's own block, and tops the blocks up with the send", async () => {
    const { queue, calls } = queueWith((call) => (call.path === '/floor/sync' && call.method === 'POST' ? syncAnswer(call) : mine))
    await queue.start()
    queue.setContext({ deviceId: DEVICE, workerId: ADA, numberKinds: ['BUNDLE'] })
    await queue.sync()
    const first = calls.find((call) => call.path === '/floor/sync' && call.method === 'POST')!
    expect((first.body as { blocks: unknown[] }).blocks).toEqual([{ kind: 'BUNDLE', remaining: 0 }])
    queue.setOnline(false)
    const made = await queue.enqueue('production.bundles.make', { workOrderId: 'wo', cells: [{ workOrderSizeId: 'c', quantities: [10] }] })
    expect(made.payload.ticketCode).toBe(formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 1 }))
    expect(made.numbered).toMatchObject({ kind: 'BUNDLE', ref: 1, blockId: 'b1' })
    const next = await queue.enqueue('production.bundles.make', { workOrderId: 'wo', cells: [{ workOrderSizeId: 'c', quantities: [10] }] })
    expect(next.payload.ticketCode).toBe(formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 2 }))
    expect(remainingOf(queue.getSnapshot().numbers, 'BUNDLE')).toBe(198)
  })

  it('sends nothing while nothing waits and the label numbers are enough (each top-up is an audited command)', async () => {
    const { queue, calls } = queueWith((call) => (call.path === '/floor/sync' && call.method === 'POST' ? syncAnswer(call) : mine))
    await queue.start()
    queue.setContext({ deviceId: DEVICE, workerId: ADA, numberKinds: ['BUNDLE'] })
    await queue.sync()
    const posts = () => calls.filter((call) => call.path === '/floor/sync' && call.method === 'POST').length
    expect(posts()).toBe(1)
    await queue.sync()
    await queue.sync()
    expect(posts()).toBe(1)
    // Running low again (the tablet took numbers): the next send asks for more.
    queue.setOnline(false)
    for (let index = 0; index < 160; index++) await queue.enqueue('production.bundles.make', { workOrderId: 'wo', cells: [{ workOrderSizeId: 'c', quantities: [1] }] })
    queue.setOnline(true)
    await queue.sync()
    const asked = calls.filter((call) => call.path === '/floor/sync' && call.method === 'POST' && (call.body as { blocks?: unknown[] }).blocks)
    // (The made-up server never reserves a new block, so the tablet stays low and asks with each round of the send.)
    expect(asked.length).toBeGreaterThan(1)
    expect((asked[1]!.body as { blocks: { remaining: number }[] }).blocks[0]!.remaining).toBe(40)
  })

  it('discards a refused action with the network; one the office discarded leaves the tablet too', async () => {
    let serverRefused: { id: string }[] = []
    const { queue, calls } = queueWith((call) => {
      if (call.path === '/floor/sync' && call.method === 'POST') return syncAnswer(call, () => 'refused')
      if (call.path.startsWith('/floor/sync/refused/')) return { refused: { id: call.path.split('/')[4], clientEventId: 'x', kind: 'production.scan.report', deviceSeq: 1, code: 'REPLACED', message: 'm', fix: 'f', final: true, summary: {}, deviceTime: null, serverTime: '2026-10-29T08:05:00.000Z', status: 'DISCARDED' } }
      return { ...mine, refused: serverRefused.map((row) => ({ id: row.id, clientEventId: 'x', kind: 'production.scan.report', deviceSeq: 1, code: 'REPLACED', message: 'm', fix: 'f', final: true, summary: {}, deviceTime: null, serverTime: '2026-10-29T08:05:00.000Z', status: 'OPEN' })) }
    })
    await queue.start()
    queue.setContext({ deviceId: DEVICE, workerId: ADA, numberKinds: [] })
    const one = await queue.enqueue('production.scan.report', { code: 'BN-7K-000123-M', good: 1 })
    const two = await queue.enqueue('production.scan.report', { code: 'BN-7K-000124-P', good: 1 })
    serverRefused = [{ id: 'refused-1' }, { id: 'refused-2' }]
    await queue.sync()
    expect(queue.getSnapshot().items.map((entry) => entry.state)).toEqual(['refused', 'refused'])
    queue.setOnline(false)
    expect(await queue.discard(one.clientEventId)).toBe(false)
    queue.setOnline(true)
    serverRefused = [{ id: 'refused-2' }]
    expect(await queue.discard(one.clientEventId)).toBe(true)
    expect(calls.some((call) => call.path === '/floor/sync/refused/refused-1/discard' && call.key)).toBe(true)
    // The office discarded the second one: the next refresh takes it off this tablet.
    serverRefused = []
    await queue.refresh()
    expect(queue.getSnapshot().items.find((entry) => entry.clientEventId === two.clientEventId)!.state).toBe('discarded')
  })

  it('a session that ended stops the send (signed out), the actions stay', async () => {
    const { queue } = queueWith((call) => (call.path === '/floor/sync' && call.method === 'POST' ? new ApiError('signed_out', 401, 'unauthenticated', 'Sign in first.') : mine))
    await queue.start()
    queue.setContext({ deviceId: DEVICE, workerId: ADA, numberKinds: [] })
    await queue.enqueue('production.scan.report', { code: 'BN-7K-000123-M', good: 1 })
    await queue.sync()
    expect(queue.getSnapshot()).toMatchObject({ problem: 'signedOut', sending: false })
    expect(queue.getSnapshot().items[0]!.state).toBe('waiting')
  })

  it('refuses to save an action without a person signed in on an enrolled tablet', async () => {
    const { queue } = queueWith(() => mine)
    await queue.start()
    await expect(queue.enqueue('production.scan.report', {})).rejects.toThrow(/person signed in/)
  })
})

describe('the shell banner', () => {
  it("shows the person's waiting and refused counts and the label kinds running low", async () => {
    const { queue } = queueWith(() => mine)
    await queue.start()
    const snapshot = { ...queue.getSnapshot(), items: [item(1), item(2, { state: 'refused', refusal: refusal(true) }), item(3, { workerId: BEA })], numbers: { scanTag: TAG, blocks: [{ id: 'b1', kind: 'BUNDLE' as const, fromRef: 1, toRef: 12, highestUsedRef: null, status: 'ACTIVE' as const }], taken: {} } }
    const shell = shellQueueOf(snapshot, { workerId: ADA, numberKinds: ['BUNDLE'] }, { now: new Date('2026-10-29T10:00:00.000Z'), timeZone: 'Europe/Rome' })
    expect(shell).toMatchObject({ pending: 1, refused: 1, lowNumbers: [{ kind: 'BUNDLE', left: 12 }] })
  })
})
