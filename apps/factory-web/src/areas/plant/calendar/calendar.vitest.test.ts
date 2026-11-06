import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { DEADLINE_KINDS, DEADLINE_REFUSALS, ITEM_STATES, KNOWN_CALENDAR_KINDS } from '@nexus/factory-domain/safety/calendar/rules'
import { ORGANISATION_REFUSALS, SAFETY_ROLES } from '@nexus/factory-domain/safety/organisation/rules'
import { createApiClient } from '../../../lib/api/client'
import { ApiError, networkError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor, WINDOW_PAGES } from '../../../shell/nav/office-nav'
import { officeArea } from '../nav'
import { APPOINTMENTS, ENDED, FILED, ITEMS, MEETING_DONE, organisation, PENDING, PLACES, SITE_N, SITE_S, TODAY } from './_demo/fixtures'
import { createAppointment, fileKindFor, readCalendar, type CalendarItem } from './api'
import { designScreen } from './fixtures'
import {
  appointmentBody,
  appointmentHeld,
  appointmentSelectHeld,
  calendarAddressOf,
  calendarAddressText,
  calendarCan,
  chartGroups,
  deadlineBody,
  deadlineEdit,
  deadlineHeld,
  doneHeld,
  doneRefusedFirst,
  draftOfDeadline,
  EMPTY_DEADLINE,
  endHeld,
  evidenceKey,
  filingHeld,
  itemSelectHeld,
  itemWords,
  listRows,
  listWindow,
  missingPlaces,
  monthGroups,
  monthWindow,
  newAppointmentDraft,
  noticeLists,
  noticeToConfirm,
  openTargetOf,
  printWindow,
  problemOf,
  readProblemOf,
  sectionsOfChange,
  signHeld,
  tilesOf,
} from './model'
import { designScreen as orgPrintScreen } from './organisation/fixtures'
import { designScreen as calPrintScreen } from './print/fixtures'

/**
 * B-W2b-120 — SCR-267 Safety calendar: the pure rules (address, windows, sentences per kind, where an item opens, holds,
 * bodies, refusals), the calls' shape, the navigation, the words (every key in it and en) and every design case drawn in
 * both languages with no key or placeholder left on screen.
 */

const item = (key: string): CalendarItem => ITEMS.find((entry) => entry.key.startsWith(key))!

describe('safety calendar: the address', () => {
  it('round-trips every term; a tile means the List; a role and a site only for a new appointment', () => {
    const address = calendarAddressOf(new URLSearchParams('view=list&month=2026-11&day=2026-11-03&from=2026-10-01&to=2026-12-31&ended=1&open=DEADLINE:d1&new=1&filing=n1'))
    expect(address).toMatchObject({ view: 'list', month: '2026-11', day: '2026-11-03', from: '2026-10-01', to: '2026-12-31', ended: true, open: 'DEADLINE:d1', newDeadline: true, filing: 'n1' })
    expect(calendarAddressOf(new URLSearchParams(calendarAddressText(address).slice(1)))).toEqual(address)
    expect(calendarAddressOf(new URLSearchParams('tile=overdue'))).toMatchObject({ view: 'list', tile: 'overdue' })
    expect(calendarAddressText(calendarAddressOf(new URLSearchParams('tile=dueSoon&view=list')))).toBe('?tile=dueSoon')
    expect(calendarAddressOf(new URLSearchParams('appoint=new&role=RLS&at=s1'))).toMatchObject({ appoint: 'new', role: 'RLS', at: 's1' })
    expect(calendarAddressOf(new URLSearchParams('appoint=a1&role=RLS&at=s1'))).toMatchObject({ appoint: 'a1', role: null, at: null })
    expect(calendarAddressOf(new URLSearchParams('month=2026-13&day=2026-02-30&tile=nope&role=NOPE&appoint=new'))).toMatchObject({ view: 'month', month: null, day: null, tile: null, role: null })
    expect(calendarAddressText(calendarAddressOf(null))).toBe('')
  })

  it('the Month reads its month and one each side; the List 35 days back to a year on (400 days); the print this month and 11 more', () => {
    expect(monthWindow('2026-11')).toEqual({ from: '2026-10-01', to: '2026-12-31' })
    expect(monthWindow('2027-01')).toEqual({ from: '2026-12-01', to: '2027-02-28' })
    expect(listWindow(TODAY, { from: null, to: null })).toEqual({ from: '2026-09-29', to: '2027-11-03' })
    expect(listWindow(TODAY, { from: '2026-01-01', to: '2026-03-31' })).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    // Longer than the API's 400 days: the default instead.
    expect(listWindow(TODAY, { from: '2025-01-01', to: '2026-12-31' })).toEqual({ from: '2026-09-29', to: '2027-11-03' })
    expect(printWindow(TODAY, { from: null, to: null })).toEqual({ from: '2026-11-01', to: '2027-10-31' })
  })
})

