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
