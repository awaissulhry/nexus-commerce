import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { FITNESS_OUTCOMES, HEALTH_REFUSALS, JUDGEMENT_STATES, PROPOSAL_REASONS, VIEW_WHATS, VISIT_CANCEL_REASONS, VISIT_STATES, VISIT_TYPES, VOID_REASONS } from '@nexus/factory-domain/safety/health/rules'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor, WINDOW_PAGES } from '../../../shell/nav/office-nav'
import { BOOKED_VISIT, DONE_VISIT, GIULIA, MARCO, PERIODIC_VISIT, PLAN_CUT, PLAN_FIN, PROPOSALS, RETURN_VISIT, STARTER_VISIT, TODAY, VISITS } from './_demo/fixtures'
import { bookVisits, listJudgements, listVisits, openVisit, readViews, recordJudgement } from './api'
import { designScreen as copyScreen } from './copy/fixtures'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressTerms,
  bookBody,
  bookHeld,
  byHandHeld,
  copyKindOf,
  EMPTY_ADDRESS,
  healthCan,
  healthOfChange,
  inTile,
  judgementBody,
  judgementHeld,
  moveHeld,
  newByHand,
  newJudgementDraft,
  newMoveDraft,
  pageMode,
  planBody,
  planDraftOf,
  planHeld,
  planItemsOf,
  planVisitsHeld,
  problemOf,
  proposalKey,
  readProblemOf,
  tileChange,
  tileRows,
  visitSelectHeld,
} from './model'
import { designScreen as printScreen } from './print/fixtures'

/**
 * B-W2b-148 — SCR-212 Health surveillance: the pure rules (address with ids only, the tiles as filters, which rows may be
 * chosen, every hold, the bodies sent, the refusals in our words, live), the calls' shape (a recorded read takes no key, a
 * write its own), the navigation (who opens the page, the windows, the record links), the words (every key in it and en) and
 * every design case drawn in both languages with no key or placeholder left — and no person before a recorded read.
 */

const refused = (code: string, path?: string) => new ApiError('conflict', 409, 'refused', 'refused', null, [{ path: `refusal/${code}` }, ...(path ? [{ path }] : [])])

describe('health: the address and the tiles', () => {
  it('round-trips every term; ids only as uuids, never a name; bad terms are dropped', () => {
    const address = addressOf(new URLSearchParams(`tile=overdue&status=all&type=PERIODIC&jstate=VOIDED&judge=${PERIODIC_VISIT.id}&planVisits=1&visit=${RETURN_VISIT.id}&judgement=${PLAN_CUT.id}&plan=${PLAN_FIN.id}`))
    expect(address).toMatchObject({ tile: 'overdue', status: 'all', type: 'PERIODIC', jstate: 'VOIDED', judge: PERIODIC_VISIT.id, planVisits: true, visit: RETURN_VISIT.id })
    expect(addressOf(new URLSearchParams(addressTerms(address).slice(1)))).toEqual(address)
    expect(addressOf(new URLSearchParams('tile=unfitEnding&status=maybe&type=X&jstate=x&judge=Giulia&visit=Marco%20Prova'))).toEqual(EMPTY_ADDRESS)
    expect(addressTerms({ ...EMPTY_ADDRESS, status: 'open', jstate: 'current' })).toBe('')
    expect(addressOf(new URLSearchParams('judge=1')).judge).toBe('1')
  })

  it('a tile filters the rows read (no new read); pressing it again lets go; the unfit ending are judgements', () => {
    expect(tileRows(VISITS, 'overdue', TODAY).map((row) => row.id)).toEqual([RETURN_VISIT.id])
    expect(tileRows(VISITS, 'dueIn30', TODAY).map((row) => row.id).sort()).toEqual([STARTER_VISIT.id, BOOKED_VISIT.id, PERIODIC_VISIT.id].sort())
    expect(tileRows(VISITS, 'beforeTask', TODAY).map((row) => row.id)).toEqual([STARTER_VISIT.id])
    expect(tileRows(VISITS, 'returnVisits', TODAY).map((row) => row.id)).toEqual([RETURN_VISIT.id])
    expect(inTile(DONE_VISIT, 'dueIn30', TODAY)).toBe(false)
    expect(tileChange('overdue', { ...EMPTY_ADDRESS, status: 'all', type: 'PERIODIC' })).toEqual({ tile: 'overdue', status: null, type: null })
    expect(tileChange('overdue', { ...EMPTY_ADDRESS, tile: 'overdue' })).toEqual({ tile: null })
  })
})

