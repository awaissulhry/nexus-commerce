import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ApiClient, HttpMethod, RequestOptions } from '../../lib/api/client'
import { ApiError, networkError } from '../../lib/api/errors'
import { tapOrKeep } from '../tasks/clock/api'
import { offStandardEndOrKeep, offStandardStartOrKeep, timingOrKeep, type TimingRoute } from '../tasks/scans/api'
import { onlineFirst } from './online-first'
import { FloorQueue } from './queue'
import { memoryStorage } from './storage'

/**
 * B-W2b-77: an answer lost on its way back. A made-up office that behaves as the real one on this point (the API's own
 * dedupe is held by the PG tests): it keeps a record per client id, answers a retry under a known id `duplicate`, and judges a
 * new id as a NEW action, which is what a double clock-in and ALREADY_RUNNING came from.
 */

const DEVICE = '0192f1a2-7b3c-7d4e-8f50-0000000000d1'
const ADA = '0192f1a2-7b3c-7d4e-8f50-0000000000a1'
const BODY = { code: 'BN-7K-000123-M', workOrderOperationId: '0192f1a2-7b3c-7d4e-8f50-0000000000e1' }
const mine = { serverTime: '2026-11-02T08:00:00.000Z', lastRecordedAt: null, subject: 'WORKER', refused: [], othersRefused: 0 }

type Sent = { readonly clientEventId: string; readonly seq: number; readonly kind: string }

function office(rule: 'answerLost' | 'neverArrived' | { readonly answers: unknown }) {
  const records: string[] = []
  const posts: { path: string; id: string; key: string | undefined }[] = []
  const sends: Sent[] = []
  const request = async <T,>(method: HttpMethod, path: string, options: RequestOptions<T> = {}): Promise<T> => {
    if (method === 'GET') return (path === '/floor/sync' ? mine : {}) as T
    if (path === '/floor/sync') {
      const events = (options.body as { events: Sent[] }).events
      sends.push(...events)
      const answer = {
        serverTime: mine.serverTime,
        clock: null,
        blocks: null,
        events: events.map((event) => {
          const known = records.includes(event.clientEventId)
          if (!known) records.push(event.clientEventId)
          return { clientEventId: event.clientEventId, seq: event.seq, kind: event.kind, status: known ? 'duplicate' : 'accepted', serverTime: mine.serverTime, result: { type: 'Record', id: event.clientEventId }, refusal: null }
        }),
      }
      return (options.schema ? options.schema.parse(answer) : answer) as T
    }
    const body = options.body as { clientEventId?: string; clientScanId?: string }
    const id = body.clientEventId ?? body.clientScanId ?? ''
    posts.push({ path, id, key: options.idempotencyKey })
    if (rule === 'answerLost') {
      records.push(id)
      throw networkError(new TypeError('Failed to fetch'))
    }
    if (rule === 'neverArrived') throw networkError(new TypeError('Failed to fetch'))
    if (rule.answers instanceof Error) throw rule.answers
    return (options.schema ? options.schema.parse(rule.answers) : rule.answers) as T
  }
  const api: ApiClient = {
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, options) => request('POST', path, options),
    bytes: async () => {
      throw new Error('no files here')
    },
  }
  return { api, records, posts, sends }
}

async function tabletOn(api: ApiClient): Promise<FloorQueue> {
  const queue = new FloorQueue(memoryStorage(), api, { now: () => new Date(mine.serverTime) })
  await queue.start()
  queue.setContext({ deviceId: DEVICE, workerId: ADA, numberKinds: [] })
  return queue
}

