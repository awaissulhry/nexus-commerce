import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUEUED_ACTIONS } from '@nexus/factory-domain/floor-sync/kinds'
import { summaryOf } from '@nexus/factory-domain/floor-sync/rules'
import { FAILURE_CODES, HAND_BACK_ACTIONS } from '@nexus/factory-domain/plant/jobs/close'
import { DEPTH_REFUSALS } from '@nexus/factory-domain/plant/requests/refusals'
import type { ApiClient, HttpMethod, RequestOptions } from '../../../lib/api/client'
import { networkError } from '../../../lib/api/errors'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { FloorQueue } from '../../queue/queue'
import { memoryStorage } from '../../queue/storage'
import { openMedia, stepKey, stepOrKeep, uploadMedia, type FloorRequest, type QueueEntry, type RequestProgress } from './api'
import {
  actionTiles,
  closeBody,
  closeDraftOf,
  closeHeld,
  failureTiles,
  INCIDENT_PAGE,
  leadHeld,
  leadOffered,
  MEDIA_MAX,
  mediaHeld,
  mediaKey,
  mediaName,
  nextUpload,
  offersIncident,
  progressRows,
  progressTone,
  queueOrder,
  stationOrder,
  techHeld,
  voiceTypeOf,
  worksHeld,
} from './depth'
import { KNOWN_REFUSALS } from './model'

/** The W2b parts of the machine problem (B-W2b-102): made-up requests, a made-up office and store. */

const AT = '2026-11-03T08:00:00.000Z'
const progress = (extra: Partial<RequestProgress> = {}): RequestProgress => ({ step: 'REPORTED', acknowledgedAt: null, onTheWayAt: null, fixedAt: null, worksAt: null, closedWithoutJob: false, canConfirm: false, ...extra })
const request = (extra: Partial<FloorRequest> = {}): FloorRequest => ({
  id: 'r1',
  machine: { id: 'm1', assetNumber: 'DEMO-SEW-21', status: 'RUNNING', class: { id: 'c1', code: 'LOCKSTITCH', labelIt: 'Lineare', labelEn: 'Lockstitch', labelI18n: {}, icon: 'needle' } },
  symptom: null,
  description: 'Rumore forte',
  unsafe: false,
  reportedAt: '2026-11-03T07:00:00.000Z',
  ageMinutes: 60,
  reportedBy: { kind: 'STATION' },
  station: null,
  status: 'NEW',
  job: null,
  signedSafe: null,
  locking: false,
  photos: 0,
  voiceNotes: 0,
  progress: progress(),
  routing: { routedTo: null, escalationLevel: 0 },
  version: 1,
  ...extra,
})

