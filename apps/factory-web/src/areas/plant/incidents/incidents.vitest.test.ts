import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { BODY_PARTS, FILING_STATES, INCIDENT_KINDS, INCIDENT_REFUSALS, INJURY_NATURES } from '@nexus/factory-domain/safety/incidents/rules'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor, WINDOW_PAGES } from '../../../shell/nav/office-nav'
import { SEARCH_TYPES, SEARCH_VIEW_PERMISSIONS } from '../../search/model'
import { ACTIONS, FILED, FILINGS, PEOPLE, record } from './_demo/fixtures'
import { readIncidents, reportIncident } from './api'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressTerms,
  closeHeld,
  editBody,
  editDraftOf,
  filingDraftHeld,
  filingDraftOf,
  filingPlan,
  filingTypeFor,
  filingHeld,
  incidentOfChange,
  incidentsCan,
  makeBodyOf,
  makeHeld,
  newActionDraft,
  newPersonDraft,
  newReportDraft,
  personBody,
  problemOf,
  readProblemOf,
  reportBody,
  reportHeld,
  spanWords,
  tileActive,
  tileFilter,
  TRAINING_HELD,
  withKind,
} from './model'
import { designScreen as printScreen } from './print/fixtures'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * B-W2b-149 — SCR-210 Incidents: the pure rules (address, tiles, holds, the report's and the filing's bodies, the refusals in
 * our words, live), the calls' shape, the navigation and the search, the words (every key in it and en) and every design case
 * drawn in both languages with no key or placeholder left — and no person on an anonymised one.
 */

const NOW = new Date('2026-11-04T10:00:00.000Z')
const refused = (code: string, field?: string) => new ApiError('conflict', 409, 'refused', 'refused', null, [{ path: `refusal/${code}` }, ...(field ? [{ path: `body/${field}` }] : [])])

describe('incidents: the address and the tiles', () => {
  it('round-trips every filter; a dialog stays out of the export terms; bad terms are dropped', () => {
    const address = addressOf(new URLSearchParams('rows=INAIL_DUE&status=ALL&from=2026-10-01&to=2026-10-31&q=INC-2026&new=1'))
    expect(address).toEqual({ rows: 'INAIL_DUE', status: 'ALL', from: '2026-10-01', to: '2026-10-31', q: 'INC-2026', report: true })
    expect(addressOf(new URLSearchParams(addressTerms(address).slice(1)))).toEqual(address)
    expect(addressTerms(address, false)).toBe('?rows=INAIL_DUE&status=ALL&from=2026-10-01&to=2026-10-31&q=INC-2026')
    expect(addressOf(new URLSearchParams('rows=PEOPLE&status=MAYBE&from=2026-13-01&q=%20'))).toEqual({ rows: null, status: null, from: null, to: null, q: null, report: false })
  })

  it('a tile is a filter of the list, but Actions overdue (no such rows in the API)', () => {
    expect(tileFilter('inailOpen', '2026-11-04')).toMatchObject({ rows: 'INAIL_DUE' })
    expect(tileFilter('nearMissesThisMonth', '2026-11-04')).toMatchObject({ rows: 'NEAR_MISS', from: '2026-11-01' })
    expect(tileFilter('actionsOverdue', '2026-11-04')).toBeNull()
    expect(tileActive('hazardsOpen', addressOf(new URLSearchParams('rows=HAZARD&status=OPEN')), '2026-11-04')).toBe(true)
    expect(tileActive('hazardsOpen', addressOf(new URLSearchParams('rows=HAZARD&status=OPEN&q=x')), '2026-11-04')).toBe(false)
  })

  it('a span in words: minutes, hours, days and hours', () => {
    expect(spanWords(25 * 60_000)).toEqual({ key: 'time.minutes', params: { minutes: 25 } })
    expect(spanWords(-3.5 * 3_600_000)).toEqual({ key: 'time.hours', params: { hours: 3 } })
    expect(spanWords(50 * 3_600_000)).toEqual({ key: 'time.days', params: { days: 2, hours: 2 } })
  })
})