describe('health: holds and bodies', () => {
  it('only open visits are chosen; Mark booked asks a day from today and sends ids and versions only', () => {
    expect(visitSelectHeld(DONE_VISIT)).toBe('held.select.closed')
    expect(visitSelectHeld(BOOKED_VISIT)).toBeNull()
    expect(bookHeld([], { on: TODAY, place: '' }, TODAY)).toEqual({ key: 'held.book.none' })
    expect(bookHeld([RETURN_VISIT], { on: '', place: '' }, TODAY)).toEqual({ key: 'held.book.day' })
    expect(bookHeld([RETURN_VISIT], { on: '2026-11-04', place: '' }, TODAY)).toEqual({ key: 'refusal.BOOKED_IN_PAST' })
    expect(bookHeld([RETURN_VISIT], { on: '2026-11-14', place: 'x'.repeat(201) }, TODAY)?.key).toBe('held.book.place')
    expect(bookBody([RETURN_VISIT, BOOKED_VISIT], { on: '2026-11-14', place: ' Ambulatorio ' })).toEqual({ visits: [{ id: RETURN_VISIT.id, version: 1 }, { id: BOOKED_VISIT.id, version: 2 }], bookedOn: '2026-11-14', bookedPlace: 'Ambulatorio' })
    expect(bookBody([RETURN_VISIT], { on: '2026-11-14', place: ' ' })).toEqual({ visits: [{ id: RETURN_VISIT.id, version: 1 }], bookedOn: '2026-11-14' })
  })

  it('a visit\'s moves say the API\'s refusals before the call', () => {
    expect(moveHeld(DONE_VISIT, newMoveDraft('move', TODAY, DONE_VISIT), TODAY)).toEqual({ key: 'refusal.VISIT_CLOSED' })
    expect(moveHeld(PERIODIC_VISIT, newMoveDraft('unbook', TODAY), TODAY)).toEqual({ key: 'refusal.VISIT_NOT_BOOKED' })
    expect(moveHeld(BOOKED_VISIT, newMoveDraft('unbook', TODAY), TODAY)).toBeNull()
    expect(moveHeld(PERIODIC_VISIT, newMoveDraft('move', TODAY, PERIODIC_VISIT), TODAY)).toEqual({ key: 'held.move.same' })
    expect(moveHeld(PERIODIC_VISIT, newMoveDraft('cancel', TODAY), TODAY)).toEqual({ key: 'held.cancel.reason' })
    expect(moveHeld(PERIODIC_VISIT, { ...newMoveDraft('done', TODAY), day: '2026-11-06' }, TODAY)).toEqual({ key: 'held.done.future' })
    expect(moveHeld(PERIODIC_VISIT, { ...newMoveDraft('book', TODAY), day: '2026-11-04' }, TODAY)).toEqual({ key: 'refusal.BOOKED_IN_PAST' })
  })

  it('Record a judgement: held in words until whole; a medical word is held at once; the body carries only what the outcome takes', () => {
    let draft = newJudgementDraft(TODAY)
    expect(judgementHeld(draft, TODAY)).toEqual({ key: 'held.judgement.visit' })
    draft = newJudgementDraft(TODAY, PERIODIC_VISIT)
    expect(judgementHeld(draft, TODAY)).toEqual({ key: 'held.judgement.outcome' })
    draft = { ...draft, outcome: 'FIT_WITH_LIMITS' }
    expect(judgementHeld(draft, TODAY)).toEqual({ key: 'held.judgement.limits' })
    expect(judgementHeld({ ...draft, taskLimits: 'Ernia del disco: niente sollevamento' }, TODAY)).toMatchObject({ key: 'held.judgement.clinical', params: { words: 'ernia' } })
    draft = { ...draft, taskLimits: ' Niente sollevamento oltre 15 kg ', expiresOn: '2027-11-05' }
    expect(judgementHeld(draft, TODAY)).toBeNull()
    expect(judgementHeld({ ...draft, judgedOn: '2026-11-06' }, TODAY)).toEqual({ key: 'held.judgement.future' })
    expect(judgementHeld({ ...draft, expiresOn: '2026-11-01' }, TODAY)).toEqual({ key: 'held.judgement.expiresAfter' })
    expect(judgementBody(draft)).toEqual({ employeeId: GIULIA.id, visitId: PERIODIC_VISIT.id, outcome: 'FIT_WITH_LIMITS', taskLimits: 'Niente sollevamento oltre 15 kg', judgedOn: TODAY, expiresOn: '2027-11-05' })
    const unfit = { ...draft, outcome: 'TEMPORARILY_UNFIT' as const, unfitUntil: '' }
    expect(judgementHeld(unfit, TODAY)).toEqual({ key: 'held.judgement.unfitUntil' })
    expect(judgementBody({ ...unfit, unfitUntil: '2026-12-01' })).toEqual({ employeeId: GIULIA.id, visitId: PERIODIC_VISIT.id, outcome: 'TEMPORARILY_UNFIT', unfitUntil: '2026-12-01', judgedOn: TODAY, expiresOn: '2027-11-05' })
    expect(judgementBody({ ...draft, outcome: 'UNFIT', from: 'person', employeeId: MARCO.id })).toEqual({ employeeId: MARCO.id, outcome: 'UNFIT', judgedOn: TODAY })
  })

  it('Plan visits: the chosen proposals with their role, then the visits by hand; a return visit carries its length only', () => {
    const chosen = new Set([proposalKey(PROPOSALS[0]!)])
    expect(planVisitsHeld(PROPOSALS, new Set(), [])).toEqual({ key: 'held.plan.none' })
    const hand = { ...newByHand('h1', TODAY), employeeId: MARCO.id, name: MARCO.name, type: 'RETURN_AFTER_ABSENCE' as const, absenceDays: '40' }
    expect(byHandHeld(hand)).toMatchObject({ key: 'held.plan.absence' })
    expect(byHandHeld({ ...hand, employeeId: null })).toEqual({ key: 'held.plan.person' })
    const ok = { ...hand, absenceDays: '75' }
    expect(planVisitsHeld(PROPOSALS, chosen, [ok])).toBeNull()
    expect(planItemsOf(PROPOSALS, chosen, [ok, { ...newByHand('h2', TODAY), employeeId: GIULIA.id, name: GIULIA.name }])).toEqual([
      { employeeId: PROPOSALS[0]!.employee.id, type: 'PREVENTIVE', dueOn: '2026-11-10', roleSheetId: PROPOSALS[0]!.role.id },
      { employeeId: MARCO.id, type: 'RETURN_AFTER_ABSENCE', dueOn: TODAY, absenceDays: 75 },
      { employeeId: GIULIA.id, type: 'ON_REQUEST', dueOn: TODAY },
    ])
  })

  it('a role\'s plan sends only what changed; "needed" stays the role sheet\'s', () => {
    const draft = planDraftOf(PLAN_CUT, TODAY)
    expect(planHeld(PLAN_CUT, draft, TODAY)).toEqual({ key: 'held.plan.unchanged' })
    expect(planBody(PLAN_CUT, { ...draft, frequency: '24' })).toEqual({ version: 2, frequencyMonths: 24, setOn: TODAY })
    expect(planBody(PLAN_CUT, { ...draft, doctorId: '' })).toEqual({ version: 2, doctorAppointmentId: null, setOn: TODAY })
    expect(planHeld(PLAN_CUT, { ...draft, frequency: '61' }, TODAY)?.key).toBe('held.plan.frequency')
    expect(planHeld(PLAN_FIN, { ...planDraftOf(PLAN_FIN, TODAY), frequency: '12' }, TODAY)).toEqual({ key: 'refusal.PLAN_NOT_NEEDED' })
    expect(planHeld({ ...PLAN_CUT, canEdit: false }, draft, TODAY)).toEqual({ key: 'held.plan.noRight' })
    expect(planHeld(PLAN_CUT, { ...draft, frequency: '24', setOn: '2026-11-06' }, TODAY)).toEqual({ key: 'held.plan.setOnFuture' })
  })
})

