import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAILURE_CODES, HAND_BACK_ACTIONS } from '@nexus/factory-domain/plant/jobs/close'
import { DEPTH_REFUSALS } from '@nexus/factory-domain/plant/requests/refusals'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { at, CARDS, JOBS, MACHINES, PEOPLE, REQUESTS, uid } from '../../_shared/fixtures'
import { designScreen as jobsScreen } from '../../jobs/fixtures'
import { designScreen as jobScreen } from '../../jobs/record/fixtures'
import { designScreen as requestsScreen } from '../fixtures'
import { confirmJobWorks, confirmWorks, handBackJob, listDeepRequests, lockAsUnsafe, mergeRequests, readDuplicates, readLocks, sayOnTheWay, uploadMedia } from './api'
import { DEEP, DEEP_JOBS, deep, deepRecord, media, PRESS_LOCK, trail } from './fixtures'
import {
  actionTiles,
  afterHeld,
  audioRefusal,
  closeBody,
  closeDraftOf,
  closeHeld,
  DEPTH_REFUSAL_CODES,
  depthProblemOf,
  depthRefusalOf,
  escalatedWords,
  escalationTone,
  failureLabel,
  failureTiles,
  firstPieceAsked,
  goHeld,
  groupOfDuplicates,
  groupOfRecord,
  leadHeld,
  lockHeld,
  mediaName,
  mergeBody,
  mergeDraftOf,
  mergeHeld,
  mergeSources,
  progressRows,
  retarget,
  routedWords,
  sourceHeld,
  targetsOf,
  trailSteps,
  uploadHeld,
  worksHeld,
} from './model'

/**
 * Machine requests and Maintenance jobs in depth (B-W2b-140 on the API of B-W2b-96): the pure rules (the Age tone by
 * escalation, Routed to, the duplicates and what a merge sends — a request that locks its machine never goes into another
 * request, H1 —, Lock as unsafe, the requester's progress, the trail in order, the one-screen close with the domain's
 * tiles, the line lead's confirmation, photos and voice notes), the calls as the API takes them (an Idempotency-Key on
 * every write, the version read), every depth refusal said in both languages, and every design case of SCR-148, SCR-149
 * and SCR-149-record drawn in Italian and English with no key or placeholder left on screen.
 */

const t = createTranslator('en', messagesFor('en', ['plant']).plant!)
const lead = { triage: true, report: true, work: true }

describe('the queue: Age tone by escalation level, Routed to', () => {
  it('locking is danger; an open request escalated twice danger, once warning; else waiting over 30 min', () => {
    expect(escalationTone(DEEP.unsafe)).toBe('danger')
    expect(escalationTone(DEEP.thread)).toBe('danger')
    expect(escalationTone(DEEP.oil)).toBe('warning')
    expect(escalationTone({ ...DEEP.noise, ageMinutes: 5 })).toBe('neutral')
    expect(escalationTone({ ...DEEP.noise, ageMinutes: 45 })).toBe('warning')
    expect(escalationTone({ ...DEEP.closed, routing: { ...DEEP.closed.routing, escalationLevel: 2 } })).toBe('neutral')
  })

  it('a team by name, a technician by name or unnamed, nobody; the escalation level', () => {
    expect(t(routedWords(DEEP.thread.routing).key, routedWords(DEEP.thread.routing).params)).toBe('Squadra Demo A')
    expect(routedWords({ ...DEEP.thread.routing, routedTo: { kind: 'TECHNICIAN', id: null, name: null } })).toEqual({ key: 'routing.aTechnician' })
    expect(routedWords(DEEP.closed.routing)).toEqual({ key: 'routing.none' })
    expect(escalatedWords(DEEP.thread.routing)).toEqual({ key: 'routing.escalated', params: { level: 2 } })
    expect(escalatedWords(DEEP.noise.routing)).toBeNull()
  })
})

