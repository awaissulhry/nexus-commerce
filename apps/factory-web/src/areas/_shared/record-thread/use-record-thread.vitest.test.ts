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
// F-SA-260: THE dock pick, and the work order's dock that draws it.
import { createElement } from 'react'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { render } from '../../../lib/record-thread/parts/testing'
import { WorkOrderThreads } from '../../production/work-orders/record/view/WorkOrderThreads'
import { pickedChoice, pickShown, ThreadPick, type ThreadChoice } from './ThreadPick'
/** Words as the server markup writes them (an apostrophe, a quote, an ampersand). */
const escaped = (words: string): string => words.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;')

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
    expect(await sendReplyKeyed(reply.api, { type: 'Inquiry', id: 'i1' }, { to: ['a@x.example'], cc: ['b@x.example'], body: 'Hi', attachments: [], sendOutside: true }, 'key-2')).toEqual({ messageId: 'm10', email: null }) // B-TH-236: the mail's id and its undo window come back
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
    for (const part of ["record-panels/tasks/view/TaskNewDialog'", "record-panels/approvals/view/AskDialog'", "record-panels/share/view/InviteDialog'", "record-panels/tasks/view/FollowersControl'", "record-panels/approvals/use-approvals'", "record-panels/share/use-shares'"]) expect(docked).toContain(part)
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
    // Never a sender: no address and no from / sender field (UNKNOWN_SENDER is the reason's code, not a sender).
    expect(Object.keys(page.waitingMail ?? {}).sort()).toEqual(['count', 'mayReview', 'reasons'])
    expect(JSON.stringify(page.waitingMail)).not.toMatch(/@|"from|"sender/i)
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

