import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { APPOINTMENT_KINDS, APPOINTMENT_STATUSES, FITTING_VERDICTS } from '@nexus/factory-domain/sales/fittings/rules'
import { BODY_ZONES } from '@nexus/factory-domain/sales/measure-link/rules'
import { REVIEW_STATUSES } from '@nexus/factory-domain/sales/mtm/rules'
import { SALES_ORDER_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { QUOTE_STATUSES } from '@nexus/factory-domain/sales/quotes/quotes'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { RECORD_PAGES } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { FORM_POINTS, ME, NOW, PEOPLE, RECORD, RECORD_CONFIRMED, RECORD_OWN, REV2, REV3, RESULT_ALTER, RESULT_TO_ALTER, ROLE_PERMISSIONS, TILES_DATA } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  addressOf,
  addressText,
  appointmentHeld,
  bookBodyOf,
  bookDraftFor,
  bookHeld,
  changeProblem,
  checkMeasuresOf,
  chipsOf,
  compareLines,
  emptyDraft,
  formProblems,
  HOME_ADDRESS,
  MTM_PERMISSIONS,
  mtmCan,
  newProfileBodyOf,
  newRevisionBodyOf,
  nextOf,
  offPhrase,
  pointProblem,
  promiseMove,
  queryOf,
  recordHref,
  repeatHeld,
  resultBodyOf,
  resultDraftFor,
  reviewBodyOf,
  reviewDraftHeld,
  reviewHeld,
  saveProblemsOf,
  tileValue,
  TILES,
  TILE_VIEW,
  todayOf,
  worksheetHref,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
import { designScreen as worksheetScreen } from './worksheet/fixtures'

const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['sales-mtm']!
const can = mtmCan(Object.values(MTM_PERMISSIONS))

describe('the list address, tiles and chips', () => {
  it('reads and writes the address (view, garment type, search, New, link) and ignores what is not one', () => {
    const address = addressOf(new URLSearchParams('view=needMore&garment=JACKET&q=Uno&new=1'))
    expect(address).toEqual({ view: 'needMore', garment: 'JACKET', q: 'Uno', isNew: true, link: false })
    expect(addressText(address)).toBe('?view=needMore&garment=JACKET&q=Uno&new=1')
    expect(addressOf(new URLSearchParams('view=nonsense&garment=jacket wear'))).toEqual(HOME_ADDRESS)
    expect(addressText(HOME_ADDRESS)).toBe('')
  })

  it('asks the API what each saved row means', () => {
    expect(queryOf({ ...HOME_ADDRESS, view: 'waiting' })).toMatchObject({ review: 'WAITING', old: null })
    expect(queryOf({ ...HOME_ADDRESS, view: 'old' }, 50)).toMatchObject({ review: null, old: true, offset: 50 })
    expect(queryOf({ ...HOME_ADDRESS, view: 'confirmed', garment: 'SUIT' })).toMatchObject({ review: 'CONFIRMED', garmentType: 'SUIT' })
  })

  it('a tile shows its count, "—" when unknown; the two the list cannot filter press nothing', () => {
    expect(TILES.map((tile) => tileValue(TILES_DATA, tile))).toEqual([2, 1, null, 3, 1])
    expect(TILES.map((tile) => tileValue(null, tile))).toEqual([null, null, null, null, null])
    expect(TILE_VIEW.outside).toBeNull()
    expect(TILE_VIEW.fittings).toBeNull()
    expect(chipsOf({ ...HOME_ADDRESS, view: 'old', garment: 'JACKET', q: 'x' }).map((chip) => chip.id)).toEqual(['view', 'garment', 'q'])
  })

  it('links the record, its dialogs and the worksheet tab', () => {
    expect(recordHref('/w/DEMO', 'abc')).toBe('/w/DEMO/sales/made-to-measure/abc')
    expect(recordHref('/w/DEMO', 'abc', 'fittings', 'fitting')).toBe('/w/DEMO/sales/made-to-measure/abc?tab=fittings&do=fitting')
    expect(worksheetHref('/w/DEMO', 'abc')).toBe('/w/DEMO/sales/made-to-measure/abc/worksheet')
  })
})

describe('the measurement form', () => {
  const draft = { ...emptyDraft(NOW), values: { chest: '141', waist: '88', back_length: '47', sleeve: '64' }, noticeRef: 'Notice v3' }

  it('asks a value outside its plausible range again until it is confirmed; required points and numbers first', () => {
    const chest = FORM_POINTS.find((point) => point.code === 'chest')!
    expect(pointProblem(chest, draft)?.key).toBe('form.problem.outside')
    expect(pointProblem(chest, { ...draft, confirmed: ['chest'] })).toBeNull()
    expect(pointProblem(chest, { ...draft, values: { chest: '' } })?.key).toBe('form.problem.required')
    expect(pointProblem(chest, { ...draft, values: { chest: 'abc' } })?.key).toBe('form.problem.number')
    expect(pointProblem(FORM_POINTS.find((point) => point.code === 'neck')!, { ...draft, values: {} })).toBeNull()
  })

  it('needs the privacy notice on a new profile, who measured when outside, and no time in the future', () => {
    const problems = formProblems({ ...draft, confirmed: ['chest'], noticeRef: '', measurer: { kind: 'outside' }, takenAt: '2030-01-01T00:00:00.000Z' }, FORM_POINTS, { needNotice: true, now: NOW })
    expect(Object.keys(problems).sort()).toEqual(['noticeRef', 'takenAt', 'takenBy'])
  })

  it('sends the typed values, the confirmed points outside, the measurer and the notice', () => {
    const body = newProfileBodyOf({ partyId: 'p', contactId: null, riderName: ' Demo ', garmentType: 'JACKET' }, { ...draft, values: { ...draft.values, height: '181,5' }, confirmed: ['chest'] }, FORM_POINTS, ME)
    expect(body).toMatchObject({ partyId: 'p', riderName: 'Demo', garmentType: 'JACKET', confirmedOutside: ['chest'], measuredByUserId: ME, privacyNoticeRef: 'Notice v3' })
    expect(body.measurements).toEqual({ chest: '141', waist: '88', back_length: '47', sleeve: '64', height: '181.5' })
    expect('contactId' in body).toBe(false)
    const outside = newProfileBodyOf({ partyId: 'p', contactId: 'c', riderName: 'D', garmentType: 'JACKET' }, { ...draft, measurer: { kind: 'outside' }, takenBy: 'Dealer fitter' }, FORM_POINTS, ME)
    expect(outside).toMatchObject({ contactId: 'c', takenBy: 'Dealer fitter', measuredByUserId: null })
  })

  it('keeps the newest revision’s notice on a new revision unless another was given', () => {
    const notice = { ref: 'Notice v3', at: NOW }
    expect('privacyNoticeRef' in newRevisionBodyOf({ ...draft, noticeAt: NOW }, FORM_POINTS, ME, notice)).toBe(false)
    expect(newRevisionBodyOf({ ...draft, noticeRef: 'Notice v4', noticeAt: NOW }, FORM_POINTS, ME, notice)).toMatchObject({ privacyNoticeRef: 'Notice v4' })
  })

  it('checks only numbers, in the point’s unit (cm, mm; the basics cm and kg)', () => {
    expect(checkMeasuresOf({ values: { chest: '104', riding_reach: '620', sleeve: 'x', weight: '78' } }, FORM_POINTS)).toEqual({ chest: { value: '104', unit: 'cm' }, riding_reach: { value: '620', unit: 'mm' }, weight: { value: '78', unit: 'kg' } })
  })

  it('reads a refused save at its fields in our words (never the API’s sentence)', () => {
    const error = new ApiError('invalid', 400, 'invalid', 'English.', null, [{ path: 'body/measurements/chest', message: 'Chest 141 cm is outside…' }, { path: 'body/takenAt', message: 'x' }])
    const said = saveProblemsOf(error, draft, FORM_POINTS)
    expect(said.fields.chest?.key).toBe('form.problem.outside')
    expect(said.fields.takenAt?.key).toBe('form.problem.takenAtFuture')
    expect(said.notice.key).toBe('form.problem.fix')
    expect(saveProblemsOf(new ApiError('conflict', 409, 'conflict', 'x'), draft, FORM_POINTS).notice.key).toBe('problem.newerRevision')
  })
})

describe('the factory review', () => {
  it('holds a decision with why: no right, confirmed, own measures (confirm only), not now', () => {
    expect(reviewHeld(RECORD, 'CONFIRM', ME, mtmCan(['sales.measurements.view']), false)?.params).toEqual({ right: 'right.review' })
    expect(reviewHeld(RECORD_CONFIRMED, 'NEED_MORE', ME, can, false)?.key).toBe('held.review.confirmed')
    expect(reviewHeld(RECORD_OWN, 'CONFIRM', ME, can, false)?.key).toBe('held.review.ownMeasures')
    expect(reviewHeld(RECORD_OWN, 'NEED_MORE', ME, can, false)).toBeNull()
    expect(reviewHeld(RECORD, 'CONFIRM', ME, can, false)).toBeNull()
  })

  it('asks the words for "need more"; the sender company only when no link and no unit name one', () => {
    expect(reviewDraftHeld({ decision: 'NEED_MORE', note: ' ', notify: true })?.key).toBe('review.held.note')
    expect(reviewDraftHeld({ decision: 'CONFIRM', note: '', notify: false })).toBeNull()
    expect(reviewBodyOf({ decision: 'NEED_MORE', note: 'More', notify: true }, RECORD, 'co', 'it')).toEqual({ decision: 'NEED_MORE', note: 'More', notify: true, language: 'it' })
    const lone = { ...RECORD, units: [], revisions: [{ ...REV3, byLink: false }] }
    expect(reviewBodyOf({ decision: 'NEED_MORE', note: 'More', notify: true }, lone, 'co', 'en')).toMatchObject({ companyId: 'co' })
    expect(reviewBodyOf({ decision: 'CONFIRM', note: '', notify: true }, lone, 'co', 'en')).toEqual({ decision: 'CONFIRM', note: null, notify: false, language: 'en' })
  })

  it('says the off state of made-to-measure for the template (GATE-MTM)', () => {
    expect(offPhrase({ code: 'JACKET', rulesOn: false })).toEqual({ key: 'off.template', params: { template: 'JACKET' } })
    expect(offPhrase({ code: 'JACKET', rulesOn: true })).toBeNull()
    expect(offPhrase(null)?.key).toBe('off.noTemplate')
  })

  it('compares two revisions per point with signed differences', () => {
    const lines = compareLines(REV2, REV3, FORM_POINTS)
    expect(lines.find((line) => line.code === 'chest')).toMatchObject({ before: '101', after: '104', difference: '+3', changed: true })
    expect(lines.find((line) => line.code === 'neck')).toMatchObject({ difference: null, changed: false })
  })
})

describe('fittings', () => {
  const now = new Date(NOW)

  it('books ahead with a place; the fitter is the person, one of ours, or named', () => {
    const draft = { ...bookDraftFor(now), place: 'Showroom' }
    expect(bookHeld(draft, now)).toBeNull()
    expect(bookHeld({ ...draft, place: ' ' }, now)?.key).toBe('book.held.place')
    expect(bookHeld({ ...draft, startsAt: '2026-01-01T10:00:00.000Z' }, now)?.key).toBe('book.held.past')
    expect(bookHeld({ ...draft, fitter: { kind: 'outside' } }, now)?.key).toBe('book.held.fitter')
    const body = bookBodyOf({ ...draft, minutes: 45, fitter: { kind: 'person', id: PEOPLE[2]!.id } }, RECORD, 'co', ME, 'it')
    expect(body).toMatchObject({ kind: 'FITTING', measurementProfileId: RECORD.latestId, withUserId: PEOPLE[2]!.id, invite: true, place: 'Showroom' })
    expect(new Date(body.endsAt).getTime() - new Date(body.startsAt).getTime()).toBe(45 * 60_000)
  })

  it('takes a point change as a signed decimal, not zero, with its unit', () => {
    expect(changeProblem('+2.0')).toBeNull()
    expect(changeProblem('−1,5')).toBeNull()
    expect(changeProblem('0')?.key).toBe('result.problem.zero')
    expect(changeProblem('two')?.key).toBe('result.problem.change')
    const body = resultBodyOf({ ...resultDraftFor('a', ''), verdict: 'ALTER', changes: { chest: { change: '2', note: ' ' }, riding_reach: { change: '−10', note: 'reach' }, sleeve: { change: '', note: '' } }, days: '5' }, RECORD, FORM_POINTS)
    expect(body).toMatchObject({ appointmentId: 'a', measurementProfileId: RECORD.latestId, verdict: 'ALTER', alterationDays: 5 })
    expect(body.pointChanges).toEqual({ chest: { change: '+2', unit: 'cm' }, riding_reach: { change: '-10', unit: 'mm', note: 'reach' } })
  })

  it('says what comes next and the date moved by the alteration, from the facts', () => {
    expect(nextOf(RESULT_ALTER)?.key).toBe('fit.next.altered')
    expect(nextOf(RESULT_TO_ALTER)?.key).toBe('fit.next.alter')
    expect(nextOf({ ...RESULT_ALTER, verdict: 'REMAKE', newProfile: null })?.key).toBe('fit.next.remakeMeasure')
    expect(promiseMove(RESULT_TO_ALTER)).toEqual({ from: '2026-12-04', to: '2026-12-09' })
    expect(promiseMove(RESULT_ALTER)).toBeNull()
  })

  it('holds the appointment’s actions with why', () => {
    const appointment = { ...RECORD_APPOINTMENT, may: { ...RECORD_APPOINTMENT.may, close: false } }
    expect(appointmentHeld(appointment, 'close', can, false)?.key).toBe('appt.held.notStarted')
    expect(appointmentHeld(appointment, 'move', can, true)?.key).toBe('held.offline')
    expect(appointmentHeld(appointment, 'move', mtmCan([]), false)?.params).toEqual({ right: 'right.fittings' })
  })

  it('holds a repeat order on old measures until "order anyway"', () => {
    const facts = { latest: { id: 'x', revision: 3, takenAt: NOW, takenOn: '2025-01-01', months: 14, old: true, review: 'CONFIRMED' as const }, reMeasure: 'old', earlier: RECORD.units }
    expect(repeatHeld(facts, false, { can, offline: false, companyId: 'co' })?.key).toBe('repeat.held.old')
    expect(repeatHeld(facts, true, { can, offline: false, companyId: 'co' })).toBeNull()
    expect(repeatHeld({ ...facts, earlier: [] }, true, { can, offline: false, companyId: 'co' })?.key).toBe('repeat.held.noEarlier')
  })

  it('takes today as a business day (Europe/Rome), never the UTC slice', () => {
    expect(todayOf('2026-11-12T23:30:00.000Z')).toBe('2026-11-13')
  })
})

describe('words, lists, navigation', () => {
  it('has the words of every state the API answers, in both languages', () => {
    for (const locale of LOCALES) {
      const own = words(locale)
      for (const status of REVIEW_STATUSES) expect(own[`review.${status}`], status).toBeTruthy()
      for (const kind of APPOINTMENT_KINDS) expect(own[`apptKind.${kind}`], kind).toBeTruthy()
      for (const status of APPOINTMENT_STATUSES) expect(own[`apptStatus.${status}`], status).toBeTruthy()
      for (const verdict of FITTING_VERDICTS) expect(own[`verdict.${verdict}`], verdict).toBeTruthy()
      for (const zone of BODY_ZONES) expect(own[`zone.${zone}`], zone).toBeTruthy()
      for (const status of QUOTE_STATUSES) expect(own[`orders.status.QUOTE.${status}`], status).toBeTruthy()
      for (const status of SALES_ORDER_STATUSES) expect(own[`orders.status.ORDER.${status}`], status).toBeTruthy()
      for (const ability of Object.keys(MTM_PERMISSIONS)) expect(own[`right.${ability}`], ability).toBeTruthy()
    }
  })

  it('opens the page and its records from the navigation and the record links', () => {
    expect(OFFICE_PAGES.has('/sales/made-to-measure')).toBe(true)
    expect(OFFICE_PAGES.has('/sales/made-to-measure/[id]')).toBe(true)
    expect(OFFICE_PAGES.has('/sales/made-to-measure/[id]/worksheet')).toBe(true)
    expect(RECORD_PAGES.MeasurementProfile).toBe('/sales/made-to-measure/[id]')
    expect(RECORD_PAGES.MeasurementTemplate).toBe('/products/sizes/templates/[id]')
    const rows = (permissions: readonly string[]) => officeNavFor(permissionCheck([...permissions])).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))
    for (const role of ['sales', 'production'] as const) expect(rows(ROLE_PERMISSIONS[role]), role).toContain('/sales/made-to-measure')
    for (const role of ['reader', 'warehouse'] as const) expect(rows(ROLE_PERMISSIONS[role]), role).not.toContain('/sales/made-to-measure')
  })
})

