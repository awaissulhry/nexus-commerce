import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { BLOCKED, designScreen, MAILS, MAILS_MASKED, UNBLOCKED } from '../fixtures'
import { ConnectionsMessages } from '../view/parts'
import { DELIVERY_STATES, listBlocked, listDelivery, SUPPRESSION_REASONS, unblockAddress } from './api'
import {
  ABOUT_FILTERS,
  blockedSelectable,
  hasComplaint,
  KNOWN_LINKS,
  KNOWN_RECORD_TYPES,
  linkKey,
  problemKeyOf,
  queryOf,
  reasonProblem,
  recordHref,
  recordTypeKey,
  STATE_TONE,
  tileValue,
  unblockHeld,
  unblockReach,
} from './model'
import { BlockedMailCell, MessageCell, ProblemCell, StatePill, ToCell, UnblockedCell, WhyCell } from './view/DeliverySection'

/**
 * The delivery log and blocked addresses (B-W2a-41; PLT-149; SCR-087 sec:delivery): the filters as the API's query, the
 * states' words, record links (a person's mail never linked), masked addresses kept masked, which blocked rows "Unblock N"
 * reaches and why it is held, the reason rule, the calls against a mocked API (the version and reason sent, one call per
 * address), every key in it and en, and the cells drawn (AG Grid draws them in a browser only).
 */

const own = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['admin-connections'] ?? {}
const has = (key: string) => LOCALES.every((locale) => key in own(locale) || (`${key}_one` in own(locale) && `${key}_other` in own(locale)))

const cell = (node: ReactNode, locale: (typeof LOCALES)[number] = 'en') =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(ConnectionsMessages, null, node))).replace(/<!-- -->/g, '')

describe('the delivery log in words', () => {
  it('a tile filters by state, Invoices and Links by what the mail is about; none reads everything', () => {
    expect(queryOf(null)).toEqual({})
    expect(queryOf('PROBLEM')).toEqual({ state: 'PROBLEM' })
    expect(queryOf('INVOICES')).toEqual({ about: 'INVOICES' })
    expect(queryOf('LINKS')).toEqual({ about: 'LINKS' })
    expect(Object.keys(STATE_TONE).sort()).toEqual([...DELIVERY_STATES].sort())
    expect(STATE_TONE.PROBLEM).toBe('danger')
    expect(tileValue(null, 'SENT')).toBe('—')
    expect(tileValue({ WAITING: 0, SENT: 3, DELIVERED: 9, PROBLEM: 1, FAILED: 0 }, 'SENT')).toBe('3')
  })

  it('says each problem in words; a delivered mail has none', () => {
    expect(problemKeyOf({ state: 'PROBLEM', status: 'BOUNCED' })).toBe('conn.delivery.problem.bounced')
    expect(problemKeyOf({ state: 'PROBLEM', status: 'COMPLAINED' })).toBe('conn.delivery.problem.complained')
    expect(problemKeyOf({ state: 'FAILED', status: 'FAILED' })).toBe('conn.delivery.problem.failed')
    expect(problemKeyOf({ state: 'DELIVERED', status: 'DELIVERED' })).toBeNull()
  })

  it('a record mail links to its record (its own page once built, else its panels); a person\'s mail is never linked', () => {
    const invoice = MAILS[1]!
    expect(recordHref('/w/DEMO', invoice.record, invoice.companyId, OFFICE_PAGES)).toBe(`/w/DEMO/finance/invoices/${invoice.record!.id}`)
    expect(recordHref('/w/DEMO', { type: 'DepositRequest', id: 'x1', label: null }, 'c1', new Set())).toBe('/w/DEMO/records/DepositRequest/x1?company=c1')
    expect(recordHref('/w/DEMO', MAILS[6]!.record, MAILS[6]!.companyId, OFFICE_PAGES)).toBeNull()
    expect(recordHref('/w/DEMO', null, 'c1', OFFICE_PAGES)).toBeNull()
    expect(recordTypeKey('Invoice')).toBe('conn.delivery.recordType.Invoice')
    expect(recordTypeKey('Something')).toBe('conn.delivery.recordType.other')
    expect(linkKey('DOCUMENT_VIEW')).toBe('conn.delivery.link.DOCUMENT_VIEW')
    expect(linkKey('NEW_KIND')).toBe('conn.delivery.link.other')
  })
})

