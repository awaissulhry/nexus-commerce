import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STATUTORY_REFUSALS } from '@nexus/factory-domain/plant/statutory/rules'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress, listAddress } from '../../../lib/records/record-links'
import { officeNavFor, OFFICE_PAGES, WINDOW_PAGES } from '../../../shell/nav/office-nav'
import { permissionCheck } from '../../../lib/session/session'
import { dropDayOf } from '../_shared/calendar/CalendarView'
import { BODY, CHIPS, ENDED_PLAN, GUARDS, GUARDS_PLAN, LIFTING_PLAN, PLANS, PREFIX, PRESS, PREVENTIVE_ROLES_DEMO, RESULT_IDS, RESULTS, TODAY, VESSEL_PLAN } from './_demo/fixtures'
import { makeJob, movePlan, readCalendar, readPlans, readResults, recordResult, uploadReport } from './api'
import { designScreen as preventiveScreen } from './fixtures'
import {
  calendarItems,
  chipKey,
  chipMoves,
  chipState,
  chipTarget,
  EMPTY_ADDRESS,
  EMPTY_PLAN,
  KNOWN_REFUSALS,
  listWindow,
  monthWindow,
  moveHeld,
  newResultDraft,
  nextDueOf,
  planBody,
  planHeld,
  preventiveAddressOf,
  preventiveAddressText,
  preventiveCan,
  printAddressOf,
  printOfChosen,
  printWindow,
  printWindowHeld,
  problemOf,
  reminderFrom,
  reportState,
  resultBody,
  resultHeld,
  sectionsOfChange,
  tileChange,
  tilesOf,
  withAddress,
  withOutcome,
  withType,
  type ResultContext,
} from './model'
import { designScreen as printScreen } from './print/fixtures'
import { designScreen as reportScreen } from './report/fixtures'

/**
 * B-W2b-142 — SCR-266 Preventive & statutory checks on B-W2b-124's API: the address, the windows, a chip in words, the
 * tiles, every dialog's held reasons and what it sends (the job and the lock in the same step only when offered and
 * ticked), the API's refusals in our words, the calls as the API takes them, the merge points, and every design case
 * of SCR-266, its register print and its report window in both languages with no key left on screen.
 */

const today = TODAY
const all = preventiveCan(PREVENTIVE_ROLES_DEMO.maintenance)

describe('the address keeps the page’s state; a tile is a filter', () => {
  it('round trip: view, month, filters, every dialog', () => {
    const address = { ...EMPTY_ADDRESS, view: 'list' as const, month: '2026-12', day: '2026-12-03', due: 'OVERDUE' as const, missing: true, outcome: 'FAILED' as const, plan: 'p1', record: 'new', move: 'p2', date: '2026-12-10' }
    const text = preventiveAddressText(address)
    expect(preventiveAddressOf(new URLSearchParams(text.slice(1)))).toEqual(address)
    expect(text).toContain('record=1')
    expect(preventiveAddressOf(new URLSearchParams('month=2026-13&day=2026-02-30&due=SOON&outcome=MAYBE&date=x'))).toEqual(EMPTY_ADDRESS)
    expect(preventiveAddressText(withAddress(EMPTY_ADDRESS, { date: '2026-12-01' }))).toBe('')
  })

  it('the tiles filter the plans (due) or the register (missing); a second press clears', () => {
    expect(tilesOf({ tiles: { OVERDUE: 1, DUE_SOON: 2, REPORTS_MISSING: 3 }, today })).toEqual([
      { id: 'OVERDUE', value: 1 },
      { id: 'DUE_SOON', value: 2 },
      { id: 'REPORTS_MISSING', value: 3 },
    ])
    expect(tilesOf(null).every((tile) => tile.value === null)).toBe(true)
    expect(tileChange('OVERDUE', EMPTY_ADDRESS)).toEqual({ due: 'OVERDUE', ended: false })
    expect(tileChange('OVERDUE', { ...EMPTY_ADDRESS, due: 'OVERDUE' })).toEqual({ due: null, ended: false })
    expect(tileChange('REPORTS_MISSING', EMPTY_ADDRESS)).toEqual({ missing: true })
  })

  it('windows: the month ± 1 within the API’s 400 days; the List 35 days back to a year on; the print three years', () => {
    expect(monthWindow('2026-01')).toEqual({ from: '2025-12-01', to: '2026-02-28' })
    expect(listWindow('2026-11-03')).toEqual({ from: '2026-09-29', to: '2027-11-03' })
    expect(printWindow('2026-11-03', { from: null, to: null })).toEqual({ from: '2023-11-04', to: '2026-11-03' })
    expect(printWindow('2026-11-03', { from: '2025-01-01', to: '2025-12-31' })).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(printWindowHeld('2023-01-01', '2026-01-01')).toBe('print.heldLong')
    expect(printWindowHeld('2023-01-02', '2026-01-01')).toBeNull()
    expect(printWindowHeld('2026-02-01', '2026-01-01')).toBe('print.heldOrder')
  })

  it('Print N: the chosen results and their days', () => {
    const href = printOfChosen(PREFIX, [RESULTS[0]!, RESULTS[1]!])
    expect(href).toBe(`${PREFIX}/plant/preventive/register?from=2026-09-28&to=2026-10-30&ids=${RESULTS[0]!.id}%2C${RESULTS[1]!.id}`)
    expect(printAddressOf(new URL(href, 'http://x').searchParams)).toEqual({ from: '2026-09-28', to: '2026-10-30', ids: [RESULTS[0]!.id, RESULTS[1]!.id] })
    expect(printOfChosen(PREFIX, [])).toBe(`${PREFIX}/plant/preventive/register`)
  })
})

