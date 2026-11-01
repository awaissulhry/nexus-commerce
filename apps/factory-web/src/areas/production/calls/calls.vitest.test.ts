import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CALL_KINDS, CALL_STATUSES, CALL_VIEWS } from '@nexus/factory-domain/production/calls/rules'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { officeNavFor, OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { permissionCheck } from '../../../lib/session/session'
import { cancelCall, comeToCall, listCalls, makeJob, nameOutcome, seeCall, solveCall, type Call, type CallsByHour } from './api'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { designScreen } from './fixtures'
import { CallDetailBody } from './view/CallDetail'
import type { CallsModel } from './view/CallsView'
import {
  ackHeld,
  ackTargets,
  addressOf,
  addressText,
  callsCanOf,
  cancelHeld,
  chartHours,
  chartParts,
  chartRows,
  closeHeld,
  comeHeld,
  durationPhrase,
  jobDraftHeld,
  jobHeld,
  personPhrase,
  refusalCode,
  RESOLUTIONS,
  rowHeld,
  searchRows,
  solveBody,
  solveHeld,
  solveTargets,
  tileAddress,
  typeLabel,
  writeProblem,
} from './model'

/**
 * Production › Floor control › Help calls (SCR-142; B-W2b-58): the pure rules (the address and the tiles as the API's own
 * named filters, durations and people in words — a floor worker never named in a list —, what Acknowledge N and Solve N
 * reach, why each step is held, the API's refusals in our words, the chart's rows), the calls as B-W2b-35's API takes
 * them (version and Idempotency-Key on every write), the page in the map, and every design case drawn in Italian and
 * English with no message key or placeholder left on screen.
 */

const address = (query = '') => addressOf(new URLSearchParams(query))
const base: Call = {
  id: 'c1',
  version: 3,
  siteId: 's1',
  status: 'SENT',
  open: true,
  type: { id: 't1', code: 'MACHINE_STOP', kind: 'MACHINE', labelIt: 'Macchina ferma', labelEn: 'Machine stopped', labelI18n: { ro: 'Mașină oprită' }, icon: null, colour: null },
  station: { id: 'st1', code: 'SEW-04', name: 'Cucitura 4' },
  line: { id: 'l2', code: 'L2', name: 'Linea 2' },
  workOrder: { id: 'w1', number: 'WO-1' },
  bundle: null,
  responderTeam: { id: 'tm', code: 'MNT', name: 'Manutenzione' },
  note: null,
  sentAt: '2026-10-30T09:28:00.000Z',
  seenAt: null,
  onTheWayAt: null,
  solvedAt: null,
  cancelledAt: null,
  openSeconds: 720,
  times: { responseSeconds: null, onTheWaySeconds: null, resolveSeconds: null },
  seenBy: null,
  resolutionCode: null,
  outcome: null,
  waitingBooked: false,
}

describe('help calls: the address and the tiles', () => {
  it('reads and writes its address; nonsense falls back to the open inbox', () => {
    expect(address('view=all&tile=WAITING&kind=MATERIAL&q=sew&open=c1')).toEqual({ view: 'all', tile: 'WAITING', kind: 'MATERIAL', q: 'sew', open: 'c1' })
    expect(address('view=x&tile=y&kind=z')).toEqual({ view: 'open', tile: null, kind: null, q: '', open: null })
    expect(addressText(address())).toBe('')
    expect(addressText({ ...address(), view: 'closed', kind: 'QUALITY' })).toBe('?view=closed&kind=QUALITY')
  })

  it('a tile is the API’s named filter: open calls for the first two, every call for “answered today”; pressed again: the inbox', () => {
    expect(tileAddress(address(), 'WAITING')).toEqual({ tile: 'WAITING', view: 'open' })
    expect(tileAddress(address(), 'ANSWERED_TODAY')).toEqual({ tile: 'ANSWERED_TODAY', view: 'all' })
    expect(tileAddress(address('tile=OPEN'), 'OPEN')).toEqual({ tile: null, view: 'open' })
  })
})

describe('words', () => {
  it('durations in words; a floor worker is never named in a list; an office user by name', () => {
    expect(durationPhrase(null)).toBeNull()
    expect(durationPhrase(45)).toEqual({ key: 'dur.s', params: { s: 45 } })
    expect(durationPhrase(120)).toEqual({ key: 'dur.m', params: { m: 2 } })
    expect(durationPhrase(130)).toEqual({ key: 'dur.ms', params: { m: 2, s: 10 } })
    expect(durationPhrase(3900)).toEqual({ key: 'dur.hm', params: { h: 1, m: '05' } })
    expect(personPhrase({ kind: 'USER', name: 'Giulia Esempio' }, false)).toEqual({ key: 'person.named', params: { name: 'Giulia Esempio' } })
    expect(personPhrase({ kind: 'WORKER', name: null }, false)).toEqual({ key: 'person.worker' })
    expect(personPhrase({ kind: 'WORKER', name: null }, true)).toEqual({ key: 'person.workerHidden' })
    expect(typeLabel(base.type, 'it')).toBe('Macchina ferma')
    expect(typeLabel(base.type, 'ro')).toBe('Mașină oprită')
    expect(typeLabel({ ...base.type, labelEn: '' }, 'en')).toBe('MACHINE_STOP')
  })

  it('the search finds station, line, work order and the type’s words', () => {
    const other: Call = { ...base, id: 'c2', station: { id: 'x', code: 'QC-01', name: 'Controllo' }, line: null, workOrder: null }
    expect(searchRows([base, other], 'sew', 'en').map((row) => row.id)).toEqual(['c1'])
    expect(searchRows([base, other], 'wo-1', 'en').map((row) => row.id)).toEqual(['c1'])
    expect(searchRows([base, other], 'machine', 'en').map((row) => row.id)).toEqual(['c1', 'c2'])
  })
})

describe('steps and their reasons', () => {
  const answering = { canAnswer: true, busy: false }
  it('Acknowledge only an unseen open call; On my way once; Done and Cancel while open; each held with why', () => {
    expect(ackHeld(base, answering)).toBeNull()
    expect(ackHeld({ status: 'SEEN' }, answering)).toBe('held.seenAlready')
    expect(ackHeld({ status: 'ON_THE_WAY' }, answering)).toBe('held.comingAlready')
    expect(ackHeld({ status: 'SOLVED' }, answering)).toBe('held.closed')
    expect(ackHeld(base, { canAnswer: false, busy: false })).toBe('held.noAnswer')
    expect(comeHeld({ status: 'SEEN' }, answering)).toBeNull()
    expect(comeHeld({ status: 'ON_THE_WAY' }, answering)).toBe('held.comingAlready')
    expect(closeHeld({ open: false }, answering)).toBe('held.closed')
    expect(closeHeld({ open: true }, { canAnswer: true, busy: true })).toBe('held.busy')
  })

  it('Acknowledge N reaches the unseen, Solve N the open; a closed row or no right cannot be selected', () => {
    const rows: Call[] = [base, { ...base, id: 'c2', status: 'SEEN' }, { ...base, id: 'c3', status: 'SOLVED', open: false }]
    expect(ackTargets(rows).map((row) => row.id)).toEqual(['c1'])
    expect(solveTargets(rows).map((row) => row.id)).toEqual(['c1', 'c2'])
    expect(rowHeld(rows[2]!, { answer: true })).toBe('held.closed')
    expect(rowHeld(rows[0]!, { answer: false })).toBe('held.noAnswer')
  })

  it('Done sends the resolution code and words only when given; Cancel needs a reason; a job needs a machine and the problem', () => {
    expect(solveBody({ code: '', note: '  ' })).toEqual({})
    expect(solveBody({ code: 'FIXED', note: ' Ago sostituito ' })).toEqual({ resolutionCode: 'FIXED', resolutionNote: 'Ago sostituito' })
    expect(solveHeld({ code: '', note: 'x'.repeat(501) }, false)).toBe('held.noteLong')
    for (const code of RESOLUTIONS) expect(solveHeld({ code, note: '' }, false)).toBeNull()
    expect(cancelHeld(' ', false)).toBe('held.reason')
    expect(cancelHeld('Sent by mistake', false)).toBeNull()
    expect(jobDraftHeld({ machineId: '', priority: 'P2', problem: 'x' }, false)).toBe('held.machine')
    expect(jobDraftHeld({ machineId: 'm1', priority: 'P2', problem: ' ' }, false)).toBe('held.problem')
    expect(jobHeld({ outcome: { recordType: 'MaintenanceJob', recordId: 'j' }, type: base.type }, false, { answer: true, plantJobs: true }, false)).toBe('held.outcomeNamed')
    expect(jobHeld({ outcome: null, type: base.type }, true, { answer: true, plantJobs: false }, false)).toBe('held.noPlantJobs')
    expect(jobHeld({ outcome: null, type: base.type }, true, { answer: true, plantJobs: true }, false)).toBeNull()
  })

  it('refusals in our words, with the rule’s code; the rest by kind', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/ALREADY_SEEN', message: 'x' }, { path: 'fix', message: 'y' }])
    expect(refusalCode(refused)).toBe('ALREADY_SEEN')
    expect(writeProblem(refused)).toEqual({ key: 'refusal.ALREADY_SEEN' })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'problem.changed' })
    expect(writeProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'problem.forbidden' })
    expect(writeProblem(new Error('x'))).toEqual({ key: 'problem.write' })
  })

  it('the abilities follow the permissions', () => {
    expect(callsCanOf(['production.calls.view'])).toEqual({ view: true, answer: false, manage: false, settings: false, plantJobs: false, workOrders: false })
    expect(callsCanOf(['production.calls.view', 'production.calls.answer', 'plant.view', 'plant.jobs.manage']).plantJobs).toBe(true)
  })
})