describe('the blocked addresses', () => {
  it('an unblocked row cannot be ticked; Unblock N reaches the blocked ones and says why it leaves the others out', () => {
    expect(blockedSelectable(BLOCKED[0]!)).toBeNull()
    expect(blockedSelectable(UNBLOCKED[0]!)).toBe('conn.blocked.noSelect')
    const reach = unblockReach([BLOCKED[0]!, UNBLOCKED[0]!, BLOCKED[2]!])
    expect(reach.applies.map((row) => row.id)).toEqual([BLOCKED[0]!.id, BLOCKED[2]!.id])
    expect(reach.left).toEqual([{ item: UNBLOCKED[0]!, why: 'conn.blocked.left.unblocked' }])
  })

  it('Unblock is held without the right over every company, or when nothing blocked is ticked', () => {
    expect(unblockHeld(unblockReach([BLOCKED[0]!]), false)).toBe('conn.blocked.heldRight')
    expect(unblockHeld(unblockReach([UNBLOCKED[0]!]), true)).toBe('conn.blocked.noneToUnblock')
    expect(unblockHeld(unblockReach([BLOCKED[0]!]), true)).toBeNull()
  })

  it('the reason is required (three letters at least); a complaint is warned about', () => {
    expect(reasonProblem('')).toBe('conn.blocked.reasonShort')
    expect(reasonProblem(' ok ')).toBe('conn.blocked.reasonShort')
    expect(reasonProblem('Mailbox fixed')).toBeNull()
    expect(hasComplaint([BLOCKED[0]!])).toBe(false)
    expect(hasComplaint([BLOCKED[0]!, BLOCKED[1]!])).toBe(true)
  })
})

function mockApi(answers: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown; key: string | null }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, key: headers.get('idempotency-key') })
    const answer = answers.shift() ?? { status: 500, body: {} }
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchImpl, csrfToken: () => 'csrf' })
  return { api, calls }
}

describe('the calls', () => {
  it('reads the log with the filter and the cursor, and the blocked list; checks each answer\'s shape', async () => {
    const page = { mails: MAILS.slice(0, 2), nextBefore: MAILS[1]!.id, counts: { WAITING: 1, SENT: 0, DELIVERED: 1, PROBLEM: 1, FAILED: 0 }, blocked: 2 }
    const { api, calls } = mockApi([
      { status: 200, body: page },
      { status: 200, body: { addresses: BLOCKED, nextBefore: null, canUnblock: true } },
    ])
    expect((await listDelivery(api, { about: 'INVOICES', before: MAILS[0]!.id })).nextBefore).toBe(MAILS[1]!.id)
    expect((await listBlocked(api, { state: 'UNBLOCKED' })).canUnblock).toBe(true)
    expect(calls[0]!.url).toBe(`/api/email/delivery?about=INVOICES&before=${MAILS[0]!.id}&limit=50`)
    expect(calls[1]!.url).toBe('/api/email/blocked?state=UNBLOCKED&limit=50')
  })

  it('unblocks one address with the version read and the reason, under an idempotency key', async () => {
    const { api, calls } = mockApi([{ status: 200, body: { address: { ...BLOCKED[0]!, version: 2, unblocked: { at: '2026-10-29T10:00:00.000Z', byId: null, reason: 'Mailbox fixed' } } } }])
    const answer = await unblockAddress(api, BLOCKED[0]!.id, { version: 1, reason: 'Mailbox fixed' })
    expect(answer.unblocked?.reason).toBe('Mailbox fixed')
    expect(calls).toEqual([{ method: 'POST', url: `/api/email/blocked/${BLOCKED[0]!.id}/unblock`, body: { version: 1, reason: 'Mailbox fixed' }, key: expect.any(String) }])
  })

  it('an answer that does not match its shape is a contract error, never half-read', async () => {
    const { api } = mockApi([{ status: 200, body: { mails: [{ id: 'x', state: 'LOST' }], nextBefore: null } }])
    const error = await listDelivery(api).catch((caught: unknown) => caught)
    expect(isApiError(error) && error.kind).toBe('contract')
  })
})

