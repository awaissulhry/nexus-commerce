import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HOLD_SUBJECT_TYPES, RELEASE_CHECKS } from '@nexus/factory-domain/quality/holds/rules'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE, createScopedTranslator, messagesFor } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, RECORD_PAGES, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { qualityCan } from '../_shared/model'
import { CLOSED, DETAIL_CR_VI, DETAIL_MAKER, DETAIL_PLACER, DETAIL_READY, DETAIL_RELEASED, DETAIL_STATEMENT, detailOf, HOLDS, PREVIEW, PREVIEW_PROBLEMS, REASONS, REASON_WORDS, RELEASED } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  blocksKey,
  bulkAssignHeld,
  bulkNotice,
  bulkReleaseHeld,
  changeHeld,
  checkLineKey,
  checkNameKey,
  evidenceOf,
  fieldOf,
  firstOpenCheck,
  holdsAddress,
  needsStatement,
  nextLimit,
  nounKey,
  ownerWords,
  placeable,
  placeBody,
  placeDraftOf,
  placedByKey,
  placeProblems,
  prefillFromAddress,
  quarantineKey,
  queryOf,
  reasonText,
  releaseHeld,
  releaseProblems,
  scopeFromAddress,
  sourceKey,
  statusOf,
  tabFromAddress,
  tagAddress,
  traceOf,
  viewFromAddress,
  VIEWS,
  withKind,
} from './model'
import { officeToday, placeRefusal } from './place/PlaceHold'
import { designScreen as tagScreen } from './tag/fixtures'

const params = (query: string) => new URLSearchParams(query)
const QUALITY = qualityCan(['quality.holds.view', 'quality.holds.place', 'quality.holds.release', 'quality.ncr.raise'])
const PLACER = qualityCan(['quality.holds.view', 'quality.holds.place'])
const VIEWER = qualityCan(['quality.holds.view'])
const ME = 'me-0000'

describe('Holds: views and the address (the API\'s own filters)', () => {
  it('reads ?view= first, then the filters a link carries, else Open', () => {
    expect(viewFromAddress(params('view=released'))).toBe('released')
    expect(viewFromAddress(params('status=RELEASED'))).toBe('released')
    expect(viewFromAddress(params('status=CLOSED'))).toBe('closed')
    expect(viewFromAddress(params('status=ALL'))).toBe('all')
    expect(viewFromAddress(params('overdue=true'))).toBe('overdue')
    expect(viewFromAddress(params('system=true'))).toBe('system')
    expect(viewFromAddress(params('quarantine=ASKED'))).toBe('quarantine')
    expect(viewFromAddress(params('ownerId=me'))).toBe('mine')
    expect(viewFromAddress(params('view=nonsense'))).toBe('open')
    expect(viewFromAddress(null)).toBe('open')
  })

  it("narrows to one record's holds (Q3) and asks the API exactly that", () => {
    const id = '0190f0e2-7822-7000-8000-000000000001'
    expect(scopeFromAddress(params(`subjectType=WorkOrder&subjectId=${id}`))).toEqual({ subjectType: 'WorkOrder', subjectId: id })
    expect(scopeFromAddress(params('subjectType=Nope&subjectId=x'))).toEqual({ subjectType: null, subjectId: null })
    expect(queryOf('open', { subjectType: null, subjectId: id })).toEqual({ subjectType: null, subjectId: id, status: 'ACTIVE' })
    expect(queryOf('mine', { subjectType: null, subjectId: null })).toMatchObject({ status: 'ACTIVE', ownerId: 'me' })
    expect(queryOf('quarantine', { subjectType: null, subjectId: null })).toMatchObject({ status: 'ACTIVE', quarantine: 'ASKED' })
    expect(queryOf('all', { subjectType: 'Lot', subjectId: null })).toMatchObject({ status: 'ALL', subjectType: 'Lot' })
    for (const view of VIEWS) expect(viewFromAddress(params(holdsAddress({ view }).slice(1)))).toBe(view)
  })

  it('keeps the open hold and its tab in the address; Show more grows by 50 up to 200', () => {
    expect(holdsAddress({ view: 'open', open: 'h1', tab: 'decision' })).toBe('?open=h1&tab=decision')
    expect(holdsAddress({ view: 'overdue', open: 'h1', tab: 'hold' })).toBe('?view=overdue&open=h1')
    expect(tabFromAddress(params('tab=activity'))).toBe('activity')
    expect(tabFromAddress(params('tab=x'))).toBe('hold')
    expect([nextLimit(50), nextLimit(150), nextLimit(200)]).toEqual([100, 200, 200])
  })
})

