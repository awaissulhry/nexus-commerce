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
    expect(await findRecords(api)).toEqual([
      { type: 'Certificate', id: 'r1', number: '0000-17092-A', title: 'EN 17092-3:2020 · A', hasParty: true },
      { type: 'Certificate', id: 'r2', number: '0000-1621', title: 'EN 1621-1:2012', hasParty: false },
    ])
    const refused = client(() => json(403, { error: { code: 'forbidden', message: 'm' } }))
    const quote = { type: 'Quote', id: 'q1', number: 'Q-1', title: 'Made-up quote', hasParty: true }
    const extra: RecordFinder = { type: 'Quote', find: async () => [quote] }
    expect(await findRecords(refused.api, [findRecordsFinder(), extra])).toEqual([quote])
    // Any other failure is the screen's to show.
    await expect(findRecords(client(() => json(500, { error: { code: 'internal_error', message: 'm' } })).api)).rejects.toMatchObject({ kind: 'internal' })
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