describe('incidents: the report and its holds', () => {
  it('Send report is held until kind, words, when and where are given; people as the guard asks', () => {
    let draft = newReportDraft(NOW.toISOString())
    expect(reportHeld(draft, NOW)).toBe('held.report.kind')
    draft = { ...draft, kind: 'NEAR_MISS' }
    expect(reportHeld(draft, NOW)).toBe('held.report.what')
    draft = { ...draft, what: 'Carrello quasi urtato' }
    expect(reportHeld(draft, NOW)).toBe('refusal.WHERE_MISSING')
    draft = { ...draft, place: 'Corridoio' }
    expect(reportHeld(draft, NOW)).toBeNull()
    expect(reportHeld({ ...draft, occurredAt: '2026-11-04T11:00:00.000Z' }, NOW)).toBe('refusal.OCCURRED_IN_FUTURE')
    const hurt = { ...newPersonDraft('p1', 'INJURY'), employeeId: 'e1' }
    expect(reportHeld({ ...draft, people: [hurt] }, NOW)).toBe('refusal.INJURED_NOT_INJURY')
    expect(reportHeld({ ...draft, kind: 'INJURY', people: [hurt, { ...hurt, key: 'p2' }] }, NOW)).toBe('refusal.PERSON_TWICE')
    expect(reportHeld({ ...draft, kind: 'INJURY', people: [{ ...hurt, bodySide: 'LEFT' }] }, NOW)).toBe('held.person.side')
  })

  it('a kind that is not an injury makes the hurt people involved; the body sends only what was given', () => {
    const draft = { ...newReportDraft('2026-11-04T09:00:00.000Z'), kind: 'INJURY' as const, what: ' Taglio ', stationId: 's1', people: [{ ...newPersonDraft('p1', 'INJURY'), employeeId: 'e1', bodyParts: ['HAND' as const], bodySide: 'LEFT' as const, nature: 'CUT' as const, firstAidGiven: true }] }
    expect(withKind(draft, 'HAZARD').people[0]).toMatchObject({ involvement: 'INVOLVED', bodyParts: [], nature: null, firstAidGiven: false })
    expect(reportBody(draft, { companyId: 'c1', siteId: 's1' })).toEqual({
      companyId: 'c1',
      siteId: 's1',
      kind: 'INJURY',
      occurredAt: '2026-11-04T09:00:00.000Z',
      what: 'Taglio',
      stationId: 's1',
      people: [{ involvement: 'INJURED', employeeId: 'e1', bodyParts: ['HAND'], bodySide: 'LEFT', nature: 'CUT', firstAidGiven: true, sentToHospital: false }],
    })
    expect(personBody({ ...newPersonDraft('p2', 'NEAR_MISS'), who: 'OUTSIDE', outsideName: ' Visitatore Demo ' })).toEqual({ involvement: 'INVOLVED', outsideName: 'Visitatore Demo' })
  })

  it('the edit sends only what changed; an injury with someone hurt stays an injury', () => {
    const incident = record()
    expect(editBody(incident, editDraftOf(incident))).toBeNull()
    expect(editBody(incident, { ...editDraftOf(incident), severity: 'FIRST_AID', place: ' Tavolo ' })).toEqual({ version: incident.version, place: 'Tavolo', severity: 'FIRST_AID' })
  })
})