describe('a hold in our words', () => {
  it('names every kind, what it blocks, who placed it (never a name), the quarantine move and the source', () => {
    for (const type of HOLD_SUBJECT_TYPES) {
      expect(nounKey(type)).toBe(`noun.${type}`)
      expect(blocksKey(type)).toBe(`blocks.${type}`)
    }
    expect(placedByKey(HOLDS[1]!, ME)).toBe('placedBy.system')
    expect(placedByKey(HOLDS[2]!, ME)).toBe('placedBy.bench')
    expect(placedByKey({ placedBy: { kind: 'USER', userId: ME } }, ME)).toBe('placedBy.you')
    expect(placedByKey(HOLDS[0]!, ME)).toBe('placedBy.office')
    expect(quarantineKey(HOLDS[0]!)).toBe('quarantine.ASKED')
    expect(sourceKey(HOLDS[0]!)).toBe('source.manual')
    expect(sourceKey(HOLDS[1]!)).toBe('source.Inspection')
    expect(sourceKey({ sourceType: 'Something' })).toBe('source.other')
    expect(statusOf(HOLDS[1]!)).toEqual({ key: 'status.OVERDUE', tone: 'danger' })
    expect(statusOf(RELEASED[0]!).key).toBe('status.RELEASED')
    expect(statusOf(CLOSED[0]!).key).toBe('status.CLOSED')
  })

  it("says the owner (an office user by name), the reason in the reader's language, else the API's words", () => {
    expect(ownerWords({ ownerId: null, owner: null }, ME)).toEqual({ key: 'owner.nobody' })
    expect(ownerWords({ ownerId: ME, owner: { id: ME, name: 'x' } }, ME)).toEqual({ key: 'owner.you' })
    expect(ownerWords({ ownerId: 'u', owner: { id: 'u', name: 'Demo Lead' } }, ME)).toEqual({ key: 'owner.name', params: { name: 'Demo Lead' } })
    expect(reasonText(HOLDS[0]!, REASON_WORDS, 'it')).toBe('Verifica fornitore')
    expect(reasonText(HOLDS[0]!, REASON_WORDS, 'en')).toBe('Supplier check')
    expect(reasonText({ reasonCode: 'GONE', reason: 'Gone reason' }, REASON_WORDS, 'it')).toBe('Gone reason')
  })

  it('traces a lot or a hide; the evidence trail opens from a serial or a work order with its batch', () => {
    expect(traceOf('/w/D', HOLDS[0]!).href).toBe(`/w/D/warehouse/lots/${HOLDS[0]!.subjects[0]!.id}?tab=trace`)
    expect(traceOf('/w/D', HOLDS[2]!).href).toBe(`/w/D/warehouse/hides/${HOLDS[2]!.subjects[0]!.id}`)
    expect(traceOf('/w/D', HOLDS[1]!)).toEqual({ href: null, held: 'held.traceKind' })
    expect(evidenceOf('/w/D', HOLDS[3]!, null).href).toBe('/w/D/compliance/evidence/serial/DEMO-0139-001')
    expect(evidenceOf('/w/D', HOLDS[1]!, DETAIL_MAKER).href).toBe('/w/D/compliance/evidence/batch/DEMO-B-0142')
    expect(evidenceOf('/w/D', HOLDS[1]!, null).held).toBe('held.evidenceOpen')
    expect(evidenceOf('/w/D', HOLDS[0]!, null).held).toBe('held.evidenceKind')
    expect(tagAddress('/w/D', ['a'])).toBe('/w/D/quality/holds/a/tag')
    expect(tagAddress('/w/D', ['a', 'b'])).toBe('/w/D/quality/holds/a/tag?ids=a,b')
    expect(tagAddress('/w/D', [])).toBeNull()
  })
})

