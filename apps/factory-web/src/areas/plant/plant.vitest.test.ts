import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CLOSE_REASONS, JOB_SOURCES, JOB_STATUSES, JOB_TYPES, MACHINE_STATUSES, PLANT_REFUSALS, PRIORITIES, REQUEST_STATUSES } from '@nexus/factory-domain/plant/rules'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { createApiClient, type ApiClient } from '../../lib/api/client'
import { ApiError } from '../../lib/api/errors'
import type { DesignScreen } from '../../lib/design/design-screen'
import { LOCALES } from '../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../lib/records/record-links'
import { permissionCheck } from '../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../shell/nav/office-nav'
import { assignJobs, closeRequest, createMachine, listJobs, listMachines, listRequests, makeJobOfRequest, moveJob, signSafe, updateJob } from './_shared/api'
import { JOB_LIST, JOBS, MACHINE_LIST, MACHINES, OPEN_QUEUE, REQUESTS } from './_shared/fixtures'
import {
  assigneeFields,
  assigneeValue,
  assigneeWords,
  BOARD_LANES,
  costMinorOf,
  costTextOf,
  dueWords,
  instantOf,
  jobsAddressOf,
  jobsAddressText,
  jobsQuery,
  laneHeld,
  localOf,
  machinesAddressOf,
  machinesAddressText,
  machinesQuery,
  moveHeld,
  moveToLane,
  nextMove,
  personWords,
  plantCan,
  PLANT_REFUSAL_CODES,
  problemOf,
  refusalOf,
  requestsAddressOf,
  requestsAddressText,
  requestsQuery,
  yearOf,
} from './_shared/model'
import { designScreen as jobsScreen } from './jobs/fixtures'
import { designScreen as jobScreen } from './jobs/record/fixtures'
import { designScreen as sheetScreen } from './jobs/sheet/fixtures'
import { designScreen as machinesScreen } from './machines/fixtures'
import { designScreen as machineScreen } from './machines/record/fixtures'
import { designScreen as tagsScreen } from './machines/tags/fixtures'
import { officeArea } from './nav'
import { designScreen as requestsScreen } from './requests/fixtures'
import { designScreen as printScreen } from './requests/print/fixtures'

/**
 * Plant › Maintenance (SCR-148, SCR-149, SCR-150 and their records and print pages; B-W2a-53 on the API of B-W2a-35): the
 * pure rules (saved rows ⇄ the API's own filters, the address, the board's lanes and why a card may not go there, the job
 * moves a person may make, a refusal read from an API error, a cost and a due time typed in the site's zone, who a person
 * is in words — a floor worker never by name in a list), the calls as the API takes them (Idempotency-Key and the version
 * read on every write), the navigation and record links, and every design case drawn in Italian and English with no
 * message key or placeholder left on screen.
 */

describe('plant: who may do what', () => {
  it('reads the permissions of the plant (and the cost grain) by name', () => {
    const lead = plantCan(templateOf('maintenance')!.permissions)
    expect(lead).toMatchObject({ view: true, manageMachines: true, report: true, triage: true, manageJobs: true, work: true, signSafe: true, cost: false })
    expect(plantCan(templateOf('production_manager')!.permissions)).toMatchObject({ view: true, triage: true, manageJobs: true, work: false, signSafe: false })
    expect(plantCan(templateOf('floor_supervisor')!.permissions)).toMatchObject({ view: true, triage: true, manageJobs: false, manageMachines: false })
    expect(plantCan(templateOf('sales')!.permissions).view).toBe(false)
  })

  it('the area: Plant (order 12) with its three Maintenance pages, each asking plant.view; a sales person sees no Plant', () => {
    expect(officeArea.order).toBe(12)
    expect(officeArea.area.sections?.[0]?.items.map((item) => [item.href, item.permission])).toEqual([
      ['/plant/requests', 'plant.view'],
      ['/plant/jobs', 'plant.view'],
      ['/plant/machines', 'plant.view'],
    ])
    expect(officeNavFor(permissionCheck(templateOf('sales')!.permissions)).areas.map((area) => area.id)).not.toContain('plant')
    expect(officeNavFor(permissionCheck(templateOf('maintenance')!.permissions)).areas.map((area) => area.id)).toContain('plant')
  })

  it('a machine and a job open their own pages; a request opens in the queue’s detail; the lists are built', () => {
    expect(recordAddress({ type: 'Machine', id: 'm1' }, OFFICE_PAGES)).toBe('/plant/machines/m1')
    expect(recordAddress({ type: 'MaintenanceJob', id: 'j1' }, OFFICE_PAGES)).toBe('/plant/jobs/j1')
    expect(recordAddress({ type: 'MaintenanceRequest', id: 'r1' }, OFFICE_PAGES)).toBe('/plant/requests?open=r1')
    for (const list of ['/plant/requests', '/plant/jobs', '/plant/machines']) expect(LIST_PAGES[list]).toBe(list)
  })
})

