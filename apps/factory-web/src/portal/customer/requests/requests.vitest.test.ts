import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PORTAL_REQUEST_STATES as DOMAIN_STATES, REQUEST_STATE_WORDS, requestStateOf } from '@nexus/factory-domain/sales/portal-requests/state'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA } from '../../../lib/testing/two-brands'
import { recordPageOf } from '../../shell/nav/portal-nav'
import { PORTAL_REQUEST_STATES } from './api'
import { REQUESTS, requestRow, requestView } from './design-data'
import { designScreen } from './fixtures'
import { matchesSearch, NS, questionOf, quoteText, requestHref, requestOrder, stateLinks, stateTone, yourNumberText, type ThreadLine } from './model'
// B-TH-282 / B-TH-291
import type { ApiClient } from '../../../lib/api/client'
import { withdrawRequest } from './api'
import { filesDoorOf, withdrawProblemKey } from './model'
import { partnerThreadSchema } from '../../shell/api' // B-TH-236
import type { HeldFile } from '../../../lib/request-compose/files' // end check (B-TH-282)

/**
 * B-TH-222, B-TH-303 — the customer's request page: true states only (the API's words; "Quote being prepared" for a quote not
 * sent, never "Quote sent"; an order waiting for our yes never reads "confirmed"), the question we asked quoted with Answer,
 * what was made of it named by the customer's OWN numbers, the neutral page for a request that is not theirs, RECORD_PAGES,
 * and every design case read by Brand Beta with nothing of Brand Alpha and no office series (INQ-, QT-, SO-, RQ-).
 */

const t = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const OFFICE_SERIES = /\b(?:INQ|QT|SO|RQ|Q)-\d{4}-\d{2,}/