describe('the calendar: a chip in words, where it opens, what moves', () => {
  it('only a next due date moves; done opens its result, due and later open the plan', () => {
    const [done, due, projected] = CHIPS as [typeof CHIPS[number], typeof CHIPS[number], typeof CHIPS[number]]
    expect(chipMoves(due)).toBe(true)
    expect(chipMoves(projected)).toBe(false)
    expect(chipMoves(done)).toBe(false)
    expect(chipTarget(done)).toEqual({ result: RESULT_IDS.lifting, plan: null })
    expect(chipTarget(projected)).toEqual({ plan: GUARDS_PLAN.id, result: null })
    expect(chipState(done)).toBe('DONE')
    expect(chipState(due)).toBe('OVERDUE')
    expect(new Set(CHIPS.map(chipKey)).size).toBe(CHIPS.length)
  })

  it('items carry the check, the machine, the later-check, outcome, body and lock words; the site only with All sites', () => {
    const say = (key: string, params?: Readonly<Record<string, string | number>>) => `${key}${params ? JSON.stringify(params) : ''}`
    const items = calendarItems(CHIPS, 'en', say, false)
    expect(items[1]).toMatchObject({ title: 'Press guards and two-hand controls · DEMO-CP-01', state: 'OVERDUE', site: null })
    expect(items[2]!.meta).toContain('chip.projected')
    expect(items[0]!.meta).toContain('outcome.FAILED')
    expect(items[0]!.meta).toContain(`chip.body{"body":"${BODY.name}"}`)
    expect(calendarItems(CHIPS, 'it', say, true)[1]!.title).toBe('Ripari e comandi a due mani della pressa · DEMO-CP-01')
    expect(calendarItems(CHIPS, 'it', say, true)[1]!.site).toBe('Stabilimento Demo Nord')
  })

  it('a drop on a day cell names its day; anything else none', () => {
    const cell = { dataset: { calDate: '2026-11-27' } }
    const target = { closest: (selector: string) => (selector === '[data-cal-date]' ? cell : null) }
    expect(dropDayOf(target as unknown as EventTarget)).toBe('2026-11-27')
    expect(dropDayOf({ closest: () => null } as unknown as EventTarget)).toBeNull()
    expect(dropDayOf(null)).toBeNull()
  })
})