describe('health: the API\'s answers, live, the copy', () => {
  it('a refusal in our words, with the item of Plan visits it names; a failed read is never "empty"', () => {
    expect(problemOf(refused('OPEN_VISIT_EXISTS', 'body/items/1/type'))).toEqual({ key: 'refusal.OPEN_VISIT_EXISTS', field: 'type', item: 1 })
    expect(problemOf(refused('BOOKED_IN_PAST', 'body/bookedOn'))).toEqual({ key: 'refusal.BOOKED_IN_PAST', field: 'bookedOn', item: null })
    expect(problemOf(new ApiError('invalid', 400, 'invalid', 'bad', null, [{ path: 'body/taskLimits' }])).key).toBe('problem.taskLimits')
    expect(readProblemOf(new ApiError('forbidden', 403, 'forbidden', 'no', null, []))).toBe('problem.forbidden')
    expect(readProblemOf(new ApiError('internal', 500, 'internal', 'x', null, []))).toBe('problem.read')
  })

  it('what a live event moves', () => {
    expect(healthOfChange({ type: 'health_visit.changed' })).toEqual({ visits: true, judgements: false, plans: false })
    expect(healthOfChange({ type: 'fitness_judgement.changed' })).toEqual({ visits: true, judgements: true, plans: false })
    expect(healthOfChange({ type: 'health_plan.changed' })).toEqual({ visits: false, judgements: false, plans: true })
    expect(healthOfChange({ type: 'incident.changed' })).toEqual({ visits: false, judgements: false, plans: false })
  })

  it('a copy is told by its first bytes, never its name', () => {
    expect(copyKindOf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('pdf')
    expect(copyKindOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image')
    expect(copyKindOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image')
    expect(copyKindOf(new Uint8Array([0x3c, 0x68]))).toBeNull()
  })

  it('the calls: a recorded read is a POST with no key; a write carries its own; the judgements read anonymised', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      const path = url.split('?')[0]!
      const body = path.endsWith('/visits/list')
        ? { today: TODAY, visits: [], more: false, recorded: false }
        : path.endsWith('/open')
          ? { today: TODAY, visit: { ...RETURN_VISIT, planId: null, absenceDays: 75, booked: null, cancelled: null, judgementId: null, risks: [] }, recorded: true, law: 'x' }
          : path.endsWith('/visits/book')
            ? { visits: [{ id: RETURN_VISIT.id, version: 2, status: 'BOOKED' }], replayed: false }
            : path.endsWith('/judgements') && init?.method === 'POST'
              ? { judgement: { id: 'j1', version: 1 }, visit: null, replayed: false }
              : path.endsWith('/views')
                ? { views: [], fitnessChecks: [], law: 'x' }
                : { today: TODAY, judgements: [], more: false }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api = createApiClient({ baseUrl: '/api', fetch: fetcher, csrfToken: () => 't' })
    await listVisits(api, { siteId: 's1', status: 'open', type: null })
    expect(seen[0]!.url).toBe('/api/safety/health/visits/list')
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ siteId: 's1', status: 'open', offset: 0, limit: 200 })
    expect(new Headers(seen[0]!.init?.headers).get('idempotency-key')).toBeNull()
    await openVisit(api, RETURN_VISIT.id)
    expect(seen[1]!.init?.method).toBe('POST')
    await bookVisits(api, { visits: [{ id: RETURN_VISIT.id, version: 1 }], bookedOn: '2026-11-14' }, 'k1')
    expect(new Headers(seen[2]!.init?.headers).get('idempotency-key')).toBe('k1')
    await recordJudgement(api, { employeeId: GIULIA.id, outcome: 'FIT', judgedOn: TODAY }, 'k2')
    expect(new Headers(seen[3]!.init?.headers).get('idempotency-key')).toBe('k2')
    await listJudgements(api, 's1', 'current')
    expect(seen[4]!.url).toBe('/api/safety/health/judgements?siteId=s1&state=current&offset=0&limit=200')
    await readViews(api, { companyId: 'c1', lists: true })
    expect(seen[5]!.url).toBe('/api/safety/health/views?companyId=c1&lists=true&limit=50')
  })
})

