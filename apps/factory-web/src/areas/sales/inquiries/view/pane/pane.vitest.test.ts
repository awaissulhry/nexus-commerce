import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { messagesFor } from '../../../../../lib/i18n/messages'
import { canFor, CONTACTS, JACKET_DETAIL, ME, PREFIX, PROSPECT_VIEW, QUOTED_VIEW, STYLE_OPTIONS, VIEW, type RoleCase } from '../../demo/fixtures'
import type { InquiryView } from '../../api'
import { NAMESPACES } from '../../model'
import type { InquiryRecordModel } from '../../record-model'
import { detailsLabel, paneMenu, RequestPane, waitingShort, wordsInThread, type RequestPaneProps } from './RequestPane'

/**
 * B-TH-217 (threads plan TH-1b; O-SAL-INQ-LIST.pane-head, .pane-thread, .pane-facts; wall W08, W20, W22, W23, W37): the reading pane
 * shows ONE request of the reader's scope — the customer's own words as its first card, never editable; row 1's menu by right;
 * Details by grain (no target price without the price grain, a prospect's e-mail and phone only for who answers requests).
 */

const record = (view: InquiryView | null, role: RoleCase = 'owner', over: Partial<InquiryRecordModel> = {}): InquiryRecordModel => ({
  prefix: PREFIX,
  me: ME,
  can: canFor(role),
  live: 'live',
  loaded: view ? { status: 'ready', value: view } : { status: 'loading' },
  tab: 'request',
  draft: null,
  saving: false,
  busy: false,
  contacts: view?.party ? { items: CONTACTS, problem: null } : null,
  styles: { items: STYLE_OPTIONS, problem: null },
  details: { [JACKET_DETAIL.id]: { status: 'ready', value: JACKET_DETAIL } },
  stale: null,
  notice: null,
  dialog: null,
  pictures: false,
  ...over,
})

function render(props: Partial<RequestPaneProps> & { model: InquiryRecordModel }, locale: 'en' | 'it' = 'en'): string {
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, [...NAMESPACES, 'shell', 'ds']) }, createElement(RequestPane, { detailsOpen: true, ...props })))
}