describe('the chart', () => {
  const zero = { MACHINE: 0, MATERIAL: 0, QUALITY: 0, SUPERVISOR: 0, MAINTENANCE: 0, OTHER: 0 }
  const day: CallsByHour = {
    date: '2026-10-30',
    timeZone: 'Europe/Rome',
    hours: Array.from({ length: 24 }, (_, hour) =>
      hour === 5 ? { hour, calls: 2, byKind: { ...zero, MACHINE: 1, MATERIAL: 1 }, byLine: [{ lineId: 'l1', count: 1 }, { lineId: null, count: 1 }] } : hour === 9 ? { hour, calls: 1, byKind: { ...zero, MATERIAL: 1 }, byLine: [{ lineId: 'l1', count: 1 }] } : { hour, calls: 0, byKind: zero, byLine: [] },
    ),
    byKind: [],
    lines: [{ id: 'l1', code: 'L1', name: 'Linea 1' }],
  }
  it('shows 6 to 20, widened to the first and last hour with a call; parts by kind or line; calls so far as the line', () => {
    expect(chartHours(day.hours)[0]).toBe(5)
    expect(chartHours(day.hours).at(-1)).toBe(20)
    expect(chartParts(day, 'kind').map((part) => part.key)).toEqual(['MACHINE', 'MATERIAL'])
    expect(chartParts(day, 'line').map((part) => part.key)).toEqual(['l1', 'none'])
    const rows = chartRows(day, 'kind')
    expect(rows[0]).toEqual({ hour: '05:00', sofar: 2, MACHINE: 1, MATERIAL: 1 })
    expect(rows.find((row) => row.hour === '09:00')).toEqual({ hour: '09:00', sofar: 3, MACHINE: 0, MATERIAL: 1 })
    expect(chartRows(day, 'line')[0]).toEqual({ hour: '05:00', sofar: 2, l1: 1, none: 1 })
  })
})

