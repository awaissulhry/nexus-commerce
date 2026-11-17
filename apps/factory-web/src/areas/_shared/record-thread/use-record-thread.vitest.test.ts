import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import type { ApiClient } from '../../../lib/api/client'
import type { ApiMessage } from '../../../record-panels/api'
import { checkReply, postNoteKeyed, readContacts, sendReplyKeyed, shareWithParty } from './api'
import { afterRead, applyNewest, applyOlder, checkProblemOf, draftStoreKey, EMPTY_SERVER, hasUnsent, parseStoredDraft, readStatusOf, replyRefusal, sendReason, uploadReason, type Work } from './state'

/** B-TH-212 — the office container of RecordThread v1: its calls, a live read that never drops the draft, the errors in words. */

const msg = (id: string, at: string): ApiMessage => ({ id, direction: 'INBOUND', audience: 'PARTNER', channel: 'EMAIL', author: { kind: 'PARTY', id: null, name: 'A' }, authorHidden: false, forFloor: false, body: id, bodyHtml: null, attachments: [], at })
const thread = { status: 'OPEN' as const, version: 3, partyId: 'p1' }
const work: Work = {
  draft: { mode: 'reply', body: 'Half a sentence I am typing', forFloor: false },
  notes: [],
  files: [{ key: 'k', name: 'a.pdf', sizeBytes: 1, contentType: 'application/pdf', source: 'device', phase: 'uploading', audience: 'PARTY' }],
  to: [{ address: 'a@x.example', name: 'A', kind: 'PARTY', organisation: 'Brand Alpha' }],
  cc: [],
  subject: 'Re: x',
  outbox: [{ key: 'local-1', card: { id: 'local-1', kind: 'note', channel: 'APP', author: 'Alex', authorKind: 'USER', at: '2026-11-17T10:00:00Z', body: 'sent', mentions: [], files: [] }, state: 'sending', messageId: 'm3' }],
}

describe('a live read never drops the draft (T4-F06)', () => {
  it('the newest page replaces the newest messages and keeps the older pages already loaded', () => {
    const first = applyNewest(EMPTY_SERVER, { thread, messages: [msg('m2', '2026-11-17T09:00:00Z'), msg('m1', '2026-11-16T09:00:00Z')], nextCursor: 'c1' })
    expect(first).toMatchObject({ status: 'ready', cursor: 'c1', more: true })
    expect(first.messages.map((item) => item.id)).toEqual(['m1', 'm2'])
    const older = applyOlder(first, { messages: [msg('m0', '2026-11-15T09:00:00Z')], nextCursor: null })
    expect(older.messages.map((item) => item.id)).toEqual(['m0', 'm1', 'm2'])
    const live = applyNewest(older, { thread, messages: [msg('m3', '2026-11-17T10:00:00Z'), msg('m2', '2026-11-17T09:00:00Z')], nextCursor: 'c2' })
    expect(live.messages.map((item) => item.id)).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(live.more).toBe(false)
  })

  it('after a re-read the draft, its files and its recipients are the same; only the confirmed outbox item leaves', () => {
    const server = applyNewest(EMPTY_SERVER, { thread, messages: [msg('m3', '2026-11-17T10:00:00Z')], nextCursor: null })
    const next = afterRead(work, server)
    expect(next.draft).toBe(work.draft)
    expect(next.files).toBe(work.files)
    expect(next.to).toBe(work.to)
    expect(next.outbox).toEqual([])
    expect(afterRead(work, EMPTY_SERVER)).toBe(work)
  })

  it('the draft waits on this device per company and record, text and mode only', () => {
    expect(draftStoreKey('c1', { type: 'Inquiry', id: 'i1' })).toBe('fw-rt-draft:c1:Inquiry:i1')
    expect(parseStoredDraft(JSON.stringify({ mode: 'reply', body: 'Hi', forFloor: false }))).toEqual({ mode: 'reply', body: 'Hi', forFloor: false })
    expect(parseStoredDraft('{"mode":"other","body":"x"}')).toBeNull()
    expect(parseStoredDraft('not json')).toBeNull()
    expect(hasUnsent(work)).toBe(true)
    expect(hasUnsent({ draft: { mode: 'note', body: ' ', forFloor: false }, files: [] })).toBe(false)
  })
})