describe('New plan', () => {
  it('held until machine, type, a valid interval, first due and a lead time; a type brings its default interval', () => {
    expect(planHeld(EMPTY_PLAN)).toBe('held.machine')
    const typed = withType({ ...EMPTY_PLAN, machineId: PRESS.id }, GUARDS)
    expect(typed).toMatchObject({ checkTypeId: GUARDS.id, interval: '1', intervalUnit: 'MONTH' })
    expect(planHeld(typed)).toBe('held.firstDue')
    expect(planHeld({ ...typed, interval: '121' })).toBe('held.interval')
    expect(planHeld({ ...typed, firstDueOn: '2026-12-01', reminderDays: '400' })).toBe('held.reminder')
    expect(planHeld({ ...typed, firstDueOn: '2026-12-01', replace: true })).toBe('held.replaceReason')
    expect(planHeld({ ...typed, firstDueOn: '2026-12-01' })).toBeNull()
    expect(reminderFrom('2026-12-01', '30')).toBe('2026-11-01')
  })

  it('sends the plan; replace ends the active one in the same step with its reason', () => {
    const draft = { ...withType({ ...EMPTY_PLAN, machineId: PRESS.id }, GUARDS), firstDueOn: '2026-12-01', outsideBodyPartyId: BODY.id, ownerId: 'u1', note: '  ' }
    expect(planBody(draft)).toEqual({ machineId: PRESS.id, checkTypeId: GUARDS.id, interval: 1, intervalUnit: 'MONTH', outsideBodyPartyId: BODY.id, ownerId: 'u1', firstDueOn: '2026-12-01', reminderDays: 30 })
    expect(planBody({ ...draft, replace: true, replaceReason: ' monthly now ' })).toMatchObject({ replaceReason: 'monthly now' })
  })
})

describe('Record a check result: one step with the job and the lock', () => {
  const onPlan: ResultContext = { planId: LIFTING_PLAN.id, correctsId: null, machineLocked: false, can: all }
  const failed = { ...withOutcome(newResultDraft(today, LIFTING_PLAN), 'FAILED'), remarks: 'chain worn' }

  it('a failed check ticks the job; a pass drops both; remarks unless passed; never a future day', () => {
    expect(failed).toMatchObject({ makeJob: true, lock: false, performedBy: BODY.name, outsideBodyPartyId: BODY.id })
    expect(withOutcome({ ...failed, lock: true }, 'PASSED')).toMatchObject({ makeJob: false, lock: false })
    expect(withOutcome({ ...failed, lock: true }, 'PASSED_WITH_REMARKS')).toMatchObject({ lock: false })
    expect(resultHeld({ ...failed, remarks: '' }, onPlan, today)).toBe('held.remarksFailed')
    expect(resultHeld({ ...failed, performedOn: '2026-11-04' }, onPlan, today)).toBe('held.future')
    expect(resultHeld({ ...failed, nextDueOn: today }, onPlan, today)).toBe('held.nextDue')
    expect(resultHeld(failed, onPlan, today)).toBeNull()
  })

  it('each offer missing its right is held and says which; a lock on a locked machine is refused before the call', () => {
    const checksOnly = preventiveCan(PREVENTIVE_ROLES_DEMO.checksOnly)
    expect(resultHeld(failed, { ...onPlan, can: checksOnly }, today)).toBe('held.jobRight')
    expect(resultHeld({ ...failed, makeJob: false, lock: true }, { ...onPlan, can: checksOnly }, today)).toBe('held.lockRight')
    expect(resultHeld({ ...failed, lock: true }, { ...onPlan, machineLocked: true }, today)).toBe('refusal.LOCKED_ALREADY')
    expect(resultHeld(failed, { ...onPlan, can: preventiveCan(PREVENTIVE_ROLES_DEMO.readOnly) }, today)).toBe('held.manage')
    expect(resultHeld(newResultDraft(today), { ...onPlan, planId: null }, today)).toBe('held.machine')
  })

  it('sends the job and the lock only when offered and ticked; a correction names what it corrects', () => {
    expect(resultBody({ ...failed, lock: true, lockNote: ' look at the chain ' }, onPlan)).toEqual({
      planId: LIFTING_PLAN.id,
      performedOn: today,
      outcome: 'FAILED',
      remarks: 'chain worn',
      performedBy: BODY.name,
      outsideBodyPartyId: BODY.id,
      nextDueOn: null,
      job: {},
      lock: { note: 'look at the chain' },
    })
    expect(resultBody({ ...failed, lock: true }, { ...onPlan, machineLocked: true })).not.toHaveProperty('lock')
    expect(resultBody(withOutcome(failed, 'PASSED'), onPlan)).not.toHaveProperty('job')
    const correction = resultBody({ ...withOutcome(newResultDraft(today), 'PASSED'), machineId: PRESS.id, checkTypeId: GUARDS.id, performedBy: 'Manutenzione', correctionReason: 'wrong day' }, { planId: null, correctsId: RESULT_IDS.guards, machineLocked: false })
    expect(correction).toMatchObject({ machineId: PRESS.id, checkTypeId: GUARDS.id, correctsId: RESULT_IDS.guards, correctionReason: 'wrong day' })
    expect(correction).not.toHaveProperty('planId')
  })

  it('the next due date: the one typed, else the day plus the plan’s interval, never before its first', () => {
    expect(nextDueOf({ performedOn: '2026-11-03', nextDueOn: '' }, GUARDS_PLAN)).toBe('2026-12-03')
    expect(nextDueOf({ performedOn: '2026-11-03', nextDueOn: '2026-12-15' }, GUARDS_PLAN)).toBe('2026-12-15')
    expect(nextDueOf({ performedOn: '2020-01-01', nextDueOn: '' }, GUARDS_PLAN)).toBe(GUARDS_PLAN.firstDueOn)
    expect(nextDueOf({ performedOn: '2026-11-03', nextDueOn: '' }, null)).toBeNull()
  })

  it('a report in words: on file, missing while in force, kept by the result it corrects', () => {
    expect(RESULTS.map(reportState)).toEqual(['missing', 'onFile', 'onFile', 'byCorrected', 'onFile', 'missing'])
  })
})