describe('possible duplicates and Merge requests (QHS-181)', () => {
  const record = deepRecord({ card: CARDS.sew3, duplicates: [REQUESTS.threadAgain], canTriage: true, canSignSafe: false }, DEEP.thread)
  const group = groupOfRecord(record)!

  it('the detail knows the group: the request and the other open ones, oldest first; the oldest suggested', () => {
    expect(group.requests.map((request) => request.id)).toEqual([DEEP.thread.id, DEEP.threadAgain.id])
    expect(group.suggested).toEqual({ kind: 'REQUEST', id: DEEP.thread.id })
    expect(group.withinMinutes).toBe(38)
    expect(groupOfRecord({ ...record, duplicates: [] })).toBeNull()
  })

  it('the draft keeps the target out of the sources; into a request it merges, into the open job it joins', () => {
    const draft = mergeDraftOf(group)
    expect(draft).toEqual({ target: `REQUEST:${DEEP.thread.id}`, picked: [DEEP.threadAgain.id] })
    expect(mergeBody(group, draft)).toEqual({ requests: [{ id: DEEP.threadAgain.id, version: 1 }], intoId: DEEP.thread.id })
    const withJob = { ...group, openJob: { id: JOBS.thread.id, number: JOBS.thread.number }, suggested: { kind: 'JOB' as const, id: JOBS.thread.id, number: JOBS.thread.number } }
    expect(targetsOf(withJob)[0]).toEqual({ kind: 'JOB', id: JOBS.thread.id, number: JOBS.thread.number })
    expect(mergeBody(withJob, mergeDraftOf(withJob))).toEqual({ requests: [{ id: DEEP.thread.id, version: 1 }, { id: DEEP.threadAgain.id, version: 1 }], intoJobId: JOBS.thread.id })
    expect(mergeHeld(group, draft, lead)).toBeNull()
    expect(mergeHeld(group, draft, { triage: false })).toBe('held.noTriage')
    expect(mergeHeld(group, { ...draft, picked: [] }, lead)).toBe('mergeMany.held.none')
  })

  it('a request that locks the machine joins a job but never another request (H1): held with its reason', () => {
    const other = deep({ ...REQUESTS.oil, id: uid('5151', 22), machine: PRESS_LOCK.machine, reportedAt: at(30, 8, 20) })
    const press = groupOfDuplicates({ machine: PRESS_LOCK.machine, requests: [other, PRESS_LOCK], withinMinutes: 15, suggested: { kind: 'REQUEST', job: null, requestId: PRESS_LOCK.id } })
    expect(press.requests[0]!.id).toBe(PRESS_LOCK.id)
    expect(press.suggested).toEqual({ kind: 'REQUEST', id: PRESS_LOCK.id })
    const intoOther = retarget(press, { target: `REQUEST:${other.id}`, picked: [] })
    expect(sourceHeld(PRESS_LOCK, intoOther)).toBe('mergeMany.lockedSource')
    expect(sourceHeld(other, intoOther)).toBe('mergeMany.isTarget')
    expect(intoOther.picked).toEqual([])
    expect(mergeHeld(press, intoOther, lead)).toBe('mergeMany.held.none')
    expect(mergeHeld(press, { ...intoOther, picked: [PRESS_LOCK.id] }, lead)).toBe('mergeMany.held.lockedSource')
    expect(mergeSources(press, mergeDraftOf(press)).map((request) => request.id)).toEqual([other.id])
  })
})

describe('Lock as unsafe, the progress, the trail', () => {
  const thread = deepRecord({ card: CARDS.sew3, duplicates: [], canTriage: true, canSignSafe: false }, DEEP.thread)
  const locked = deepRecord({ card: CARDS.sew2, duplicates: [], canTriage: false, canSignSafe: true }, DEEP.unsafe)

  it('L is held without plant.report, on a locked or retired machine, and where the site says no', () => {
    expect(lockHeld(thread, { report: true })).toBeNull()
    expect(lockHeld(thread, { report: false })).toBe('held.noReport')
    expect(lockHeld(locked, { report: true })).toBe('lockAsUnsafe.held.locked')
    expect(lockHeld({ ...thread, canLock: false }, { report: true })).toBe('lockAsUnsafe.held.notAllowed')
    expect(lockHeld({ ...thread, card: { ...thread.card, machine: { ...thread.card.machine, status: 'RETIRED' } } }, { report: true })).toBe('held.machineRetired')
  })

  it('the five steps the reporter sees; a step never said before a later one is left out', () => {
    expect(progressRows(DEEP.unsafe).map((row) => [row.key, row.done])).toEqual([
      ['REPORTED', true],
      ['ACKNOWLEDGED', true],
      ['ON_THE_WAY', true],
      ['FIXED', false],
      ['WORKS', false],
    ])
    const fixed = deep(REQUESTS.noise, { progress: { ...DEEP.noise.progress, step: 'FIXED', onTheWayAt: null, fixedAt: at(30, 11) } })
    expect(progressRows(fixed).map((row) => row.key)).toEqual(['REPORTED', 'ACKNOWLEDGED', 'FIXED', 'WORKS'])
  })

  it('On my way and It works again are held with their reasons', () => {
    expect(goHeld(thread, { work: true })).toBeNull()
    expect(goHeld(thread, { work: false })).toBe('held.noWork')
    expect(goHeld(locked, { work: true })).toBe('progress.held.onTheWay')
    expect(worksHeld(thread, { report: true })).toBe('progress.held.notFixed')
    expect(worksHeld(locked, { report: true })).toBe('progress.held.locked')
    const fixed = { ...thread, request: deep(REQUESTS.noise, { progress: { ...DEEP.noise.progress, step: 'FIXED', fixedAt: at(30, 11), canConfirm: true } }), canConfirm: true }
    expect(worksHeld(fixed, { report: true })).toBeNull()
    expect(worksHeld({ ...fixed, request: { ...fixed.request, progress: { ...fixed.request.progress, worksAt: at(30, 12) } } }, { report: true })).toBe('progress.held.confirmed')
  })

  it('the trail in time order with who; the job before its fix; a lock still waiting at the end', () => {
    const steps = trailSteps(t, { ...DEEP.unsafe, job: { id: JOBS.safety.id, number: 'MJ-D-0001', status: 'HANDED_BACK' } }, trail(['REPORTED', at(30, 9, 12)], ['ROUTED', at(30, 9, 12)], ['ESCALATED', at(30, 9, 22), 1], ['FIXED', at(30, 11)]))
    expect(steps.map((step) => step.words.key)).toEqual(['trail.reported', 'trail2.routed', 'trail2.escalated', 'trail.job', 'trail2.fixedJob', 'trail.waitsSignSafe'])
    expect(t(steps[1]!.words.key, steps[1]!.words.params)).toBe('Sent to Squadra Demo A')
    expect(steps[0]!.words.params).toEqual({ who: PEOPLE.sew2.name })
  })
})

