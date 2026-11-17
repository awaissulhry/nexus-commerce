import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LAWFUL_BASES } from '@nexus/factory-domain/sales/inquiries/rules'
import type { ApiClient } from '../../../../lib/api/client'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { EMPTY_COMPOSE } from '../../../../lib/request-compose/model'
import { scanText } from '../../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../lib/testing/two-brands'
import { listRequestCustomers, readCustomerFacts, type RequestCustomer } from '../api'
import { MAIL_DRAFT, ROLE_PERMISSIONS } from '../demo/fixtures'
import { emptyLine, inquiriesCan } from '../model'
import {
  composeProblems,
  composeRefusals,
  DEFAULT_BASIS,
  emptyNewRequest,
  fromMailRequestBody,
  n,
  NEW_NS,
  newRequestBody,
  newRequestFromMail,
  newRequestHeld,
  newRequestTyped,
  OFFICE_VOICE,
  prospectMatch,
  requestWords,
  shipToOf,
  stylesFor,
  withWho,
  type NewRequestDraft,
} from '../new-request'
import { designScreen as newScreen } from './new/fixtures'

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so the dialog's words are checked.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), createElement('p', null, subtitle as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

/**
 * B-TH-221 — New request in the office (threads plan O-SAL-INQ-LIST.band-F02; walls W23 and W37): the portal's compose with the
 * customer OR the prospect; the lawful basis required with any prospect field (Contract by default); the PO, the day wanted and
 * a delivery address of the request's OWN customer sent; the picker reading only the customers the API says this person may
 * make a request for (never another customer's name); "Use <customer>?" only among those; the lines naming only the open
 * range and this customer's own labels; the office's voice for the compose's labels; every design case in both languages.
 */

const owner = inquiriesCan(ROLE_PERMISSIONS.owner)
const TODAY = '2026-11-17'
const FACTS = { can: owner, offline: false, busy: false, fromMail: false, unnumbered: false, today: TODAY }
const BETA: RequestCustomer = { id: BRAND_BETA.ids.order, code: BRAND_BETA.code, legalName: BRAND_BETA.legalName, tradeName: BRAND_BETA.tradeName }
const ALPHA: RequestCustomer = { id: BRAND_ALPHA.ids.order, code: BRAND_ALPHA.code, legalName: BRAND_ALPHA.legalName, tradeName: BRAND_ALPHA.tradeName }
const ADDRESS = 'b2b2b2b2-0000-4000-8000-000000000301'

const customerDraft = (over: Partial<NewRequestDraft> = {}): NewRequestDraft => ({
  ...withWho(emptyNewRequest(), 'customer', BETA.id),
  compose: { ...EMPTY_COMPOSE, subject: 'Rain jackets', message: BRAND_BETA.message, customerRef: BRAND_BETA.customerRef, wantedDate: '2027-02-15', shipToAddressId: ADDRESS },
  ...over,
})
const prospectDraft = (over: Partial<NewRequestDraft> = {}): NewRequestDraft => ({
  ...withWho(emptyNewRequest(), 'prospect'),
  source: 'FAIR',
  prospect: { name: 'Gianni Esempio', company: 'Demo Moto Club', email: 'club@motoclub.example.com', phone: '' },
  compose: { ...EMPTY_COMPOSE, message: 'Club jackets with a logo, about 40.' },
  ...over,
})