describe('plant: saved rows and the address', () => {
  it('requests: the queue (open), a tile, all and done map to the API; the address round-trips', () => {
    expect(requestsQuery({ view: 'open', tile: null, siteId: null })).toEqual({ open: true, siteId: null })
    expect(requestsQuery({ view: 'unsafe', tile: null, siteId: 's1' })).toEqual({ tile: 'UNSAFE', siteId: 's1' })
    expect(requestsQuery({ view: 'open', tile: 'WAITING', siteId: null })).toEqual({ tile: 'WAITING', siteId: null })
    expect(requestsQuery({ view: 'closed', tile: null, siteId: null })).toEqual({ status: ['JOB_MADE', 'MERGED', 'CLOSED'], siteId: null })
    const address = requestsAddressOf(new URLSearchParams('view=all&tile=DUPLICATES&site=s1&open=r1&report=1&machine=m1'))
    expect(address).toEqual({ view: 'all', tile: 'DUPLICATES', siteId: 's1', open: 'r1', report: true, machineId: 'm1' })
    expect(requestsAddressText(address)).toBe('?view=all&tile=DUPLICATES&site=s1&open=r1&report=1&machine=m1')
    expect(requestsAddressOf(new URLSearchParams('view=x&tile=y'))).toMatchObject({ view: 'open', tile: null })
  })

  it('jobs: every row maps to the API (mine = only my own; tiles by name); list or board in the address', () => {
    expect(jobsQuery({ view: 'open', siteId: null, machineId: null })).toEqual({ siteId: null, machineId: null, open: true })
    expect(jobsQuery({ view: 'mine', siteId: null, machineId: null })).toEqual({ siteId: null, machineId: null, open: true, mine: true })
    expect(jobsQuery({ view: 'overdue', siteId: 's1', machineId: 'm1' })).toEqual({ siteId: 's1', machineId: 'm1', tile: 'OVERDUE' })
    expect(jobsQuery({ view: 'closed', siteId: null, machineId: null }).status).toEqual(['CLOSED', 'CANCELLED'])
    const address = jobsAddressOf(new URLSearchParams('view=waiting&mode=board&new=1&machine=m1'))
    expect(address).toEqual({ view: 'waiting', siteId: null, machineId: 'm1', mode: 'board', isNew: true })
    expect(jobsAddressText(address)).toBe('?view=waiting&machine=m1&mode=board&new=1')
  })

  it('machines: in use by default (the API leaves retired out), tiles, retired, all; the search trims', () => {
    expect(machinesQuery({ view: 'inUse', q: '  ', siteId: null, classId: null })).toEqual({ siteId: null, classId: null })
    expect(machinesQuery({ view: 'doNotUse', q: 'CD', siteId: null, classId: 'c1' })).toEqual({ siteId: null, classId: 'c1', q: 'CD', tile: 'DO_NOT_USE' })
    expect(machinesQuery({ view: 'retired', q: '', siteId: null, classId: null }).status).toEqual(['RETIRED'])
    expect(machinesQuery({ view: 'all', q: '', siteId: null, classId: null }).status).toEqual([...MACHINE_STATUSES])
    const address = machinesAddressOf(new URLSearchParams('view=down&q=sew&site=s1&class=c1&new=1'))
    expect(machinesAddressText(address)).toBe('?view=down&q=sew&site=s1&class=c1&new=1')
  })
})