describe('the calls', () => {
  function recorder(answer: unknown) {
    const calls: Array<{ method: string; url: string; body: unknown; key: string | null }> = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, key: headers.get('idempotency-key') })
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchFn, csrfToken: () => 'csrf' })
    return { api, calls }
  }
  const record = { ...base, caller: null, timeline: [{ step: 'SENT', at: base.sentAt, by: null }], coming: null, resolutionNote: null, waiting: null, bookWaiting: false }

  it('reads the inbox by site, view, tile and kind', async () => {
    const { api, calls } = recorder({ calls: [base], nextCursor: null })
    expect((await listCalls(api, { siteId: 's1', view: 'open', tile: 'WAITING', kind: 'MACHINE' })).calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/api/production/calls?siteId=s1&view=open&tile=WAITING&kind=MACHINE&limit=50')
  })

  it('every step sends the version read and its own key', async () => {
    const { api, calls } = recorder({ call: record, replayed: false })
    await seeCall(api, base, 'k1')
    await comeToCall(api, base, 'k2')
    await solveCall(api, base, { resolutionCode: 'FIXED' }, 'k3')
    await cancelCall(api, base, 'Sent by mistake', 'k4')
    await nameOutcome(api, base, { recordType: 'MaintenanceJob', recordId: 'j1' }, 'k5')
    expect(calls.map((call) => [call.method, new URL(call.url, 'http://x').pathname, call.key])).toEqual([
      ['POST', '/api/production/calls/c1/seen', 'k1'],
      ['POST', '/api/production/calls/c1/on-the-way', 'k2'],
      ['POST', '/api/production/calls/c1/solve', 'k3'],
      ['POST', '/api/production/calls/c1/cancel', 'k4'],
      ['POST', '/api/production/calls/c1/outcome', 'k5'],
    ])
    expect(calls[2]!.body).toEqual({ version: 3, resolutionCode: 'FIXED' })
    expect(calls[3]!.body).toEqual({ version: 3, reason: 'Sent by mistake' })
    expect(calls[4]!.body).toEqual({ version: 3, recordType: 'MaintenanceJob', recordId: 'j1' })
  })

  it('opens a corrective maintenance job for the station’s machine', async () => {
    const { api, calls } = recorder({ job: { id: 'j1', number: 'MJ-0042' } })
    expect(await makeJob(api, { machineId: 'm1', type: 'CORRECTIVE', problem: 'Help call from SEW-04', priority: 'P1' }, 'k6')).toEqual({ id: 'j1', number: 'MJ-0042' })
    expect(calls[0]).toMatchObject({ method: 'POST', key: 'k6', body: { machineId: 'm1', type: 'CORRECTIVE', problem: 'Help call from SEW-04', priority: 'P1' } })
  })
})

