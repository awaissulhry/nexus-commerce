import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../../lib/api/client'
import { answerProblem, assignMail, findRecords, getMail, listMail, rejectMail, releaseMail, RECORD_FINDERS, type RecordFinder } from './api'
import { isMailChange, matchCandidates, mailActions, mailDocument, releaseTarget, remotePictureCount, senderLine, verdictWarnings, type RecordCandidate } from './model'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function client(...answers: Array<() => Response>) {
  let index = 0
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => (answers[Math.min(index++, answers.length - 1)] ?? (() => json(500, {})))())
  const api = createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-1' })
  const sent = (call = 0) => {
    const [url, init] = fetch.mock.calls[call]!
    return { url, method: init.method, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined }
  }
  return { api, fetch, sent }
}

const PASS = { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS', dmarcPolicy: null, spam: 'PASS', virus: 'PASS' }
const summary = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  companyId: 'c1',
  status,
  receivedAt: '2026-10-28T10:00:00.000Z',
  from: { address: 'buyer@example.com', name: 'Buyer' },
  subject: 'Hello',
  excerpt: 'Hello',
  verdicts: PASS,
  heldReason: null,
  rejectReason: null,
  matchedBy: null,
  threadId: null,
  suggestion: { partyId: null, contactId: null },
  attachmentCount: 0,
  version: 3,
  ...extra,
})
const detail = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  ...summary(id, status, extra),
  to: ['orders@example.com'],
  cc: [],
  bodyText: 'Hello',
  bodyHtml: null,
  attachments: [{ name: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10, kept: true, skipReason: null, file: { id: 'f1', kind: 'ATTACHMENT', originalName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10, status: 'AVAILABLE' } }],
  thread: null,
  messageId: null,
  attempts: 1,
  lastError: null,
  fetchedAt: '2026-10-28T10:00:01.000Z',
  sortedAt: null,
  sortedById: null,
})
const MAIL = { id: 'm1', version: 3 }
/** The certificates finder: its module's list route (refused here with a 403). */
const findRecordsFinder = (): RecordFinder => RECORD_FINDERS.find((finder) => finder.type === 'Certificate')!