describe('plant: job moves and the board', () => {
  const both = { manageJobs: true, work: true }
  it('a move is held for the right, the state, and a locked machine handed back running (H1)', () => {
    expect(moveHeld('start', JOBS.fresh, both)).toBeNull()
    expect(moveHeld('start', JOBS.fresh, { manageJobs: true, work: false })).toBe('held.noWork')
    expect(moveHeld('plan', JOBS.fresh, { manageJobs: false, work: true })).toBe('held.noManageJobs')
    expect(moveHeld('close', JOBS.fresh, both)).toBe('held.move.close')
    expect(moveHeld('handBack', JOBS.safety, both, 'RUNNING')).toBe('held.lockedRunning')
    expect(moveHeld('handBack', JOBS.safety, both, 'DO_NOT_USE')).toBeNull()
    expect(nextMove('NEW')).toBe('start')
    expect(nextMove('IN_PROGRESS')).toBe('handBack')
    expect(nextMove('HANDED_BACK')).toBe('close')
    expect(nextMove('CLOSED')).toBeNull()
  })

  it('a drop asks the move its lane means; Closed only after the hand-back; nothing goes back to New', () => {
    expect(BOARD_LANES).toEqual(['NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_PARTS', 'HANDED_BACK', 'CLOSED'])
    expect(moveToLane('NEW', 'PLANNED')).toBe('plan')
    expect(moveToLane('PLANNED', 'IN_PROGRESS')).toBe('start')
    expect(moveToLane('HANDED_BACK', 'IN_PROGRESS')).toBe('reopen')
    expect(moveToLane('IN_PROGRESS', 'WAITING_PARTS')).toBe('wait')
    expect(moveToLane('IN_PROGRESS', 'HANDED_BACK')).toBe('handBack')
    expect(moveToLane('HANDED_BACK', 'CLOSED')).toBe('close')
    expect(laneHeld(JOBS.fresh, 'CLOSED', both)).toBe('held.board.closedAfterHandBack')
    expect(laneHeld(JOBS.safety, 'NEW', both)).toBe('held.board.notBackToNew')
    expect(laneHeld(JOBS.planned, 'WAITING_PARTS', both)).toBe('held.board.to.WAITING_PARTS')
    expect(laneHeld(JOBS.handedBack, 'CLOSED', { manageJobs: false, work: true })).toBe('held.noManageJobs')
  })
})

