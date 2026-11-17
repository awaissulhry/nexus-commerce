import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import type { ApiClient } from '../../../lib/api/client'
import type { ApiMessage } from '../../../record-panels/api'
import { checkReply, officeOnly, postNoteKeyed, readContacts, removeFile, sendReplyKeyed, shareWithParty } from './api'
import { afterRead, applyNewest, applyOlder, checkProblemOf, EMPTY_SERVER, readStatusOf, replyRefusal, sendReason, uploadReason, type Work } from './state'
// B-TH-229
import { markThreadRead, setThreadOwner } from './api'
import { readMarker } from './state'
// B-TH-255
import { readHiddenNew, readThreadPage } from './api'

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

  it('the container keeps the draft with TH-1c’s store and guard, never a second copy (B-TH-208, B-TH-211)', () => {
    const source = readFileSync(new URL('./use-record-thread.ts', import.meta.url), 'utf8')
    expect(source).toContain("from '../../../lib/record-thread/helpers/model'")
    expect(source).toContain("from '../../../lib/record-thread/popups/use-leave-guard'")
    expect(source).not.toMatch(/localStorage\.(setItem|getItem)/)
    expect(source).not.toContain("addEventListener('beforeunload'")
  })
})

// ---- B-TH-229 (TH-2, on B-TH-027): reading marks the thread read for this person, once ----------------------------------------
describe('B-TH-229 — reading marks the thread read once, forward only', () => {
  const at = (minute: number) => `2026-11-17T10:${String(minute).padStart(2, '0')}:00.000Z`
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('one call per message seen later than the mark; the same or an older message never sends again', async () => {
    const sent: string[] = []
    const marker = readMarker(async (id) => void sent.push(id))
    marker.seen({ id: 'm2', at: at(2) })
    await settle()
    marker.seen({ id: 'm2', at: at(2) })
    marker.seen({ id: 'm1', at: at(1) })
    await settle()
    expect(sent).toEqual(['m2'])
    marker.seen({ id: 'm3', at: at(3) })
    await settle()
    expect(sent).toEqual(['m2', 'm3'])
  })

  it('the server’s own mark is known first: nothing at or before it sends', async () => {
    const sent: string[] = []
    const marker = readMarker(async (id) => void sent.push(id))
    marker.known({ id: 'm5', at: at(5) })
    marker.seen({ id: 'm4', at: at(4) })
    marker.seen({ id: 'm5', at: at(5) })
    await settle()
    expect(sent).toEqual([])
  })

  it('one call in flight: the newest message seen meanwhile goes right after, the ones between never', async () => {
    const sent: string[] = []
    let release: () => void = () => undefined
    const marker = readMarker((id) => {
      sent.push(id)
      return id === 'm1' ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()
    })
    marker.seen({ id: 'm1', at: at(1) })
    marker.seen({ id: 'm2', at: at(2) })
    marker.seen({ id: 'm3', at: at(3) })
    expect(sent).toEqual(['m1'])
    release()
    await settle()
    await settle()
    expect(sent).toEqual(['m1', 'm3'])
  })

  it('a failed call is forgotten quietly: the next message seen tries again', async () => {
    const sent: string[] = []
    const marker = readMarker(async (id) => {
      sent.push(id)
      if (id === 'm1') throw new Error('offline')
    })
    marker.seen({ id: 'm1', at: at(1) })
    await settle()
    await settle()
    marker.seen({ id: 'm1', at: at(1) })
    await settle()
    expect(sent).toEqual(['m1', 'm1'])
  })

  it('the calls: POST …/read names the message; PUT …/owner names a person or null (the record’s own); never anyone else’s mark (W08)', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const api = {
      post: async (path: string, options: { body: unknown }) => (calls.push({ method: 'POST', path, body: options.body }), { reading: { lastReadMessageId: 'm9', newCount: 0, firstNewMessageId: null } }),
      request: async (method: string, path: string, options: { body: unknown }) => (calls.push({ method, path, body: options.body }), { owner: null }),
    } as unknown as ApiClient
    expect(await markThreadRead(api, { type: 'SalesOrder', id: 'o1' }, 'm9')).toEqual({ lastReadMessageId: 'm9', newCount: 0, firstNewMessageId: null })
    expect(await setThreadOwner(api, { type: 'SalesOrder', id: 'o1' }, null)).toBeNull()
    expect(calls).toEqual([
      { method: 'POST', path: '/threads/SalesOrder/o1/read', body: { messageId: 'm9' } },
      { method: 'PUT', path: '/threads/SalesOrder/o1/owner', body: { ownerId: null } },
    ])
    // The body never names a person for the mark: the API takes the reader from the session.
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/user|person|reader/i)
  })

  it('a live re-read keeps the reading and head when the page has none, and takes them when it has', () => {
    const reading = { lastReadMessageId: 'm1', newCount: 1, firstNewMessageId: 'm2' }
    const head = { owner: null, waiting: null }
    const first = applyNewest(EMPTY_SERVER, { thread, messages: [msg('m2', '2026-11-17T09:00:00Z'), msg('m1', '2026-11-16T09:00:00Z')], nextCursor: null, reading, head })
    expect(first).toMatchObject({ reading, head })
    expect(applyNewest(first, { thread, messages: [msg('m2', '2026-11-17T09:00:00Z')], nextCursor: null })).toMatchObject({ reading, head })
    expect(applyNewest(first, { thread, messages: [msg('m2', '2026-11-17T09:00:00Z')], nextCursor: null, reading: { ...reading, newCount: 0, firstNewMessageId: null } }).reading?.newCount).toBe(0)
  })
})
// ---- end B-TH-229

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