describe('Move a check', () => {
  it('held: a new day, never before the first due date, not the day it has, with a reason; an ended plan never', () => {
    expect(moveHeld({ nextDueOn: '', reason: 'x' }, [VESSEL_PLAN])).toBe('held.newDate')
    expect(moveHeld({ nextDueOn: '2024-01-01', reason: 'x' }, [VESSEL_PLAN])).toBe('refusal.BEFORE_FIRST_DUE')
    expect(moveHeld({ nextDueOn: VESSEL_PLAN.nextDueOn, reason: 'x' }, [VESSEL_PLAN])).toBe('refusal.SAME_DATE')
    expect(moveHeld({ nextDueOn: '2026-11-27', reason: ' ' }, [VESSEL_PLAN])).toBe('held.reason')
    expect(moveHeld({ nextDueOn: '2026-11-27', reason: 'visit moved' }, [VESSEL_PLAN, ENDED_PLAN])).toBe('refusal.PLAN_ENDED')
    expect(moveHeld({ nextDueOn: '2026-11-27', reason: 'visit moved' }, [VESSEL_PLAN, GUARDS_PLAN])).toBeNull()
    expect(moveHeld({ nextDueOn: '2026-11-27', reason: 'visit moved' }, [])).toBe('held.reading')
  })
})