describe('the one-screen close and the line lead (QHS-190, QHS-180)', () => {
  const working = { ...DEEP_JOBS.thread, status: 'IN_PROGRESS' as const }
  const close = { minutesSoFar: 42, runningHeld: false, canHandBack: true }

  it('the tiles are the domain’s, in the page’s language; a code outside them is said as it is', () => {
    expect(actionTiles('it').map((tile) => tile.code)).toEqual(HAND_BACK_ACTIONS.map((entry) => entry.code))
    expect(failureTiles('en').map((tile) => tile.label)).toEqual(FAILURE_CODES.map((entry) => entry.labelEn))
    expect(failureLabel('SETTINGS', 'it')).toBe('Regolazioni')
    expect(failureLabel('X_NEW', 'en')).toBe('X_NEW')
  })

  it('Running is chosen unless the lock holds it; Hand back waits for the tiles, words for Other, the right and the state', () => {
    expect(closeDraftOf(close).after).toBe('RUNNING')
    expect(closeDraftOf({ runningHeld: true }).after).toBeNull()
    const draft = { action: 'ADJUSTED' as const, failure: 'SETTINGS', words: '', after: 'RUNNING' as const }
    expect(closeHeld(draft, working, close, { work: true })).toBeNull()
    expect(closeHeld({ ...draft, action: null }, working, close, { work: true })).toBe('close.held.action')
    expect(closeHeld({ ...draft, action: 'OTHER' }, working, close, { work: true })).toBe('close.held.words')
    expect(closeHeld({ ...draft, failure: null }, working, close, { work: true })).toBe('close.held.failure')
    expect(closeHeld(draft, working, close, { work: false })).toBe('held.noWork')
    expect(closeHeld(draft, DEEP_JOBS.thread, close, { work: true })).toBe('held.move.handBack')
    expect(closeHeld(draft, { ...working, machine: { ...working.machine, locked: true } }, close, { work: true })).toBe('held.lockedRunning')
    expect(afterHeld('DO_NOT_USE', { machine: { locked: true } }, close)).toBeNull()
    expect(closeBody(draft, 4)).toEqual({ version: 4, machineAfter: 'RUNNING', action: 'ADJUSTED', failureCode: 'SETTINGS' })
    expect(closeBody({ ...draft, words: ' tension ' }, 4).workDone).toBe('tension')
  })

  it('the line lead confirms once, while handed back, with the triage right; a settings repair names the first-piece check', () => {
    const handed = { job: DEEP_JOBS.handedBack, canConfirm: true }
    expect(leadHeld(handed, { triage: true })).toBeNull()
    expect(leadHeld(handed, { triage: false })).toBe('lead.held.noRight')
    expect(leadHeld({ job: { ...DEEP_JOBS.handedBack, leadConfirmed: { at: at(29, 12), by: PEOPLE.anna } }, canConfirm: false }, { triage: true })).toBe('lead.held.done')
    expect(leadHeld({ job: DEEP_JOBS.thread, canConfirm: false }, { triage: true })).toBe('lead.held.notHandedBack')
    expect(firstPieceAsked(DEEP_JOBS.handedBack)).toBe(true)
    expect(firstPieceAsked(DEEP_JOBS.thread)).toBe(false)
  })

  it('photos and voice notes: held on a closed job and without the work right; the audio the API takes', () => {
    expect(uploadHeld(DEEP_JOBS.thread, { work: true })).toBeNull()
    expect(uploadHeld(DEEP_JOBS.closed, { work: true })).toBe('media.held.closed')
    expect(uploadHeld(DEEP_JOBS.thread, { work: false })).toBe('held.noWork')
    expect(audioRefusal({ type: 'audio/webm;codecs=opus', size: 1000 })).toBeNull()
    expect(audioRefusal({ type: 'audio/x-m4a', size: 1000 })).toBeNull()
    expect(audioRefusal({ type: 'video/mp4', size: 1000 })).toBe('media.audioType')
    expect(audioRefusal({ type: 'audio/ogg', size: 11 * 1024 * 1024 })).toBe('media.audioSize')
    expect(mediaName('MJ-D-0002', 'PHOTO', 'BEFORE_WORK', 1, 'image/jpeg')).toBe('MJ-D-0002-before-1.jpg')
    expect(mediaName('MJ-D-0002', 'AUDIO', null, 2, 'audio/mp4')).toBe('MJ-D-0002-voice-2.m4a')
  })
})