describe('B-TH-300 — the docked thread’s container', () => {
  const recording = (answer: unknown) => {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: unknown }> = []
    const api = {
      request: async (method: string, path: string, options: { body?: unknown; query?: unknown; schema: { parse: (v: unknown) => unknown } }) => {
        calls.push({ method, path, body: options.body, query: options.query })
        return options.schema.parse(answer)
      },
    } as unknown as ApiClient
    return { api, calls }
  }

  it('the Files view’s bulk work: office only takes every outside audience off; Delete sends the version as read', async () => {
    const office = recording({ file: { id: 'f 1', version: 5, visibility: ['OFFICE'] } })
    await officeOnly(office.api, { id: 'f 1', version: 4 })
    expect(office.calls[0]).toMatchObject({ method: 'PUT', path: '/files/f%201/visibility', body: { visibility: ['OFFICE'], partyId: null, version: 4 } })
    const removed = recording({ file: { id: 'f', version: 2, visibility: ['OFFICE'] } })
    await removeFile(removed.api, { id: 'f', version: 1 })
    expect(removed.calls[0]).toMatchObject({ method: 'DELETE', path: '/files/f', query: { version: 1 } })
  })

  it('one container: the docked bands read the same reads (no second thread, files or people read for the page)', () => {
    const docked = readFileSync(new URL('./DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).not.toMatch(/readThreadPage|listFiles\(|listPeople\(|readTimeline\(/)
    expect(docked).toContain('base.files')
    const office = readFileSync(new URL('./OfficeRecordThread.tsx', import.meta.url), 'utf8')
    expect(office).toContain('useRecordThread(host)')
    expect(office.match(/useRecordThread\(/g)?.length).toBe(1)
  })

  it('Activity’s doors open the record panels’ EXISTING dialogs (R-ACT), never a copy', () => {
    const docked = readFileSync(new URL('./DockedOfficeThread.tsx', import.meta.url), 'utf8')
    for (const part of ["record-panels/view/TaskNewDialog'", "record-panels/approvals/view/AskDialog'", "record-panels/share/view/InviteDialog'", "record-panels/view/FollowersControl'", "record-panels/approvals/use-approvals'", "record-panels/share/use-shares'"]) expect(docked).toContain(part)
    const reminder = readFileSync(new URL('./use-thread-reminder.tsx', import.meta.url), 'utf8')
    expect(reminder).toContain("shell/panels/remind-me/view/RemindMeDialog'")
    expect(reminder).toContain('REMIND_ME_EVENT')
  })

  it('the brand wall: Share and Ask reach this record’s party only; the files are this record’s; no portal code', () => {
    const docked = readFileSync(new URL('./DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toContain('recordFiles(base.files.map((file) => fromApiFile(file)), key)')
    expect(docked).toContain("shareWithParty(api, file, partyId)")
    expect(docked).not.toMatch(/from '[^']*\/portal\//)
  })
})

// ---- B-TH-255 (B-TH-079): the feed tells everything — the View sent to the API, the office read's depth, the mail that waits -------
describe('B-TH-255 — the View asks the API what it hides; the office read keeps erased, skipped files and the mail that waits', () => {
  const getting = (answer: unknown) => {
    const calls: Array<{ path: string; query?: unknown }> = []
    const api = {
      get: async (path: string, options: { query?: unknown; schema: { parse: (v: unknown) => unknown } }) => {
        calls.push({ path, query: options.query })
        return options.schema.parse(answer)
      },
    } as unknown as ApiClient
    return { api, calls }
  }

  it('readHiddenNew: GET …/timeline with the view’s audience and kinds, one entry; only the count is used', async () => {
    const { api, calls } = getting({ entries: [], nextCursor: null, hiddenNew: 2, waitingMail: null })
    expect(await readHiddenNew(api, { type: 'SalesOrder', id: 'o 1' }, { audience: 'PARTNER', kinds: 'message' })).toBe(2)
    expect(calls).toEqual([{ path: '/threads/SalesOrder/o%201/timeline', query: { audience: 'PARTNER', kinds: 'message', limit: 1 } }])
    const changes = getting({ entries: [], nextCursor: null, hiddenNew: 5, waitingMail: null })
    expect(await readHiddenNew(changes.api, { type: 'SalesOrder', id: 'o1' }, { audience: 'ALL', kinds: 'change' })).toBe(5)
    expect(changes.calls[0]!.query).toEqual({ audience: 'ALL', kinds: 'change', limit: 1 })
  })

  it('the thread page keeps a message’s `erased` and its `skippedAttachments`, and the read’s `waitingMail` (never a sender)', async () => {
    const message = { ...msg('m1', '2026-11-17T09:00:00Z'), body: '', author: { kind: 'PARTY', id: null, name: null }, erased: true }
    const mail = { ...msg('m2', '2026-11-17T09:10:00Z'), skippedAttachments: [{ name: 'logo.ai', contentType: 'application/postscript', sizeBytes: 10, reason: 'type_not_allowed' }] }
    const { api, calls } = getting({ thread: null, messages: [mail, message], nextCursor: null, waitingMail: { count: 1, reasons: ['UNKNOWN_SENDER'], mayReview: false } })
    const page = await readThreadPage(api, { type: 'SalesOrder', id: 'o1' }, null)
    expect(calls[0]!.path).toBe('/threads/SalesOrder/o1')
    expect(page.messages.find((item) => item.id === 'm1')?.erased).toBe(true)
    expect(page.messages.find((item) => item.id === 'm2')?.skippedAttachments).toEqual([{ name: 'logo.ai', contentType: 'application/postscript', sizeBytes: 10, reason: 'type_not_allowed' }])
    expect(page.waitingMail).toEqual({ count: 1, reasons: ['UNKNOWN_SENDER'], mayReview: false })
    expect(JSON.stringify(page.waitingMail)).not.toMatch(/@|from|sender/i)
  })

  it('a live re-read keeps the waiting mail when the page says nothing of it; null when it says none', () => {
    const waitingMail = { count: 2, reasons: ['UNKNOWN_SENDER'], mayReview: true }
    const first = applyNewest(EMPTY_SERVER, { thread, messages: [msg('m1', '2026-11-17T09:00:00Z')], nextCursor: null, waitingMail })
    expect(first.waitingMail).toEqual(waitingMail)
    expect(applyNewest(first, { thread, messages: [msg('m1', '2026-11-17T09:00:00Z')], nextCursor: null }).waitingMail).toEqual(waitingMail)
    expect(applyNewest(first, { thread, messages: [msg('m1', '2026-11-17T09:00:00Z')], nextCursor: null, waitingMail: null }).waitingMail).toBeNull()
  })

  it('the container: every card carries its depth; Review opens Mail to sort only for a reader who may (mayReview)', () => {
    const container = readFileSync(new URL('./use-record-thread.ts', import.meta.url), 'utf8')
    expect(container).toContain('...cardDepth(message)')
    expect(container).toContain('waitingMail: page.waitingMail')
    expect(container).toContain("reviewHref: server.waitingMail.mayReview ? `${prefix}/home/mail-to-sort` : null")
  })

  it('the docked thread: a view is never remembered, asks the API only while on, and marks nothing read while it hides messages', () => {
    const docked = readFileSync(new URL('./DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toContain("useEffect(() => setView('all'), [key.type, key.id])")
    expect(docked).toMatch(/const query = viewQuery\(shown\)\s*if \(!query \|\| !can\.read\) \{\s*setHiddenNew\(0\)/)
    expect(docked).toContain('readHiddenNew(api, key, query, controller.signal)')
    expect(docked).toContain("onSeen: shown === 'all' ? actions.onSeen : undefined")
    expect(docked).toContain("onShowAll: () => setView('all')")
    expect(docked).toContain("hiddenNew: shown === 'all' ? 0 : hiddenNew")
    // No view is kept on the device (storage) — a new visit opens on All.
    expect(docked).not.toMatch(/localStorage|sessionStorage/)
  })
})
// ---- end B-TH-255

// ---- B-TH-286 / 287 / 288 / 289 (TH-9 on B-TH-091 pins, B-TH-092 drafts, B-TH-093 Done, B-TH-097 search, B-TH-096 follow-ups) -------
import { discardServerDraft, pinMessage, pinRequestNote, readPins, readServerDraft, saveServerDraft, searchThread, setThreadDone, unpinMessage } from './api'
import { pinRefusalKey } from './state'

describe('TH-9 — pins, the draft on the server, Done, search, the follow-up', () => {
  const recorder = (answer: unknown) => {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: unknown; idempotencyKey?: string }> = []
    const handler = (method: string) => async (path: string, options: { body?: unknown; query?: unknown; idempotencyKey?: string; schema: { parse: (v: unknown) => unknown } }) => {
      calls.push({ method, path, body: options.body, query: options.query, idempotencyKey: options.idempotencyKey })
      return options.schema.parse(answer)
    }
    const api = { get: handler('GET'), post: handler('POST'), request: (method: string, path: string, options: never) => handler(method)(path, options) } as unknown as ApiClient
    return { api, calls }
  }
  const pin = { messageId: 'm1', pinnedAt: '2026-11-17T09:00:00.000Z', pinnedBy: { id: 'u1', name: 'Alex Demo' }, message: { authorName: 'Dora', excerpt: 'Collar', at: '2026-11-16T09:00:00.000Z', audience: 'PARTNER', attachmentCount: 0, removed: false } }

  it('B-TH-286: reads, pins and unpins on the conversation’s own address, each write with its key; the request note moves in one call', async () => {
    const read = recorder({ pins: [pin] })
    expect((await readPins(read.api, { type: 'SalesOrder', id: 'o 1' }))[0]!.messageId).toBe('m1')
    expect(read.calls[0]).toMatchObject({ method: 'GET', path: '/threads/SalesOrder/o%201/pins' })
    const put = recorder({ pins: [pin] })
    await pinMessage(put.api, { type: 'SalesOrder', id: 'o1' }, 'm 1')
    expect(put.calls[0]).toMatchObject({ method: 'PUT', path: '/threads/SalesOrder/o1/pins/m%201', idempotencyKey: expect.any(String) })
    const del = recorder({ pins: [] })
    expect(await unpinMessage(del.api, { type: 'SalesOrder', id: 'o1' }, 'm1')).toEqual([])
    expect(del.calls[0]).toMatchObject({ method: 'DELETE', path: '/threads/SalesOrder/o1/pins/m1' })
    const note = recorder({ pins: [pin], messageId: 'm2' })
    expect((await pinRequestNote(note.api, 'i 1')).messageId).toBe('m2')
    expect(note.calls[0]).toMatchObject({ method: 'POST', path: '/threads/Inquiry/i%201/pins/note' })
  })

  it('B-TH-286: a refused pin in words — held mail, 50 pins, no right, gone', () => {
    const refusal = (code: string) => new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: `refusal.${code}`, message: 'x' }])
    expect(pinRefusalKey(refusal('HELD'))).toBe('notice.pin.HELD')
    expect(pinRefusalKey(refusal('FULL'))).toBe('notice.pin.FULL')
    expect(pinRefusalKey(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('notice.pin.forbidden')
    expect(pinRefusalKey(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('notice.pin.gone')
    expect(pinRefusalKey(new Error('x'))).toBe('notice.pin.failed')
  })

  it('B-TH-287: the draft is read, saved with the version last read (never a person or party), and discarded on its own address', async () => {
    const draft = { recordType: 'SalesOrder', recordId: 'o1', audience: 'OFFICE', body: 'x', fields: { mode: 'note' }, attachments: [], savedAt: '2026-11-17T09:42:00.000Z', version: 4 }
    const read = recorder({ draft })
    expect((await readServerDraft(read.api, { type: 'SalesOrder', id: 'o1' }))?.version).toBe(4)
    expect(read.calls[0]).toMatchObject({ method: 'GET', path: '/threads/SalesOrder/o1/draft' })
    const save = recorder({ draft: { ...draft, version: 5 }, replacedNewer: false })
    await saveServerDraft(save.api, { type: 'SalesOrder', id: 'o1' }, { audience: 'OFFICE', body: 'x', fields: { mode: 'note' }, attachments: [], version: 4 })
    expect(save.calls[0]).toMatchObject({ method: 'PUT', path: '/threads/SalesOrder/o1/draft', body: { audience: 'OFFICE', body: 'x', fields: { mode: 'note' }, attachments: [], version: 4 } })
    expect(JSON.stringify(save.calls[0]!.body)).not.toMatch(/userId|partyId/)
    const discard = recorder({ draft: null })
    await discardServerDraft(discard.api, { type: 'SalesOrder', id: 'o1' })
    expect(discard.calls[0]).toMatchObject({ method: 'DELETE', path: '/threads/SalesOrder/o1/draft' })
  })

  it('B-TH-287: the container saves a pause after typing, restores the newer copy, and a sent or discarded text never comes back', () => {
    const container = readFileSync(new URL('./use-record-thread.ts', import.meta.url), 'utf8')
    expect(container).toContain('readServerDraft(api, key, controller.signal)')
    expect(container).toContain('newerCopy(local, found)')
    expect(container).toContain('DRAFT_SAVE_MS')
    // A send clears the draft (forgetDraft stops saving); a save still on its way is followed by a discard.
    expect(container).toMatch(/setKept\(null\)\s*stopSaving\(\)/)
    expect(container).toContain('if (seq <= stoppedAt.current)')
    expect(container).toContain('void discardServerDraft(api, key).catch(() => undefined)')
    // Discard is the person's word: the server's draft goes too; an emptied box discards it.
    expect(container).toMatch(/discardRef\.current = \(\) => \{[\s\S]*?discardServerDraft\(api, key\)/)
    // Leaving with the draft on the server asks nothing (only files still going up are not kept).
    expect(container).toContain("useLeaveGuard(keptOnServer ? { text: '', files: notKept } : { text: work.draft.body, files: unsentFiles })")
  })

  it('B-TH-288: Done on its own address (the customer can still write); search asks the server for this record’s messages only', async () => {
    const done = recorder({ done: { at: '2026-11-17T09:00:00.000Z', by: { id: 'u1', name: 'Alex Demo' } } })
    expect(await setThreadDone(done.api, { type: 'SalesOrder', id: 'o1' }, true)).toMatchObject({ by: { name: 'Alex Demo' } })
    expect(done.calls[0]).toMatchObject({ method: 'PUT', path: '/threads/SalesOrder/o1/done', body: { done: true } })
    const search = recorder({ query: 'collar', words: ['collar'], tooShort: false, results: [{ recordType: 'Message', recordId: 'm1', subtitle: 'Collar', status: 'INBOUND', indexedAt: '2026-11-17T09:00:00.000Z' }], counts: [], total: 1, nextOffset: null, asOf: null })
    const hits = await searchThread(search.api, { type: 'SalesOrder', id: 'o1' }, 'collar')
    expect(hits.results[0]!.recordId).toBe('m1')
    expect(search.calls[0]).toMatchObject({ method: 'GET', path: '/search', query: { q: 'collar', type: 'Message', recordType: 'SalesOrder', recordId: 'o1' } })
    // The thread page keeps Done (office only) through a live re-read.
    const first = applyNewest(EMPTY_SERVER, { thread, messages: [], nextCursor: null, done: { at: 'x', by: { id: 'u1', name: null } } })
    expect(applyNewest(first, { thread, messages: [], nextCursor: null }).done).toEqual({ at: 'x', by: { id: 'u1', name: null } })
    expect(applyNewest(first, { thread, messages: [], nextCursor: null, done: null }).done).toBeNull()
  })

  it('B-TH-288: a hit or a pin is brought on screen (older pages read), the View back to All first; search only for readers', () => {
    const container = readFileSync(new URL('./use-record-thread.ts', import.meta.url), 'utf8')
    expect(container).toContain('const jumpTo = useCallback(')
    expect(container).toContain('readThreadPage(api, key, current.cursor)')
    const docked = readFileSync(new URL('./DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toMatch(/const pickHit = \(messageId: string\) => \{\s*setSearch\(null\)[\s\S]*?setView\('all'\)\s*void base\.jumpTo\(messageId\)/)
    expect(docked).toContain('const searchOffered = can.read')
    expect(docked).toContain('searchThread(api, key, searchQuery, controller.signal)')
  })

  it('B-TH-289: the follow-up is the person’s own reminder on the message that went, three days on; a mail taken back takes it along', () => {
    const container = readFileSync(new URL('./use-record-thread.ts', import.meta.url), 'utf8')
    expect(container).toContain("setReminder(api, { record: key, messageId, kind: 'AT_TIME', remindAt: followUpAt(Date.now()), note: null })")
    expect(container).toContain('if (snapshot.followUp) void setFollowUp(messageId)')
    expect(container).toContain("if (item.snapshot.followUp && item.snapshot.draft.mode === 'portal') void setFollowUp(messageId)")
    expect(container).toContain('void removeReminder(api, followUp)')
    // Never on an office note: the tick is offered on a message to the customer only.
    expect(container).toContain('followUpOffered(work.draft.mode, { remind: true })')
  })
})
// ---- end TH-9