describe('health: navigation, record links and who opens it', () => {
  it('the page and its two tabs are built; the tabs are windows; a visit, a judgement and a plan open on the page', () => {
    for (const page of ['/plant/health', '/plant/health/print', '/plant/health/copy']) expect(OFFICE_PAGES.has(page), page).toBe(true)
    for (const page of ['/plant/health/print', '/plant/health/copy']) expect(WINDOW_PAGES.has(page), page).toBe(true)
    expect(recordAddress({ type: 'HealthVisit', id: 'v1' }, OFFICE_PAGES)).toBe('/plant/health?visit=v1')
    expect(recordAddress({ type: 'FitnessJudgement', id: 'j1' }, OFFICE_PAGES)).toBe('/plant/health?judgement=j1')
    expect(recordAddress({ type: 'HealthPlan', id: 'p1' }, OFFICE_PAGES)).toBe('/plant/health?plan=p1')
    expect(LIST_PAGES['/safety/health']).toBe('/plant/health')
  })

  it('HR and the doctor open the protected page; the safety officer the plans only; production, read-only and sales nothing', () => {
    const rows = (key: string) => officeNavFor(permissionCheck(templateOf(key)!.permissions)).areas.flatMap((area) => (area.sections ?? []).flatMap((entry) => entry.items.map((row) => row.href)))
    for (const key of ['hr', 'company_doctor', 'safety_officer']) expect(rows(key), key).toContain('/plant/health')
    for (const key of ['production_manager', 'read_only', 'sales']) expect(rows(key), key).not.toContain('/plant/health')
    const mode = (key: string) => pageMode(healthCan(templateOf(key)!.permissions))
    expect([mode('hr'), mode('company_doctor'), mode('safety_officer'), mode('production_manager'), mode('read_only')]).toEqual(['full', 'full', 'limited', 'none', 'none'])
    expect(healthCan(templateOf('hr')!.permissions)).toMatchObject({ manage: true, views: true, plans: false, pickPeople: true })
    expect(healthCan(templateOf('company_doctor')!.permissions)).toMatchObject({ manage: true, views: false, plans: true, pickPeople: false })
  })
})