describe('mail to sort calls the API through its one client (SCR-019)', () => {
  it('lists the mail to sort by default, one place on a filter, and keeps only mail that waits', async () => {
    const all = client(() => json(200, { mails: [summary('m1', 'TRIAGE'), summary('m2', 'HELD', { heldReason: 'SPAM' }), summary('m3', 'MATCHED')], nextCursor: 'next' }))
    const page = await listMail(all.api, 'all')
    expect(all.sent().url).toBe('/api/email/inbound?limit=50')
    expect(page.mails.map((mail) => mail.id)).toEqual(['m1', 'm2'])
    expect(page.nextCursor).toBe('next')
    const held = client(() => json(200, { mails: [summary('m2', 'HELD')], nextCursor: null }))
    await listMail(held.api, 'HELD', 'c-1')
    expect(held.sent().url).toBe('/api/email/inbound?status=HELD&cursor=c-1&limit=50')
  })

  it('reads one mail with its kept files', async () => {
    const { api } = client(() => json(200, { mail: detail('m1', 'TRIAGE') }))
    const mail = await getMail(api, 'm1')
    expect(mail.attachments).toEqual([{ name: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10, kept: true, skipReason: null, fileId: 'f1' }])
  })

  it('assigns a mail to a record with the version it read, the CSRF token, the company and an idempotency key', async () => {
    const { api, sent } = client(() => json(200, { mail: detail('m1', 'MATCHED', { matchedBy: 'MANUAL', version: 4 }) }))
    const result = await assignMail(api, MAIL, { type: 'Certificate', id: 'r1' })
    const call = sent()
    expect([call.method, call.url]).toEqual(['POST', '/api/email/inbound/m1/assign'])
    expect(call.body).toEqual({ recordType: 'Certificate', recordId: 'r1', version: 3 })
    expect(call.headers.get('x-csrf-token')).toBe('csrf-1')
    expect(call.headers.get('x-factory-company')).toBe('DEMO')
    expect(call.headers.get('idempotency-key')).toBeTruthy()
    expect(result.status).toBe('MATCHED')
  })

  it('releases a held mail (a reason only when one was written) and rejects one as spam or not for us', async () => {
    const release = client(() => json(200, { mail: detail('m1', 'MATCHED') }))
    await releaseMail(release.api, MAIL, '  ')
    expect(release.sent().body).toEqual({ version: 3 })
    const withReason = client(() => json(200, { mail: detail('m1', 'TRIAGE') }))
    await releaseMail(withReason.api, MAIL, ' Known supplier ')
    expect(withReason.sent().body).toEqual({ version: 3, reason: 'Known supplier' })
    const reject = client(() => json(200, { mail: detail('m1', 'REJECTED', { rejectReason: 'MARKED_SPAM' }) }))
    await rejectMail(reject.api, MAIL, 'MARKED_SPAM', '')
    expect([reject.sent().url, reject.sent().body]).toEqual(['/api/email/inbound/m1/reject', { reason: 'MARKED_SPAM', version: 3 }])
  })

  it('says, in its own words, why an answer failed — and reads the mail again when it moved meanwhile (COL-078)', async () => {
    const fail = async (status: number, error: Record<string, unknown>) => {
      try {
        await assignMail(client(() => json(status, { error: { message: 'english text', requestId: 'r', ...error } })).api, MAIL, { type: 'Certificate', id: 'r1' })
      } catch (caught) {
        return answerProblem(caught)
      }
      throw new Error('expected a refusal')
    }
    expect(await fail(409, { code: 'conflict', issues: [{ path: 'version', message: 'The current version is 4.' }] })).toEqual({ key: 'mailToSort.notice.conflict', tone: 'warning', reload: true })
    expect(await fail(409, { code: 'invalid_state' })).toEqual({ key: 'mailToSort.notice.conflict', tone: 'warning', reload: true })
    expect(await fail(409, { code: 'conflict' })).toEqual({ key: 'mailToSort.notice.cannot', tone: 'warning', reload: true })
    expect((await fail(403, { code: 'forbidden' })).key).toBe('mailToSort.notice.forbidden')
    expect((await fail(404, { code: 'not_found' })).key).toBe('mailToSort.notice.notFound')
    expect((await fail(503, { code: 'not_ready' })).key).toBe('mailToSort.notice.unavailable')
    expect(answerProblem(new Error('boom')).key).toBe('mailToSort.notice.failed')
  })

  it('finds records by number from each finder; a finder the person may not use finds nothing', async () => {
    const { api } = client(() =>
      json(200, {
        certificates: [
          { id: 'r1', holderPartyId: 'p1', standard: 'EN 17092-3:2020', ppeClass: 'A', number: '0000-17092-A' },
          { id: 'r2', holderPartyId: null, standard: 'EN 1621-1:2012', ppeClass: null, number: '0000-1621' },
        ],
        today: '2026-10-28',
      }),
    )
    expect(await findRecords(api, '', [findRecordsFinder()])).toEqual([
      { type: 'Certificate', id: 'r1', number: '0000-17092-A', title: 'EN 17092-3:2020 · A', hasParty: true },
      { type: 'Certificate', id: 'r2', number: '0000-1621', title: 'EN 1621-1:2012', hasParty: false },
    ])
    const refused = client(() => json(403, { error: { code: 'forbidden', message: 'm' } }))
    const quote = { type: 'Quote', id: 'q1', number: 'Q-1', title: 'Made-up quote', hasParty: true }
    const extra: RecordFinder = { type: 'Quote', find: async () => [quote] }
    expect(await findRecords(refused.api, '', [findRecordsFinder(), extra])).toEqual([quote])
    // Any other failure is the screen's to show.
    await expect(findRecords(client(() => json(500, { error: { code: 'internal_error', message: 'm' } })).api, '', [findRecordsFinder()])).rejects.toMatchObject({ kind: 'internal' })
  })

  it('quotes, orders and purchase orders are searched by number on the server, with their party', async () => {
    const finder = (type: string) => RECORD_FINDERS.find((entry) => entry.type === type)!
    const quotes = client(() => json(200, { quotes: [{ id: 'q1', number: 'OF-2026/0042', partyName: 'Negozio Esempio', netAmount: 1 }] }))
    expect(await finder('Quote').find(quotes.api, ' 0042 ')).toEqual([{ type: 'Quote', id: 'q1', number: 'OF-2026/0042', title: 'Negozio Esempio', hasParty: true }])
    expect(quotes.sent().url).toBe('/api/sales/quotes?q=0042&limit=20')
    const orders = client(() => json(200, { orders: [{ id: 'o1', number: 'OV-2026/0017', partyName: 'Negozio Esempio' }] }))
    expect((await finder('SalesOrder').find(orders.api, ''))[0]?.type).toBe('SalesOrder')
    expect(orders.sent().url).toBe('/api/sales/orders?limit=20')
    const purchases = client(() => json(200, { summary: {}, orders: [{ id: 'p1', number: 'OA-2026/0103', supplierName: 'Conceria Demo' }] }))
    expect(await finder('PurchaseOrder').find(purchases.api, 'OA')).toEqual([{ type: 'PurchaseOrder', id: 'p1', number: 'OA-2026/0103', title: 'Conceria Demo', hasParty: true }])
    expect(purchases.sent().url).toBe('/api/purchasing/orders?q=OA&limit=20')
  })
})