describe('the page in the map', () => {
  it('is built, in Floor control after Scrap & rework, for production.calls.view; a call opens in its DetailModal (the bell)', () => {
    expect(OFFICE_PAGES.has('/production/calls')).toBe(true)
    expect(LIST_PAGES['/production/calls']).toBe('/production/calls')
    expect(recordAddress({ type: 'HelpCall', id: 'c1' }, OFFICE_PAGES)).toBe('/production/calls?open=c1')
    const control = officeNavFor(permissionCheck(['production.calls.view', 'production.scrap.view'])).areas.find((area) => area.id === 'production')?.sections?.find((section) => section.id === 'production-floor-control')
    expect(control?.items.map((item) => item.id)).toEqual(['production-scrap', 'production-calls'])
    const without = officeNavFor(permissionCheck(['production.scrap.view'])).areas.find((area) => area.id === 'production')?.sections?.find((section) => section.id === 'production-floor-control')
    expect(without?.items.map((item) => item.id)).toEqual(['production-scrap'])
  })
})

const LEFT_KEY = /\b(?:common|live|page|tiles|tile|held|kind|status|chart|routing|col|list|view|bulk|keys|person|dur|open|waiting|detail|step|coming|resolution|outcome|solve|cancel|job|machine|announce|notice|refusal|problem)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:production\.[a-z.]+|plant\.[a-z.]+|people\.[a-z.]+)\b/g