// ---- the words and every design case ---------------------------------------------------------------------------------------

const NS = 'plant-health'
const TOP = [...new Set(Object.keys(flat(CATALOGUE.en[NS] ?? {})).map((key) => key.split('.')[0]!))]
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose; file names and the law are not keys. */
const SAID = /\b(?:safety\.[a-zA-Z.]+|[\w-]+\.(?:pdf|jpg|png)|D\.Lgs\.|art\.|artt\.)/g

function flat(dictionary: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(dictionary).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
}

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('health: the words', () => {
  it('every key in it and en; every word the page names exists; every type, state, outcome, reason and refusal has its words', () => {
    const words = { it: flat(CATALOGUE.it[NS] ?? {}), en: flat(CATALOGUE.en[NS] ?? {}) }
    expect(Object.keys(words.it).sort()).toEqual(Object.keys(words.en).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.') && !file.includes('fixtures')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...source.matchAll(/'((?:held|refusal|problem|notice)\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    for (const locale of LOCALES) {
      const has = (key: string) => key in words[locale] || `${key}_one` in words[locale]
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
      for (const type of VISIT_TYPES) expect(has(`visitType.${type}`), `${locale} ${type}`).toBe(true)
      for (const state of VISIT_STATES) expect(has(`visitState.${state}`), `${locale} ${state}`).toBe(true)
      for (const state of JUDGEMENT_STATES) expect(has(`judgementState.${state}`) && has(`judgementFilter.${state}`), `${locale} ${state}`).toBe(true)
      for (const outcome of FITNESS_OUTCOMES) expect(has(`outcome.${outcome}`) && has(`outcomeHint.${outcome}`), `${locale} ${outcome}`).toBe(true)
      for (const reason of VISIT_CANCEL_REASONS) expect(has(`cancelReason.${reason}`), `${locale} ${reason}`).toBe(true)
      for (const reason of VOID_REASONS) expect(has(`voidReason.${reason}`), `${locale} ${reason}`).toBe(true)
      for (const why of PROPOSAL_REASONS) expect(has(`why.${why}`), `${locale} ${why}`).toBe(true)
      for (const what of VIEW_WHATS) expect(has(`who.what.${what}`), `${locale} ${what}`).toBe(true)
      for (const code of HEALTH_REFUSALS) expect(has(`refusal.${code}`), `${locale} ${code}`).toBe(true)
      for (const kind of ['move', 'unbook', 'cancel', 'done', 'book']) for (const part of ['title', 'body', 'day', 'do']) expect(has(`move.${kind}.${part}`) && has(`notice.visit.${kind}`), `${locale} ${kind} ${part}`).toBe(true)
    }
  })

  for (const screen of [designScreen, printScreen, copyScreen] as unknown as DesignScreen<unknown>[]) {
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

  it('no person before a recorded read: the note first, the plans and the limited page name nobody', () => {
    const html = (id: string) => render(designScreen as never, designScreen.cases.find((entry) => entry.id === id)!.model, 'it')
    for (const id of ['loading', 'error', 'safety-officer', 'no-permission', 'read-only', 'plan-edit']) {
      for (const name of [GIULIA.name, MARCO.name]) expect(html(id), `${id} ${name}`).not.toContain(name)
    }
    // The page says it is protected and recorded before anything is read.
    expect(html('loading')).toMatch(/registrat/)
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['hr', 'doctor', 'all-sites', 'selected', 'book', 'show-confirm', 'shown', 'judge', 'judge-clinical', 'plan-visits', 'visit', 'judgement', 'judgement-void', 'plan-edit', 'who-looked', 'safety-officer', 'loading', 'error', 'empty', 'no-permission', 'keys']))
  })
})