describe('safety calendar: an item in words', () => {
  it('each kind composes its own sentence from data words; a health visit is a count, never a name', () => {
    expect(itemWords(item('DEADLINE:'), 'en')).toEqual({ key: 'item.DEADLINE', params: { title: 'Prova di evacuazione semestrale' }, sub: { type: 'deadlineKind.DRILL' } })
    expect(itemWords(item('MACHINE_CHECK'), 'it')).toEqual({ key: 'item.MACHINE_CHECK', params: { check: 'Verifica periodica del carrello elevatore', machine: 'DEMO-FLT-01 Carrello elevatore' } })
    expect(itemWords(item('MACHINE_CHECK'), 'en').params?.check).toBe('Periodic forklift inspection')
    expect(itemWords(item('HEALTH_VISIT'), 'en')).toEqual({ key: 'item.HEALTH_VISIT', params: { count: 6 } })
    expect(itemWords(item('TRAINING_REFRESHER'), 'en')).toEqual({ key: 'item.TRAINING_REFRESHER', params: { course: 'Formazione specifica, rischio medio', count: 4 } })
    expect(itemWords(item('APPOINTMENT_END'), 'en')).toEqual({ key: 'item.APPOINTMENT_END', params: { person: 'Luca Demo' }, sub: { role: 'role.FIRST_AID' } })
    expect(itemWords(item('INAIL_REPORT'), 'en')).toEqual({ key: 'item.INAIL_REPORT', params: { incident: 'INC-D-0007', count: 1 } })
    expect(itemWords({ kind: 'DVR_REVIEW', params: {}, count: null }, 'en')).toEqual({ key: 'item.DVR_REVIEW_plain' })
  })

  it('a kind a later step adds still reads: "Deadline" with its title, never a raw code; missing data words say —', () => {
    expect(itemWords(item('SDS_REVIEW'), 'en')).toEqual({ key: 'item.other', params: { title: 'Schede di sicurezza dei collanti' } })
    expect(itemWords({ kind: 'NEW_KIND', params: {}, count: null }, 'en')).toEqual({ key: 'item.otherPlain' })
    expect(itemWords({ kind: 'RLS_NOTICE', params: { role: 'NOPE' }, count: null }, 'en')).toEqual({ key: 'item.RLS_NOTICE', params: { person: '—' }, sub: { role: 'role.unknown' } })
    expect(itemWords({ kind: 'DEADLINE', params: { title: 'X', kind: 'LATER' }, count: null }, 'en').sub).toEqual({ type: 'deadlineKind.OTHER' })
  })

  it('evidence in words', () => {
    expect(evidenceKey(null)).toBe('evidence.source')
    expect(evidenceKey({ required: true, onFile: false })).toBe('evidence.missing')
    expect(evidenceKey({ required: false, onFile: true })).toBe('evidence.onFile')
    expect(evidenceKey({ required: false, onFile: false })).toBe('evidence.notAsked')
  })
})