describe('errors in this app’s words', () => {
  it('a first read: no right, or a fault', () => {
    expect(readStatusOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('forbidden')
    expect(readStatusOf(new Error('x'))).toBe('error')
  })

  it('why a message did not go; a refusal the person must fix goes back into the box', () => {
    expect(sendReason(new TypeError('fetch failed'))).toBe('reason.network')
    expect(sendReason(new ApiError('unavailable', 503, 'unavailable', 'x'))).toBe('reason.unavailable')
    const outside = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal.OTHER_PARTY', message: 'x' }])
    expect(sendReason(outside)).toBe('reason.outside')
    expect(replyRefusal(outside)).toBe('notice.outside')
    expect(replyRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal.HIDDEN_OUTSIDE', message: 'x' }]))).toBe('notice.hidden')
    expect(replyRefusal(new ApiError('invalid', 422, 'invalid', 'x', null, [{ path: 'body.to.0', message: 'suppressed' }]))).toBe('notice.badRecipient')
    expect(replyRefusal(new ApiError('unavailable', 503, 'unavailable', 'x'))).toBeNull()
  })

  it('the check and the uploads', () => {
    expect(checkProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ problem: 'problem.forbidden', retry: false })
    expect(checkProblemOf(new ApiError('unavailable', 503, 'unavailable', 'x'))).toEqual({ problem: 'problem.unavailable', retry: true })
    expect(uploadReason(new ApiError('invalid', 422, 'invalid', 'x', null, [{ path: 'body.partyId', message: 'x' }]), false)).toBe('failed.otherParty')
    expect(uploadReason(new Error('x'), true)).toBe('failed.store')
  })
})

describe('the container’s calls', () => {
  const recording = (answer: unknown) => {
    const calls: Array<{ method: string; path: string; body?: unknown; idempotencyKey?: string; query?: unknown }> = []
    const handler = (method: string) => async (path: string, options: { body?: unknown; schema: { parse: (v: unknown) => unknown }; idempotencyKey?: string; query?: unknown }) => {
      calls.push({ method, path, body: options.body, idempotencyKey: options.idempotencyKey, query: options.query })
      return options.schema.parse(answer)
    }
    const api = { get: handler('GET'), post: handler('POST'), request: (method: string, path: string, options: never) => handler(method)(path, options) } as unknown as ApiClient
    return { api, calls }
  }

  it('a note and a reply carry the caller’s key (Retry sends the same one); the reply has To and Cc apart and the tick', async () => {
    const note = recording({ message: { id: 'm9' } })
    expect(await postNoteKeyed(note.api, { type: 'Inquiry', id: 'i 1' }, { body: 'x', mentions: [], attachments: [], forFloor: false }, 'key-1')).toBe('m9')
    expect(note.calls).toEqual([{ method: 'POST', path: '/threads/Inquiry/i%201/notes', body: { body: 'x', mentions: [], attachments: [] }, idempotencyKey: 'key-1', query: undefined }])
    const reply = recording({ messageId: 'm10' })
    expect(await sendReplyKeyed(reply.api, { type: 'Inquiry', id: 'i1' }, { to: ['a@x.example'], cc: ['b@x.example'], body: 'Hi', attachments: [], sendOutside: true }, 'key-2')).toBe('m10')
    expect(reply.calls[0]).toMatchObject({ path: '/threads/Inquiry/i1/emails', body: { to: ['a@x.example'], cc: ['b@x.example'], sendOutside: true }, idempotencyKey: 'key-2' })
  })

  it('the check reads every address of To and Cc; the contacts are the active ones with an address', async () => {
    const check = recording({ party: null, recipients: [], warnings: [], attachments: [], outsideCustomer: ['b@x.example'] })
    expect((await checkReply(check.api, { type: 'Inquiry', id: 'i1' }, { addresses: ['a@x.example', 'b@x.example'], subject: ' ', body: 'Hi', attachments: [] })).outsideCustomer).toEqual(['b@x.example'])
    expect(check.calls[0]).toMatchObject({ path: '/threads/Inquiry/i1/emails/check', body: { to: ['a@x.example', 'b@x.example'], body: 'Hi', attachments: [] } })
    const party = recording({ party: { id: 'p', contacts: [{ name: 'A', email: 'a@x.example', status: 'ACTIVE' }, { name: 'B', email: null, status: 'ACTIVE' }, { name: 'C', email: 'c@x.example', status: 'ARCHIVED' }] } })
    expect(await readContacts(party.api, 'p')).toEqual([{ name: 'A', email: 'a@x.example' }])
  })

  it('sharing a file with the customer keeps its audiences, adds the portal and names the record’s customer', async () => {
    const share = recording({ file: { id: 'f', version: 4, visibility: ['OFFICE', 'PARTNER'] } })
    await shareWithParty(share.api, { id: 'f', version: 3, visibility: ['OFFICE', 'FLOOR'] }, 'p1')
    expect(share.calls[0]).toMatchObject({ method: 'PUT', path: '/files/f/visibility', body: { visibility: ['OFFICE', 'FLOOR', 'PARTNER'], partyId: 'p1', version: 3 } })
  })

  it('the office container never runs in the portal (check-view-boundaries: areas is the Office view)', () => {
    const source = readFileSync(new URL('./use-record-thread.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from '[^']*\/portal\//)
  })
})