describe('the release, held with its reason before the click', () => {
  it('names each check in our words and the first one that holds the release (the statement is signed in the dialog)', () => {
    for (const key of RELEASE_CHECKS) {
      expect(checkNameKey(key)).toBe(`check.${key}.name`)
      expect(checkLineKey(key, false)).toBe(`check.${key}.open`)
    }
    expect(firstOpenCheck(DETAIL_READY)).toBeNull()
    expect(firstOpenCheck(DETAIL_PLACER)).toBe('NOT_PLACER')
    expect(firstOpenCheck(DETAIL_MAKER)).toBe('NOT_MAKER')
    expect(firstOpenCheck(DETAIL_STATEMENT)).toBeNull()
    expect(needsStatement(DETAIL_STATEMENT)).toBe(true)
    expect(firstOpenCheck(DETAIL_CR_VI)).toBe('CR_VI')
  })

  it('holds one release: no right, not active, a check open; else allows it', () => {
    expect(releaseHeld(HOLDS[0]!, DETAIL_READY, PLACER)).toEqual({ key: 'held.noRelease' })
    expect(releaseHeld(RELEASED[0]!, DETAIL_RELEASED, QUALITY)).toEqual({ key: 'held.notActive' })
    expect(releaseHeld(HOLDS[4]!, DETAIL_PLACER, QUALITY)).toEqual({ key: 'held.check.NOT_PLACER' })
    expect(releaseHeld(HOLDS[0]!, { ...DETAIL_READY, release: { ...DETAIL_READY.release, mayRelease: false } }, QUALITY)).toEqual({ key: 'held.noReleaseHere' })
    expect(releaseHeld(HOLDS[0]!, DETAIL_READY, QUALITY)).toBeNull()
    expect(releaseProblems({ note: '', statement: false }, [DETAIL_STATEMENT])).toEqual(['release.problem.statement'])
    expect(releaseProblems({ note: '', statement: true }, [DETAIL_STATEMENT])).toEqual([])
  })

  it('holds Release N while the checks are read, when one is not active or one fails (named)', () => {
    const picked = [HOLDS[0]!, HOLDS[1]!]
    expect(bulkReleaseHeld(picked, {}, VIEWER)).toEqual({ key: 'held.noRelease' })
    expect(bulkReleaseHeld([], {}, QUALITY)).toEqual({ key: 'held.pickFirst' })
    expect(bulkReleaseHeld(picked, { [HOLDS[0]!.id]: DETAIL_READY }, QUALITY)).toEqual({ key: 'held.bulkChecking' })
    expect(bulkReleaseHeld(picked, { [HOLDS[0]!.id]: DETAIL_READY, [HOLDS[1]!.id]: DETAIL_MAKER }, QUALITY)).toEqual({ key: 'held.bulkCheck', params: { count: 1, code: 'DEMO-WO-0142', check: 'NOT_MAKER' } })
    expect(bulkReleaseHeld([HOLDS[0]!, RELEASED[0]!], {}, QUALITY)).toEqual({ key: 'held.bulkNotActive', params: { count: 1 } })
    expect(bulkReleaseHeld([HOLDS[0]!, HOLDS[6]!], { [HOLDS[0]!.id]: DETAIL_READY, [HOLDS[6]!.id]: detailOf(HOLDS[6]!) }, QUALITY)).toBeNull()
  })

  it('assigns owners to holds of one site only; changes are held for readers and ended holds', () => {
    expect(bulkAssignHeld([HOLDS[0]!], VIEWER)).toBe('held.noPlace')
    expect(bulkAssignHeld([HOLDS[0]!, { ...HOLDS[1]!, siteId: 'other' }], PLACER)).toBe('held.assignSites')
    expect(bulkAssignHeld([HOLDS[0]!, RELEASED[0]!], PLACER)).toBe('held.assignNotActive')
    expect(bulkAssignHeld([HOLDS[0]!, HOLDS[1]!], PLACER)).toBeNull()
    expect(changeHeld(HOLDS[0]!, VIEWER)).toBe('held.noPlace')
    expect(changeHeld(CLOSED[0]!, PLACER)).toBe('held.notActive')
    expect(bulkNotice(2, [], 'notice.releasedMany')).toEqual({ key: 'notice.releasedMany', params: { count: 2 }, tone: 'success' })
    expect(bulkNotice(1, [{ code: 'Lot L1', words: 'No.' }], 'notice.releasedMany')).toMatchObject({ key: 'notice.bulkPartly', tone: 'warning', detail: ['Lot L1: No.'] })
  })
})