describe('true states only', () => {
  it('the page reads the domain’s states and draws its words as they come', () => {
    expect([...PORTAL_REQUEST_STATES]).toEqual([...DOMAIN_STATES])
    for (const code of PORTAL_REQUEST_STATES) {
      for (const locale of ['it', 'en'] as const) expect(t(locale)(`hint.${code}`), `${code} ${locale}`).not.toMatch(/^hint\./)
      expect(['neutral', 'info', 'success', 'warning', 'danger']).toContain(stateTone(code))
    }
  })

  it('a quote not sent yet is "Quote being prepared" and is never named; an order waiting is never "confirmed"', () => {
    for (const quoteStatus of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED']) expect(requestStateOf({ status: 'QUOTED', quoteStatus, orderStatus: null })).toBe('QUOTE_BEING_PREPARED')
    expect(REQUEST_STATE_WORDS.QUOTE_BEING_PREPARED.en).toBe('Quote being prepared')
    expect(requestStateOf({ status: 'QUOTED', quoteStatus: 'ACCEPTED', orderStatus: 'PENDING_APPROVAL' })).toBe('ORDER_WAITING')
    expect(REQUEST_STATE_WORDS.ORDER_WAITING.en).not.toMatch(/confirmed/i)
    const draftQuote = requestView('QUOTE_BEING_PREPARED', { made: { quote: { id: 'q', number: 'QT-2026-0098', yourNumber: customerNumberOf('QUOTE', 3), sent: false }, order: null } })
    expect(stateLinks(draftQuote, '/p/X', 'en', t('en')).quote).toBeNull()
    const sentQuote = requestView('QUOTE_SENT', { made: { quote: { id: 'q', number: 'QT-2026-0098', yourNumber: customerNumberOf('QUOTE', 3), sent: true }, order: null } })
    expect(stateLinks(sentQuote, '/p/X', 'en', t('en')).quote).toEqual({ label: 'Your quote 3' })
    const ordered = requestView('ORDER_WAITING', { made: { quote: null, order: { id: 'o-1', number: 'SO-2026-0142', yourNumber: customerNumberOf('ORDER', 12) } } })
    expect(stateLinks(ordered, '/p/X', 'it', t('it')).order).toEqual({ href: '/p/X/orders/o-1', label: 'Il vostro ordine 12' })
  })

  // ---- B-TH-228 (on B-TH-025): a request made straight into an order (no quote) reads the ORDER's own state on its page (W37)
  it('a request made straight into an order reads the order\'s own state: waiting for approval is never "confirmed"', () => {
    expect(requestStateOf({ status: 'ORDERED', quoteStatus: null, orderStatus: 'PENDING_APPROVAL' })).toBe('ORDER_WAITING')
    expect(requestStateOf({ status: 'ORDERED', quoteStatus: null, orderStatus: 'CONFIRMED' })).toBe('ORDER_CONFIRMED')
    expect(requestStateOf({ status: 'ORDERED', quoteStatus: null, orderStatus: 'CANCELLED' })).toBe('CLOSED')
    const straight = requestView('ORDER_CONFIRMED', { made: { quote: null, order: { id: 'o-2', number: '#12', yourNumber: customerNumberOf('ORDER', 12) } } })
    // The link names the customer's own order number, never the office's SO- series.
    expect(stateLinks(straight, '/p/X', 'en', t('en'))).toEqual({ order: { href: '/p/X/orders/o-2', label: 'Your order 12' }, quote: null })
  })
  // ---- end B-TH-228

  it('quotes our question of a request that waits for the customer; the answer ends it', () => {
    const line = (id: string, side: 'company' | 'partner', body: string): ThreadLine => ({ id, side, body, at: '2026-11-17T09:00:00Z' })
    const thread = [line('1', 'partner', 'Forty jackets'), line('2', 'company', 'Which sizes?')]
    expect(questionOf('NEED_INFO', thread)?.body).toBe('Which sizes?')
    expect(questionOf('BEING_REVIEWED', thread)).toBeNull()
    expect(questionOf('NEED_INFO', [...thread, line('3', 'partner', 'S to XL')])).toBeNull()
    expect(quoteText('a  b\n\nc')).toBe('a b c')
    expect(quoteText('x'.repeat(400))).toHaveLength(280)
  })
})

describe('the customer’s own numbers (B-TH-303)', () => {
  it('"Your request 7" in the page’s language; none when it has no number of its own', () => {
    expect(yourNumberText(customerNumberOf('REQUEST', 7), 'en')).toBe('Your request 7')
    expect(yourNumberText(customerNumberOf('REQUEST', 7), 'it')).toBe('La vostra richiesta 7')
    expect(yourNumberText(null, 'en')).toBeNull()
  })

  it('a search finds a request by its subject, its PO or its own number — never the office’s number', () => {
    const row = requestRow(7, 'SENT', { customerRef: 'BETA-PO-0077' })
    expect(matchesSearch(row, 'jackets', 'en')).toBe(true)
    expect(matchesSearch(row, 'beta-po', 'en')).toBe(true)
    expect(matchesSearch(row, 'request 7', 'en')).toBe(true)
    expect(matchesSearch(row, row.number, 'en')).toBe(false)
  })

  it('what needs the customer comes first, then the last move', () => {
    expect(requestOrder(REQUESTS)[0]!.state.code).toBe('NEED_INFO')
  })
})

describe('the address', () => {
  it('RECORD_PAGES.Inquiry opens the customer’s request page; no other kind has one', () => {
    expect(recordPageOf(['CUSTOMER'], 'Inquiry', 'abc')).toBe('/orders/requests/abc')
    expect(recordPageOf(['SUPPLIER'], 'Inquiry', 'abc')).toBeNull()
    expect(requestHref('/p/BRAND-BETA', 'abc')).toBe('/p/BRAND-BETA/orders/requests/abc')
  })
})

const KEY = /\b(?:title|state|hint|question|details|thread|missing|failed|offline|loading|record|nav)\.[a-zA-Z_]+\b/

describe('SCR-185-request design cases (read by Brand Beta)', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  const render = (locale: 'it' | 'en', entry: (typeof screen.cases)[number]) => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: entry.model })))

  it('every case draws in Italian and English with no raw key, nothing of Brand Alpha and no office series', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of screen.cases) {
        const html = render(locale, entry)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html.match(KEY)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
        expect(scanText(html, BRAND_ALPHA), `${entry.id} (${locale})`).toEqual([])
        expect(html.match(OFFICE_SERIES)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
      }
    }
  })

  it('shows the customer’s own number and the true state of each case', () => {
    const html = render('en', screen.cases.find((entry) => entry.id === 'th-222-need-info')!)
    expect(html).toContain('Your request 7')
    expect(html).toContain('We need something from you')
    expect(html).toContain('Answer')
    expect(html).toContain('Which sizes do you need')
    const prepared = render('en', screen.cases.find((entry) => entry.id === 'th-222-quote-prepared')!)
    expect(prepared).toContain('Quote being prepared')
    expect(prepared).not.toContain('Quote sent')
    expect(prepared).not.toContain('Your quote')
    const waiting = render('en', screen.cases.find((entry) => entry.id === 'th-222-order-waiting')!)
    expect(waiting).toContain('Order waiting for approval')
    expect(waiting).toContain('Made into Your order 12')
    expect(waiting).not.toMatch(/Order confirmed/)
  })

  it('another customer’s request reads like one that does not exist (never says another customer exists)', () => {
    const html = render('en', screen.cases.find((entry) => entry.id === 'th-222-missing')!)
    expect(html).toContain('This request is not one of yours, or it no longer exists.')
    expect(html).not.toMatch(/another customer|other customer|belongs to/i)
  })

  it('the thread draws two sides only: no office note can be drawn (the DS PartnerThread has no such kind)', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = render(locale, screen.cases.find((entry) => entry.id === 'th-222-declined')!)
      expect(html).not.toMatch(/Office note|Nota d.ufficio|Internal note|Office only/i)
    }
  })
})