describe('photos and voice notes (QHS-189)', () => {
  it('records voice in a type the API takes, names each file by the machine, and holds it offline or when full', () => {
    expect(voiceTypeOf((type) => type === 'audio/mp4')).toBe('audio/mp4')
    expect(voiceTypeOf((type) => type.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus')
    expect(voiceTypeOf(() => false)).toBeNull()
    expect(mediaName('PHOTO', 'DEMO-SEW-21', 1, 'image/jpeg')).toBe('DEMO-SEW-21-photo-1.jpg')
    expect(mediaName('AUDIO', 'MJ-1', 2, 'audio/webm;codecs=opus')).toBe('MJ-1-voice-2.webm')
    expect(mediaName('AUDIO', 'MJ-1', 3, 'audio/mp4')).toBe('MJ-1-voice-3.m4a')
    expect(mediaHeld({ online: false, count: 0 })).toBe('held.mediaOffline')
    expect(mediaHeld({ online: true, count: MEDIA_MAX })).toBe('held.mediaFull')
    expect(mediaHeld({ online: true, count: 1, busy: true })).toBe('held.busy')
    expect(mediaHeld({ online: true, count: 1 })).toBeNull()
  })

  it('sends one at a time, in the order taken, and says a stored one in words', () => {
    expect(nextUpload([{ id: 'a', kind: 'PHOTO', name: 'a', state: 'added' }, { id: 'b', kind: 'AUDIO', name: 'b', state: 'waiting' }])?.id).toBe('b')
    expect(nextUpload([{ id: 'a', kind: 'PHOTO', name: 'a', state: 'sending' }, { id: 'b', kind: 'AUDIO', name: 'b', state: 'waiting' }])).toBeNull()
    expect(nextUpload([{ id: 'a', kind: 'PHOTO', name: 'a', state: 'failed' }])).toBeNull()
    expect(mediaKey({ kind: 'AUDIO', category: null })).toBe('media.voice')
    expect(mediaKey({ kind: 'PHOTO', category: 'BEFORE_WORK' })).toBe('media.photoBefore')
    expect(mediaKey({ kind: 'PHOTO', category: 'AFTER_WORK' })).toBe('media.photoAfter')
    expect(mediaKey({ kind: 'PHOTO', category: null })).toBe('media.photo')
  })

  it('Guard missing offers Report an incident; the page waits for B-W2b-137 (the hook)', () => {
    expect(offersIncident({ code: 'GUARD_MISSING' })).toBe(true)
    expect(offersIncident({ code: 'NOISE' })).toBe(false)
    expect(offersIncident(null)).toBe(false)
    expect(INCIDENT_PAGE).toBeNull()
  })
})

describe('progress (QHS-180)', () => {
  it('shows reported → seen → on the way → fixed → works, leaves out what never happened, ends a closed one there', () => {
    expect(progressRows(request()).map((row) => [row.key, row.at])).toEqual([
      ['REPORTED', '2026-11-03T07:00:00.000Z'],
      ['ACKNOWLEDGED', null],
      ['ON_THE_WAY', null],
      ['FIXED', null],
      ['WORKS', null],
    ])
    // The office made the job at once and nobody said "on the way": those steps are left out, not "not yet".
    expect(progressRows(request({ progress: progress({ step: 'FIXED', fixedAt: AT }) })).map((row) => row.key)).toEqual(['REPORTED', 'FIXED', 'WORKS'])
    expect(progressRows(request({ progress: progress({ step: 'FIXED', acknowledgedAt: AT, fixedAt: AT, closedWithoutJob: true }) })).map((row) => [row.key, row.at])).toEqual([
      ['REPORTED', '2026-11-03T07:00:00.000Z'],
      ['ACKNOWLEDGED', AT],
      ['CLOSED', AT],
    ])
  })

  it('holds “It works” with the reason until it may be said; never while the machine is locked (H1); offline is no reason', () => {
    expect(worksHeld(request({ progress: progress({ step: 'FIXED', fixedAt: AT, canConfirm: true }) }), true)).toBeNull()
    expect(worksHeld(request(), true)).toBe('held.worksNotFixed')
    expect(worksHeld(request({ locking: true }), true)).toBe('held.worksLocked')
    expect(worksHeld(request({ progress: progress({ step: 'WORKS', worksAt: AT }) }), true)).toBe('held.worksDone')
    expect(worksHeld(request({ progress: progress({ closedWithoutJob: true }) }), true)).toBe('held.worksClosed')
    expect(worksHeld(request({ progress: progress({ canConfirm: true, fixedAt: AT }) }), false)).toBe('held.noReport')
  })

  it('puts the reports waiting for “It works” first, tones a fixed one in success and a locked one in warning', () => {
    const fixed = request({ id: 'fixed', progress: progress({ step: 'FIXED', fixedAt: AT, canConfirm: true }) })
    expect(stationOrder([request({ id: 'new' }), fixed]).map((entry) => entry.id)).toEqual(['fixed', 'new'])
    expect(progressTone(fixed)).toBe('success')
    expect(progressTone(request({ locking: true }))).toBe('warning')
    expect(progressTone(request({ progress: progress({ step: 'ON_THE_WAY' }) }))).toBe('info')
  })

  it('offers the line lead only on a handed-back job, online; the technician’s steps by the API’s word', () => {
    expect(leadOffered(request({ job: { id: 'j1', number: 'MJ-1', status: 'HANDED_BACK' } }), true)).toBe(true)
    expect(leadOffered(request({ job: { id: 'j1', number: 'MJ-1', status: 'IN_PROGRESS' } }), true)).toBe(false)
    expect(leadOffered(request({ job: { id: 'j1', number: 'MJ-1', status: 'HANDED_BACK' } }), false)).toBe(false)
    expect(leadHeld(false)).toBe('held.offline')
    expect(leadHeld(true)).toBeNull()
    expect(techHeld(true, true)).toBeNull()
    expect(techHeld(false, true)).toBe('held.stepDone')
    expect(techHeld(true, false)).toBe('held.noWork')
    const entries: QueueEntry[] = [
      { request: request({ id: 'done' }), toMe: true, canAcknowledge: false, canGo: false },
      { request: request({ id: 'go' }), toMe: false, canAcknowledge: false, canGo: true },
    ]
    expect(queueOrder(entries).map((entry) => entry.request.id)).toEqual(['go', 'done'])
  })
})

describe('close on one screen (QHS-190)', () => {
  it('draws factory-domain’s action and failure tiles in the screen’s language', () => {
    expect(actionTiles('it').map((tile) => tile.code)).toEqual(HAND_BACK_ACTIONS.map((entry) => entry.code))
    expect(actionTiles('it')[0]!.label).toBe(HAND_BACK_ACTIONS[0].labelIt)
    expect(failureTiles('en').map((tile) => tile.label)).toEqual(FAILURE_CODES.map((entry) => entry.labelEn))
  })

  it('preselects running unless the machine is locked; holds until action and failure; Other needs words', () => {
    const open = closeDraftOf({ close: { minutesSoFar: 12, runningHeld: false, canHandBack: true } })
    expect(open.after).toBe('RUNNING')
    expect(closeDraftOf({ close: { minutesSoFar: 12, runningHeld: true, canHandBack: true } }).after).toBeNull()
    const free = { locked: false }
    expect(closeHeld(open, free, true)).toBe('held.whatDone')
    expect(closeHeld({ ...open, action: 'OTHER' }, free, true)).toBe('held.words')
    expect(closeHeld({ ...open, action: 'ADJUSTED' }, free, true)).toBe('held.failure')
    expect(closeHeld({ ...open, action: 'ADJUSTED', failure: 'SETTINGS', after: null }, free, true)).toBe('held.after')
    expect(closeHeld({ ...open, action: 'ADJUSTED', failure: 'SETTINGS' }, { locked: true }, true)).toBe('held.signFirst')
    expect(closeHeld({ ...open, action: 'ADJUSTED', failure: 'SETTINGS' }, free, false)).toBe('held.offline')
    expect(closeHeld({ ...open, action: 'ADJUSTED', failure: 'SETTINGS' }, free, true)).toBeNull()
  })

  it('sends the tiles and the machine after; words only when written; never minutes (the office counts them)', () => {
    expect(closeBody({ action: 'ADJUSTED', failure: 'SETTINGS', words: '  ', after: 'RUNNING' })).toEqual({ action: 'ADJUSTED', failureCode: 'SETTINGS', machineAfter: 'RUNNING' })
    expect(closeBody({ action: 'OTHER', failure: 'OTHER', words: ' Pedal rewired ', after: 'DO_NOT_USE' })).toEqual({ action: 'OTHER', failureCode: 'OTHER', machineAfter: 'DO_NOT_USE', workDone: 'Pedal rewired' })
  })
})

describe('refusals and words', () => {
  it('says in its own words every refusal a floor route of B-W2b-96 answers, in Italian and English', () => {
    const floorCodes = DEPTH_REFUSALS.filter((code) => !['H1_HELD', 'LOCKED_ALREADY', 'MERGE_NOTHING', 'ORDER_INCOMPLETE'].includes(code))
    for (const code of floorCodes) expect(KNOWN_REFUSALS as readonly string[], code).toContain(code)
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['floor-machine'] ?? {}
      for (const code of KNOWN_REFUSALS) {
        expect(words[`refusal.${code}.message`], `${locale} ${code}`).toBeTruthy()
        expect(words[`refusal.${code}.fix`], `${locale} ${code}`).toBeTruthy()
      }
    }
  })
})

// ---- the network: one id for the try and the queued retry; the files' calls -------------------------------------------------

const DEVICE = '0192f1a2-7b3c-7d4e-8f50-0000000000d1'
const WORKER = '0192f1a2-7b3c-7d4e-8f50-0000000000a1'
const REQUEST = '0192f1a2-7b3c-7d4e-8f50-0000000000b1'

function office(rule: 'answerLost' | 'answers') {
  const posts: { path: string; body: unknown; key: string | undefined }[] = []
  const sends: { clientEventId: string; kind: string; payload: unknown }[] = []
  const request = async <T,>(method: HttpMethod, path: string, options: RequestOptions<T> = {}): Promise<T> => {
    if (method === 'GET') {
      if (path === '/floor/sync') return { serverTime: AT, lastRecordedAt: null, subject: 'WORKER', refused: [], othersRefused: 0 } as T
      if (path.startsWith('/plant/floor/files/')) return { download: { method: 'GET', url: '/store/f1', headers: {}, expiresAt: AT } } as T
      return {} as T
    }
    if (path === '/floor/sync') {
      const events = (options.body as { events: { clientEventId: string; seq: number; kind: string; payload: unknown }[] }).events
      sends.push(...events)
      const answer = { serverTime: AT, clock: null, blocks: null, events: events.map((event) => ({ clientEventId: event.clientEventId, seq: event.seq, kind: event.kind, status: 'duplicate', serverTime: AT, result: { type: 'MaintenanceRequest', id: REQUEST }, refusal: null })) }
      return (options.schema ? options.schema.parse(answer) : answer) as T
    }
    posts.push({ path, body: options.body, key: options.idempotencyKey })
    if (rule === 'answerLost') throw networkError(new TypeError('Failed to fetch'))
    const answer = path.endsWith('/files') ? { file: { id: 'f1' }, upload: { method: 'PUT', url: '/store/f1', headers: {}, expiresAt: AT } } : { file: { id: 'f1' } }
    return answer as T
  }
  const api: ApiClient = { request, get: (path, options) => request('GET', path, options), post: (path, options) => request('POST', path, options), bytes: async () => new Uint8Array() }
  return { api, posts, sends }
}

afterEach(() => vi.unstubAllGlobals())

describe('the floor’s calls (B-W2b-96’s routes)', () => {
  it('a progress step whose answer died goes to the queue under the try’s id: the office’s key is the same (<device>.<id>)', async () => {
    const fake = office('answerLost')
    const queue = new FloorQueue(memoryStorage(), fake.api, { now: () => new Date(AT) })
    await queue.start()
    queue.setContext({ deviceId: DEVICE, workerId: WORKER, numberKinds: [] })
    const outcome = await stepOrKeep(fake.api, queue, true, DEVICE, REQUEST, 'WORKS_AGAIN')
    expect(fake.posts[0]!.path).toBe(`/plant/floor/requests/${REQUEST}/works`)
    expect(fake.posts[0]!.body).toEqual({})
    expect(outcome.kept?.kind).toBe('plant.request.progress')
    expect(fake.posts[0]!.key).toBe(stepKey(DEVICE, outcome.kept!.clientEventId))
    expect(outcome.kept?.payload).toEqual({ requestId: REQUEST, step: 'WORKS_AGAIN' })
    await queue.sync()
    expect(fake.sends.map((event) => event.clientEventId)).toEqual([outcome.kept!.clientEventId])
    // The queued kind is the reporter's own permission, and the office's lists name the step and the request, never who.
    expect(QUEUED_ACTIONS['plant.request.progress'].permission).toBe('plant.report')
    expect(summaryOf('plant.request.progress', { requestId: REQUEST, step: 'WORKS_AGAIN' })).toEqual({ code: 'WORKS_AGAIN', target: REQUEST })
  })

  it('offline no try is made: the step waits on the tablet', async () => {
    const fake = office('answerLost')
    const queue = new FloorQueue(memoryStorage(), fake.api, { now: () => new Date(AT) })
    await queue.start()
    queue.setContext({ deviceId: DEVICE, workerId: WORKER, numberKinds: [] })
    queue.setOnline(false)
    const outcome = await stepOrKeep(fake.api, queue, false, DEVICE, REQUEST, 'ON_THE_WAY')
    expect(fake.posts).toEqual([])
    expect(outcome.kept?.state).toBe('waiting')
    expect(stepKey(null, 'abc12345')).toBe('abc12345')
  })

  it('a photo of a job goes up announced with its kind, category and checksum, PUT to the store, then confirmed', async () => {
    const fake = office('answers')
    const put = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', put)
    const answer = await uploadMedia(fake.api, { type: 'job', id: 'j1', category: 'AFTER_WORK' }, 'PHOTO', new Blob(['made-up'], { type: 'image/jpeg' }), 'MJ-1-photo-1.jpg')
    expect(answer).toEqual({ ok: true, value: { fileId: 'f1' } })
    expect(fake.posts[0]!.path).toBe('/plant/jobs/j1/files')
    expect(fake.posts[0]!.body).toMatchObject({ kind: 'PHOTO', category: 'AFTER_WORK', contentType: 'image/jpeg', originalName: 'MJ-1-photo-1.jpg', sizeBytes: 7 })
    expect((fake.posts[0]!.body as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(put).toHaveBeenCalledTimes(1)
    expect(fake.posts[1]!.path).toBe('/plant/jobs/j1/files/f1/complete')
  })

  it('a voice note of a request takes no category and the type without its codec', async () => {
    const fake = office('answers')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    await uploadMedia(fake.api, { type: 'request', id: REQUEST }, 'AUDIO', new Blob(['made-up'], { type: 'audio/webm;codecs=opus' }), 'DEMO-voice-1.webm')
    expect(fake.posts[0]!.path).toBe(`/plant/requests/${REQUEST}/files`)
    expect(fake.posts[0]!.body).toMatchObject({ kind: 'AUDIO', contentType: 'audio/webm' })
    expect(fake.posts[0]!.body).not.toHaveProperty('category')
  })

  it('opens a stored one through the floor’s download route as a blob of its type', async () => {
    const fake = office('answers')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })))
    const answer = await openMedia(fake.api, { id: 'f1', contentType: 'audio/webm' })
    expect(answer.ok).toBe(true)
    if (answer.ok) {
      expect(answer.value.type).toBe('audio/webm')
      expect(answer.value.size).toBe(3)
    }
  })
})