describe('customer OR prospect, and the lawful basis (W37)', () => {
  it('waits for a customer or a prospect, then the basis, then their words — each in words', () => {
    expect(newRequestHeld(emptyNewRequest(), FACTS)).toEqual({ key: n('held.customer') })
    expect(newRequestHeld(withWho(emptyNewRequest(), 'prospect'), FACTS)?.key).toBe('prospect.problem.who')
    expect(newRequestHeld(prospectDraft({ lawfulBasis: null }), FACTS)).toEqual({ key: n('held.basis') })
    expect(newRequestHeld(prospectDraft({ compose: EMPTY_COMPOSE }), FACTS)).toEqual({ key: n('held.message') })
    expect(newRequestHeld(prospectDraft(), FACTS)).toBeNull()
    expect(newRequestHeld(customerDraft(), FACTS)).toBeNull()
  })

  it('the lawful basis starts at Contract (a request for a quote) and goes with the prospect, never with a customer', () => {
    expect(emptyNewRequest().lawfulBasis).toBe('CONTRACT')
    expect(DEFAULT_BASIS).toBe('CONTRACT')
    expect(LAWFUL_BASES).toContain(DEFAULT_BASIS)
    const body = newRequestBody(prospectDraft({ lawfulBasis: 'LEGITIMATE_INTEREST' }), 'co1', owner, null)
    expect(body).toMatchObject({ companyId: 'co1', source: 'FAIR', prospect: { name: 'Gianni Esempio', company: 'Demo Moto Club', email: 'club@motoclub.example.com', phone: null, lawfulBasis: 'LEGITIMATE_INTEREST' } })
    expect(body).not.toHaveProperty('partyId')
    expect(newRequestBody(customerDraft(), 'co1', owner, null)).not.toHaveProperty('prospect')
  })

  it('holds: no right, the window busy, no request numbering, a price that does not read, a line with a problem, offline', () => {
    const reader = inquiriesCan(ROLE_PERMISSIONS.reader)
    expect(newRequestHeld(customerDraft(), { ...FACTS, can: reader })).toEqual({ key: 'held.right', params: { right: 'right.sales.inquiries.manage' } })
    expect(newRequestHeld(customerDraft(), { ...FACTS, busy: true })).toEqual({ key: n('held.busy') })
    expect(newRequestHeld(customerDraft(), { ...FACTS, unnumbered: true })).toEqual({ key: n('held.unnumbered') })
    expect(newRequestHeld(customerDraft({ targetPrice: 'abc' }), FACTS)).toEqual({ key: 'request.problem.price' })
    expect(newRequestHeld(customerDraft({ lines: [{ ...emptyLine('l1'), quantity: '12' }] }), FACTS)?.key).toBe('line.problem.at')
    expect(newRequestHeld(customerDraft(), { ...FACTS, offline: true })).toEqual({ key: 'held.offline' })
    expect(newRequestHeld(customerDraft({ compose: { ...customerDraft().compose, wantedDate: '2020-01-01' } }), FACTS)).toEqual({ key: n('held.problems') })
  })
})

describe('what is sent: the PO, the day wanted and the customer’s own delivery address (W23)', () => {
  it('a customer’s request carries their PO, the day wanted and one of its delivery addresses; the subject is the first line', () => {
    const body = newRequestBody({ ...customerDraft(), contactId: 'c1', assignToMe: true, targetPrice: '38,50' }, 'co1', owner, 'me')
    expect(body).toEqual({
      companyId: 'co1',
      source: 'PHONE',
      partyId: BETA.id,
      contactId: 'c1',
      request: `Rain jackets\n\n${BRAND_BETA.message}`,
      wantedDate: '2027-02-15',
      customerRef: BRAND_BETA.customerRef,
      shipToAddressId: ADDRESS,
      targetUnitPrice: '38.50',
      currency: 'EUR',
      assigneeId: 'me',
    })
  })

  it('a prospect never sends a delivery address (none is theirs), and its compose never holds for one', () => {
    const draft = prospectDraft({ compose: { ...prospectDraft().compose, shipToAddressId: ADDRESS, customerRef: 'CLUB-7' } })
    const body = newRequestBody(draft, 'co1', owner, null)
    expect(body).not.toHaveProperty('shipToAddressId')
    expect(body).toMatchObject({ customerRef: 'CLUB-7' })
    expect(composeProblems(draft, TODAY)).toEqual({})
  })

  it('picking another customer forgets the contact and the delivery address of the one before', () => {
    const picked = { ...customerDraft(), contactId: 'c1' }
    expect(withWho(picked, 'customer', BETA.id)).toMatchObject({ contactId: 'c1', compose: { shipToAddressId: ADDRESS } })
    expect(withWho(picked, 'customer', ALPHA.id)).toMatchObject({ partyId: ALPHA.id, contactId: null, compose: { shipToAddressId: '' } })
    expect(withWho(picked, 'prospect')).toMatchObject({ who: 'prospect', partyId: null, contactId: null, compose: { shipToAddressId: '' } })
  })

  it('no price without the price grain; blank lines and a blank PO are left out', () => {
    const noPrice = inquiriesCan(ROLE_PERMISSIONS.sales.filter((name) => name !== 'money.price'))
    const body = newRequestBody(customerDraft({ targetPrice: '38', lines: [emptyLine('blank')], compose: { ...customerDraft().compose, customerRef: '  ' } }), 'co1', noPrice, null)
    expect(body).not.toHaveProperty('targetUnitPrice')
    expect(body).not.toHaveProperty('lines')
    expect(body).not.toHaveProperty('customerRef')
  })

  it('the API’s refusal at a compose field comes back to that field, in the office’s words', () => {
    expect(composeRefusals(['body/shipToAddressId'])).toEqual({ shipToAddressId: 'problem.shipTo' })
    expect(composeRefusals(['body/customerRef', 'body/wantedDate', 'body/request'])).toEqual({ customerRef: 'problem.refLong', wantedDate: 'problem.datePast', message: 'problem.tooLong' })
    expect(composeRefusals(['body/partyId'])).toEqual({})
  })

  it('from a mail: the sender’s customer, the mail’s words (left as they came), its version, its attachments as the tech pack, the PO', () => {
    const draft = { ...newRequestFromMail(MAIL_DRAFT), techPackFileIds: [MAIL_DRAFT.attachments[0]!.id] }
    expect(draft).toMatchObject({ who: 'customer', partyId: MAIL_DRAFT.party!.id, contactId: MAIL_DRAFT.contactId, compose: { message: MAIL_DRAFT.request } })
    expect(newRequestHeld({ ...draft, compose: EMPTY_COMPOSE }, { ...FACTS, fromMail: true })).toBeNull()
    const body = fromMailRequestBody({ ...draft, compose: { ...draft.compose, customerRef: 'MAIL-PO-1' } }, MAIL_DRAFT, 4, owner, null, 'co1')
    expect(body).toMatchObject({ version: 4, partyId: MAIL_DRAFT.party!.id, techPackFileIds: [MAIL_DRAFT.attachments[0]!.id], customerRef: 'MAIL-PO-1', request: MAIL_DRAFT.request })
    expect(body).not.toHaveProperty('companyId')
    expect(fromMailRequestBody({ ...draft, compose: EMPTY_COMPOSE }, MAIL_DRAFT, 4, owner, null, 'co1')).not.toHaveProperty('request')
  })

  it('closing asks first only when something was typed', () => {
    expect(newRequestTyped(emptyNewRequest())).toBe(false)
    expect(newRequestTyped({ ...emptyNewRequest(), compose: { ...EMPTY_COMPOSE, message: 'x' } })).toBe(true)
    expect(newRequestTyped(prospectDraft({ compose: EMPTY_COMPOSE }))).toBe(true)
    expect(requestWords({ subject: '  ', message: 'Only words  \n' })).toBe('Only words')
  })
})