// ---- B-TH-282 (B-TH-085): "Add files" on the request page; B-TH-291 (B-TH-095): Withdraw before the office decided.
describe('B-TH-282 / B-TH-291 — Add files and Withdraw on the customer’s request page', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  const draw = (locale: 'it' | 'en', id: string) => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: screen.cases.find((entry) => entry.id === id)!.model })))

  it('a file goes onto the request while the office has not decided, through its thread after', () => {
    expect(filesDoorOf('SENT')).toBe('request')
    expect(filesDoorOf('BEING_REVIEWED')).toBe('request')
    expect(filesDoorOf('NEED_INFO')).toBe('request')
    for (const code of ['QUOTE_BEING_PREPARED', 'QUOTE_SENT', 'ORDER_WAITING', 'ORDER_CONFIRMED', 'DECLINED', 'CLOSED', 'WITHDRAWN'] as const) expect(filesDoorOf(code), code).toBe('thread')
  })

  it('Add files: a sheet ticked, a photo sent, a design file held for the virus scan, the API’s own words, a refused SVG — Brand Beta only (W25)', () => {
    const html = draw('en', 'th-282-files')
    expect(html).toContain('Add files')
    expect(html).toContain('This is a measurement sheet')
    expect(html).toContain('Held for the virus scan: it reaches us once the scan says it is clean')
    expect(html).toContain('Kept as it is: download only')
    expect(html).toContain('Did not go: This already holds 50 of your files: write to us in the messages for the rest.')
    expect(html).toContain('an SVG, HTML or script file is never accepted: send a PDF or PNG')
    expect(html).toContain('Send the file')
    expect(scanText(html, BRAND_ALPHA)).toEqual([])
    expect(html.match(OFFICE_SERIES)?.[0] ?? null).toBeNull()
    expect(draw('it', 'th-282-files')).toContain('Trattenuto per il controllo antivirus')
    // Closed until the virus scanner runs: the API's sentence, nothing taken.
    const closed = draw('en', 'th-282-files-closed')
    expect(closed).toContain('Uploads from outside are closed for now')
    expect(closed).toContain('Nothing can be added here for now.')
  })

  it('Withdraw only before the office decided; after, the API’s words say why; withdrawn reads “Withdrawn”', () => {
    const open = draw('en', 'th-291-withdraw')
    expect(open).toContain('Withdraw this request')
    expect(open).toContain('Possible until we decide on it.')
    const decided = draw('en', 'th-291-decided')
    expect(decided).not.toContain('Withdraw this request')
    expect(decided).toContain('The factory already decided this request: ask us if something should change.')
    const withdrawn = draw('en', 'th-291-withdrawn')
    expect(withdrawn).toContain('Withdrawn')
    expect(withdrawn).toContain('You withdrew this request.')
    expect(withdrawn).not.toContain('Withdraw this request')
    for (const locale of ['it', 'en'] as const) for (const id of ['th-291-withdraw', 'th-291-withdraw-ask', 'th-291-decided', 'th-291-withdrawn']) expect(scanText(draw(locale, id), BRAND_ALPHA), `${id} ${locale}`).toEqual([])
  })

  it('W37: a withdrawal names the request and the version read — never a party or a company; a refusal without words is said in ours', async () => {
    const calls: { path: string; body: unknown; key?: string }[] = []
    const api = { post: async (path: string, options: { body?: unknown; idempotencyKey?: string }) => {
      calls.push({ path, body: options.body, key: options.idempotencyKey })
      return { request: requestView('WITHDRAWN') }
    } } as unknown as ApiClient
    const answer = await withdrawRequest(api, 'inq-7', 3, 'key-w')
    expect(answer.state.code).toBe('WITHDRAWN')
    expect(calls).toEqual([{ path: '/portal/inquiries/inq-7/withdraw', body: { version: 3 }, key: 'key-w' }])
    expect(withdrawProblemKey('conflict')).toBe('withdraw.problem.changed')
    expect(withdrawProblemKey('not_found')).toBe('withdraw.problem.missing')
    expect(withdrawProblemKey(null)).toBe('withdraw.problem.network')
    for (const locale of ['it', 'en'] as const) for (const key of ['withdraw.action', 'withdraw.title', 'withdraw.body', 'withdraw.keep', 'withdraw.confirm', 'withdraw.problem.changed', 'withdraw.problem.failed', 'files.title', 'files.offline']) expect(t(locale)(key, { seq: 7 }), `${locale} ${key}`).not.toBe(key)
  })
})
// ---- end B-TH-282 / B-TH-291