describe('the depth refusals (B-W2b-96) are said in both languages', () => {
  it('the list is the domain’s; each code has its words; a code is read from the 409', () => {
    expect([...DEPTH_REFUSAL_CODES]).toEqual([...DEPTH_REFUSALS])
    for (const locale of LOCALES) {
      const words = createTranslator(locale, messagesFor(locale, ['plant']).plant!)
      for (const code of DEPTH_REFUSALS) expect(words(`depthRefusal.${code}`), `${locale}: ${code}`).not.toBe(`depthRefusal.${code}`)
    }
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/LOCKED_ALREADY', message: 'English' }, { path: 'fix', message: 'English' }])
    expect(depthRefusalOf(refused)).toBe('LOCKED_ALREADY')
    expect(depthProblemOf(refused)).toEqual({ key: 'depthRefusal.LOCKED_ALREADY' })
    expect(depthProblemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/LOCKED_UNSAFE', message: 'English' }]))).toEqual({ key: 'refusal.LOCKED_UNSAFE' })
  })
})

interface Call {
  method: string
  url: string
  headers: Headers
  body: unknown
}

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

afterEach(() => vi.unstubAllGlobals())

describe('the depth calls as the API takes them', () => {
  it('reads: the queue with the depth fields, the locks and the duplicates of a site', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { requests: [DEEP.unsafe], nextCursor: null, truncated: false } },
      { status: 200, body: { locks: [{ machine: MACHINES.sew2, request: DEEP.unsafe, canSignSafe: true }] } },
      { status: 200, body: { groups: [{ machine: DEEP.thread.machine, requests: [DEEP.thread, DEEP.threadAgain], withinMinutes: 38, words: 'English', suggested: { kind: 'REQUEST', job: null, requestId: DEEP.thread.id } }] } },
    ])
    const page = await listDeepRequests(api, { open: true, siteId: 's1', limit: 200 })
    expect(calls[0]!.url).toBe('/api/plant/requests?siteId=s1&open=true&limit=200')
    expect(page.requests[0]!.routing.routedTo?.name).toBe('Squadra Demo A')
    expect(page.requests[0]!.voiceNotes).toBe(1)
    expect((await readLocks(api, 's1'))[0]!.canSignSafe).toBe(true)
    expect(calls[1]!.url).toBe('/api/plant/requests/locks?siteId=s1')
    const groups = await readDuplicates(api, null)
    expect(calls[2]!.url).toBe('/api/plant/requests/duplicates')
    expect(groups[0]).not.toHaveProperty('words')
  })

  it('writes carry an Idempotency-Key and the version read; the lock keeps its own key', async () => {
    const step = { request: DEEP.noise, machine: MACHINES.heat, replayed: false }
    const move = { job: DEEP_JOBS.handedBack, machine: MACHINES.cutTable, replayed: false }
    const { api, calls } = mockApi([
      { status: 200, body: { requests: [DEEP.threadAgain], target: DEEP.thread, job: null, replayed: false } },
      { status: 201, body: { lock: DEEP.unsafe, from: DEEP.thread, joined: true, machine: MACHINES.sew3, replayed: false } },
      { status: 200, body: step },
      { status: 200, body: step },
      { status: 200, body: move },
      { status: 200, body: move },
    ])
    await mergeRequests(api, { requests: [{ id: DEEP.threadAgain.id, version: 1 }], intoId: DEEP.thread.id })
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/plant/requests/merge', body: { requests: [{ id: DEEP.threadAgain.id, version: 1 }], intoId: DEEP.thread.id } })
    await lockAsUnsafe(api, DEEP.thread.id, { version: 1, note: 'vibra' }, 'lock-key')
    expect(calls[1]!.headers.get('idempotency-key')).toBe('lock-key')
    expect(calls[1]!.body).toEqual({ version: 1, note: 'vibra' })
    await sayOnTheWay(api, DEEP.noise.id, 2)
    expect(calls[2]).toMatchObject({ url: `/api/plant/requests/${DEEP.noise.id}/on-the-way`, body: { version: 2 } })
    await confirmWorks(api, DEEP.noise.id, 3)
    expect(calls[3]!.url).toBe(`/api/plant/requests/${DEEP.noise.id}/works`)
    await handBackJob(api, JOBS.thread.id, { version: 4, machineAfter: 'RUNNING', action: 'ADJUSTED', failureCode: 'SETTINGS' })
    expect(calls[4]).toMatchObject({ url: `/api/plant/jobs/${JOBS.thread.id}/hand-back`, body: { version: 4, machineAfter: 'RUNNING', action: 'ADJUSTED', failureCode: 'SETTINGS' } })
    await confirmJobWorks(api, JOBS.handedBack.id, 5)
    expect(calls[5]).toMatchObject({ url: `/api/plant/jobs/${JOBS.handedBack.id}/confirm`, body: { version: 5 } })
    for (const call of calls) {
      expect(call.headers.get('idempotency-key'), call.url).toBeTruthy()
      expect(call.headers.get('x-csrf-token'), call.url).toBe('csrf-demo')
    }
  })

  it('a photo before the work: announce (with its category) → the store → complete, on the plant route', async () => {
    const put = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', put)
    const presigned = { method: 'PUT', url: 'https://store.example.com/up', headers: {}, expiresAt: at(30, 10) }
    const { api, calls } = mockApi([
      { status: 201, body: { file: { id: media(31, 'PHOTO').id }, upload: presigned } },
      { status: 200, body: { file: { id: media(31, 'PHOTO').id } } },
    ])
    const id = await uploadMedia(api, { type: 'job', id: JOBS.thread.id, category: 'BEFORE_WORK' }, 'PHOTO', new Blob(['jpeg'], { type: 'image/jpeg' }), 'MJ-D-0002-before-1.jpg')
    expect(id).toBe(media(31, 'PHOTO').id)
    expect(calls[0]).toMatchObject({ url: `/api/plant/jobs/${JOBS.thread.id}/files`, body: { kind: 'PHOTO', category: 'BEFORE_WORK', originalName: 'MJ-D-0002-before-1.jpg', contentType: 'image/jpeg', sizeBytes: 4 } })
    expect((calls[0]!.body as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(put).toHaveBeenCalledTimes(1)
    expect(calls[1]!.url).toBe(`/api/plant/jobs/${JOBS.thread.id}/files/${media(31, 'PHOTO').id}/complete`)
  })
})