describe('what a person may do with a mail', () => {
  it('TRIAGE: assign or throw away; HELD: release, assign or throw away; FAILED: throw away only', () => {
    expect(mailActions({ status: 'TRIAGE' }, true)).toEqual([
      { action: 'assign', held: null },
      { action: 'reject', held: null },
    ])
    expect(mailActions({ status: 'HELD' }, true).map((entry) => entry.action)).toEqual(['release', 'assign', 'reject'])
    expect(mailActions({ status: 'FAILED' }, true)).toEqual([{ action: 'reject', held: null }])
    expect(mailActions({ status: 'MATCHED' }, true)).toEqual([])
  })

  it('without threads.post, assigning and releasing are held and say why; throwing away is not', () => {
    expect(mailActions({ status: 'HELD' }, false)).toEqual([
      { action: 'release', held: 'mailToSort.held.noWrite' },
      { action: 'assign', held: 'mailToSort.held.noWrite' },
      { action: 'reject', held: null },
    ])
  })

  it('a released mail goes into the thread it named, else back to the list', () => {
    expect(releaseTarget({ threadId: 't1' })).toBe('thread')
    expect(releaseTarget({ threadId: null })).toBe('list')
  })

  it('offers only records whose thread can take mail, found by their number', () => {
    const candidates: RecordCandidate[] = [
      { type: 'Certificate', id: 'r1', number: '0000-17092-A', title: 'EN 17092-3', hasParty: true },
      { type: 'Certificate', id: 'r2', number: '0000-1621-2', title: 'EN 1621-1', hasParty: false },
      { type: 'Certificate', id: 'r3', number: '0000-17092-AA', title: 'EN 17092-2', hasParty: true },
      { type: 'Quote', id: 'q1', number: 'OF-2026/0042', title: 'Giacche 46-56', hasParty: true },
    ]
    const ids = (query: string) => matchCandidates(candidates, query).shown.map((candidate) => candidate.id)
    expect(ids('')).toEqual(['r1', 'r3', 'q1'])
    // Spaces, hyphens, slashes and dots aside; a number that starts with it first; never one without a party.
    expect(ids('0000 17092')).toEqual(['r1', 'r3'])
    expect(ids('2026 0042')).toEqual(['q1'])
    expect(ids('1621')).toEqual([])
    expect(ids('giacche')).toEqual(['q1'])
    expect(matchCandidates(candidates, '', 1)).toEqual({ shown: [candidates[0]], total: 3 })
  })

  it('points at failed checks and names the sender', () => {
    expect(verdictWarnings({ spf: 'FAIL', dkim: 'PASS', dmarc: 'FAIL', dmarcPolicy: 'reject', spam: 'GRAY', virus: 'PASS' })).toEqual(['spf', 'dmarc'])
    expect(senderLine({ name: 'Buyer', address: 'buyer@example.com' })).toBe('Buyer <buyer@example.com>')
    expect(senderLine({ name: null, address: null })).toBeNull()
    expect(isMailChange({ type: 'email.inbound_sorted' })).toBe(true)
    expect(isMailChange({ type: 'thread.message_posted' })).toBe(false)
  })
})