describe('incidents: the record’s holds, the actions and the filing', () => {
  it('close is held while an action is open or a filing waits; the filing needs the people right and an injury', () => {
    expect(closeHeld(record())).toBe('held.actionsOpen')
    expect(closeHeld(record({ actions: [] }))).toBe('held.filingWaiting')
    expect(closeHeld(record({ actions: [], inail: { ...record().inail, deadlines: [] } }))).toBeNull()
    expect(closeHeld(record({ canManage: false }))).toBe('held.noManage')
    expect(filingHeld(record({ canPeople: false }))).toBe('held.noPeople')
    expect(filingHeld(record({ kind: 'HAZARD' }))).toBe('held.notInjury')
  })

  it('make into: a job on the incident’s machine or one chosen; training waits for its courses', () => {
    const incident = record({ machine: { id: 'm1', assetNumber: 'DEMO-1' } })
    expect(makeHeld('TRAINING_SESSION', { machineId: null }, incident)).toBe(TRAINING_HELD)
    expect(makeHeld('MAINTENANCE_JOB', { machineId: null }, record())).toBe('refusal.NO_MACHINE')
    expect(makeBodyOf({ ...newActionDraft('MAINTENANCE_JOB'), problem: ' Carter ', priority: 'P1' }, incident)).toEqual({ into: 'MAINTENANCE_JOB', machineId: 'm1', type: 'SAFETY', priority: 'P1', problem: 'Carter' })
    expect(makeBodyOf(newActionDraft('RISK_MEASURE'), incident)).toEqual({ into: 'RISK_MEASURE' })
  })

  it('the filing: the absence names the type; the calls in order; the holds as the API refuses', () => {
    expect([filingTypeFor('0'), filingTypeFor('1'), filingTypeFor('3'), filingTypeFor('4'), filingTypeFor('x')]).toEqual([null, 'STATISTICAL', 'STATISTICAL', 'INSURANCE', null])
    const facts = { occurredAt: '2026-10-31T08:00:00.000Z', now: NOW }
    const fresh = filingDraftOf(null, PEOPLE)
    expect(fresh.personId).toBe(PEOPLE[0]!.id)
    expect(filingDraftHeld(fresh, null, facts)).toBe('held.filing.absence')
    expect(filingDraftHeld({ ...fresh, expectedAbsenceDays: '0' }, null, facts)).toBe('refusal.NO_FILING_NEEDED')
    expect(filingPlan({ ...fresh, expectedAbsenceDays: '5', certificateReceivedAt: '2026-11-03T10:00:00.000Z' }, null)).toMatchObject({ add: { incidentPersonId: PEOPLE[0]!.id, expectedAbsenceDays: 5, certificateReceivedAt: '2026-11-03T10:00:00.000Z' }, edit: null, file: null })
    const due = FILINGS[0]!
    const draft = filingDraftOf(due, PEOPLE)
    expect(filingDraftHeld({ ...draft, filedAt: '2026-11-04T09:00:00.000Z' }, due, facts)).toBe('held.filing.protocol')
    expect(filingDraftHeld({ ...draft, filedAt: '2026-11-01T09:00:00.000Z', protocolNumber: 'P-1' }, due, facts)).toBe('refusal.FILED_BEFORE_CERTIFICATE')
    expect(filingPlan({ ...draft, filedAt: '2026-11-04T09:00:00.000Z', protocolNumber: ' P-1 ' }, due)).toMatchObject({ add: null, edit: null, file: { filedAt: '2026-11-04T09:00:00.000Z', protocolNumber: 'P-1' } })
    expect(filingDraftHeld(filingDraftOf(FILED, PEOPLE), FILED, facts)).toBe('refusal.FILING_FILED')
  })

  it('every refusal code is said in our words; a read problem never shows a refusal', () => {
    expect(problemOf(refused('FILED_BEFORE_CERTIFICATE', 'filedAt'))).toEqual({ key: 'refusal.FILED_BEFORE_CERTIFICATE', field: 'filedAt' })
    expect(problemOf(refused('SOMETHING_NEW'))).toEqual({ key: 'problem.conflict', field: null })
    expect(readProblemOf(refused('NOT_OPEN'))).toBe('problem.read')
    expect(readProblemOf(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('problem.notFound')
  })

  it('live: every incident event moves the page, the record its own', () => {
    expect(incidentOfChange({ type: 'inail_filing.changed', fields: { incidentId: 'i1' } })).toEqual({ moves: true, incidentId: 'i1' })
    expect(incidentOfChange({ type: 'machine.changed', fields: {} }).moves).toBe(false)
  })
})

describe('incidents: the calls', () => {
  it('the list asks the API’s own filters; the report posts the body with its key', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      const body = url.includes('/safety/incidents?') ? { now: NOW.toISOString(), incidents: [], nextCursor: null, canReport: true } : { incident: { id: 'i1', number: 'INC-1', kind: 'HAZARD', status: 'OPEN', anonymous: false, version: 1 }, replayed: false }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api = createApiClient({ baseUrl: '/api', fetch: fetcher, csrfToken: () => 't' })
    await readIncidents(api, { siteId: 's1', rows: 'INAIL_DUE', status: null, from: null, to: null, q: 'INC' }, 'cur')
    expect(seen[0]!.url).toBe('/api/safety/incidents?siteId=s1&rows=INAIL_DUE&q=INC&cursor=cur&limit=50')
    await reportIncident(api, { companyId: 'c1', siteId: 's1', kind: 'HAZARD', occurredAt: NOW.toISOString(), what: 'Olio', place: 'Corridoio' }, 'k1')
    expect(seen[1]!.init?.method).toBe('POST')
    expect(new Headers(seen[1]!.init?.headers).get('idempotency-key')).toBe('k1')
  })
})

describe('incidents: navigation, record links and search', () => {
  it('the page, its record and its print are built; the print is a window; an incident opens its record', () => {
    for (const page of ['/plant/incidents', '/plant/incidents/[id]', '/plant/incidents/print']) expect(OFFICE_PAGES.has(page), page).toBe(true)
    expect(WINDOW_PAGES.has('/plant/incidents/print')).toBe(true)
    expect(recordAddress({ type: 'Incident', id: 'i1' }, OFFICE_PAGES)).toBe('/plant/incidents/i1')
    expect(LIST_PAGES['/safety/incidents']).toBe('/plant/incidents')
    expect(SEARCH_TYPES).toContain('Incident')
    expect(SEARCH_VIEW_PERMISSIONS).toContain('safety.incidents.view')
  })

  it('who sees it: the safety officer, HR and the production manager; never sales', () => {
    const rows = (key: string) => officeNavFor(permissionCheck(templateOf(key)!.permissions)).areas.flatMap((area) => (area.sections ?? []).flatMap((entry) => entry.items.map((row) => row.href)))
    for (const key of ['safety_officer', 'hr', 'production_manager']) expect(rows(key), key).toContain('/plant/incidents')
    expect(rows('sales')).not.toContain('/plant/incidents')
    const can = (key: string) => incidentsCan(templateOf(key)!.permissions)
    expect(can('safety_officer')).toMatchObject({ view: true, report: true, manage: true, people: true })
    expect(can('hr')).toMatchObject({ view: true, manage: false, people: true })
    expect(can('read_only')).toMatchObject({ view: true, report: false, people: false })
  })
})

// ---- the words and every design case ---------------------------------------------------------------------------------------

const NS = 'plant-incidents'
const TOP = [...new Set(Object.keys(flat(CATALOGUE.en[NS] ?? {})).map((key) => key.split('.')[0]!))]
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose; file names and the law are not keys. */
const SAID = /\b(?:safety\.[a-zA-Z.]+|plant\.view|[\w-]+\.(?:pdf|jpg)|D\.Lgs\.|art\.)/g

function flat(dictionary: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(dictionary).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
}

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('incidents: the words', () => {
  it('every key in it and en; every word the page names exists; every kind, state, part, nature and refusal has its words', () => {
    const words = { it: flat(CATALOGUE.it[NS] ?? {}), en: flat(CATALOGUE.en[NS] ?? {}) }
    expect(Object.keys(words.it).sort()).toEqual(Object.keys(words.en).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.') && !file.includes('fixtures')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...source.matchAll(/'((?:held|refusal|problem|notice|time|madeInto)\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    for (const locale of LOCALES) {
      const has = (key: string) => key in words[locale] || `${key}_one` in words[locale]
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
      for (const kind of INCIDENT_KINDS) expect(has(`kind.${kind}`), `${locale} ${kind}`).toBe(true)
      for (const state of FILING_STATES) expect(has(`filingState.${state}`), `${locale} ${state}`).toBe(true)
      for (const part of BODY_PARTS) expect(has(`bodyPart.${part}`), `${locale} ${part}`).toBe(true)
      for (const nature of INJURY_NATURES) expect(has(`nature.${nature}`), `${locale} ${nature}`).toBe(true)
      for (const code of INCIDENT_REFUSALS) expect(has(`refusal.${code}`), `${locale} ${code}`).toBe(true)
      for (const into of ['MAINTENANCE_JOB', 'RISK_MEASURE', 'TRAINING_SESSION']) for (const family of ['make', 'makeHint', 'make.title', 'make.do', 'action.addMake', 'notice.made', 'madeInto']) expect(has(`${family}.${into}`), `${locale} ${family}.${into}`).toBe(true)
    }
  })

  for (const screen of [designScreen, recordScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en with no key or placeholder left`, () => {
      for (const entry of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, entry.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${entry.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('anonymised by default: no person on the list, its print or a record before the recorded open', () => {
    const name = PEOPLE[0]!.employee!.name
    const html = (screen: DesignScreen<unknown>, id: string) => render(screen, screen.cases.find((entry) => entry.id === id)!.model, 'it')
    for (const id of ['list', 'all-sites', 'selected', 'production-manager', 'report']) expect(html(designScreen as never, id), id).not.toContain(name)
    for (const id of ['list', 'all-sites']) expect(html(printScreen as never, id), id).not.toContain(name)
    for (const id of ['report', 'people-restricted', 'authority', 'authority-restricted']) expect(html(recordScreen as never, id), id).not.toContain(name)
    // Shown only after the recorded open, to the people right.
    // The list's cells are the grid's (drawn in the browser); the shown state says it was recorded.
    expect(html(designScreen as never, 'people-shown')).toMatch(/registrata/)
    expect(html(recordScreen as never, 'people-open')).toContain(name)
    expect(html(recordScreen as never, 'authority-open')).toContain(name)
    // The filing itself (its type, absence, certificate) only after the open too; the law's words name both types for everyone.
    for (const id of ['authority', 'authority-restricted']) {
      expect(html(recordScreen as never, id), id).not.toContain('CERT-DEMO-0042')
      expect(html(recordScreen as never, id), id).not.toContain('Assenza prevista')
    }
    expect(html(recordScreen as never, 'authority-open')).toContain('CERT-DEMO-0042')
    expect(ACTIONS.length).toBeGreaterThan(0)
  })

  it('SCR-210 names every state the design asks for', () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['list', 'deadline-late', 'all-sites', 'people-confirm', 'people-shown', 'report', 'report-refused', 'loading', 'error', 'empty', 'no-permission', 'read-only', 'keys']))
    expect(recordScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['report', 'people-open', 'people-restricted', 'actions', 'authority', 'filing', 'filing-refused', 'close-held', 'loading', 'error', 'not-found']))
  })
})