function render(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = designScreen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'help-calls', 'ds-words']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  it(`${designScreen.screen}: ${designScreen.cases.length} cases × it, en`, () => {
    for (const item of designScreen.cases as unknown as DesignScreen<unknown>['cases']) {
      for (const locale of LOCALES) {
        const html = render(item.model, locale).replace(SAID, '')
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('the call’s detail draws in both languages (the caller named inside the call only, at a WORKER site)', () => {
    for (const id of ['detail-machine', 'detail-named', 'detail-solved']) {
      const model = (designScreen.cases.find((item) => item.id === id)!.model as unknown as { model: CallsModel }).model
      const detail = model.detail!
      if (detail.loaded.status !== 'ready') throw new Error(id)
      for (const locale of LOCALES) {
        const html = renderToString(
          createElement(I18nProvider, { locale, messages: messagesFor(locale, ['help-calls', 'ds-words', 'lists']) }, createElement(CallDetailBody, { model, call: detail.loaded.value.call, place: { locale, timeZone: 'Europe/Rome' } })),
        ).replace(SAID, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${id} (${locale}) placeholder`).toBeNull()
        if (id === 'detail-named') expect(html).toContain('Marta Esempio')
      }
    }
    expect(render(designScreen.cases.find((item) => item.id === 'inbox')!.model, 'en')).not.toContain('Marta Esempio')
  })

  it('every literal key the page says exists in both catalogues (the dialogs draw only in a browser)', () => {
    const dir = __dirname
    const files = ['model.ts', 'CallsPage.tsx', 'view/CallsView.tsx', 'view/CallDetail.tsx', 'view/CallDialogs.tsx', 'view/parts.tsx', 'fixtures.ts']
    const keys = new Set<string>()
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8')
      for (const match of source.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)) keys.add(match[1]!)
      for (const match of source.matchAll(/'((?:held|problem|refusal|notice|dur|person)\.[A-Za-z_.]+)'/g)) keys.add(match[1]!)
    }
    expect(keys.size).toBeGreaterThan(80)
    for (const locale of LOCALES) {
      const catalogue = messagesFor(locale, ['help-calls'])['help-calls'] ?? {}
      const t = createTranslator(locale, catalogue)
      for (const key of keys) expect(t(key, { count: 2 }), `${locale}: ${key}`).not.toBe(key)
    }
  })

  it('has words for every kind, status, view, resolution and machine state in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['help-calls'])['help-calls'] ?? {})
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const kind of CALL_KINDS) has(`kind.${kind}`)
      for (const status of CALL_STATUSES) {
        has(`status.${status}`)
        has(`step.${status}`)
      }
      for (const view of CALL_VIEWS) has(`view.${view}`)
      for (const code of RESOLUTIONS) has(`resolution.${code}`)
      for (const state of ['RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE', 'RETIRED']) has(`machine.${state}`)
      for (const type of ['MaintenanceJob', 'MaintenanceRequest', 'Nonconformance', 'Task']) has(`outcome.${type}`)
      for (const key of ['notice.acked', 'notice.solved', 'notice.cancelled', 'notice.coming', 'list.count', 'page.ackN', 'bulk.solve']) has(key, 2)
      for (const tile of ['OPEN', 'WAITING', 'ANSWERED_TODAY', 'MEDIAN']) has(`tile.${tile}`)
      for (const state of ['connecting', 'live', 'offline']) has(`live.${state}`)
      for (const by of ['kind', 'line']) has(`chart.by.${by}`)
      for (const priority of ['P1', 'P2', 'P3']) has(`job.${priority}`)
      for (const state of ['OPEN', 'PENDING', 'APPROVED', 'REJECTED']) has(`waiting.status.${state}`)
      for (const step of ['SEEN', 'ON_THE_WAY']) has(`coming.${step}`)
      for (const code of ['SOLVED', 'CANCELLED', 'ALREADY_SEEN', 'ALREADY_ON_THE_WAY', 'OUTCOME_NAMED', 'KIND_FIXED', 'CODE_TAKEN', 'CODE_NOT_LISTED', 'TEAM_NOT_ACTIVE', 'WAITING_CODE', 'TYPE_INACTIVE', 'NOT_THIS_STATION', 'NO_STATION', 'OTHER_STATION']) has(`refusal.${code}`)
    }
  })
})