describe('safe rendering of incoming mail (COL-026)', () => {
  const html = '<p>Hi</p><img data-remote-src="https://images.example.com/a.png" alt="a"><img data-remote-src="https://images.example.com/b.png">'

  it('keeps remote pictures out until the person allows them', () => {
    expect(remotePictureCount(html)).toBe(2)
    const blocked = mailDocument(html, { allowPictures: false })
    expect(blocked).not.toContain(' src=')
    expect(blocked).toContain("img-src data:;")
    const allowed = mailDocument(html, { allowPictures: true })
    expect(allowed).toContain(' src="https://images.example.com/a.png"')
    expect(allowed).toContain('img-src https: data:')
  })

  it('runs no script and sends no form, whatever the sanitiser let through', () => {
    const page = mailDocument('<p>x</p>', { allowPictures: true })
    expect(page).toContain("default-src 'none'")
    expect(page).toContain("form-action 'none'")
    expect(page).not.toContain('script-src')
    expect(page).toContain('<meta name="referrer" content="no-referrer">')
  })
})

// ── B-TH-224 (threads plan TH-1b): Mail to sort points at Incoming ──
describe('Make incoming request / Open in Incoming (B-TH-224)', () => {
  it('a waiting mail offers "Make incoming request" (Incoming\'s dialog for this mail); a mail that became a request offers "Open in Incoming"', async () => {
    const { inquiryHeld, inquiryHref, incomingHref, requestOfMail } = await import('../mail/create-inquiry/model')
    expect(inquiryHref('/w/DEMO', 'm 1')).toBe('/w/DEMO/sales/incoming?mail=m%201')
    expect(incomingHref('/w/DEMO', 'r1')).toBe('/w/DEMO/sales/incoming?open=r1')
    // Waiting, read by someone who answers requests: offered.
    expect(requestOfMail({ inquiry: null, thread: null })).toBeNull()
    expect(inquiryHeld({ status: 'TRIAGE', inquiry: null }, true)).toBeNull()
    // Without the right: held with words, never hidden.
    expect(inquiryHeld({ status: 'TRIAGE', inquiry: null }, false)).toBe('inquiry.held.noRight')
    // Made already: the request by the read, or by the request thread a customer's mail joined.
    expect(requestOfMail({ inquiry: { id: 'r1', number: 'INQ-2026-0007' }, thread: null })).toEqual({ id: 'r1', number: 'INQ-2026-0007' })
    expect(requestOfMail({ inquiry: null, thread: { recordType: 'Inquiry', recordId: 'r2' } })).toEqual({ id: 'r2', number: null })
    expect(requestOfMail({ inquiry: null, thread: { recordType: 'SalesOrder', recordId: 'so1' } })).toBeNull()
    // A thrown-away mail cannot become one.
    expect(inquiryHeld({ status: 'REJECTED', inquiry: null }, true)).toBe('inquiry.held.notWaiting')
  })

  it('the words say "request" and "Incoming" in both languages (one word per thing)', async () => {
    const { CATALOGUE } = await import('../../../lib/i18n/messages')
    const en = CATALOGUE.en['mail-depth']!
    const it_ = CATALOGUE.it['mail-depth']!
    expect(en['verb.createInquiry']).toBe('Make incoming request')
    expect(en['verb.openInIncoming']).toBe('Open in Incoming')
    expect(en['verb.openInquiry']).toBe('Open {number} in Incoming')
    expect(it_['verb.createInquiry']).toBe('Crea richiesta in arrivo')
    for (const words of [en, it_]) expect(Object.values(words).filter((value) => /\binquir/i.test(value.replace(/sales\.inquiries\.\w+/g, '')))).toEqual([])
  })
})
// ── end B-TH-224 ──