const LEFT_KEY =
  /\b(?:common|held|list|record|tile|new|tab|live|row|col|keys|chip|view|right|problem|form|band|activity|noAccess|off|meas|reviewPanel|review|range|photos|fit|book|appt|apptKind|apptStatus|result|link|quote|repeat|orders|proofs|sheet|compare|verdict|finding|shape|proofState|zone|revision)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen, worksheetScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
            .replace(/\b[\w-]+\.(?:pdf|png|jpg)\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})

const RECORD_APPOINTMENT = {
  id: 'a',
  companyId: 'c',
  partyId: RECORD.partyId,
  customer: RECORD.customer,
  kind: 'FITTING' as const,
  status: 'BOOKED' as const,
  rider: { contactId: null, name: 'Demo' },
  profile: null,
  garmentType: 'JACKET',
  startsAt: '2099-01-01T10:00:00.000Z',
  endsAt: '2099-01-01T11:00:00.000Z',
  place: 'Showroom',
  with: { userId: null, name: null },
  inviteSentAt: null,
  reminderSentAt: null,
  results: 0,
  version: 1,
  closedAt: null,
  closedBy: null,
  cancelReason: null,
  notes: null,
  mailTo: true,
  mails: [],
  resultList: [],
  createdAt: NOW,
  createdBy: null,
  may: { move: true, close: false, cancel: true, invite: true, ledTo: false, result: false, notes: true },
  why: null,
  // B-W2b-F38: the company's fitting reminder switch.
  reminderEnabled: true,
}