describe('the place dialog', () => {
  it('starts from a prefill (an inspection: the work order, its source) and asks the move only for stock', () => {
    const draft = placeDraftOf({ subjectType: 'WorkOrder', subjectIds: ['w1'], sourceType: 'Inspection', sourceId: 'i1' })
    expect(draft).toMatchObject({ subjectType: 'WorkOrder', ids: ['w1'], sourceType: 'Inspection', sourceId: 'i1', askQuarantine: false })
    expect(placeDraftOf(null)).toMatchObject({ subjectType: 'Lot', askQuarantine: true, sourceType: null })
    expect(withKind(placeDraftOf({ subjectType: 'Lot', codes: ['L1'] }), 'Bundle')).toMatchObject({ subjectType: 'Bundle', codes: [], askQuarantine: false })
    const id = '0190f0e2-7822-7000-8000-000000000001'
    expect(prefillFromAddress(params(`new=1&kind=WorkOrder&ids=${id},bad&source=Inspection:${id}`))).toEqual({ subjectType: 'WorkOrder', subjectIds: [id], codes: [], sourceType: 'Inspection', sourceId: id, reasonCode: null })
    expect(prefillFromAddress(params('new=1&source=Nope:x'))).toMatchObject({ subjectType: 'Lot', sourceType: null })
    expect(prefillFromAddress(params('kind=Lot'))).toBeNull()
  })

  it('says every problem at once, and the body names only the records that may be held', () => {
    const empty = placeDraftOf(null)
    expect(placeProblems(empty, null, REASONS, '2026-10-29')).toEqual(['place.problem.subjects', 'place.problem.reason'])
    const draft = { ...placeDraftOf({ subjectType: 'Lot', codes: ['DEMO-LOT-0231', 'DEMO-LOT-0233', 'DEMO-LOT-9999'] }), reasonCode: 'OTHER', expectedReleaseOn: '2026-10-01' }
    expect(placeProblems(draft, null, REASONS, '2026-10-29')).toContain('place.problem.previewing')
    expect(placeProblems(draft, PREVIEW_PROBLEMS, REASONS, '2026-10-29')).toEqual(['place.problem.records', 'place.problem.reasonNote', 'place.problem.date', 'place.problem.place'])
    const fine = { ...draft, codes: ['DEMO-LOT-0231', 'DEMO-LOT-0233'], reasonCode: 'SUPPLIER_CHECK', expectedReleaseOn: '', quarantineLocationId: PREVIEW.quarantinePlaces[0]!.id }
    expect(placeProblems(fine, PREVIEW, REASONS, '2026-10-29')).toEqual([])
    expect(placeable(PREVIEW_PROBLEMS)).toEqual(PREVIEW.subjects.map((row) => row.id))
    expect(placeBody(fine, PREVIEW)).toMatchObject({ subjectType: 'Lot', subjectIds: PREVIEW.subjects.map((row) => row.id), reasonCode: 'SUPPLIER_CHECK', askQuarantine: true, quarantineLocationId: PREVIEW.quarantinePlaces[0]!.id, expectedReleaseOn: null })
    expect(placeBody({ ...fine, askQuarantine: false }, PREVIEW)).toMatchObject({ askQuarantine: false, quarantineLocationId: null })
  })

  it("turns a refusal into our words with the fields it names; the office's day in Rome", () => {
    const refused = placeRefusal(new ApiError('invalid', 400, 'invalid', 'The hold is not valid.', null, [{ path: 'body/expectedReleaseOn', message: 'The expected release is today or later.' }, { path: 'body/subjectIds/0', message: 'x' }]))
    expect(refused).toEqual({ problem: 'place.problem.refused', lines: ['The expected release is today or later.', 'x'], fields: ['expectedReleaseOn', 'subjectIds'] })
    expect(placeRefusal(new Error('x')).problem).toBe('problem.unavailable')
    expect(fieldOf('body/reasonCode')).toBe('reasonCode')
    expect(officeToday(new Date('2026-10-30T23:30:00Z'))).toBe('2026-10-31')
  })
})

describe('where a hold opens', () => {
  it('opens in its DetailModal on the Holds page (RECORD_PAGES), and the list from its API list', () => {
    expect(RECORD_PAGES.QualityHold).toBe('/quality/holds?open=[id]')
    expect(LIST_PAGES['/quality/holds']).toBe('/quality/holds')
    expect(recordAddress({ type: 'QualityHold', id: 'h1' }, OFFICE_PAGES)).toBe('/quality/holds?open=h1')
  })
})

// ---- every design case, both languages, no key on screen ------------------------------------------------------------------

const HOLD_KEYS = Object.keys(CATALOGUE.en.holds ?? {})
const PREFIXES = [...new Set(HOLD_KEYS.map((key) => key.split('.')[0]!))].filter((prefix) => prefix.length > 2)
const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z0-9_]+)*`)

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  for (const screen of [listScreen, tagScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/(?:href|src|id|class|aria-[a-z]+|data-[a-z-]+|name|for|value)="[^"]*"/g, '')
          expect(html.length, item.id).toBeGreaterThan(300)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('Italian words where English would be (a sample), and the same keys in both languages', () => {
    const it = createScopedTranslator('it', messagesFor('it', ['holds']), 'holds')
    expect(it('list.place')).toBe('Metti un blocco')
    expect(it('bulk.release', { count: 3 })).toBe('Sblocca 3 blocchi')
    expect(it('noun.Lot', { count: 1 })).toBe('lotto')
    expect(Object.keys(CATALOGUE.it.holds ?? {}).sort()).toEqual(HOLD_KEYS.sort())
  })

  it('no money and no person in a list: owners are office users, placers are kinds', () => {
    const html = render(listScreen as DesignScreen<unknown>, listScreen.cases[0]!.model, 'en')
    expect(html).toContain('Open holds')
    expect(render(listScreen as DesignScreen<unknown>, listScreen.cases[0]!.model, 'it')).toContain('Blocchi aperti')
    expect(html).not.toMatch(/€|EUR\b/)
    expect(html).not.toMatch(/Demo Floor Worker/)
  })
})
