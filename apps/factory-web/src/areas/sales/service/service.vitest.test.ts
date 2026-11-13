import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  actionLinkNote,
  CASE_CHANNELS,
  CASE_KINDS,
  CASE_PRIORITIES,
  CASE_STATUSES,
  CASE_VIEWS,
  CASE_WISHES,
  COVER_DECISIONS,
  COVER_STATES,
  COVERS,
  coverProblems,
  coverWarnings,
  HELD_CODES,
  LINK_RECORD_TYPES,
  moveProblems,
  warrantyCheckOf,
  type Cover,
  type CoverDecision,
} from '@nexus/factory-domain/sales/service/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { BUSINESS_CASE, CHECK_BUSINESS, CHECK_CONSUMER, CHECK_ENDED, CHECK_RIDER, CLOSED_CASE, CONSUMER_CASE, OPEN_ROWS, PREFIX, ROLE_PERMISSIONS, ROWS } from './demo/fixtures'
import { designScreen as listScreen } from './list/fixtures'
import {
  addressOf,
  addressText,
  caseChangesOf,
  caseDraftOf,
  caseDraftProblems,
  chipsOf,
  coverDraftProblems,
  coverDraftWarnings,
  emptyNewDraft,
  FIELD_NAMES,
  HOME_ADDRESS,
  KNOWN_RIGHTS,
  linkNoteOf,
  MAIL_STATUSES,
  MOVE_ACTIONS,
  moveBodyOf,
  moveDraftHeld,
  moveNeeds,
  newBodyOf,
  newDraftHeld,
  pageNotices,
  previewBodyOf,
  primaryOf,
  PROBLEM_KEYS,
  recordHref,
  refusalOf,
  rowVerbHeld,
  SAVED_ROWS,
  serviceCan,
  tileValue,
  TILES,
  warningPhrase,
  warrantyLines,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

const owner = serviceCan(ROLE_PERMISSIONS.owner)
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['sales-service']!
const params = (text: string) => new URLSearchParams(text.replace(/^\?/, ''))

describe('who may do what, by the role templates (B-W2b-345)', () => {
  it('sales follows up and decides the cover; quality follows up without deciding; production reads; the warehouse has no page', () => {
    const sales = serviceCan(ROLE_PERMISSIONS.sales)
    expect([sales.view, sales.manage, sales.decide]).toEqual([true, true, true])
    const inspector = serviceCan(ROLE_PERMISSIONS.inspector)
    expect([inspector.view, inspector.manage, inspector.decide]).toEqual([true, true, false])
    const production = serviceCan(ROLE_PERMISSIONS.production)
    expect([production.view, production.manage, production.decide]).toEqual([true, false, false])
    expect(serviceCan(ROLE_PERMISSIONS.warehouse).view).toBe(false)
  })
})

describe('the address: the tiles and saved rows are the API’s `view`, one chip per filter', () => {
  it('reads and writes every term; the default row is Open; nonsense is dropped', () => {
    const address = { ...HOME_ADDRESS, view: 'waitingPart' as const, kind: 'WARRANTY' as const, cover: 'UNKNOWN' as const, serial: 'DEMO-SN-1', q: 'zip', isNew: true }
    expect(addressOf(params(addressText(address)))).toEqual(address)
    expect(addressText(HOME_ADDRESS)).toBe('')
    expect(addressOf(params('view=nope&kind=X&cover=Y'))).toEqual(HOME_ADDRESS)
  })

  it('every tile and saved row is a view the API takes; a chip per filter, the pressed tile’s too', () => {
    for (const view of [...TILES, ...SAVED_ROWS]) expect(CASE_VIEWS).toContain(view)
    expect(chipsOf(HOME_ADDRESS)).toEqual([])
    expect(chipsOf({ ...HOME_ADDRESS, view: 'new', kind: 'SAFETY', q: 'x' }).map((chip) => chip.id)).toEqual(['view', 'kind', 'q'])
  })

  it('an unknown count is "—", never 0', () => {
    expect(tileValue(null, 'new')).toBe('—')
    expect(tileValue({ tiles: { new: 0, waitingCustomer: 2, waitingPart: 1 } }, 'new')).toBe('0')
  })

  it('a case opens its page; a row verb opens it with that verb’s dialog', () => {
    expect(recordHref(PREFIX, 'c1')).toBe(`${PREFIX}/sales/service/c1`)
    expect(recordHref(PREFIX, 'c1', 'actions', 'repair')).toBe(`${PREFIX}/sales/service/c1?tab=actions&do=repair`)
  })
})

describe('the notices and the row verbs', () => {
  it('no delivery day, a cover to decide, no customer, the first page only; a dismissed one stays away until its value changes', () => {
    const notices = pageNotices(OPEN_ROWS, true, PREFIX, new Set())
    expect(notices.map((notice) => notice.id)).toEqual(['unknown:1', 'undecided:1', 'noCustomer:1', `partial:${OPEN_ROWS.length}`])
    expect(pageNotices(OPEN_ROWS, false, PREFIX, new Set(['unknown:1'])).map((notice) => notice.id)).toEqual(['undecided:1', 'noCustomer:1'])
    expect(pageNotices(OPEN_ROWS, false, PREFIX, new Set(['unknown:7']))[0]!.id).toBe('unknown:1')
  })

  it('a verb is held before the click: the right, no customer, a closed case, offline', () => {
    const open = ROWS[0]!
    expect(rowVerbHeld(open, 'repair', owner, false)).toBeNull()
    expect(rowVerbHeld(open, 'repair', serviceCan(ROLE_PERMISSIONS.production), false)?.key).toBe('held.right')
    expect(rowVerbHeld({ ...open, party: null }, 'return', owner, false)?.key).toBe('held.NO_CUSTOMER')
    expect(rowVerbHeld({ ...open, status: 'CLOSED' }, 'close', owner, false)?.key).toBe('held.ALREADY_CLOSED')
    expect(rowVerbHeld(open, 'close', owner, true)?.key).toBe('held.offline')
  })
})

describe('the warranty check in our words (never the API’s sentences)', () => {
  it('a consumer: delivery, the legal guarantee with its days, the first year; no factory guarantee', () => {
    const lines = warrantyLines(CHECK_CONSUMER)
    expect(lines.map((line) => [line.id, line.state, line.text.key])).toEqual([
      ['delivery', 'OK', 'check.deliveredOn'],
      ['buyer', 'OK', 'buyer.CONSUMER'],
      ['legal', 'OK', 'legal.RUNS'],
      ['presumption', 'OK', 'presumption.applies'],
      ['factory', 'NOT_NEEDED', 'factory.NONE'],
    ])
    expect(lines[2]!.more).toEqual({ key: 'check.daysLeft', params: { count: 484 } })
  })

  it('a business, a rider with no delivery day, an ended guarantee', () => {
    expect(warrantyLines(CHECK_BUSINESS).find((line) => line.id === 'legal')!.text.key).toBe('legal.NONE_BUSINESS')
    expect(warrantyLines(CHECK_BUSINESS).find((line) => line.id === 'factory')!.state).toBe('OK')
    expect(warrantyLines(CHECK_RIDER)[0]!.state).toBe('UNKNOWN')
    expect(warrantyLines(CHECK_ENDED).find((line) => line.id === 'legal')!.state).toBe('OPEN')
    expect(warrantyLines(CHECK_ENDED).find((line) => line.id === 'presumption')!.state).toBe('WARNING')
  })

  it('the cover decision’s checks and warnings are factory-domain’s own (coverProblems, coverWarnings), field by field', () => {
    const check = warrantyCheckOf({ today: '2026-11-12', buyer: 'CONSUMER', deliveredOn: '2026-03-10', legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: null })
    for (const cover of COVERS)
      for (const decision of COVER_DECISIONS)
        for (const note of ['', 'Why.'])
          for (const ends of [{ legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: null }, { legalGuaranteeEndsOn: '2028-03-10', factoryGuaranteeEndsOn: '2027-01-01' }]) {
            const draft = { cover: cover as Cover, decision: decision as CoverDecision, note }
            const ours = coverDraftProblems(draft, ends)
            const theirs = coverProblems({ ...draft, ...ends })
            expect(Object.keys(ours).sort(), `${cover} ${decision} ${note}`).toEqual([...new Set(theirs.map((issue) => issue.path.slice(5)))].sort())
            expect(coverDraftWarnings(draft, check).length, `${cover} ${decision}`).toBe(coverWarnings({ ...draft, check }).length)
          }
  })
})

describe('the moves, the Case form and New case', () => {
  it('the band’s one primary per status: open, decide a warranty claim’s cover, resolve, resume, close', () => {
    expect(primaryOf({ ...CONSUMER_CASE, status: 'NEW' })).toEqual({ kind: 'move', action: 'open' })
    expect(primaryOf(CONSUMER_CASE)).toEqual({ kind: 'decide' })
    expect(primaryOf(BUSINESS_CASE)).toEqual({ kind: 'move', action: 'resume' })
    expect(primaryOf({ ...BUSINESS_CASE, status: 'OPEN' })).toEqual({ kind: 'move', action: 'resolve' })
    expect(primaryOf({ ...BUSINESS_CASE, status: 'RESOLVED' })).toEqual({ kind: 'move', action: 'close' })
    expect(primaryOf(CLOSED_CASE)).toBeNull()
  })

  it('a move asks what factory-domain’s moveProblems asks; the body carries only what the move takes', () => {
    for (const from of CASE_STATUSES)
      for (const action of MOVE_ACTIONS) {
        const to = action === 'resolve' ? 'RESOLVED' : action === 'close' ? 'CLOSED' : action === 'waitCustomer' ? 'WAITING_CUSTOMER' : action === 'waitPart' ? 'WAITING_PART' : 'OPEN'
        const needs = moveNeeds(from, to, false)
        const empty = { action, resolution: '', reason: '', message: '' }
        expect(moveDraftHeld(empty, needs) !== null, `${from} → ${to}`).toBe(moveProblems({ ...moveBodyOf(empty, 1, needs), from }).length > 0)
      }
    expect(moveBodyOf({ action: 'resolve', resolution: ' Sewn. ', reason: '', message: 'Ready.' }, 4, moveNeeds('OPEN', 'RESOLVED', true))).toEqual({ version: 4, to: 'RESOLVED', resolution: 'Sewn.', message: 'Ready.' })
  })

  it('nothing changed: nothing sent; a closed case sends its note only; the customer only while nothing is linked', () => {
    expect(caseChangesOf(CONSUMER_CASE, caseDraftOf(CONSUMER_CASE))).toEqual({})
    expect(caseChangesOf(CONSUMER_CASE, { ...caseDraftOf(CONSUMER_CASE), priority: 'HIGH', deliveredOn: '' })).toEqual({ priority: 'HIGH', deliveredOn: null })
    expect(caseChangesOf(CLOSED_CASE, { ...caseDraftOf(CLOSED_CASE), priority: 'HIGH', internalNote: 'x' })).toEqual({ internalNote: 'x' })
    expect(caseChangesOf(BUSINESS_CASE, { ...caseDraftOf(BUSINESS_CASE), partyId: '' })).toEqual({})
    expect(caseDraftProblems({ ...caseDraftOf(CONSUMER_CASE), notifyCustomer: true }, '2026-11-12', null).notifyCustomer?.key).toBe('form.problem.notifyNeedsEmail')
    expect(caseDraftProblems({ ...caseDraftOf(CONSUMER_CASE), deliveredOn: '2026-12-01' }, '2026-11-12', null).deliveredOn?.key).toBe('form.problem.deliveredFuture')
  })

  it('New case: held until the problem is said; the preview reads once a serial, batch or customer is named; the body is what the API takes', () => {
    const draft = emptyNewDraft('me')
    expect(newDraftHeld(draft, '2026-11-12', null)?.key).toBe('form.problem.problemNeeded')
    expect(previewBodyOf(draft, 'co')).toBeNull()
    expect(previewBodyOf({ ...draft, serial: ' SN-1 ' }, 'co')).toEqual({ companyId: 'co', kind: 'WARRANTY', channel: 'PHONE', serial: 'SN-1' })
    const filled = { ...draft, problem: ' Torn. ', serial: 'SN-1' }
    expect(newDraftHeld(filled, '2026-11-12', null)).toBeNull()
    expect(newBodyOf(filled, 'co')).toMatchObject({ companyId: 'co', kind: 'WARRANTY', channel: 'PHONE', partyId: null, serial: 'SN-1', problem: 'Torn.', ownerId: 'me', notifyCustomer: false })
  })
})

describe('refusals and the API’s English never shown', () => {
  it('a held code, the fields, a stale version, a duplicate link, each in our words', () => {
    expect(refusalOf(new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: 'held/COVER_UNDECIDED', message: 'x' }])).lines).toEqual([{ key: 'held.COVER_UNDECIDED' }])
    expect(refusalOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/notifyCustomer', message: 'x' }])).lines).toEqual([{ key: 'field.notifyCustomer' }])
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version', message: 'x' }])).stale).toBe(true)
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'x', null, []), true).say.key).toBe('problem.duplicate')
    expect(refusalOf(new ApiError('conflict', 409, 'invalid_state', 'x', null, [])).say.key).toBe('problem.refused')
  })

  it('the notes the case’s own actions write are said in our words; a person’s note as typed', () => {
    for (const via of ['REPAIR', 'RETURN', 'REMAKE', 'CREDIT'] as const) expect(linkNoteOf(actionLinkNote(via, 'X-1')).via).toEqual({ key: `linked.via.${via}` })
    expect(linkNoteOf('The second jacket')).toEqual({ via: null, words: 'The second jacket' })
    expect(warningPhrase('body/serial')).toEqual({ key: 'warning.serial' })
    expect(warningPhrase('body/whatever')).toEqual({ key: 'warning.other' })
  })
})

