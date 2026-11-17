import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { messagesFor } from '../../../../../lib/i18n/messages'
import { canFor, CONTACTS, CUSTOMERS, JACKET_DETAIL, ME, PREFIX, PROSPECT_VIEW, QUOTED_VIEW, STYLE_OPTIONS, VIEW, type RoleCase } from '../../demo/fixtures'
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
  customers: view?.prospect ? { items: CUSTOMERS, problem: null } : null,
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