describe('the picker reads only the customers this person may make a request for (W23)', () => {
  function fakeApi(answers: Record<string, unknown>) {
    const calls: Array<{ path: string; query?: unknown }> = []
    const api = { get: async (path: string, options?: { query?: unknown; schema?: { parse: (value: unknown) => unknown } }) => (calls.push({ path, query: options?.query }), options?.schema ? options.schema.parse(answers[path]) : answers[path]) } as unknown as ApiClient
    return { api, calls }
  }

  it('reads GET /sales/inquiries/customers for the page’s company — not the whole party list', async () => {
    const { api, calls } = fakeApi({ '/sales/inquiries/customers': { customers: [BETA], total: 1, limited: true } })
    expect(await listRequestCustomers(api, 'co1')).toEqual({ customers: [BETA], total: 1, limited: true })
    expect(calls).toEqual([{ path: '/sales/inquiries/customers', query: { companyId: 'co1', limit: 200 } }])
  })

  it('the picked customer’s contacts (active only) and delivery addresses (active SHIP_TO, never a refused one; the default first)', async () => {
    const { api } = fakeApi({
      [`/parties/${BETA.id}`]: {
        party: {
          contacts: [
            { id: 'c1', name: BRAND_BETA.contact.name, email: BRAND_BETA.contact.email, status: 'ACTIVE' },
            { id: 'c2', name: 'Gone', email: null, status: 'ARCHIVED' },
          ],
          addresses: [
            { id: 'a1', kinds: ['REGISTERED', 'BILL_TO'], name: null, line1: BRAND_BETA.address.line1, postalCode: BRAND_BETA.address.postalCode, city: BRAND_BETA.address.city, status: 'ACTIVE', isDefaultShipTo: false, approval: null },
            { id: 'a2', kinds: ['SHIP_TO'], name: 'Lager', line1: 'Betastrasse 30', postalCode: '10115', city: 'Berlin', status: 'ACTIVE', isDefaultShipTo: false, approval: { status: 'WAITING' } },
            { id: 'a3', kinds: ['SHIP_TO'], name: 'Shop', line1: 'Betastrasse 40', postalCode: '10115', city: 'Berlin', status: 'ACTIVE', isDefaultShipTo: true, approval: null },
            { id: 'a4', kinds: ['SHIP_TO'], name: 'Refused', line1: 'X 1', postalCode: '1', city: 'Y', status: 'ACTIVE', isDefaultShipTo: false, approval: { status: 'REFUSED' } },
            { id: 'a5', kinds: ['SHIP_TO'], name: 'Old', line1: 'X 2', postalCode: '1', city: 'Y', status: 'ARCHIVED', isDefaultShipTo: false, approval: null },
          ],
        },
      },
    })
    const facts = await readCustomerFacts(api, BETA.id)
    expect(facts.contacts.map((contact) => contact.id)).toEqual(['c1'])
    expect(shipToOf(facts.addresses)).toEqual([
      { id: 'a3', label: 'Shop, Betastrasse 40, 10115 Berlin', waiting: false, isDefault: true },
      { id: 'a2', label: 'Lager, Betastrasse 30, 10115 Berlin', waiting: true, isDefault: false },
    ])
  })

  it('"Use <customer>?" only among the reader’s own customers: a person limited to Beta is never told Alpha exists', () => {
    const typedAlpha = { name: '', company: BRAND_ALPHA.tradeName, email: '', phone: '' }
    expect(prospectMatch(typedAlpha, [BETA])).toBeNull()
    expect(prospectMatch(typedAlpha, [BETA, ALPHA])).toEqual(ALPHA)
    expect(prospectMatch({ name: '', company: 'brand-beta gmbh', email: '', phone: '' }, [BETA])).toEqual(BETA)
    expect(prospectMatch({ name: 'Al', company: '', email: '', phone: '' }, [ALPHA])).toBeNull()
    expect(prospectMatch(typedAlpha, null)).toBeNull()
  })

  it('a line names the open range and this customer’s own labels only; a prospect the open range', () => {
    const styles = [
      { id: 's1', brand: null },
      { id: 's2', brand: { id: BETA.id } },
      { id: 's3', brand: { id: ALPHA.id } },
      { id: 's4' },
    ]
    expect(stylesFor(styles, 'customer', BETA.id)?.map((style) => style.id)).toEqual(['s1', 's2', 's4'])
    expect(stylesFor(styles, 'prospect', null)?.map((style) => style.id)).toEqual(['s1', 's4'])
    expect(stylesFor(null, 'customer', BETA.id)).toBeNull()
  })
})