describe('words and navigation', () => {
  it('every code, status, kind, channel, wish, priority, cover, decision, view, held code, field, right and mail state has words in both languages', () => {
    for (const locale of LOCALES) {
      const all = words(locale)
      const has = (key: string) => expect(all[key] ?? all[`${key}_other`], `${locale} ${key}`).toBeTruthy()
      for (const status of CASE_STATUSES) has(`status.${status}`)
      for (const kind of CASE_KINDS) has(`kind.${kind}`)
      for (const channel of CASE_CHANNELS) has(`channel.${channel}`)
      for (const wish of CASE_WISHES) has(`wish.${wish}`)
      for (const priority of CASE_PRIORITIES) has(`priority.${priority}`)
      for (const cover of COVER_STATES) has(`cover.${cover}`)
      for (const cover of COVERS) [`coverName.${cover}`, `remedies.${cover}`, `decide.coverHint.${cover}`].forEach(has)
      for (const decision of COVER_DECISIONS) has(`decision.${decision}`)
      for (const view of CASE_VIEWS) has(`view.${view}`)
      for (const tile of TILES) [`tile.${tile}`, `tile.hint.${tile}`].forEach(has)
      for (const code of HELD_CODES) has(`held.${code}`)
      for (const field of FIELD_NAMES) has(`field.${field}`)
      for (const right of KNOWN_RIGHTS) has(`right.${right}`)
      for (const status of MAIL_STATUSES) has(`mailStatus.${status}`)
      for (const type of LINK_RECORD_TYPES) has(`linkType.${type}`)
      for (const key of PROBLEM_KEYS) has(key)
      for (const action of MOVE_ACTIONS) [`move.title.${action}`, `move.go.${action}`, `band.move.${action}`].forEach(has)
    }
  })

  it('the pages are built, in the navigation of the roles that read them; a case opens its page', () => {
    expect(OFFICE_PAGES.has('/sales/service')).toBe(true)
    expect(OFFICE_PAGES.has('/sales/service/[id]')).toBe(true)
    expect(recordAddress({ type: 'ServiceCase', id: 'c1' }, OFFICE_PAGES)).toBe('/sales/service/c1')
    expect(listAddress('/sales/service/cases', { view: 'new' }, OFFICE_PAGES)).toBe('/sales/service?view=new')
    const rows = (permissions: readonly string[]) => officeNavFor(permissionCheck([...permissions])).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))
    for (const role of ['sales', 'inspector', 'production'] as const) expect(rows(ROLE_PERMISSIONS[role]), role).toContain('/sales/service')
    expect(rows(ROLE_PERMISSIONS.warehouse)).not.toContain('/sales/service')
    const sales = rows(ROLE_PERMISSIONS.sales)
    expect(sales.indexOf('/sales/service')).toBe(sales.indexOf('/sales/returns') + 1)
  })
})

const LEFT_KEY = /\b(?:common|held|list|record|tile|new|tab|live|row|col|keys|notice|chip|status|kind|channel|wish|priority|cover|coverName|decision|view|right|problem|field|warning|check|checkState|buyer|legal|presumption|factory|remedies|liable|warranty|decide|linked|linkType|link|unlink|actions|repair|return|move|band|mails|mailStatus|activity|garment|form|scan|suggested|noAccess)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
            .replace(/\b(?:sales|product|products|files|example|email|quotes|money|threads|parties)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
            .replace(/\bart\.\s?\d+/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