// ── B-TH-239 (threads plan TH-3; O-HOME-MAIL.tiles-F01, picture 17): the "Mail to sort" tile counts what waits, one rule ──
describe('the "Mail to sort" tile (B-TH-239)', () => {
  const page = { mails: [summary('m1', 'TRIAGE'), summary('m2', 'HELD', { heldReason: 'SPAM' }), summary('m3', 'FAILED'), summary('m4', 'MATCHED')], nextCursor: 'next' }

  it('counts the first page of what waits (TRIAGE, HELD, FAILED) — the same number Sales › Incoming’s notice says', async () => {
    const { mailToSortCount } = await import('../../sales/inquiries/api')
    const { toSortCountOf } = await import('./model')
    const tile = toSortCountOf(await listMail(client(() => json(200, page)).api, 'all'))
    const notice = await mailToSortCount(client(() => json(200, page)).api)
    expect(tile).toEqual({ count: 3, more: true })
    expect(tile).toEqual(notice)
    expect(toSortCountOf({ mails: [], nextCursor: null })).toEqual({ count: 0, more: false })
    // Not read yet: "—", never 0.
    expect(toSortCountOf(null)).toEqual({ count: null, more: false })
  })

  it('never follows the list’s filter or "Show more": a filtered list says "—" unless the page counted on its own', async () => {
    const { toSortTile } = await import('./model')
    const items = [summary('m2', 'HELD')].map((mail) => ({ ...mail, suggestedPartyId: null })) as never[]
    // The page's own count wins, whatever the list below shows.
    expect(toSortTile({ toSort: { count: 12, more: false }, filter: 'HELD', mails: { items, more: false } })).toEqual({ count: 12, more: false })
    // Without it (the design index): only the first page of "All to sort" is a count; the Held filter's rows are not.
    expect(toSortTile({ filter: 'HELD', mails: { items, more: false } })).toEqual({ count: null, more: false })
    expect(toSortTile({ filter: 'all', mails: { items, more: true } })).toEqual({ count: 1, more: true })
    expect(toSortTile({ filter: 'all', mails: { items: null, more: false } })).toEqual({ count: null, more: false })
    const many = Array.from({ length: 75 }, () => items[0]!)
    expect(toSortTile({ filter: 'all', mails: { items: many, more: false } })).toEqual({ count: 50, more: true })
  })

  it('the tiles and views stay as built: Mail to sort first, then each team inbox; Open, Mine, Nobody’s, Snoozed, Follow-up, Closed, All', async () => {
    const { QUEUE_VIEWS } = await import('../mail/team-inbox/model')
    expect(QUEUE_VIEWS).toEqual(['OPEN', 'MINE', 'UNASSIGNED', 'SNOOZED', 'FOLLOW_UP', 'CLOSED', 'ALL'])
    const { designScreen } = await import('./fixtures')
    expect(designScreen.cases.map((entry) => entry.id)).toContain('th3-239-tiles')
  })
})
// ── end B-TH-239 ──