describe('the API’s answers in our words', () => {
  const refused = (code: string, path = `refusal/${code}`) => new ApiError('conflict', 409, 'refused', 'English', null, [{ path, message: 'English' }])

  it('every statutory refusal by its code; a refusal of another kind is "refused", never "changed meanwhile"', () => {
    for (const code of STATUTORY_REFUSALS) expect(problemOf(refused(code)).key).toBe(`refusal.${code}`)
    expect(problemOf(refused('H1_HELD')).key).toBe('refusal.H1_HELD')
    expect(problemOf(refused('SOMETHING_NEW')).key).toBe('problem.refused')
    expect(problemOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/performedOn', message: 'x' }]))).toEqual({ key: 'problem.field', field: 'performedOn' })
    expect(problemOf(new Error('lost')).unknown).toBe(true)
  })

  it('every refusal and every held reason the page names has its words in Italian and English', () => {
    for (const locale of LOCALES) {
      const dictionary = messagesFor(locale, ['plant-preventive'])['plant-preventive'] as Record<string, unknown>
      // A catalogue is flat (`refusal.PLAN_EXISTS`) once loaded; read it nested too, in case.
      const words = (key: string) => dictionary[key] ?? key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), dictionary)
      for (const code of KNOWN_REFUSALS) expect(words(`refusal.${code}`), `${locale} refusal.${code}`).toBeTypeOf('string')
    }
  })

  it('live: a check recorded reads the register, the plans, the calendar and the tiles; a job of a check the register', () => {
    expect(sectionsOfChange({ type: 'machine_check.recorded' })).toEqual(['register', 'plans', 'calendar', 'counts'])
    expect(sectionsOfChange({ type: 'machine_check.due' })).toEqual(['plans', 'calendar', 'counts'])
    expect(sectionsOfChange({ type: 'maintenance_job.created' })).toEqual(['register'])
    expect(sectionsOfChange({ type: 'sales_order.changed' })).toEqual([])
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

describe('the calls as the API takes them', () => {
  it('reads: the calendar window, the plans with their filters, the register with its tile', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { from: '2026-10-01', to: '2026-12-31', today, chips: CHIPS, canManage: true } },
      { status: 200, body: { plans: PLANS, nextCursor: null, today } },
      { status: 200, body: { results: RESULTS, nextCursor: '2025-03-15|x', today, from: null, to: null } },
    ])
    expect((await readCalendar(api, { from: '2026-10-01', to: '2026-12-31', siteId: 's1' })).chips).toHaveLength(CHIPS.length)
    expect(calls[0]!.url).toBe('/api/plant/checks/calendar?from=2026-10-01&to=2026-12-31&siteId=s1')
    await readPlans(api, { siteId: null, status: 'ACTIVE', due: 'OVERDUE' })
    expect(calls[1]!.url).toBe('/api/plant/checks/plans?status=ACTIVE&due=OVERDUE&limit=100')
    expect((await readResults(api, { siteId: 's1', reportMissing: true })).nextCursor).toBe('2025-03-15|x')
    expect(calls[2]!.url).toBe('/api/plant/checks/results?siteId=s1&reportMissing=true&limit=100')
  })

  it('writes carry an Idempotency-Key; a move its version read; the result its job and lock in one call', async () => {
    const step = { result: RESULTS[0], plan: LIFTING_PLAN, job: { id: 'j1', number: 'MJ-D-0012' }, lock: { id: 'r1' }, machine: { id: LIFTING_PLAN.machine.id, status: 'DO_NOT_USE', locked: true }, replayed: false }
    const { api, calls } = mockApi([
      { status: 201, body: step },
      { status: 200, body: { plan: VESSEL_PLAN, replayed: false } },
      { status: 201, body: { ...step, lock: null } },
    ])
    const answer = await recordResult(api, { planId: LIFTING_PLAN.id, performedOn: today, outcome: 'FAILED', remarks: 'x', performedBy: BODY.name, outsideBodyPartyId: null, nextDueOn: null, job: {}, lock: {} }, 'k-record')
    expect(answer.job?.number).toBe('MJ-D-0012')
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/plant/checks/results', body: { planId: LIFTING_PLAN.id, job: {}, lock: {} } })
    expect(calls[0]!.headers.get('idempotency-key')).toBe('k-record')
    await movePlan(api, VESSEL_PLAN.id, { version: 3, nextDueOn: '2026-11-27', reason: 'visit moved' }, 'k-move')
    expect(calls[1]).toMatchObject({ url: `/api/plant/checks/plans/${VESSEL_PLAN.id}/move`, body: { version: 3, nextDueOn: '2026-11-27', reason: 'visit moved' } })
    await makeJob(api, RESULT_IDS.vessel, 'k-job')
    expect(calls[2]!.url).toBe(`/api/plant/checks/results/${RESULT_IDS.vessel}/job`)
    for (const call of calls) expect(call.headers.get('x-csrf-token'), call.url).toBe('csrf-demo')
  })

  it('a report: announce on the result (DOCUMENT for a PDF) → the store → complete, each with its key', async () => {
    const put = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', put)
    const presigned = { method: 'PUT', url: 'https://store.example.com/up', headers: {}, expiresAt: '2026-11-03T09:00:00.000Z' }
    const { api, calls } = mockApi([
      { status: 201, body: { file: { id: 'f1' }, upload: presigned } },
      { status: 200, body: { file: { id: 'f1' } } },
    ])
    let n = 0
    const id = await uploadReport(api, RESULT_IDS.lifting, new File(['%PDF-1.4'], 'verbale.pdf', { type: 'application/pdf' }), () => `k${++n}`)
    expect(id).toBe('f1')
    expect(calls[0]).toMatchObject({ url: `/api/plant/checks/results/${RESULT_IDS.lifting}/reports`, body: { kind: 'DOCUMENT', originalName: 'verbale.pdf', contentType: 'application/pdf', sizeBytes: 8 } })
    expect(put).toHaveBeenCalledTimes(1)
    expect(calls[1]!.url).toBe(`/api/plant/checks/results/${RESULT_IDS.lifting}/reports/f1/complete`)
    expect(calls.map((call) => call.headers.get('idempotency-key'))).toEqual(['k1', 'k2'])
  })
})