describe('the reading pane (B-TH-217)', () => {
  it('the first card is the customer\'s own words as they came — never a field anyone edits — unless the portal thread already opens with them', () => {
    expect(wordsInThread({ source: 'PORTAL', createdBy: null })).toBe(true)
    expect(wordsInThread({ source: 'PORTAL', createdBy: { id: 'u1', name: 'Alex Demo' } })).toBe(false)
    expect(wordsInThread({ source: 'MAIL', createdBy: null })).toBe(false)
    const html = render({ model: record(VIEW) })
    expect(html).toContain('fw-rp-first')
    expect(html).toContain(VIEW.request.slice(0, 40).replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    expect(html).toContain('As written')
    // Not a field: the first card holds no input, textarea or contenteditable.
    const first = html.slice(html.indexOf('fw-rp-first'), html.indexOf('fw-rp-thread'))
    expect(first).not.toMatch(/<textarea|<input|contenteditable/)
  })

  it('row 1\'s menu by right: erasure only for a privacy admin on a prospect not yet erased; Close thread only with threads.manage; never "Close" for the pane', () => {
    expect(paneMenu(VIEW, 'pane', { erase: false, closeThread: false }, true)).toEqual(['full', 'print', 'edit', 'copy'])
    expect(paneMenu(PROSPECT_VIEW, 'pane', { erase: true, closeThread: false }, true)).toContain('erase')
    expect(paneMenu(VIEW, 'pane', { erase: true, closeThread: false }, true)).not.toContain('erase')
    expect(paneMenu({ ...PROSPECT_VIEW, prospectDetails: { ...PROSPECT_VIEW.prospectDetails!, erased: true } }, 'pane', { erase: true, closeThread: true }, false)).toEqual(['full', 'print', 'close-thread', 'copy'])
    expect(paneMenu(VIEW, 'page', undefined, false)).toEqual(['print', 'copy'])
    // The pane closes with × and Esc, never through its menu.
    const html = render({ model: record(VIEW), onClose: () => undefined })
    expect(html).toContain('aria-label="Close the request"')
    expect(html).toContain('aria-keyshortcuts="Escape"')
  })

  it('Details by grain: the target price absent without the price grain (no empty field); a prospect\'s e-mail and phone only for who answers requests', () => {
    expect(render({ model: record(VIEW, 'owner') })).toContain('Target price')
    expect(render({ model: record(VIEW, 'reader') })).not.toContain('Target price')
    const readerProspect = render({ model: record(PROSPECT_VIEW, 'reader') })
    expect(readerProspect).not.toContain('E-mail')
    const email = PROSPECT_VIEW.prospectDetails?.email
    if (email) expect(readerProspect).not.toContain(email)
    const ownerProspect = render({ model: record(PROSPECT_VIEW, 'owner') })
    expect(ownerProspect).toContain('Prospect')
  })

  it('the state pill carries the working time it waits; Details is labelled with its key facts; what was made shows the quote with its own status', () => {
    expect(waitingShort({ waiting: { for: 'US', workingMinutes: 240, overdue: false } })).toEqual({ key: 'time.hours', params: { n: 4 } })
    expect(waitingShort({ waiting: { for: null, workingMinutes: null, overdue: false } })).toBeNull()
    const say = (phrase: { key: string; params?: Record<string, string | number> }) => `${phrase.key}:${JSON.stringify(phrase.params ?? {})}`
    expect(detailsLabel({ pieces: 300, wantedDate: '2027-03-15' }, say, (value) => value ?? '')).toBe('pane.pieces:{"count":300} · 2027-03-15')
    expect(detailsLabel({ pieces: 0, wantedDate: null }, say, (value) => value ?? '')).toBeNull()
    const quoted = render({ model: record(QUOTED_VIEW) })
    expect(quoted).toContain(QUOTED_VIEW.quote!.number)
  })

  it('a request the reader may not open answers in words without naming it (W37); someone else\'s change is said with Next', () => {
    const missing = render({ model: record(null, 'owner', { loaded: { status: 'notFound' } }), onClose: () => undefined })
    expect(missing).toContain('Request not found')
    expect(missing).not.toContain(VIEW.number)
    const handled = render({ model: record(VIEW), handled: '10:42', onNext: () => undefined })
    expect(handled).toContain('Someone else changed this request at 10:42')
    expect(handled).toContain('Next request')
  })

  it('every word of the pane exists in Italian too', () => {
    const it_ = render({ model: record(VIEW) }, 'it')
    expect(it_).toContain('Come scritta')
    expect(it_).not.toMatch(/\bpane\.[a-z]+/)
  })
})

// ---- B-TH-234 (threads plan TH-3; pane-actions-F08, on B-TH-042; wall W20, W23): make or match the customer — the check first -------
import type { CustomerCheck } from '../../api'
import { customerAsksFirst, customerBodyOf, customerChoiceOf, customerDone, customerHeld } from '../../model'

describe('B-TH-234 — match before make, the lawful basis carried, never a silent guess (W23)', () => {
  const owner234 = canFor('owner')
  const BRAND = { id: '0190f0e2-5201-7000-8000-000000000001', code: 'DEMO-BRAND', name: 'Demo Moto Brand' }
  const SHOP = { id: '0190f0e2-5201-7000-8000-000000000002', code: 'DEMO-SHOP', name: 'Demo Rider Shop' }
  const base: CustomerCheck = {
    prospect: { name: 'Demo Track Club', company: 'Demo Track Club', email: 'club@track-demo.example.com', phone: null, lawfulBasis: 'CONTRACT', erased: false },
    candidates: [],
    ambiguous: false,
    suggestion: { code: 'DEMO-TRACK', legalName: 'Demo Track Club', kind: 'ORGANISATION' },
    make: { allowed: true, refusal: null },
    match: { allowed: true, refusal: null },
  }

  it('one customer found by its own contact\'s address is picked and goes alone; anything weaker asks first', () => {
    const byContact: CustomerCheck = { ...base, candidates: [{ party: BRAND, contact: { id: 'c1', name: 'Bea Esempio' }, matchedBy: 'CONTACT' }] }
    const choice = customerChoiceOf(byContact)
    expect(choice).toEqual({ mode: 'match', partyId: BRAND.id, contactId: 'c1', addContact: false })
    expect(customerAsksFirst(byContact, choice)).toBe(false)
    expect(customerHeld(byContact, choice, false, owner234, false)).toBeNull()
    expect(customerBodyOf(PROSPECT_VIEW, byContact, choice!, false)).toEqual({ version: PROSPECT_VIEW.version, match: { partyId: BRAND.id, contactId: 'c1' } })
    // Found by its domain: nothing is picked for the person; once picked it asks first, and `confirmed` goes only with the tick.
    const byDomain: CustomerCheck = { ...base, candidates: [{ party: BRAND, contact: null, matchedBy: 'DOMAIN' }] }
    expect(customerChoiceOf(byDomain)).toBeNull()
    expect(customerHeld(byDomain, null, false, owner234, false)).toEqual({ key: 'customer.held.pick' })
    const picked = { mode: 'match' as const, partyId: BRAND.id, contactId: null, addContact: true }
    expect(customerHeld(byDomain, picked, false, owner234, false)).toEqual({ key: 'customer.held.confirm' })
    expect(customerBodyOf(PROSPECT_VIEW, byDomain, picked, true)).toEqual({ version: PROSPECT_VIEW.version, match: { partyId: BRAND.id, addContact: true }, confirmed: true })
    // Two customers with the same address: ambiguous, the person picks and confirms.
    const two: CustomerCheck = { ...base, ambiguous: true, candidates: [{ party: BRAND, contact: { id: 'c1', name: 'Bea' }, matchedBy: 'CONTACT' }, { party: SHOP, contact: { id: 'c2', name: 'Carlo' }, matchedBy: 'CONTACT' }] }
    expect(customerChoiceOf(two)).toBeNull()
    expect(customerAsksFirst(two, { mode: 'match', partyId: SHOP.id, contactId: 'c2', addContact: false })).toBe(true)
  })

  it('a new customer: the suggestion when nobody was found; asks first while any was; needs the right and a code', () => {
    const fresh = customerChoiceOf(base)
    expect(fresh).toEqual({ mode: 'make', code: 'DEMO-TRACK', legalName: 'Demo Track Club', kind: 'ORGANISATION', status: 'PROSPECT' })
    expect(customerBodyOf(PROSPECT_VIEW, base, fresh!, false)).toEqual({ version: PROSPECT_VIEW.version, make: { code: 'DEMO-TRACK', legalName: 'Demo Track Club', kind: 'ORGANISATION', status: 'PROSPECT' } })
    const found: CustomerCheck = { ...base, candidates: [{ party: BRAND, contact: null, matchedBy: 'NAME' }] }
    expect(customerHeld(found, fresh, false, owner234, false)).toEqual({ key: 'customer.held.confirm' })
    expect(customerHeld({ ...base, make: { allowed: false, refusal: null } }, fresh, false, owner234, false)).toEqual({ key: 'held.needs', params: { right: 'right.parties.manage' } })
    expect(customerHeld({ ...base, make: { allowed: false, refusal: { code: 'PROSPECT_ERASED', message: 'x' } } }, fresh, false, owner234, false)?.key).toBe('refusal.PROSPECT_ERASED')
    expect(customerHeld(base, { ...fresh!, mode: 'make', code: '  ' } as never, false, owner234, false)).toEqual({ key: 'customer.held.code' })
    expect(customerHeld(base, fresh, false, canFor('reader'), false)).toEqual({ key: 'held.right', params: { right: 'right.sales.inquiries.manage' } })
  })

  it('the receipt says what happened, and that the mail joined the conversation (shared with this customer only)', () => {
    expect(customerDone({ made: 'CUSTOMER', party: BRAND, mailJoined: true }, 'INQ-DEMO-0003')).toEqual({ phrase: { key: 'done.customerMade', params: { customer: BRAND.name, number: 'INQ-DEMO-0003' } }, lines: [{ key: 'done.mailJoined' }] })
    expect(customerDone({ made: null, party: BRAND, mailJoined: false }, 'INQ-DEMO-0003').phrase.key).toBe('done.customerMatched')
    expect(customerDone({ made: 'CONTACT', party: BRAND, mailJoined: false }, 'INQ-DEMO-0003').phrase.key).toBe('done.customerContact')
  })
})
// ---- end B-TH-234

// ---- B-TH-290 (threads plan TH-9, on B-TH-094; O-SAL-INQ-LIST.list-F10, .pane-head-F07, .pane-facts; wall W37): production's answer ----
import { portalRequestView } from '@nexus/factory-domain/sales/portal-requests/contracts'
import { requestViewSchema } from '../../../../../portal/customer/requests/api'
import { PRODUCTION_ACTION, PRODUCTION_NOT_MINE, PRODUCTION_OK, PRODUCTION_WEEKS_LATE } from '../../demo/fixtures'
import type { ProductionSuggestion } from '../../api'
import {
  answersHere,
  companyToday,
  draftFromSuggestion,
  productionBodyOf,
  productionCell,
  productionDraftOf,
  productionHeld,
  productionLate,
  productionProblem,
  productionProblems,
  productionTone,
  savedNotice,
  suggestionLine,
  suggestionProblem,
  takeBackBodyOf,
  weekChoices,
  type ProductionEditor,
  type ProductionModel,
} from '../../production-answer'

describe('B-TH-290 — production\'s answer on a request: the chip, the column, typed in Details, offered by planning', () => {
  const TODAY = '2026-11-17'
  const asSales = { ...VIEW, production: PRODUCTION_WEEKS_LATE, productionAction: PRODUCTION_NOT_MINE }
  const asProduction = { ...VIEW, production: null, productionAction: PRODUCTION_ACTION }
  const closed = { ...QUOTED_VIEW, production: PRODUCTION_OK, productionAction: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } } }
  const modelOf = (view: InquiryView, editor: ProductionEditor | null = null, offline = false): ProductionModel => ({ current: view.production ?? null, answers: answersHere(view), held: productionHeld(view, offline), editor, today: TODAY })
  const SUGGESTION: ProductionSuggestion = {
    inquiry: { id: VIEW.id, number: VIEW.number, version: VIEW.version, wantedDate: VIEW.wantedDate },
    site: { id: '0190f0e2-6101-7000-8000-000000000001', code: 'PLANT-1', name: 'Demo plant' },
    today: TODAY,
    suggestion: { answer: 'NOT_BEFORE', notBefore: '2027-02-08', week: '2027-W06', readyDate: '2027-02-10', partial: true, words: { it: 'Pronto il 2027-02-10: la pianificazione suggerisce "non prima della settimana 6 del 2027".', en: 'Ready on 2027-02-10: planning suggests "not before week 6 of 2027".' } },
    lines: [
      { lineId: VIEW.lines[0]!.id, seq: 10, date: '2027-02-03', complete: true, meetsWanted: false, words: 'x', warnings: [] },
      { lineId: VIEW.lines[1]!.id, seq: 20, date: '2027-02-10', complete: false, meetsWanted: false, words: 'x', warnings: [] },
    ],
    leftOut: [{ lineId: VIEW.lines[3]!.id, seq: 40, why: { it: 'Chiesta a parole: nessun modello da pianificare.', en: 'Asked in words: no style to plan.' } }],
    current: null,
  }
  const editorOf = (view: InquiryView, over: Partial<ProductionEditor> = {}): ProductionEditor => ({ draft: productionDraftOf(view.production ?? null, TODAY), weeks: weekChoices(TODAY), suggestion: { status: 'ready', value: SUGGESTION }, plants: null, plantId: null, busy: false, notice: null, ...over })

  it('the cell and the chip say the answer in the column\'s words, amber for a week and green for OK, with how late it is against the wanted date', () => {
    expect(productionCell(PRODUCTION_OK, TODAY)).toEqual({ key: 'production.cell.OK' })
    expect(productionCell({ answer: 'NOT_BEFORE', week: '2026-W50', weekNumber: 50 }, TODAY)).toEqual({ key: 'production.cell.notBefore', params: { week: 50 } })
    expect(productionCell(PRODUCTION_WEEKS_LATE, TODAY)).toEqual({ key: 'production.cell.notBeforeYear', params: { week: 6, year: 2027 } })
    expect(productionCell(null, TODAY)).toBeNull()
    expect(productionTone(PRODUCTION_OK)).toBe('success')
    expect(productionTone(PRODUCTION_WEEKS_LATE)).toBe('warning')
    expect(productionLate(PRODUCTION_WEEKS_LATE)).toEqual({ key: 'production.lateWeeks', params: { count: 3 } })
    expect(productionLate({ daysAfterWanted: 4 })).toEqual({ key: 'production.late', params: { count: 4 } })
    expect(productionLate({ daysAfterWanted: 0 })).toBeNull()
    expect(productionLate(PRODUCTION_OK)).toBeNull()
  })

  it('who types it: planning or the production manager (the record\'s productionAction); sales is told who does, a closed request keeps its answer, offline holds it', () => {
    expect([answersHere(asProduction), productionHeld(asProduction, false)]).toEqual([true, null])
    expect(productionHeld(asProduction, true)).toEqual({ key: 'held.offline' })
    expect([answersHere(asSales), productionHeld(asSales, false)]).toEqual([false, { key: 'production.held.notProduction' }])
    expect([answersHere(closed), productionHeld(closed, false)]).toEqual([true, { key: 'refusal.CLOSED', params: { number: QUOTED_VIEW.number } }])
    // A view without the action (an older answer, a design case): nobody is offered the editor.
    expect(answersHere({ productionAction: undefined })).toBe(false)
  })

  it('the weeks offered start at this week (the API refuses a week that is over) and cross the ISO year as the API counts it', () => {
    const weeks = weekChoices(TODAY)
    expect(weeks).toHaveLength(53)
    expect(weeks[0]).toEqual({ key: '2026-W47', week: 47, year: 2026, from: '2026-11-16', to: '2026-11-22' })
    const turn = weekChoices('2026-12-30', 3)
    expect(turn.map((week) => week.key)).toEqual(['2026-W53', '2027-W01', '2027-W02'])
    expect(companyToday(new Date('2026-12-31T23:30:00.000Z'))).toBe('2027-01-01')
  })

  it('the draft starts from the answer as it is (a week that is over: none picked); Save needs an answer and, for not before, a week from this one on', () => {
    expect(productionDraftOf(null, TODAY)).toEqual({ answer: null, week: '' })
    expect(productionDraftOf(PRODUCTION_OK, TODAY)).toEqual({ answer: 'OK', week: '' })
    expect(productionDraftOf(PRODUCTION_WEEKS_LATE, TODAY)).toEqual({ answer: 'NOT_BEFORE', week: '2027-W06' })
    expect(productionDraftOf({ answer: 'NOT_BEFORE', week: '2026-W40' }, TODAY)).toEqual({ answer: 'NOT_BEFORE', week: '' })
    expect(productionProblems({ answer: null, week: '' }, TODAY)).toEqual(['production.problem.pick'])
    expect(productionProblems({ answer: 'NOT_BEFORE', week: '' }, TODAY)).toEqual(['production.problem.week'])
    expect(productionProblems({ answer: 'NOT_BEFORE', week: '2026-W46' }, TODAY)).toEqual(['production.problem.past'])
    expect(productionProblems({ answer: 'NOT_BEFORE', week: '2026-W47' }, TODAY)).toEqual([])
    expect(productionProblems({ answer: 'OK', week: '' }, TODAY)).toEqual([])
  })

  it('the body carries the request\'s version: OK alone, not before with its week, null to take it back', () => {
    expect(productionBodyOf(VIEW, { answer: 'OK', week: '2027-W06' })).toEqual({ version: VIEW.version, answer: 'OK' })
    expect(productionBodyOf(VIEW, { answer: 'NOT_BEFORE', week: '2027-W06' })).toEqual({ version: VIEW.version, answer: 'NOT_BEFORE', week: '2027-W06' })
    expect(takeBackBodyOf(VIEW)).toEqual({ version: VIEW.version, answer: null })
    expect(savedNotice({ number: VIEW.number, production: PRODUCTION_WEEKS_LATE })).toEqual({ key: 'production.done.savedWeek', params: { number: VIEW.number, week: 6 }, tone: 'success' })
    expect(savedNotice({ number: VIEW.number, production: PRODUCTION_OK }).key).toBe('production.done.savedOk')
    expect(savedNotice({ number: VIEW.number, production: null }).key).toBe('production.done.takenBack')
  })

  it('planning\'s suggestion is offered, never written: "Use this" fills the draft; its lines in our words; a plant to pick when the company has several', () => {
    expect(draftFromSuggestion(SUGGESTION)).toEqual({ answer: 'NOT_BEFORE', week: '2027-W06' })
    expect(draftFromSuggestion({ suggestion: { ...SUGGESTION.suggestion, answer: 'OK', week: null } })).toEqual({ answer: 'OK', week: '' })
    expect(draftFromSuggestion({ suggestion: { ...SUGGESTION.suggestion, answer: null, week: null } })).toBeNull()
    expect(suggestionLine(SUGGESTION.lines[0]!)).toEqual({ key: 'production.suggest.line', params: { seq: 10, date: '2027-02-03' } })
    expect(suggestionLine(SUGGESTION.lines[1]!)).toEqual({ key: 'production.suggest.linePart', params: { seq: 20, date: '2027-02-10' } })
    expect(suggestionLine({ ...SUGGESTION.lines[0]!, date: null })).toEqual({ key: 'production.suggest.lineNone', params: { seq: 10 } })
    expect(suggestionProblem('invalid', ['querystring/siteId'], 2)).toBe('production.suggest.several')
    expect(suggestionProblem('invalid', ['querystring/siteId'], 1)).toBe('production.suggest.noPlant')
    expect(suggestionProblem('forbidden', [], 2)).toBe('production.suggest.forbidden')
    expect(suggestionProblem(null, [], 0)).toBe('production.suggest.failed')
  })

  it('a refused save in our words: nothing to take back, a closed request, someone changed it first (read again), the right; a network failure may go again', () => {
    expect(productionProblem('NO_ANSWER', 'conflict', VIEW.number)).toEqual({ phrase: { key: 'production.problem.noAnswer' }, stale: false, retry: false })
    expect(productionProblem('CLOSED', 'conflict', VIEW.number).phrase).toEqual({ key: 'refusal.CLOSED', params: { number: VIEW.number } })
    expect(productionProblem(null, 'conflict', VIEW.number)).toEqual({ phrase: { key: 'production.problem.stale' }, stale: true, retry: false })
    expect(productionProblem(null, 'invalid', VIEW.number).phrase.key).toBe('production.problem.invalid')
    expect(productionProblem(null, 'forbidden', VIEW.number).phrase.key).toBe('production.held.notProduction')
    expect(productionProblem(null, 'network', VIEW.number)).toEqual({ phrase: { key: 'production.problem.unavailable' }, stale: false, retry: true })
  })

  it('row 1 carries the chip once production answered; Details says who answered, when and how late, and who types it — sales never gets the editor', () => {
    const html = render({ model: record(asSales, 'owner', { production: modelOf(asSales) }) })
    expect(html).toContain('Production: not before week 6 of 2027')
    expect(html).toContain('3 weeks after the wanted date')
    expect(html).toContain('Answered by Marta Demo')
    expect(html).toContain('Planning or the production manager types it here')
    expect(html).toContain('Office only: the customer never sees it.')
    expect(html).not.toContain('Answer for production')
    expect(html).not.toContain('Change the answer')
    // Not answered: no chip on row 1.
    const none = render({ model: record(asProduction, 'production', { production: modelOf(asProduction) }) })
    const head = none.slice(none.indexOf('fw-rp-head'), none.indexOf('fw-rp-row2'))
    expect(head).not.toContain('Production:')
    expect(none).toContain('Production has not answered yet.')
    expect(none).toContain('Answer for production')
  })

  it('the production manager types it in Details: OK or not before a week, planning\'s suggestion with its lines and the lines left out, Save, Take back, Cancel', () => {
    const editing = { ...asProduction, production: PRODUCTION_WEEKS_LATE }
    // His draft (week 10) differs from planning's week 6: "Use this suggestion" offers it.
    const html = render({ model: record(editing, 'production', { production: modelOf(editing, editorOf(editing, { draft: { answer: 'NOT_BEFORE', week: '2027-W10' } })) }) })
    expect(html).toContain('OK, we can make it')
    expect(html).toContain('Not before a week')
    expect(html).toContain('Use this suggestion')
    expect(html).toContain('Asked in words: no style to plan.')
    expect(html).toContain('Save the answer')
    expect(html).toContain('Take the answer back')
    // The week list starts at this week and offers the weeks of 2027 (picked: the draft's).
    expect(html).toMatch(/<option value="2027-W10" selected="">/)
    expect(html).toContain('value="2027-W06"')
    expect(html).not.toContain('value="2026-W46"')
    // A closed request: "Change the answer" held with why (the answer stays).
    const shut = render({ model: record(closed, 'production', { production: modelOf(closed) }) })
    expect(shut).toContain('Change the answer')
    expect(shut).toContain('is closed: only its note can change')
  })

  it('⋯ "Production answer…" is offered to who types it, before "Start a project…"; never to sales', () => {
    expect(paneMenu(VIEW, 'pane', { erase: false, closeThread: false }, true, true, true)).toEqual(['full', 'print', 'edit', 'production', 'project', 'copy'])
    expect(paneMenu(VIEW, 'pane', { erase: false, closeThread: false }, true, true, false)).not.toContain('production')
  })

  it('every word of it exists in Italian too', () => {
    const html = render({ model: record(asSales, 'owner', { production: modelOf(asSales) }) }, 'it')
    expect(html).toContain('Produzione: non prima della settimana 6 del 2027')
    expect(html).toContain('3 settimane dopo la data voluta')
    expect(html).not.toMatch(/\bproduction\.[a-zA-Z]+/)
  })

  it('W37: the answer is office data — the portal\'s request contract and the portal page\'s schema have no such field (a portal answer that had one is cut)', () => {
    for (const shape of [portalRequestView.shape, requestViewSchema.shape]) {
      expect(Object.keys(shape)).not.toContain('production')
      expect(Object.keys(shape)).not.toContain('productionAction')
    }
  })
})
// ---- end B-TH-290

