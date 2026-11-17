import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { messagesFor } from '../../../../lib/i18n/messages'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { officeRedirects, renamedAddress } from '../../../../shell/nav/renamed'
import { canFor, CONTACTS, JACKET_DETAIL, ME, PREFIX, ROWS, STYLE_OPTIONS, VIEW } from '../demo/fixtures'
import type { InquiryView } from '../api'
import { addressOf, backAddressOf, backHref, fullPageHref, HOME_ADDRESS, NAMESPACES } from '../model'
import type { InquiryRecordModel } from '../record-model'
import { InquiryPageView, type InquiryPageProps } from '../view/InquiryPageView'

/**
 * B-TH-219 (threads plan TH-1b; O-SAL-INQ-REC.band, .thread, .side, PL5; wall W08, W09, W20, W22, W34, W37): the request's full
 * page is the reading pane's own parts (one part, not two), the old address redirects, Back returns to the list it came from with
 * its filters, and a request outside the reader's scope answers "not found" without naming it.
 */

const record = (view: InquiryView | null, over: Partial<InquiryRecordModel> = {}): InquiryRecordModel => ({
  prefix: PREFIX,
  me: ME,
  can: canFor('owner'),
  live: 'live',
  loaded: view ? { status: 'ready', value: view } : { status: 'loading' },
  tab: 'request',
  draft: null,
  saving: false,
  busy: false,
  customers: null,
  contacts: { items: CONTACTS, problem: null },
  styles: { items: STYLE_OPTIONS, problem: null },
  details: { [JACKET_DETAIL.id]: { status: 'ready', value: JACKET_DETAIL } },
  stale: null,
  notice: null,
  dialog: null,
  pictures: false,
  ...over,
})

const render = (props: Partial<InquiryPageProps> & { model: InquiryRecordModel }) =>
  renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', [...NAMESPACES, 'shell', 'ds']) }, createElement(InquiryPageView, props)))

describe('the request\'s full page (B-TH-219)', () => {
  it('is the reading pane\'s parts on a page: row 1, the ONE main button, the customer\'s words, the thread, Details — "i" for the phone sheet', () => {
    const html = render({ model: record(VIEW), thread: createElement('div', { className: 'demo-thread' }) })
    for (const part of ['fw-rp is-page', 'fw-rp-head', 'fw-rp-row2', 'fw-rp-first', 'demo-thread', 'fw-rp-details', 'fw-rp-info']) expect(html, part).toContain(part)
    expect(html).toContain('Make quote')
    // The page offers no "Open full page" of itself and no × (it is a page, not a pane).
    expect(html).not.toContain('aria-label="Close the request"')
  })

  it('opens at /sales/incoming/<id>; the old /sales/inquiries/<id> redirects there with its query', () => {
    expect(OFFICE_PAGES.has('/sales/incoming/[id]')).toBe(true)
    expect(recordAddress({ type: 'Inquiry', id: 'r1' }, OFFICE_PAGES)).toBe('/sales/incoming/r1')
    expect(renamedAddress('/sales/inquiries/r1?tab=files')).toBe('/sales/incoming/r1?tab=files')
    expect(officeRedirects().some((rule) => rule.source === '/w/:company/sales/inquiries/:rest*' && rule.destination === '/w/:company/sales/incoming/:rest*')).toBe(true)
  })

  it('Back to Incoming returns to the same filters with this request open; ?back= takes a query only (never an address of its own)', () => {
    const list = addressOf(new URLSearchParams('tile=ALL&source=MAIL&q=jacket'))
    const href = fullPageHref('/w/DEMO', 'r1', list)
    expect(href).toBe(`/w/DEMO/sales/incoming/r1?back=${encodeURIComponent('?tile=ALL&source=MAIL&q=jacket')}`)
    const back = backAddressOf(new URL(`https://x.example.com${href}`).searchParams)
    expect(back.address).toMatchObject({ tile: 'ALL', source: 'MAIL', q: 'jacket' })
    expect(backHref('/w/DEMO', back.address, 'r1')).toBe('/w/DEMO/sales/incoming?tile=ALL&source=MAIL&q=jacket&open=r1')
    expect(backAddressOf(new URLSearchParams('back=https://elsewhere.example.com')).address).toEqual(HOME_ADDRESS)
    expect(fullPageHref('/w/DEMO', 'r1', HOME_ADDRESS)).toBe(`/w/DEMO/sales/incoming/r1?back=${encodeURIComponent('?')}`)
  })

  it('opened from the list it walks the list\'s order ("2 of 3"); a deep link has no order to walk', () => {
    const ids = [ROWS[0]!.id, VIEW.id, ROWS[3]!.id]
    expect(render({ model: record(VIEW), nav: { ids, onGo: () => undefined } })).toContain('2 of 3')
    expect(render({ model: record(VIEW), nav: null })).not.toContain(' of 3')
  })

  it('a request outside the reader\'s scope answers "not found" without its number or customer (W37)', () => {
    const html = render({ model: record(null, { loaded: { status: 'notFound' } }) })
    expect(html).toContain('Request not found')
    expect(html).not.toContain(VIEW.number)
    expect(html).not.toContain(VIEW.party!.name)
  })
})