describe('an answer lost: the try and the queued retry are one action (B-W2b-77)', () => {
  it('a clock tap reached the office and its answer died: one clock-in, recorded by the queue as the same event', async () => {
    const fake = office('answerLost')
    const queue = await tabletOn(fake.api)
    const sent = await tapOrKeep(fake.api, queue, true, 'IN')
    await queue.sync()
    expect(sent.kept?.clientEventId).toBe(fake.posts[0]!.id)
    expect(fake.sends.map((event) => [event.clientEventId, event.kind])).toEqual([[fake.posts[0]!.id, 'people.clock.record']])
    expect(fake.records).toEqual([fake.posts[0]!.id])
    expect(queue.getSnapshot().items.map((item) => [item.state, item.refusal])).toEqual([['recorded', null]])
  })

  it.each<[TimingRoute, string]>([
    ['start', 'production.scan.start'],
    ['pause', 'production.scan.pause'],
    ['resume', 'production.scan.resume'],
    ['handBack', 'production.scan.handBack'],
    ['partial', 'production.scan.partial'],
  ])('a timing %s whose answer died goes to the queue under its client scan id, never as a new action', async (route, kind) => {
    const fake = office('answerLost')
    const queue = await tabletOn(fake.api)
    const sent = await timingOrKeep(fake.api, queue, true, route, BODY)
    await queue.sync()
    expect(fake.posts[0]!.key).toBe(fake.posts[0]!.id)
    expect(sent.kept?.clientEventId).toBe(fake.posts[0]!.id)
    expect(sent.kept?.kind).toBe(kind)
    expect(sent.kept?.payload).toEqual(BODY)
    expect(fake.records).toHaveLength(1)
    expect(queue.getSnapshot().items.map((item) => item.state)).toEqual(['recorded'])
  })

  it('a tile and its Done: the same, under the client event id', async () => {
    const tile = office('answerLost')
    const queue = await tabletOn(tile.api)
    expect((await offStandardStartOrKeep(tile.api, queue, true, 'code-1')).kept?.clientEventId).toBe(tile.posts[0]!.id)
    const done = office('answerLost')
    const second = await tabletOn(done.api)
    expect((await offStandardEndOrKeep(done.api, second, true)).kept?.clientEventId).toBe(done.posts[0]!.id)
  })

  it('a try that never arrived is recorded by the retry: nothing is lost either way', async () => {
    const fake = office('neverArrived')
    const queue = await tabletOn(fake.api)
    await tapOrKeep(fake.api, queue, true, 'OUT')
    await queue.sync()
    expect(fake.records).toEqual([fake.posts[0]!.id])
    expect(queue.getSnapshot().items.map((item) => item.state)).toEqual(['recorded'])
  })

  it('offline no try is made; the action waits on the tablet', async () => {
    const fake = office('answerLost')
    const queue = await tabletOn(fake.api)
    queue.setOnline(false)
    const sent = await timingOrKeep(fake.api, queue, false, 'start', BODY)
    expect(fake.posts).toEqual([])
    expect(sent.kept?.state).toBe('waiting')
  })

  it('a refusal and a broken answer are shown, never queued; an answer stands', async () => {
    const refusal = new ApiError('conflict', 409, 'conflict', 'Already running.', null, [{ path: 'refusal/ALREADY_RUNNING', message: 'Already running.' }])
    const refused = office({ answers: refusal })
    const first = await tabletOn(refused.api)
    const answer = await timingOrKeep(refused.api, first, true, 'start', BODY)
    expect(answer.kept).toBeNull()
    expect(answer.answer).toMatchObject({ ok: false, problem: { kind: 'refused', code: 'ALREADY_RUNNING' } })
    expect(first.getSnapshot().items).toEqual([])

    const broken = office({ answers: new ApiError('unavailable', 500, 'internal_error', 'No.') })
    const second = await tabletOn(broken.api)
    expect((await tapOrKeep(broken.api, second, true, 'IN')).answer).toMatchObject({ ok: false, problem: { kind: 'unavailable' } })
    expect(second.getSnapshot().items).toEqual([])

    const third = await tabletOn(refused.api)
    expect(await onlineFirst(third, { online: true, kind: 'people.clock.record', payload: {}, attempt: async () => ({ ok: true as const, value: 7 }) })).toEqual({ kept: null, answer: { ok: true, value: 7 } })
  })

  it('an id the queue holds is that action: kept once, so a send never names it twice (the office refuses such a send whole)', async () => {
    const fake = office('neverArrived')
    const queue = await tabletOn(fake.api)
    queue.setOnline(false)
    const first = await queue.enqueue('people.clock.record', { action: 'IN' }, 'same-id')
    const again = await queue.enqueue('people.clock.record', { action: 'IN' }, 'same-id')
    expect(again).toBe(first)
    expect(queue.getSnapshot().items).toHaveLength(1)
    queue.setOnline(true)
    await queue.sync()
    expect(fake.sends.map((event) => event.clientEventId)).toEqual(['same-id'])
  })
})

describe('every screen keeps to it', () => {
  const FLOOR = join(dirname(fileURLToPath(import.meta.url)), '..')
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? sources(join(dir, name)) : /\.tsx?$/.test(name) && !name.includes('.vitest.') ? [join(dir, name)] : []))

  it('no screen calls a route that may queue without its online-first call', () => {
    const direct = sources(FLOOR).filter((file) => !file.endsWith('/api.ts') && /\b(?:clockTap|postTiming|startOffStandard|endOffStandard)\(/.test(readFileSync(file, 'utf8')))
    expect(direct).toEqual([])
  })

  it('the three that keep an action themselves name the id of the try', () => {
    const read = (path: string) => readFileSync(join(FLOOR, path), 'utf8')
    expect(read('tasks/clock/Clock.tsx')).toMatch(/kept\.add\(held\.code, action\.action, held\.clientEventId\)/)
    expect(read('tasks/lineview/LineView.tsx')).toMatch(/queue\.enqueue\(SCAN_ON_BEHALF, body, clientScanId\)/)
    expect(read('tasks/scans/Operation.tsx')).toMatch(/queue\.enqueue\('production\.scan\.report', reportPayload\(row\.card, row\.operation\.id, row\.counts, expectedOf\(row\)\), row\.clientScanId\)/)
  })
})