describe('the words', () => {
  it('every office voice key of the compose and every held key exists in both languages', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][NEW_NS]!
      for (const key of OFFICE_VOICE) expect(words[`voice.${key}`], `${locale} voice.${key}`).toBeTruthy()
      for (const key of ['busy', 'unnumbered', 'customer', 'basis', 'message', 'problems', 'mail']) expect(words[`held.${key}`], `${locale} held.${key}`).toBeTruthy()
      for (const basis of LAWFUL_BASES) expect(CATALOGUE[locale]['sales-inquiries']![`basis.${basis}`], `${locale} basis.${basis}`).toBeTruthy()
    }
    expect(CATALOGUE.en[NEW_NS]!['voice.message.label']).toBe('What they asked')
    expect(CATALOGUE.en[NEW_NS]!['voice.details.ref']).toBe('Their PO')
  })
})

const LEFT_KEY = /\b(?:common|held|from|voice|office|files|mail|leave|request|line|grid|prospect|basis|source|compose|subject|message|problem|kept|details|same|send|state|refusal|new|title|subtitle|go|working|toMe)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}
const strip = (html: string) =>
  html
    .replace(/https?:\/\/[^"\s<]+/g, '')
    .replace(/data:[^"]+/g, '')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
    .replace(/\b(?:sales|product|products|files|example|email|quotes|money|threads)\.[a-z]+(?:\.[a-z]+)?\b/g, '')

describe('SCR-105-new: every design case draws in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`SCR-105-new in ${locale}: ${newScreen.cases.length} cases`, () => {
      for (const item of newScreen.cases) {
        const html = strip(render(newScreen as DesignScreen<unknown>, item.model, locale))
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('the call: the office’s From in the compose’s place, its words, the PO and the delivery address, Create request held for nothing', () => {
    const html = render(newScreen as DesignScreen<unknown>, newScreen.cases.find((item) => item.id === 'call')!.model, 'en')
    expect(html).toContain('New request')
    expect(html).toContain('What they asked')
    expect(html).toContain('Their PO')
    expect(html).toContain('DMB-PO-4521')
    expect(html).toContain('Create request')
    expect(html).toContain('Give it to me')
    expect(html).not.toContain('Goes to')
    expect(html).not.toContain('Uploads from outside are closed')
  })

  it('the prospect: the lawful basis with why; the match offers the reader’s own customer; limited: “1 customer”', () => {
    const at = (id: string) => render(newScreen as DesignScreen<unknown>, newScreen.cases.find((item) => item.id === id)!.model, 'en')
    expect(at('prospect')).toContain('Lawful basis')
    expect(at('prospect')).toContain('GDPR art. 6')
    expect(at('prospect-match')).toContain('Use Demo Rider Shop')
    expect(at('prospect-basis')).toContain('Choose the lawful basis for the prospect')
    expect(at('limited')).toContain('You make requests for 1 customer')
    expect(at('unnumbered')).toContain('Requests are not numbered at this company yet')
    expect(at('leaving')).toContain('Discard this request?')
  })

  it('names no other brand: the dialog of a person limited to Brand Beta never draws Brand Alpha', () => {
    for (const id of ['limited', 'empty', 'call']) {
      const html = render(newScreen as DesignScreen<unknown>, newScreen.cases.find((item) => item.id === id)!.model, 'en')
      expect(scanText(html, BRAND_ALPHA), id).toEqual([])
    }
  })
})