// ---- B-TH-280: the old record panels went; what only they drew lives on in the docked thread (nothing lost, nothing unused).
describe('B-TH-280 — the docked thread holds what the old record panels held', () => {
  const docked = readFileSync(new URL('./DockedOfficeThread.tsx', import.meta.url), 'utf8')

  it('imports no record panels and no panels view', () => {
    expect(docked).not.toMatch(/RecordPanels|record-panels\/view\/|record-panels\/RecordPanels/)
    expect(docked).not.toContain('as unknown as')
  })

  it('the files in depth sit in the Files view: type and expiry, Versions, Mark up, What it is, and one documents read', () => {
    expect(docked).toContain("import { useFileDepth } from '../../../record-panels/files/use-file-depth'")
    expect(docked).toContain("import { DepthActions, DepthDialogs, DepthTags, DepthTop } from '../../../record-panels/files/view/DepthParts'")
    expect(docked).toMatch(/useFileDepth\(\{[\s\S]*?files: filesOpen && can\.readFiles && base\.filesRead \? base\.files : null/)
    expect(docked).toContain('slots={depthSlots')
    // The view's "Missing before …" lines come from the depth's own read (GET /files/documents once, not twice).
    expect(docked).toContain('missingOf(depth.model.documents)')
    expect(docked).not.toContain('readDocuments(')
    // A PDF version opens in the thread's ONE viewer.
    expect(docked).toContain('openPdf: openOneFile')
  })

  it('the Ask and Share doors open their window once something is asked or shared; else the dialog at once', () => {
    expect(docked).toContain("else if (door === 'approve') (anyRequest || anyApproval ? setManaging('approve') : approvals.actions.onAsk?.(true))")
    expect(docked).toContain("else if (door === 'share') (anyShare ? setManaging('share') : shares.actions.onInvite?.(true))")
    expect(docked).toContain("{managing === 'approve' && (")
    expect(docked).toContain('<ApprovalsWindow')
    expect(docked).toContain('<SharesWindow')
    // Inside a window its panel draws the dialog: never twice.
    expect(docked).toContain("approvals.model?.ask && managing !== 'approve' && <AskDialog")
    expect(docked).toContain("shares.model?.invite && managing !== 'share' && <InviteDialog")
  })

  it('the record’s approval history is reachable (the Approvals window) and read again on an approval of this record', () => {
    expect(docked).toContain("useApprovalHistory({ api, record: key, allowed: held.has('approvals.view'), held })")
    expect(docked).toContain('<ApprovalHistory model={approvalHistory.model} actions={approvalHistory.actions} />')
    expect(docked).toContain("change.type.startsWith('approval.') && change.fields.recordId === key.id) approvalHistory.refresh()")
  })
})
// ---- end B-TH-280
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
    // B-TH-280: a read-only thread (the print view) keeps no draft and asks nothing.
    expect(container).toContain("useLeaveGuard(host.readOnly ? { text: '', files: 0 } : keptOnServer ? { text: '', files: notKept } : { text: work.draft.body, files: unsentFiles })")
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

// ── F-SA-260 (sales page plan N4, picks P9, P19; review C-13): THE pick of a record's dock, lifted from the work order's ─────────────
// F-OP-202: the pick is drawn INSIDE the dock's card (DockTop): a card that draws it stands in for the docked thread here.
const Card = () => createElement(PickedDockColumn, { label: 'The card', body: createElement('p', null, 'THE THREAD') })
describe('F-SA-260 — ThreadPick: which ONE thread the dock shows, and the one line that says whose it is', () => {
  const choices: ThreadChoice[] = [
    { value: 'workOrder', label: 'Work order notes', title: 'Office only.', line: 'Office only: never shared with a customer.' },
    { value: 'order-1', label: 'SO-0142 · Brand Alpha', line: 'SO-0142’s thread is shared with Brand Alpha.' },
  ]

  it('the picker model: the value asked for, else the first (the default) — never a choice the host did not offer', () => {
    expect(pickedChoice(choices, 'order-1')?.value).toBe('order-1')
    expect(pickedChoice(choices, 'an-order-the-reader-may-not-open')?.value).toBe('workOrder')
    expect(pickedChoice(choices, null)?.value).toBe('workOrder')
    expect(pickedChoice([], 'order-1')).toBeNull()
    // One thread alone needs no pick.
    expect(pickShown(choices)).toBe(true)
    expect(pickShown(choices.slice(0, 1))).toBe(false)
    expect(pickShown([])).toBe(false)
  })

  it('draws the DS SegmentedControl (small, wrapping, named), the picked segment checked, and the picked choice’s line under it', () => {
    const html = render(createElement(ThreadPick, { label: 'Which thread', choices, value: 'order-1', children: createElement(Card) }))
    expect(html).toContain('role="radiogroup" aria-label="Which thread"')
    expect(html).toContain('class="nds-seg sm wrap"')
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*title="SO-0142 · Brand Alpha"><span class="fw-thread-pick-long">SO-0142 · Brand Alpha<\/span>/)
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*title="Work order notes · Office only\."><span class="fw-thread-pick-long">Work order notes<\/span>/)
    expect(html).toContain('<span>SO-0142’s thread is shared with Brand Alpha.</span></p>')
    expect(html.indexOf('fw-thread-pick-line')).toBeLessThan(html.indexOf('THE THREAD'))
    // One choice: the thread alone, no pick and no line.
    const alone = render(createElement(ThreadPick, { label: 'Which thread', choices: choices.slice(0, 1), value: 'workOrder', children: createElement(Card) }))
    expect(alone).not.toContain('radiogroup')
    expect(alone).not.toContain('fw-rt-top')
    expect(alone).toContain('THE THREAD')
  })

  it('the work order page behaves exactly as today: its own words, its orders as choices, an unknown pick shows its notes', () => {
    const orders = [{ orderId: 'order-1', number: 'SO-0142', party: { id: 'p1', name: 'Brand Alpha' }, customerRef: null, companyId: 'c1' }]
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['production']).production!)
      const picked = render(createElement(WorkOrderThreads, { choices: orders, pick: 'order-1', children: createElement(Card) }), locale)
      expect(picked, locale).toContain(`aria-label="${escaped(t('thread.pickLabel'))}"`)
      expect(picked, locale).toContain(escaped(t('thread.orderShared', { number: 'SO-0142', customer: 'Brand Alpha' })))
      // F-OP-203: each order with its icon (the bag), the work order's notes with the Lock.
      expect(picked, locale).toMatch(/aria-checked="true"[^>]*><span class="nds-seg-icon"><svg[^>]*lucide-shopping-bag[^>]*>.*?<\/svg><\/span><span class="fw-thread-pick-long">SO-0142 · Brand Alpha</)
      expect(picked, locale).toMatch(/aria-checked="false"[^>]*><span class="nds-seg-icon"><svg[^>]*lucide-lock[^>]*>/)
      expect(picked, locale).toContain(`title="${escaped(`${t('thread.workOrder')} · ${t('thread.workOrderHint')}`)}"`)
      const unknown = render(createElement(WorkOrderThreads, { choices: orders, pick: 'gone', children: createElement(Card) }), locale)
      expect(unknown, locale).toContain(`aria-checked="true" tabindex="0" class="nds-seg-opt on" title="${escaped(`${t('thread.workOrder')} · ${t('thread.workOrderHint')}`)}"`)
      // The work order's notes: office only, their line under the pick in the office tone (F-OP-203).
      expect(unknown, locale).toContain('<p class="fw-thread-pick-line is-office" aria-live="polite">')
      expect(unknown, locale).toContain(`<span>${escaped(t('thread.workOrderHint'))}</span></p>`)
      // No order thread the reader may read: the work order's notes alone, no pick.
      expect(render(createElement(WorkOrderThreads, { choices: [], pick: 'workOrder', children: createElement(Card) }), locale), locale).not.toContain('radiogroup')
    }
  })

  it('one part, never a fork: the work order draws the shared pick; its old class and rule went; the same look (flex column, gap 7, muted small line)', () => {
    const workOrder = readFileSync(new URL('../../production/work-orders/record/view/WorkOrderThreads.tsx', import.meta.url), 'utf8')
    expect(workOrder).toContain("from '../../../../_shared/record-thread/ThreadPick'")
    expect(workOrder).not.toContain('SegmentedControl')
    expect(readFileSync(new URL('../../production/_shared/production.css', import.meta.url), 'utf8')).not.toMatch(/\.fw-pr-threadpick\s*\{/)
    const css = readFileSync(new URL('./thread-pick.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-thread-pick \{\s*display: flex;\s*flex-direction: column;\s*gap: var\(--nds-space-7\);\s*min-width: 0;\s*\}/)
    expect(css).toMatch(/\.fw-thread-pick-line \{\s*display: flex;\s*align-items: flex-start;\s*gap: var\(--nds-space-6\);\s*margin: 0;\s*color: var\(--nds-text-muted\);\s*font-size: var\(--nds-font-size-sm\);\s*line-height: 1\.45;\s*\}/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })
})
// ── end F-SA-260

// ── F-OP-202 (order page plan N4; 11-dock §0.1, §2; review R-13): the pick band INSIDE the card ────────────────────────────────────────
import { DockColumn } from '../../../lib/record-thread/DockColumn'
import { lineClassOf, PickedDockColumn, segmentOf, useDockTop } from './ThreadPick'
describe('F-OP-202 — the pick band inside the dock’s one card: icons, long / short words, "N new" as a Pill, the whose-line', () => {
  const choices: ThreadChoice[] = [
    { value: 'order', label: 'This order', count: 2, icon: createElement('i', { 'data-icon': 'bag' }), line: 'This order’s thread is shared with Brand Alpha.' },
    { value: 'general', label: 'Brand Alpha S.r.l. (general)', short: 'General', count: 0, line: 'Brand Alpha’s general thread.' },
    { value: 'all', label: 'All of Brand Alpha S.r.l.', short: 'All', title: 'Read only', line: null },
    { value: 'wo', label: 'Work orders', count: 1, tone: 'office', line: 'WO-1 notes: office only.' },
  ]

  it('the pick model: long and short words, the full words on hover, the count (never below 0), the office tone', () => {
    expect(segmentOf(choices[0]!)).toEqual({ long: 'This order', short: null, title: 'This order', count: 2 })
    expect(segmentOf(choices[1]!)).toEqual({ long: 'Brand Alpha S.r.l. (general)', short: 'General', title: 'Brand Alpha S.r.l. (general)', count: 0 })
    expect(segmentOf(choices[2]!)).toEqual({ long: 'All of Brand Alpha S.r.l.', short: 'All', title: 'All of Brand Alpha S.r.l. · Read only', count: 0 })
    // A short word equal to the label is no short word; a count that is not a number, or below 0, is none.
    expect(segmentOf({ value: 'x', label: 'Projects', short: 'Projects', line: null }).short).toBeNull()
    expect(segmentOf({ value: 'x', label: 'X', count: -3, line: null }).count).toBe(0)
    expect(segmentOf({ value: 'x', label: 'X', count: Number.NaN, line: null }).count).toBe(0)
    expect(segmentOf({ value: 'x', label: 'X', count: 2.7, line: null }).count).toBe(2)
    expect(lineClassOf(choices[3]!)).toBe('fw-thread-pick-line is-office')
    expect(lineClassOf(choices[0]!)).toBe('fw-thread-pick-line')
  })

  it('"N new" is a DS Pill size sm — the number visible, "2 new" its name (R-13: never compact, which hides the words)', () => {
    for (const [locale, two, one] of [['en', '2 new', '1 new'], ['it', '2 nuovi', '1 nuovo']] as const) {
      const html = render(createElement(ThreadPick, { label: 'Which thread', choices, value: 'order', children: createElement(Card) }), locale)
      expect(html, locale).toContain(`<span class="nds-pill info fw-thread-pick-new" aria-label="${two}" title="${two}">2</span>`)
      expect(html, locale).toContain(`<span class="nds-pill info fw-thread-pick-new" aria-label="${one}" title="${one}">1</span>`)
      expect(html, locale).not.toMatch(/nds-pill[^"]*compact/)
      // No pill for 0 new.
      expect(html.match(/fw-thread-pick-new/g)?.length, locale).toBe(2)
    }
    const source = readFileSync(new URL('./ThreadPick.tsx', import.meta.url), 'utf8')
    expect(source).toContain('<Pill tone="info" size="sm" className="fw-thread-pick-new" aria-label={fresh} title={fresh}>')
    expect(source).not.toMatch(/<Pill[^>]*\bcompact\b/)
  })

  it('each segment: its icon, its long words (one line, 22 characters), its short words for a card of 480 px or less', () => {
    const html = render(createElement(ThreadPick, { label: 'Which thread', choices, value: 'general', children: createElement(Card) }))
    expect(html).toContain('<span class="nds-seg-icon"><i data-icon="bag"></i></span><span class="fw-thread-pick-long">This order</span>')
    expect(html).toContain('<span class="fw-thread-pick-long has-short">Brand Alpha S.r.l. (general)</span><span class="fw-thread-pick-short">General</span>')
    expect(html).toContain('title="All of Brand Alpha S.r.l. · Read only"><span class="fw-thread-pick-long has-short">All of Brand Alpha S.r.l.</span><span class="fw-thread-pick-short">All</span>')
    const css = readFileSync(new URL('./thread-pick.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-thread-pick-long \{[^}]*max-width: min\(22ch, 100%\);[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/)
    expect(css).toMatch(/\.fw-thread-pick-short \{\s*display: none;\s*\}/)
    expect(css).toMatch(/@container fw-rtcol \(max-width: 480px\) \{\s*\.fw-thread-pick-long\.has-short \{\s*display: none;\s*\}\s*\.fw-thread-pick-short \{\s*display: inline;\s*\}\s*\}/)
    expect(css).toMatch(/\.fw-thread-pick-line\.is-office \{\s*color: var\(--nds-warning-text\);\s*\}/)
  })

  it('the whose-line is ONE polite live line with its Info icon; the office tone on an office-only thread; none for All (it says it itself)', () => {
    const order = render(createElement(ThreadPick, { label: 'Which thread', choices, value: 'order', children: createElement(Card) }))
    expect(order).toMatch(/<p class="fw-thread-pick-line" aria-live="polite"><svg[^>]*lucide-info[^>]*>.*?<\/svg><span>This order’s thread is shared with Brand Alpha\.<\/span><\/p>/)
    expect(order.match(/aria-live="polite"/g)?.length).toBe(1)
    const wo = render(createElement(ThreadPick, { label: 'Which thread', choices, value: 'wo', children: createElement(Card) }))
    expect(wo).toContain('<p class="fw-thread-pick-line is-office" aria-live="polite">')
    const all = render(createElement(ThreadPick, { label: 'Which thread', choices, value: 'all', children: createElement(Card) }))
    expect(all).not.toContain('fw-thread-pick-line')
  })

  it('the second select sits under the segments; the quieter note under the line', () => {
    const html = render(createElement(ThreadPick, { label: 'Which thread', choices, value: 'order', note: 'Draft kept on SO-1', extra: createElement('select', { 'aria-label': 'Which project' }), children: createElement(Card) }))
    const segments = html.indexOf('role="radiogroup"')
    const extra = html.indexOf('<div class="fw-thread-pick-extra"><select aria-label="Which project">')
    const line = html.indexOf('fw-thread-pick-line"')
    const note = html.indexOf('<p class="fw-thread-pick-line is-note">Draft kept on SO-1</p>')
    expect(extra).toBeGreaterThan(segments)
    expect(line).toBeGreaterThan(extra)
    expect(note).toBeGreaterThan(line)
  })

  it('ThreadPick draws nothing outside the column: its band goes down to the card, which draws it first', () => {
    // A child that is no card: no pick at all (nothing above the children any more).
    const bare = render(createElement(ThreadPick, { label: 'Which thread', choices, value: 'order', children: createElement('p', null, 'THE THREAD') }))
    expect(bare).toBe('<p>THE THREAD</p>')
    // A card: the band is its first band, inside the column.
    const html = render(createElement(ThreadPick, { label: 'Which thread', choices, value: 'order', children: createElement(Card) }))
    expect(html.startsWith('<section class="fw-rt-column is-docked" aria-label="The card"><div class="fw-rt-top"><div class="fw-thread-pick">')).toBe(true)
    expect(html.indexOf('THE THREAD')).toBeGreaterThan(html.indexOf('fw-thread-pick-line'))
    // The same band reaches any card the host draws (DockColumn handed useDockTop()).
    const Own = () => createElement(DockColumn, { label: 'Own', top: useDockTop(), body: 'B' })
    expect(render(createElement(ThreadPick, { label: 'Which thread', choices, value: 'order', children: createElement(Own) }))).toContain('<div class="fw-rt-top"><div class="fw-thread-pick">')
    // Outside a ThreadPick: no band.
    expect(render(createElement(Own))).not.toContain('fw-rt-top')
    const source = readFileSync(new URL('./ThreadPick.tsx', import.meta.url), 'utf8')
    const pick = source.slice(source.indexOf('export function ThreadPick<'), source.indexOf('/** F-OP-202: the pick band'))
    expect(pick).toContain('<DockTop.Provider value={band}>{children}</DockTop.Provider>')
    expect(pick).not.toContain('className=')
    // The office thread draws it as its first band (RecordThread's slots.top, kept when the thread is forbidden).
    const docked = readFileSync(new URL('./DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toContain('const pickBand = useDockTop()')
    expect(docked).toContain('slots={{ top: pickBand /* F-OP-202 */, head: headSlot, filesLine, helpers, overlays }}')
    // A record page's design case draws it inside its card too (as on the page).
    const design = readFileSync(new URL('../record-frame/fixtures.ts', import.meta.url), 'utf8')
    expect(design).toContain('const top = useDockTop()')
    expect(readFileSync(new URL('../../../lib/record-thread/ThreadCase.tsx', import.meta.url), 'utf8')).toContain('slots={top ? { ...slots, top } : slots /* F-OP-202 */}')
  })
})
// ── end F-OP-202

// ── F-SA-282a (sales page plan R7; B-SA-073): the office's portal reply held because its text names another customer of ours ─────────
import { postPortalReplyKeyed } from './api'
import { portalRefusal } from './state'

describe('F-SA-282a — a portal reply whose text names another customer: back in the box with why and the tick, then it goes again', () => {
  const held = new ApiError('conflict', 409, 'conflict', 'The text names another customer', null, [{ path: 'refusal/NAMES_OTHER_CUSTOMER', message: 'x' }])

  it('the API’s refusal is said in this app’s words, in both languages (never whom the text named)', () => {
    expect(portalRefusal(held)).toBe('notice.portal.NAMES_OTHER_CUSTOMER')
    // The other refusals keep their words; an unknown one stays "other".
    expect(portalRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/NO_PORTAL', message: 'x' }]))).toBe('notice.portal.NO_PORTAL')
    expect(portalRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/SOMETHING_NEW', message: 'x' }]))).toBe('notice.portal.other')
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread'])['record-thread']!)
      expect(t('notice.portal.NAMES_OTHER_CUSTOMER'), locale).not.toBe('notice.portal.NAMES_OTHER_CUSTOMER')
      expect(t('notice.portal.NAMES_OTHER_CUSTOMER'), locale).toContain(locale === 'it' ? 'Questo testo non nomina altri clienti' : 'This text names no other customer')
    }
  })

  it('the tick goes with the reply only when it is set; a first try never carries it', async () => {
    const calls: Array<{ path: string; body?: unknown }> = []
    const api = { post: async (path: string, options: { body?: unknown; schema: { parse: (v: unknown) => unknown } }) => (calls.push({ path, body: options.body }), options.schema.parse({ message: { id: 'm1' } })) } as unknown as ApiClient
    await postPortalReplyKeyed(api, { type: 'SalesOrder', id: 'o1' }, { body: 'Same trims as last season.', attachments: [] }, 'key-1')
    await postPortalReplyKeyed(api, { type: 'SalesOrder', id: 'o1' }, { body: 'Same trims as last season.', attachments: [], namesNoOtherCustomer: true }, 'key-2')
    expect(calls).toEqual([
      { path: '/threads/SalesOrder/o1/replies', body: { body: 'Same trims as last season.', attachments: [] } },
      { path: '/threads/SalesOrder/o1/replies', body: { body: 'Same trims as last season.', attachments: [], namesNoOtherCustomer: true } },
    ])
  })

  it('the container puts the text back held in the portal box and sends the tick on the next try (the docked thread draws the same)', () => {
    const container = readFileSync(new URL('./use-record-thread.ts', import.meta.url), 'utf8')
    expect(container).toContain("const namesOther = refusal === 'notice.portal.NAMES_OTHER_CUSTOMER'")
    expect(container).toContain('namesOther ? heldForNamesOther(snapshot.draft)')
    expect(container).toContain('namesNoOtherCustomer: namesNoOtherCustomerOf(now.draft)')
    expect(container).toContain('...(item.namesNoOtherCustomer ? { namesNoOtherCustomer: true } : {})')
    const docked = readFileSync(new URL('./DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toContain('<RecordThread model={shownModel} actions={threadActions}')
  })
})
// ── end F-SA-282a

// ── F-OP-203 (order page plan N4; 11-dock §0.1, §1): the three hosts adopt the card, with no new props; the old dock CSS goes ─────────
describe('F-OP-203 — the order dock, the customer dock and the work order’s threads draw every scope in the one card', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const order = read('../../sales/orders/record/dock/OrderDock.tsx')
  const customer = read('../../sales/customers/record/view/WorkTab.tsx')
  const workOrder = read('../../production/work-orders/record/view/WorkOrderThreads.tsx')

  it('the hosts keep their shape: <ThreadPick …>{thread}</ThreadPick>, the same props as before', () => {
    expect(order).toMatch(/<ThreadPick label=\{t\('record\.dock\.label'\)\} choices=\{choices\} value=\{choiceOfScope\(scope\)\} onPick=\{[^}]*\} extra=\{extra\}>\s*\{shown\}\s*<\/ThreadPick>/)
    expect(customer).toContain("<ThreadPick label={t('customers.work.dock.label')} choices={choices} value={dock.scope} onPick={dock.onScope} note={dock.draftKept ? t('customers.work.dock.draftKept', { record: dock.draftKept }) : null}>")
    expect(workOrder).toMatch(/<ThreadPick label=\{t\('thread\.pickLabel'\)\} choices=\{threads\} value=\{pick\} onPick=\{onPick\}>\s*\{children\}\s*<\/ThreadPick>/)
    expect(workOrder).toContain('export function WorkOrderThreads({ choices, pick, onPick, children }: { choices: readonly OrderThreadChoice[]; pick: OrderFilesPick; onPick?: (pick: OrderFilesPick) => void; children: ReactNode })')
  })

  // F-OP-204: the card is AllOfCustomerDock (PickedDockColumn + FeedHead + the feed + the foot), drawn by both hosts.
  it('All of <customer> is the same card (the pick band on top, its Head, the feed in the body, the order page’s write-in at the foot)', () => {
    const all = order.slice(order.indexOf("} else if (scope.kind === 'all') {"), order.indexOf('} else {', order.indexOf("} else if (scope.kind === 'all') {")))
    expect(all).toContain('<AllOfCustomerDock')
    expect(all).toContain("label={`${t('record.dock.all', { customer })} · ${t('record.dock.readOnly')}`}")
    expect(all).toContain('model={feed.model}')
    expect(all).toContain('actions={{ ...feed.actions, onAnswer, writeFirst }}')
    expect(all).toMatch(/foot=\{[\s\S]*t\('record\.dock\.writeIn'\)[\s\S]*go\(ORDER_SCOPE\)[\s\S]*go\(\{ kind: 'general' \}\)/)
    expect(all).not.toContain('className=')
    const dock = customer.slice(customer.indexOf('function Dock('))
    expect(dock).toContain("<AllOfCustomerDock label={`${t('customers.work.dock.all', { customer: customer.name })} · ${t('customers.work.dock.readOnly')}`} model={feed.model} actions={{ ...feed.actions, onAnswer, writeFirst }} />")
    const card = read('./all-of-customer/view/AllOfCustomerFeed.tsx')
    expect(card).toContain('<PickedDockColumn')
    expect(card).toContain('head={<FeedHead title={label} model={model} actions={actions} customerHref={customerHref ?? null} />}')
    expect(card).toContain('body={<AllOfCustomerFeed model={model} actions={actions} />}')
  })

  it('the segments: icons, short words, "N new" as the pick’s pill (never glued into the words), the office tone on work orders', () => {
    // The order page: This order · <Customer> (general) · Projects · Work orders · All of <Customer>.
    for (const icon of ['ShoppingBag', 'Building2', 'FolderKanban', 'Lock', 'Eye']) expect(order).toContain(`icon: <${icon} size={14} aria-hidden />`)
    expect(order).toContain("short: t('record.dock.writeGeneral')")
    expect(order).toContain("short: t('record.dock.projects')")
    expect(order).toContain("short: rt('allOfCustomer.view.all')")
    expect(order).toContain('count: fresh(order.id)')
    expect(order).toContain('count: fresh(order.partyId)')
    expect(order).toContain('count: freshOf(offer.projects)')
    expect(order).toContain('count: freshOf(offer.workOrders)')
    expect(order).toMatch(/value: 'workOrders'[^\n]*tone: 'office'/)
    const choices = order.slice(order.indexOf('const choices: ThreadChoice<ScopeChoice>[]'), order.indexOf('const extra ='))
    expect(choices).not.toContain('withNew(')
    // The customer page: <Customer> (general) · the record (its own icon) · All of <Customer>.
    expect(customer).toContain("short: o('record.dock.writeGeneral'), icon: <Building2 size={14} aria-hidden />")
    expect(customer).toContain('icon: <RecordTypeIcon type={pick.type} size={14} />')
    expect(customer).toContain("short: rt('allOfCustomer.view.all')")
    expect(customer).toContain("const CUSTOMER_DOCK_NS = [...ALL_OF_CUSTOMER_NS, 'orders'] as const")
    // The work order: its notes office only (Lock, office tone), each order with its bag.
    expect(workOrder).toContain("icon: <Lock size={14} aria-hidden />, tone: 'office'")
    expect(workOrder).toContain('icon: <ShoppingBag size={14} aria-hidden />')
  })

  it('the old dock CSS went (.fw-so-dock-all, .fw-so-dock-write): nothing draws or styles it any more', () => {
    const css = read('../../sales/orders/orders.css')
    expect(css).not.toMatch(/\.fw-so-dock-all\s*\{/)
    expect(css).not.toMatch(/\.fw-so-dock-write\s*\{/)
    for (const source of [order, customer, workOrder]) {
      expect(source).not.toContain('fw-so-dock-all')
      expect(source).not.toContain('fw-so-dock-write')
    }
  })

  it('the short words exist in both languages (the catalogue’s own: General, Projects, All)', () => {
    for (const locale of LOCALES) {
      const o = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const rt = createTranslator(locale, messagesFor(locale, ['record-thread'])['record-thread']!)
      for (const key of ['record.dock.writeGeneral', 'record.dock.projects', 'record.dock.workOrders']) expect(o(key), `${locale} ${key}`).not.toBe(key)
      expect(rt('allOfCustomer.view.all'), locale).not.toBe('allOfCustomer.view.all')
      expect(rt('dock.newCount', { count: 3 }), locale).toBe(locale === 'it' ? '3 nuovi' : '3 new')
    }
  })
})
// ── end F-OP-203