// ---- B-TH-236 (B-TH-049; W08, W34): an amount never reaches the portal — the portal's read of a thread keeps no amount even if one came.
describe('B-TH-236 — the portal reads no amount and no office link', () => {
  it('the partner thread’s message shape drops an amount (defence in depth: the API never selects it for a partner)', () => {
    const read = partnerThreadSchema.parse({
      record: { type: 'Inquiry', id: 'i1', theirRef: null, ourRef: '#7', subtitle: null, status: 'SENT' },
      thread: { id: 't1', status: 'OPEN' },
      messages: [{ id: 'm1', side: 'COMPANY', channel: 'PORTAL', author: { name: 'Alex Demo', mine: false }, body: 'Yes, both sizes.', attachments: [], at: '2026-11-17T10:00:00.000Z', amount: { value: 125_000, currency: 'EUR' }, replyTo: { id: 'x' } }],
      nextCursor: null,
      composer: { canPost: true, reason: null, words: null, replyByEmail: false, hint: null },
    })
    expect(Object.keys(read.messages[0]!)).not.toContain('amount')
    expect(JSON.stringify(read)).not.toContain('125000')
  })
})
// ---- end B-TH-236

// ---- End check (B-TH-282): the ONE message after Send carries EVERY file sent, the last one too
describe('end check: the files list is in step at once, so the message carries the last file sent', () => {
  it('a change is read back at once, before the screen’s state follows (a deferred setState left the last file out)', async () => {
    const { heldList } = await import('./use-request-files')
    const { holdFiles, toAttach } = await import('../../../lib/request-compose/files')
    const shown: HeldFile[][] = []
    // The screen's setState, which React may apply only at the next render: here it only records what it was given.
    const list = heldList((value) => shown.push(value))
    const dropped = [{ name: 'front.png', type: 'image/png', size: 69 }, { name: 'back.png', type: 'image/png', size: 69 }, { name: 'sizes.pdf', type: 'application/pdf', size: 326 }]
    list.update(() => holdFiles(list.current, dropped, (index) => `k${index}`).held)
    // The send: each file announced and completed in turn, then ONE message carries the sent ones, read right after the last "sent".
    list.current.forEach((file, index) => list.update((current) => current.map((row) => (row.key === file.key ? { ...row, state: 'sent', fileId: `f${index}`, uploaded: true } : row))))
    expect(toAttach(list.current, new Set())).toEqual(['f0', 'f1', 'f2'])
    expect(shown.at(-1)).toBe(list.current)
    // The hook keeps its list there, never in a setState updater that writes the ref when React gets to it.
    const { readFileSync } = await import('node:fs')
    const hook = readFileSync(new URL('./use-request-files.ts', import.meta.url), 'utf8')
    expect(hook).toContain('list.current = heldList(setHeld)')
    expect(hook).not.toMatch(/setHeld\(\(current\)/)
  })
})
// ---- end check (B-TH-282)