describe('safety calendar: where an item opens', () => {
  it('a typed deadline, an appointment ending and an RLS notice open here', () => {
    expect(openTargetOf(item('DEADLINE:'), OFFICE_PAGES)).toEqual({ kind: 'deadline', id: item('DEADLINE:').recordId })
    expect(openTargetOf(item('APPOINTMENT_END'), OFFICE_PAGES)).toEqual({ kind: 'appointment', id: item('APPOINTMENT_END').recordId })
    expect(openTargetOf(item('RLS_NOTICE'), OFFICE_PAGES)).toEqual({ kind: 'filing', id: item('RLS_NOTICE').recordId })
  })

  it('a built page opens (Skills, Preventive); a page not built says where it is kept, with its machine when that has a page', () => {
    expect(openTargetOf(item('TRAINING_REFRESHER'), OFFICE_PAGES)).toEqual({ kind: 'link', href: '/people/skills', page: 'people.skills' })
    // B-W2b-144 built Risk assessment: the DVR review opens there; without that page it says where it is kept.
    expect(openTargetOf(item('DVR_REVIEW'), OFFICE_PAGES)).toEqual({ kind: 'link', href: '/plant/risk', page: 'plant.risk' })
    expect(openTargetOf(item('DVR_REVIEW'), new Set([...OFFICE_PAGES].filter((page) => !page.startsWith('/plant/risk'))))).toEqual({ kind: 'kept', page: 'plant.risk', parentHref: null, parentType: null })
    // B-W2b-142 built Preventive & statutory checks: a machine check opens its plan's window there by itself.
    expect(openTargetOf(item('MACHINE_CHECK'), OFFICE_PAGES)).toMatchObject({ kind: 'link', href: `/plant/preventive?plan=${item('MACHINE_CHECK').source.recordId}`, page: 'plant.preventive' })
    // Without that page (an older build), it said where it is kept, with its machine.
    const pages = new Set([...OFFICE_PAGES].filter((page) => !page.startsWith('/plant/preventive')))
    const check = openTargetOf(item('MACHINE_CHECK'), pages)
    expect(check).toMatchObject({ kind: 'kept', page: 'plant.preventive', parentType: 'Machine' })
    expect(check.kind === 'kept' && check.parentHref).toMatch(/^\/plant\/machines\//)
  })

  it('only an open deadline typed here that the person keeps may be chosen; evidence asked and missing stays', () => {
    expect(itemSelectHeld(item('DEADLINE:'))).toBeNull()
    expect(itemSelectHeld(item('MACHINE_CHECK'))).toBe('held.select.source')
    expect(itemSelectHeld({ kind: 'DEADLINE', editable: true, state: 'DONE' })).toBe('held.select.closed')
    expect(itemSelectHeld({ kind: 'DEADLINE', editable: false, state: 'OVERDUE' })).toBe('held.select.notYours')
    expect(doneRefusedFirst(item('DEADLINE:'))).toBe(true)
    expect(doneRefusedFirst({ evidence: { required: true, onFile: true } })).toBe(false)
  })

  it('the List: by due day, a tile filters by state', () => {
    expect(listRows(ITEMS, 'overdue').map((entry) => entry.state)).toEqual(['OVERDUE', 'OVERDUE'])
    expect(listRows(ITEMS, null).map((entry) => entry.dueOn)).toEqual([...ITEMS.map((entry) => entry.dueOn)].sort())
    expect(monthGroups(ITEMS).map((group) => group.month)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01'])
  })

  it('the tiles; the live messages that move each section', () => {
    expect(tilesOf(null).map((tile) => tile.value)).toEqual([null, null, null, null])
    expect(sectionsOfChange({ type: 'safety_appointment.changed' })).toEqual(['organisation', 'notices', 'counts', 'calendar'])
    expect(sectionsOfChange({ type: 'safety_deadline.changed' })).toEqual(['calendar', 'counts'])
    expect(sectionsOfChange({ type: 'machine_check_plan.changed' })).toEqual(['calendar', 'counts'])
    expect(sectionsOfChange({ type: 'training_record.changed' })).toEqual(['calendar', 'counts'])
    expect(sectionsOfChange({ type: 'order.changed' })).toEqual([])
  })
})

describe('safety calendar: the dialogs hold and send', () => {
  it('Add deadline: a title and a day; a repeat of 1–120; the site from the top bar', () => {
    expect(deadlineHeld(EMPTY_DEADLINE)).toBe('held.title')
    expect(deadlineHeld({ ...EMPTY_DEADLINE, title: 'Prova' })).toBe('held.due')
    expect(deadlineHeld({ ...EMPTY_DEADLINE, title: 'Prova', dueOn: '2026-12-01', repeat: 'MONTH', every: '0' })).toBe('held.every')
    expect(deadlineHeld({ ...EMPTY_DEADLINE, title: 'Prova', dueOn: '2026-12-01' }, true)).toBe('held.saving')
    const draft = { ...EMPTY_DEADLINE, title: ' Prova ', dueOn: '2026-12-01', repeat: 'MONTH' as const, every: '6', ownerId: 'o1', evidenceRequired: true }
    expect(deadlineBody(draft, 'c1', 's1')).toEqual({ companyId: 'c1', siteId: 's1', title: 'Prova', kind: 'DRILL', dueOn: '2026-12-01', repeatEvery: 6, repeatUnit: 'MONTH', ownerId: 'o1', evidenceRequired: true })
    expect(deadlineBody({ ...draft, repeat: 'none' }, 'c1', null)).toMatchObject({ siteId: null, repeatEvery: null, repeatUnit: null })
  })

  it('Edit sends only what changed, at the version read', () => {
    const deadline = MEETING_DONE
    expect(deadlineEdit(deadline, draftOfDeadline(deadline))).toBeNull()
    expect(deadlineEdit(deadline, { ...draftOfDeadline(deadline), dueOn: '2026-11-20', repeat: 'none' })).toEqual({ version: deadline.version, dueOn: '2026-11-20', repeatEvery: null, repeatUnit: null })
  })

  it('Mark done is held while evidence is asked and none is on file, and for a closed deadline', () => {
    const open = { status: 'OPEN' as const, evidenceRequired: true, evidence: [], canManage: true }
    expect(doneHeld(open)).toBe('held.evidenceFirst')
    expect(doneHeld({ ...open, evidence: [{ fileId: 'f', name: 'a.pdf', kind: 'ATTACHMENT', at: '' }] })).toBeNull()
    expect(doneHeld({ ...open, status: 'DONE' })).toBe('held.doneAlready')
    expect(doneHeld({ ...open, canManage: false })).toBe('held.calendar')
  })

  it('Appointment: an RLS is a person, an RLST an outside contact; the notice due or filed; a shift only for a team', () => {
    const rls = { ...newAppointmentDraft('RLS', null, TODAY), employeeId: 'e1' }
    expect(appointmentHeld({ ...rls, who: 'outside', outsideName: 'X' }, TODAY)).toBe('refusal.RLS_IS_EMPLOYEE')
    expect(appointmentHeld({ ...newAppointmentDraft('RLST', null, TODAY), who: 'person', employeeId: 'e1' }, TODAY)).toBe('refusal.RLST_IS_OUTSIDE')
    expect(newAppointmentDraft('RLST', null, TODAY).who).toBe('outside')
    expect(appointmentHeld(rls, TODAY)).toBeNull()
    expect(appointmentBody(rls, 'c1')).toEqual({ companyId: 'c1', siteId: null, role: 'RLS', employeeId: 'e1', fromDate: TODAY })
    expect(appointmentBody({ ...rls, noticeDueOn: '2026-11-20' }, 'c1')).toMatchObject({ noticeDueOn: '2026-11-20' })
    const filed = { ...rls, notice: 'filed' as const, filedOn: '2026-11-04', reference: 'R-1' }
    expect(appointmentHeld(filed, TODAY)).toBe('refusal.FILED_IN_FUTURE')
    expect(appointmentHeld({ ...filed, filedOn: '2026-11-02' }, TODAY)).toBe('refusal.FILED_BEFORE_APPOINTMENT')
    expect(appointmentBody({ ...filed, filedOn: TODAY }, 'c1')).toMatchObject({ noticeFiled: { filedOn: TODAY, reference: 'R-1' } })
    expect(appointmentBody({ ...newAppointmentDraft('RSPP', null, TODAY), who: 'outside', outsideName: ' Paolo ', contact: 'p1|k1', shiftId: 'x' }, 'c1')).toEqual({ companyId: 'c1', siteId: null, role: 'RSPP', outsideName: 'Paolo', outsidePartyId: 'p1', outsideContactId: 'k1', fromDate: TODAY })
    expect(appointmentBody({ ...newAppointmentDraft('FIRST_AID', 's1', TODAY), employeeId: 'e1', shiftId: 'sh1' }, 'c1')).toMatchObject({ siteId: 's1', shiftPatternId: 'sh1' })
    expect(appointmentHeld({ ...rls, untilDate: '2026-11-01' }, TODAY)).toBe('refusal.ENDS_BEFORE_START')
    expect(appointmentHeld(newAppointmentDraft(null, null, TODAY), TODAY)).toBe('held.role')
  })

  it('Signature: written once; on paper only with the signed letter; End term needs a day and a reason', () => {
    const row = APPOINTMENTS.find((entry) => entry.role === 'SUPERVISOR')!
    expect(signHeld(row, 'OFFICE')).toBeNull()
    expect(signHeld({ ...row, letter: null }, 'PAPER')).toBe('refusal.LETTER_MISSING')
    expect(signHeld(APPOINTMENTS[0]!, 'OFFICE')).toBe('refusal.SIGNED_ALREADY')
    expect(signHeld(ENDED, 'OFFICE')).toBe('refusal.ENDED')
    expect(signHeld({ ...row, canManage: false }, 'OFFICE')).toBe('held.organisation')
    expect(endHeld({ untilDate: '', reason: 'x' }, [row])).toBe('held.untilDate')
    expect(endHeld({ untilDate: '2024-01-01', reason: 'x' }, [row])).toBe('refusal.ENDS_BEFORE_START')
    expect(endHeld({ untilDate: TODAY, reason: ' ' }, [row])).toBe('held.reason')
    expect(endHeld({ untilDate: TODAY, reason: 'Trasferito' }, [row])).toBeNull()
  })

  it('Record RLS notice: filed today or before, not before the appointment, with a reference', () => {
    const draft = { filedOn: TODAY, reference: 'R-1', dueOn: TODAY, cancelReason: '' }
    expect(filingHeld(draft, PENDING, TODAY)).toBeNull()
    expect(filingHeld({ ...draft, filedOn: '2026-11-04' }, PENDING, TODAY)).toBe('refusal.FILED_IN_FUTURE')
    expect(filingHeld({ ...draft, filedOn: '2026-11-01' }, PENDING, TODAY)).toBe('refusal.FILED_BEFORE_APPOINTMENT')
    expect(filingHeld({ ...draft, reference: ' ' }, PENDING, TODAY)).toBe('held.reference')
    expect(filingHeld(draft, FILED, TODAY)).toBe('refusal.NOTICE_NOT_PENDING')
    expect(noticeToConfirm(PENDING)).toBe(true)
    expect(noticeToConfirm({ ...PENDING, dueOn: '2026-11-20' })).toBe(false)
    expect(noticeLists([FILED, PENDING])).toEqual({ pending: [PENDING], filed: [FILED] })
  })

  it('the organisation: who may be chosen, who nobody holds, the chart for the notice board', () => {
    expect(appointmentSelectHeld(APPOINTMENTS[0]!, TODAY)).toBeNull()
    expect(appointmentSelectHeld(ENDED, TODAY)).toBe('held.select.ended')
    expect(appointmentSelectHeld({ ...APPOINTMENTS[0]!, canManage: false }, TODAY)).toBe('held.select.organisation')
    expect(appointmentSelectHeld({ ...APPOINTMENTS[0]!, inForce: false }, TODAY)).toBe('held.select.later')
    const slots = missingPlaces(organisation().missing, PLACES)
    expect(slots.map((slot) => [slot.role, slot.place])).toEqual([
      ['DOCTOR', PLACES[0]!.name],
      ['FIRST_AID', SITE_S.name],
      ['FIRE_EMERGENCY', SITE_S.name],
    ])
    const groups = chartGroups([...APPOINTMENTS, ENDED], TODAY)
    expect(groups.map((group) => group.site)).toEqual([null, SITE_N.name])
    expect(groups.flatMap((group) => group.rows).some((row) => row.id === ENDED.id)).toBe(false)
    expect(groups[0]!.rows.map((row) => row.role)).toEqual(['EMPLOYER', 'RSPP', 'RLS'])
  })
})

describe('safety calendar: the API in our words, and the calls', () => {
  it('a refusal by its code with the field at fault; a 400 names its field; no answer is "not known"', () => {
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/NAME_MISMATCH' }, { path: 'body/signedName' }]))).toEqual({ key: 'refusal.NAME_MISMATCH', field: 'signedName' })
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/EVIDENCE_MISSING' }]))).toEqual({ key: 'refusal.EVIDENCE_MISSING', field: null })
    expect(problemOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/dueOn' }]))).toEqual({ key: 'problem.field', field: 'dueOn' })
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'problem.conflict', field: null })
    expect(problemOf(networkError(new Error('down')))).toEqual({ key: 'problem.noAnswer', field: null, unknown: true })
    expect(readProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('problem.forbidden')
    expect(readProblemOf(new Error('x'))).toBe('problem.read')
  })

  it('the calls: the List asks with `late`; a new appointment sends its body with its own key; a letter scan is an attachment', async () => {
    const sent: { url: string; method: string; body: unknown; key: string | null }[] = []
    const fetcher = async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, key: new Headers(init.headers).get('idempotency-key') })
      const answer = url.includes('/safety/calendar') ? { items: [], from: '2026-09-29', to: '2027-11-03', today: TODAY, failed: ['MACHINE_CHECK'], canManage: true, canUpload: true } : { appointment: APPOINTMENTS[2], notice: PENDING }
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const api = createApiClient({ baseUrl: '/api', fetch: fetcher as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' })
    const calendar = await readCalendar(api, { from: '2026-09-29', to: '2027-11-03', siteId: 's1', late: true })
    expect(calendar.failed).toEqual(['MACHINE_CHECK'])
    expect(sent[0]!.url).toContain('/api/safety/calendar?')
    expect(sent[0]!.url).toContain('late=true')
    expect(sent[0]!.url).toContain('siteId=s1')
    const made = await createAppointment(api, { companyId: 'c1', siteId: null, role: 'RLS', employeeId: 'e1', fromDate: TODAY }, 'key-1')
    expect(made.notice?.status).toBe('PENDING')
    expect(sent[1]).toMatchObject({ method: 'POST', body: { companyId: 'c1', siteId: null, role: 'RLS', employeeId: 'e1', fromDate: TODAY }, key: 'key-1' })
    expect(fileKindFor('SafetyAppointment', 'application/pdf')).toBe('DOCUMENT')
    expect(fileKindFor('RlsNotice', 'image/jpeg')).toBe('ATTACHMENT')
    expect(fileKindFor('SafetyDeadline', 'application/pdf')).toBe('ATTACHMENT')
  })
})

describe('safety calendar: navigation and who sees it', () => {
  it('Plant › Health & safety › Safety calendar asks safety.view; the prints are window pages; records open on the page', () => {
    const section = officeArea.area.sections?.find((entry) => entry.id === 'plant-safety')
    // B-W2b-143 + B-W2b-149: Chemicals & waste and Incidents join the section (the design's order: Incidents, Chemicals, the calendar).
    expect(section?.items.map((row) => [row.href, row.permission])).toEqual(expect.arrayContaining([['/plant/calendar', 'safety.view']]))
    expect(officeArea.area.sections?.map((entry) => entry.id)).toEqual(['plant-maintenance', 'plant-safety', 'plant-settings'])
    for (const page of ['/plant/calendar', '/plant/calendar/organisation', '/plant/calendar/print']) expect(OFFICE_PAGES.has(page), page).toBe(true)
    for (const page of ['/plant/calendar/organisation', '/plant/calendar/print']) expect(WINDOW_PAGES.has(page), page).toBe(true)
    expect(recordAddress({ type: 'SafetyDeadline', id: 'd1' }, OFFICE_PAGES)).toBe('/plant/calendar?open=DEADLINE:d1')
    expect(recordAddress({ type: 'SafetyAppointment', id: 'a1' }, OFFICE_PAGES)).toBe('/plant/calendar?appoint=a1')
    expect(recordAddress({ type: 'RlsNotice', id: 'n1' }, OFFICE_PAGES)).toBe('/plant/calendar?filing=n1')
    expect(LIST_PAGES['/safety/calendar']).toBe('/plant/calendar')
  })

  it('the safety officer keeps both; HR the organisation; the doctor and read-only look; sales sees no row', () => {
    const can = (key: string) => calendarCan(templateOf(key)!.permissions)
    expect(can('safety_officer')).toEqual({ view: true, manageCalendar: true, manageOrganisation: true, upload: true })
    expect(can('hr')).toMatchObject({ view: true, manageCalendar: false, manageOrganisation: true })
    expect(can('company_doctor')).toMatchObject({ view: true, manageCalendar: false, manageOrganisation: false })
    expect(can('read_only')).toMatchObject({ view: true, manageCalendar: false, manageOrganisation: false })
    expect(can('sales').view).toBe(false)
    const rows = (key: string) => officeNavFor(permissionCheck(templateOf(key)!.permissions)).areas.flatMap((area) => (area.sections ?? []).flatMap((entry) => entry.items.map((row) => row.href)))
    expect(rows('safety_officer')).toContain('/plant/calendar')
    expect(rows('sales')).not.toContain('/plant/calendar')
  })
})

// ---- the words and every design case ---------------------------------------------------------------------------------------

const NAMESPACES = ['safety-calendar', 'plant-calendar-view']
const TOP = [...new Set(NAMESPACES.flatMap((ns) => Object.keys(CATALOGUE.en[ns] ?? {}).map((key) => key.split('.')[0]!.replace(/_(one|other)$/, ''))))]
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("safety.calendar.manage"); e-mail domains and file names are not keys. */
const SAID = /\b(?:safety\.[a-zA-Z.]+|files\.upload|[a-z-]+\.example\.com|[\w -]+\.pdf)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('safety calendar: the words', () => {
  it('every key in it and en; every word the page names exists; every role, kind, state and refusal has its words', () => {
    for (const ns of NAMESPACES) expect(Object.keys(CATALOGUE.it[ns] ?? {}).sort(), ns).toEqual(Object.keys(CATALOGUE.en[ns] ?? {}).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.') && !file.includes('fixtures')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...source.matchAll(/'((?:held|refusal|problem|done|item|failed|evidence|page|parent|training|repeat|bulk|kept)\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['safety-calendar'] ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
      for (const role of SAFETY_ROLES) for (const family of ['role', 'roleLaw', 'roleHint']) expect(has(`${family}.${role}`), `${locale} ${family}.${role}`).toBe(true)
      for (const kind of DEADLINE_KINDS) expect(has(`deadlineKind.${kind}`), `${locale} ${kind}`).toBe(true)
      for (const state of ITEM_STATES) expect(has(`state.${state}`), `${locale} ${state}`).toBe(true)
      for (const kind of KNOWN_CALENDAR_KINDS) expect(has(`failed.${kind}`), `${locale} failed.${kind}`).toBe(true)
      for (const code of [...ORGANISATION_REFUSALS, ...DEADLINE_REFUSALS]) expect(has(`refusal.${code}`), `${locale} ${code}`).toBe(true)
    }
  })

  for (const screen of [designScreen, orgPrintScreen, calPrintScreen] as unknown as DesignScreen<unknown>[]) {
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

  it('SCR-267 names every state the design asks for', () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['month', 'list', 'all-sites', 'loading', 'error', 'empty', 'failed-source', 'no-permission', 'read-only', 'hr', 'company-doctor', 'add-deadline', 'appoint-rls', 'appoint-open', 'sign-refused', 'filing', 'deadline-evidence', 'deadline-done-next', 'end-terms', 'keys']),
    )
  })
})