describe('plant: words of people, refusals, costs and times', () => {
  const t = createTranslator('en', messagesFor('en', ['plant']).plant!)
  it('a floor worker is never named in a list (the API gives no name there); a station by its code; me', () => {
    expect(personWords(t, { kind: 'WORKER', id: null, name: null })).toBe('A floor technician')
    expect(personWords(t, { kind: 'WORKER', id: 'w1', name: 'Luca Demo' })).toBe('Luca Demo')
    expect(personWords(t, { kind: 'STATION', id: 's1', name: 'SEW-02 Postazione' })).toBe('SEW-02 Postazione')
    expect(personWords(t, null)).toBe('Nobody')
    expect(assigneeWords(t, JOBS.thread)).toBe('Me')
    expect(assigneeWords(t, JOBS.safety)).toBe('A floor technician')
    expect(assigneeValue(JOBS.fresh)).toBe('')
    expect(assigneeValue({ assignee: { kind: 'USER', id: 'u1', name: 'x' } })).toBe('USER:u1')
    expect(assigneeFields('WORKER:w1')).toEqual({ assigneeId: null, assigneeWorkerId: 'w1' })
    expect(assigneeFields('')).toEqual({ assigneeId: null, assigneeWorkerId: null })
  })

  it('reads a plant refusal by its code (every code of the domain has our words), a field 400, else the kind', () => {
    expect([...PLANT_REFUSAL_CODES]).toEqual([...PLANT_REFUSALS])
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/LOCKED_UNSAFE', message: 'English' }, { path: 'fix', message: 'English' }])
    expect(refusalOf(refused)).toBe('LOCKED_UNSAFE')
    expect(problemOf(refused)).toEqual({ key: 'refusal.LOCKED_UNSAFE' })
    expect(problemOf(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/assigneeId', message: 'English' }]))).toEqual({ key: 'problem.field.assigneeId' })
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'problem.conflict' })
    expect(problemOf(new Error('boom'))).toEqual({ key: 'problem.unavailable' })
  })

  it('a cost typed in either language; a year; a due time in the site’s zone and back', () => {
    expect(costMinorOf('1.850,50')).toBe(185050)
    expect(costMinorOf('1850.5')).toBe(185050)
    expect(costMinorOf('1850')).toBe(185000)
    expect(costMinorOf('')).toBeNull()
    expect(costMinorOf('12,3,4')).toBeUndefined()
    expect(costTextOf(185050, 'it')).toBe('1850,50')
    expect(costTextOf(185050, 'en')).toBe('1850.50')
    expect(yearOf('2019')).toBe(2019)
    expect(yearOf('19')).toBeUndefined()
    expect(yearOf('')).toBeNull()
    // 30 October 2026 is winter time in Rome (UTC+1 since 25 October); 30 July is summer time (UTC+2).
    expect(instantOf('2026-10-30T14:00')).toBe('2026-10-30T13:00:00.000Z')
    expect(instantOf('2026-07-30T14:00')).toBe('2026-07-30T12:00:00.000Z')
    expect(localOf('2026-10-30T13:00:00.000Z')).toBe('2026-10-30T14:00')
    expect(instantOf('')).toBeNull()
    expect(dueWords(t, '2026-10-30T12:00:00.000Z', '2026-10-30T09:00:00.000Z')).toBe('in 3 h 00')
    expect(dueWords(t, '2026-10-30T09:00:00.000Z', '2026-10-30T09:20:00.000Z')).toBe('overdue by 20 min')
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

describe('plant: the calls as the API takes them', () => {
  it('lists with the API’s own filters (the queue, a tile; jobs mine; machines by words)', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { requests: OPEN_QUEUE, nextCursor: null, truncated: false } },
      { status: 200, body: { jobs: JOB_LIST, nextCursor: null } },
      { status: 200, body: { machines: MACHINE_LIST, nextCursor: 'c1' } },
    ])
    await listRequests(api, { ...requestsQuery({ view: 'open', tile: null, siteId: 's1' }), limit: 200 })
    expect(calls[0]!.url).toBe('/api/plant/requests?siteId=s1&open=true&limit=200')
    await listJobs(api, { ...jobsQuery({ view: 'mine', siteId: null, machineId: null }), limit: 50 })
    expect(calls[1]!.url).toBe('/api/plant/jobs?open=true&mine=true&limit=50')
    const page = await listMachines(api, { ...machinesQuery({ view: 'retired', q: ' cd ', siteId: null, classId: null }), limit: 50 })
    expect(calls[2]!.url).toBe('/api/plant/machines?status=RETIRED&q=cd&limit=50')
    expect(page.nextCursor).toBe('c1')
  })

  it('every write carries an Idempotency-Key and the version read; the sign-safe keeps its own key for the code', async () => {
    const triage = { request: REQUESTS.thread, machine: MACHINES.sew3, job: JOBS.fresh, replayed: false }
    const { api, calls } = mockApi([
      { status: 201, body: triage },
      { status: 200, body: triage },
      { status: 200, body: { request: REQUESTS.unsafe, machine: MACHINES.sew2, replayed: false } },
      { status: 200, body: { job: JOBS.fresh, replayed: false } },
      { status: 200, body: { jobs: [JOBS.fresh], replayed: false } },
      { status: 200, body: { job: JOBS.fresh, machine: MACHINES.heat, replayed: false } },
      { status: 201, body: { machine: MACHINES.sew1 } },
    ])
    await makeJobOfRequest(api, REQUESTS.thread.id, { version: 1, type: 'CORRECTIVE', problem: 'x', priority: 'P1', assigneeId: 'u1', assigneeWorkerId: null, dueAt: null })
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/plant/requests/${REQUESTS.thread.id}/job`, body: { version: 1, priority: 'P1', assigneeId: 'u1' } })
    await closeRequest(api, REQUESTS.thread.id, { version: 1, reason: 'OTHER', note: 'n', keepDown: true })
    expect(calls[1]!.body).toEqual({ version: 1, reason: 'OTHER', note: 'n', keepDown: true })
    await signSafe(api, REQUESTS.unsafe.id, { version: 2, note: 'checked' }, 'key-1')
    expect(calls[2]!.headers.get('idempotency-key')).toBe('key-1')
    await updateJob(api, JOBS.fresh.id, { version: 2, priority: 'P1' })
    expect(calls[3]).toMatchObject({ method: 'PATCH', url: `/api/plant/jobs/${JOBS.fresh.id}`, body: { version: 2, priority: 'P1' } })
    await assignJobs(api, { jobs: [{ id: JOBS.fresh.id, version: 2 }], assigneeId: null, assigneeWorkerId: 'w1' })
    expect(calls[4]!.body).toEqual({ jobs: [{ id: JOBS.fresh.id, version: 2 }], assigneeId: null, assigneeWorkerId: 'w1' })
    await moveJob(api, JOBS.fresh.id, 'handBack', { version: 2, workDone: 'done', machineAfter: 'RUNNING' })
    expect(calls[5]!.url).toBe(`/api/plant/jobs/${JOBS.fresh.id}/hand-back`)
    await createMachine(api, { siteId: 's1', assetNumber: 'DEMO-1', classId: 'c1' })
    for (const call of calls) {
      expect(call.headers.get('idempotency-key'), call.url).toBeTruthy()
      expect(call.headers.get('x-csrf-token'), call.url).toBe('csrf-demo')
    }
  })
})

const LEFT_KEY =
  /\b(?:machineStatus|machineReason|requestStatus|jobStatus|jobType|jobSource|priority|priorityHint|closeReason|closeReasonHint|machineAfter|machineAfterHint|unsafe|symptom|person|age|due|live|common|list|col|keys|requestView|requestTile|requestTileHint|requests|detail|trail|makeJob|closeRequest|signSafe|merge|report|jobView|jobTile|jobTileHint|jobTab|move|jobs|cell|field|newJob|assign|record|handBack|cancelJob|machineView|machineTile|machineTileHint|machineTab|machines|machine|newMachine|retire|machineRecord|print|sheet|tags|problem|refusal|held|done|stepUp|csv|csvJob|csvMachine)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs plant.jobs.manage"); addresses, file names and domains are not keys. */
const SAID = /\b(?:plant\.[a-zA-Z.]+|files\.upload|workers\.view|carter\.jpg|factory\.example|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'plant']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [requestsScreen, printScreen, jobsScreen, jobScreen, sheetScreen, machinesScreen, machineScreen, tagsScreen] as unknown as DesignScreen<unknown>[]) {
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

  it('the dynamic words exist in both languages (states, types, sources, priorities, reasons, refusals)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['plant']).plant!)
      const has = (key: string) => expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const status of MACHINE_STATUSES) has(`machineStatus.${status}`)
      for (const status of REQUEST_STATUSES) has(`requestStatus.${status}`)
      for (const status of JOB_STATUSES) has(`jobStatus.${status}`)
      for (const type of JOB_TYPES) has(`jobType.${type}`)
      for (const source of JOB_SOURCES) has(`jobSource.${source}`)
      for (const priority of PRIORITIES) has(`priority.${priority}`)
      for (const reason of CLOSE_REASONS) has(`closeReason.${reason}`)
      for (const code of PLANT_REFUSALS) has(`refusal.${code}`)
    }
  })
})