// ---- B-TH-286 (B-TH-091; O-SAL-INQ-LIST.pane-facts-F06): the Request note becomes the thread's first pinned office note ------------
describe('B-TH-286 — "Move to the thread as a pinned note"', () => {
  const noted: InquiryView = { ...VIEW, note: 'Bea prefers a call in the morning.' }

  it('is offered under the Request note when the container offers it (sales.inquiries.manage + threads.post), with why it exists', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = render({ model: record(noted, 'owner', { pinNote: { busy: false, held: null } }), actions: { onPinNote: () => undefined } }, locale)
      expect(html).toContain(locale === 'en' ? 'Move to the thread as a pinned note' : 'Sposta nella conversazione come nota fissata')
      expect(html).toContain(locale === 'en' ? 'One place for office notes' : 'Un solo posto per le note d&#x27;ufficio') // B-TH-215: one word (the apostrophe as the markup escapes it)
      expect(html).not.toMatch(/pane\.pinNote\./)
    }
  })

  it('is not offered without the container’s offer, without a note, and is held offline with why', () => {
    expect(render({ model: record(noted, 'owner', { pinNote: null }), actions: { onPinNote: () => undefined } })).not.toContain('Move to the thread as a pinned note')
    expect(render({ model: record({ ...VIEW, note: null }, 'owner', { pinNote: { busy: false, held: null } }), actions: { onPinNote: () => undefined } })).not.toContain('Move to the thread as a pinned note')
    const held = render({ model: record(noted, 'owner', { pinNote: { busy: false, held: 'pane.pinNote.offline' } }), actions: { onPinNote: () => undefined } })
    expect(held).toContain('You are offline.')
  })

  it('the container posts it through the one call and reads the request again (the field emptied by the API)', async () => {
    const { readFileSync } = await import('node:fs')
    const container = readFileSync(new URL('../../use-inquiry.tsx', import.meta.url), 'utf8')
    expect(container).toContain('await pinRequestNote(api, now.id)')
    expect(container).toContain("const mayPinNote = can.manage && session.permissions.includes('threads.post') && can.thread")
  })
})
// ---- end B-TH-286