const GROUPS = 'machineStatus|machineReason|requestStatus|jobStatus|jobType|jobSource|priority|priorityHint|closeReason|closeReasonHint|machineAfter|machineAfterHint|unsafe|symptom|person|age|due|live|common|list|col|keys|requestView|requestTile|requestTileHint|requests|detail|trail|makeJob|closeRequest|signSafe|report|jobView|jobTile|jobTileHint|jobTab|move|jobs|cell|field|newJob|assign|record|handBack|cancelJob|problem|refusal|held|done|stepUp|csv|csvJob|locks|dupes|mergeMany|lockAsUnsafe|routing|progress|trail2|media|close|lead|lockPanel|depthRefusal'
const LEFT_KEY = new RegExp(`\\b(?:${GROUPS})\\.[a-zA-Z_]+(?:\\.[a-zA-Z_]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs plant.jobs.manage"); file names and domains are not keys. */
const SAID = /\b(?:plant\.[a-zA-Z.]+|files\.(?:upload|read)|workers\.view|carter\.jpg|foto-\d+\.jpg|nota-\d+\.webm|factory\.example|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'plant']) }, createElement(View, { model })))
}

describe('every design case of the depth screens draws in both languages with no key left on screen', () => {
  for (const screen of [requestsScreen, jobsScreen, jobScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }
})