describe('the page in the Office: its row, its records, its new tabs', () => {
  it('a built page with two window pages; a plant.view holder sees its row under Maintenance', () => {
    for (const page of ['/plant/preventive', '/plant/preventive/register', '/plant/preventive/report']) expect(OFFICE_PAGES.has(page), page).toBe(true)
    expect(WINDOW_PAGES.has('/plant/preventive/register') && WINDOW_PAGES.has('/plant/preventive/report')).toBe(true)
    const plant = officeNavFor(permissionCheck([...PREVENTIVE_ROLES_DEMO.maintenance])).areas.find((area) => area.id === 'plant')
    expect(plant?.sections?.find((section) => section.id === 'plant-maintenance')?.items.map((item) => item.id)).toContain('plant-preventive')
    expect(officeNavFor(permissionCheck([...PREVENTIVE_ROLES_DEMO.sales])).areas.find((area) => area.id === 'plant')).toBeUndefined()
  })

  it('a plan and a result open in their windows; the API’s lists open the page', () => {
    expect(recordAddress({ type: 'MachineCheckPlan', id: 'p1' }, OFFICE_PAGES)).toBe('/plant/preventive?plan=p1')
    expect(recordAddress({ type: 'MachineCheckResult', id: 'r1' }, OFFICE_PAGES)).toBe('/plant/preventive?result=r1')
    expect(listAddress('/plant/checks/results', { missing: '1' }, OFFICE_PAGES)).toBe('/plant/preventive?missing=1')
  })
})

const GROUPS = 'access|band|tile|calendar|chip|chipKind|state|due|plans|kind|col|interval|unit|lastDone|body|owner|site|law|outcome|outcomeHint|register|report|reportLong|nextDue|list|facts|plan|result|lock|move|bulk|done|held|refusal|problem|print|keys|common'
const LEFT_KEY = new RegExp(`\\b(?:${GROUPS})\\.[a-zA-Z_]+(?:\\.[a-zA-Z_]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("Needs plant.checks.manage"); file names, domains and the demo's law are not keys. */
const SAID = /\b(?:plant\.[a-zA-Z.]+|parties\.view|files\.read|views\.export|[a-z0-9-]+\.pdf|example\.com|art\. \d+|c\. \d+)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [preventiveScreen, printScreen, reportScreen] as unknown as DesignScreen<unknown>[]) {
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