describe('the words and the cells', () => {
  it('every key built from an enum exists in it and en', () => {
    const built = [
      ...DELIVERY_STATES.flatMap((state) => [`conn.delivery.state.${state}`, `conn.delivery.tile.${state}`, `conn.delivery.tileHint.${state}`]),
      ...ABOUT_FILTERS.map((about) => `conn.delivery.about.${about}`),
      ...KNOWN_RECORD_TYPES.map((type) => `conn.delivery.recordType.${type}`),
      ...KNOWN_LINKS.map((purpose) => `conn.delivery.link.${purpose}`),
      ...SUPPRESSION_REASONS.map((reason) => `conn.blocked.reason.${reason}`),
      ...['BLOCKED', 'UNBLOCKED'].map((view) => `conn.blocked.view.${view}`),
      ...['RECORD', 'SIGN_IN', 'DIGEST'].map((kind) => `conn.delivery.kind.${kind}`),
      ...['Done', 'Partial', 'Failed'].map((part) => `conn.blocked.unblocked${part}`),
    ]
    expect(built.filter((key) => !has(key))).toEqual([])
  })

  it('a record mail: its number as a link, its kind, and the link it carried; a digest and a sign-in name nobody', () => {
    const quote = cell(createElement(MessageCell, { mail: MAILS[0]!, prefix: '/w/DEMO' }))
    expect(quote).toContain('Q-2026-0042')
    expect(quote).toContain(`href="/w/DEMO/sales/quotes/${MAILS[0]!.record!.id}"`)
    expect(quote).toContain('Quote to accept (link)')
    const digest = cell(createElement(MessageCell, { mail: MAILS[6]!, prefix: '/w/DEMO' }))
    expect(digest).toContain('Notification digest')
    expect(digest).toContain('Carried 6 notifications')
    expect(digest).not.toContain('href=')
    expect(cell(createElement(MessageCell, { mail: MAILS[7]!, prefix: '/w/DEMO' }))).toContain('A person (not named here)')
  })

  it('addresses stay as the API gave them (masked for a reader who does not manage the mail); hidden copies counted', () => {
    const masked = cell(createElement(ToCell, { mail: MAILS_MASKED[2]! }))
    expect(masked).toContain('o•••@conceria-esempio.example')
    expect(masked).not.toContain('ordini@')
    expect(masked).toContain('+1 hidden copy')
    expect(masked).toContain('Masked: only people who manage')
    expect(cell(createElement(ToCell, { mail: MAILS[0]! }))).toContain('acquisti@moto-esempio.example')
  })

  it('a bounced invoice says so in words, with what the provider said as data; a pill per state, in Italian too', () => {
    const bounced = cell(createElement(ProblemCell, { mail: MAILS[1]! }))
    expect(bounced).toContain('Bounced: the mailbox does not exist or refuses mail.')
    expect(bounced).toContain('Permanent/General: mailbox unavailable')
    expect(cell(createElement(StatePill, { mail: MAILS[1]! }), 'it')).toContain('Respinta o segnalata')
    expect(cell(createElement(ProblemCell, { mail: MAILS[0]! }))).toContain('—')
  })

  it('a blocked address: why, the mail that blocked it (a link), and an unblocked one with when and why', () => {
    expect(cell(createElement(WhyCell, { row: BLOCKED[1]! }))).toContain('The recipient complained')
    expect(cell(createElement(BlockedMailCell, { row: BLOCKED[0]!, prefix: '/w/DEMO' }))).toContain('FT-2026-0041')
    expect(cell(createElement(BlockedMailCell, { row: BLOCKED[2]!, prefix: '/w/DEMO' }))).toContain('—')
    expect(cell(createElement(UnblockedCell, { row: UNBLOCKED[0]! }))).toContain('The customer fixed their mailbox')
  })

  it('the section is drawn under the mail domain, absent without the right; its frames keep their keys in the footer icon', () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
    const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') =>
      renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as never, { model: screen.cases.find((item) => item.id === id)!.model }))).replace(/<!-- -->/g, '')
    const html = draw('delivery')
    expect(html).toContain('id="delivery"')
    expect(html).toContain('Delivery log and blocked addresses')
    expect(html).toContain('8 mails')
    expect(html).toContain('3 addresses blocked')
    expect(html).toContain('Bounced or complained')
    expect(html.match(/aria-label="Keyboard keys of this list"/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(draw('delivery-no-right')).not.toContain('id="delivery"')
    expect(draw('blocked-selected')).toContain('Unblock 2')
    expect(draw('unblock-held')).toContain('over every company')
    expect(draw('delivery-masked')).toContain('Some addresses are masked')
    expect(draw('delivery-empty')).toContain('No mail sent yet')
    expect(draw('unblocked-view')).toContain('1 address unblocked')
    expect(draw('unblocked-done')).toContain('1 of 2 addresses unblocked. Not unblocked:')
    expect(draw('delivery', 'it')).toContain('Registro di consegna e indirizzi bloccati')
  })
})
