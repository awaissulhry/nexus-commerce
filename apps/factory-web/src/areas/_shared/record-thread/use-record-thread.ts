'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { addDropped, contentTypeOf, draftOfRecordFile, kindOf, sendable, uploadAudience, type DraftFile, type RecordFile } from '../../../lib/record-thread/attachments/model'
import { messageLink, type CardMessage } from '../../../lib/record-thread/card/model'
import { startDraft, switchMode, type ComposerContext, type ComposerDraft } from '../../../lib/record-thread/composer/model'
// TH-1c's helpers (B-TH-208) and pop-ups (B-TH-211): the draft kept on this device, @mentions, the leave guard.
import { draftKey, mentionsIn, readDraft, writeDraft, type LocalDraft } from '../../../lib/record-thread/helpers/model'
import { withMentionTags } from '../../../lib/record-thread/helpers/tags'
import { useLeaveGuard } from '../../../lib/record-thread/popups/use-leave-guard'
import type { FeedModel } from '../../../lib/record-thread/feed/view/Feed'
import { anchorOf, cardOf, closedBy, eventOf, feedShowsChange, withOutbox, type ThreadApiChange, type ThreadApiDelivery, type ThreadApiEmail } from '../../../lib/record-thread/model'
import type { RecordThreadActions, RecordThreadModel } from '../../../lib/record-thread/RecordThread'
import { classify, cleanAddress, defaultSubject, defaultTo, sendBody, type CheckState, type Contact, type Recipient } from '../../../lib/record-thread/send-check/model'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { completeUpload, downloadLink, listEmails, listFiles, listPeople, readTimeline, requestUpload, setThreadStatus, type ApiFile } from '../../../record-panels/api'
import { useLiveChanges } from '../../../record-panels/live'
import { liveParts } from '../../../record-panels/model'
import { putToStore, sha256Hex, storeUrl, StoreError } from '../../../record-panels/store'
import { checkReply, postNoteKeyed, readContacts, readDeliveries, readThreadPage, sendReplyKeyed, shareWithParty } from './api'
import { afterRead, applyNewest, applyOlder, checkProblemOf, EMPTY_SERVER, readStatusOf, replyRefusal, sendReason, uploadReason, type ServerThread, type Work } from './state'
// B-TH-229: the person's own read mark (B-TH-027).
import { markThreadRead } from './api'
import { readMarker } from './state'

/**
 * The office container of RecordThread v1 (B-TH-212): it reads a record's thread (page by page), its mail states and bounce tasks,
 * its files, its history and the people a note may mention, re-reads a part on the live hints (thread.message_posted,
 * file.available, email.status_changed; everything after a reconnect), and does what the column asks: a note, a reply after the send
 * check ("Send outside this customer" recorded by the API), uploads with the message's audience, sharing a file with the customer,
 * Retry with the same key, Reopen, Copy link (`?message=<id>`), the leave guard. The draft is kept apart from what the server says
 * (and on this device while offline). Office only: check-view-boundaries keeps it out of the portal.
 */
export interface RecordThreadHost {
  record: { type: string; id: string; companyId: string | null; siteId?: string | null }
  /** The record's name as its page shows it ("INQ-2026-0007 · Brand Alpha"). */
  title: string
  /** The record's number ("INQ-2026-0007"). */
  recordLabel: string
  /** The record's customer (or supplier), when it has one. */
  party?: { id: string; name: string } | null
  /** A request from someone who is not a customer yet: the reply waits for "Make the customer". */
  prospect?: { name: string } | null
  /** The record's own address, for Copy link (default: this page). */
  recordHref?: string
  onMakeCustomer?: () => void
}

type Notice = NonNullable<RecordThreadModel['notice']>

/**
 * B-TH-300: what the docked thread's bands read of the same container (one read of each part for the page): the record, what the
 * server said, the files, who closed the thread, the person's rights, and the reads to run again.
 */
export interface RecordThreadBase {
  readonly key: { readonly type: string; readonly id: string }
  readonly server: ServerThread
  readonly files: readonly ApiFile[]
  /** The files were read once (null in the files line until then). */
  readonly filesRead: boolean
  readonly closed: { readonly by: string | null; readonly at: string | null } | null
  readonly offline: { readonly since: string } | null
  readonly held: ReadonlySet<string>
  readonly can: { readonly read: boolean; readonly post: boolean; readonly email: boolean; readonly manage: boolean; readonly readFiles: boolean; readonly upload: boolean; readonly share: boolean }
  readonly partyId: string | null
  readonly people: readonly { readonly id: string; readonly name: string }[]
  readonly loadFiles: () => Promise<void>
  readonly loadThread: () => Promise<void>
  readonly loadTimeline: () => Promise<void>
  readonly notify: (notice: Notice | null) => void
  /** B-TH-229: the reader's own new messages now (the Head's "2 new", the band's "Thread · 2 new"). */
  readonly newCount: number
  /** B-TH-229: the people (Change owner's list) — read, being read, or failed; and the read again. */
  readonly peopleState: 'loading' | 'ready' | 'failed'
  readonly loadPeople: () => Promise<void>
}

const EMPTY_WORK = (draft: ComposerDraft = { mode: 'note', body: '', forFloor: false }): Work => ({ draft, notes: [], files: [], to: [], cc: [], subject: '', outbox: [] })

export function useRecordThread(host: RecordThreadHost): { model: RecordThreadModel; actions: RecordThreadActions; kept: LocalDraft | null; guard: { ask: (leave: () => void) => boolean }; base: RecordThreadBase } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const key = useMemo(() => ({ type: host.record.type, id: host.record.id }), [host.record.type, host.record.id])
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const can = useMemo(
    () => ({ read: held.has('threads.read'), post: held.has('threads.post'), email: held.has('email.send'), manage: held.has('threads.manage'), readFiles: held.has('files.read'), upload: held.has('files.upload'), share: held.has('files.manage') }),
    [held],
  )
  const prefix = companyPrefix(session.company?.code ?? '')

  const [server, setServer] = useState<ServerThread>(EMPTY_SERVER)
  const [emails, setEmails] = useState<ReadonlyMap<string, ThreadApiEmail>>(new Map())
  const [deliveries, setDeliveries] = useState<ReadonlyMap<string, ThreadApiDelivery>>(new Map())
  const [files, setFiles] = useState<ApiFile[]>([])
  const [filesRead, setFilesRead] = useState(false) // B-TH-300
  const [changes, setChanges] = useState<ThreadApiChange[]>([])
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([])
  // B-TH-229: whether the people were read (Change owner says "reading" or "could not be read", never "nobody" before it knows).
  const [peopleState, setPeopleState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [work, setWork] = useState<Work>(() => EMPTY_WORK())
  const [sending, setSending] = useState(false)
  const [check, setCheck] = useState<{ state: CheckState; outside: boolean } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [offline, setOffline] = useState<{ since: string } | null>(null)
  const [kept, setKept] = useState<LocalDraft | null>(null)
  // B-TH-229: the reader's reading as it was on arrival (the feed's line); reset with the record.
  const [arrival, setArrival] = useState<{ firstNewId: string | null; newCount: number } | null>(null)
  useEffect(() => setArrival(null), [key])
  // The message a link names (`?message=<id>`), read from the address once on arrival.
  const [anchor, setAnchor] = useState<string | null>(null)
  useEffect(() => setAnchor(anchorOf(window.location.search)), [])
  const lastRead = useRef(new Date().toISOString())
  const uploads = useRef(new Map<string, File>())
  const workRef = useRef(work)
  workRef.current = work

  const party = host.party ?? null
  const partyId = party?.id ?? server.thread?.partyId ?? null

  // ── reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const loadThread = useCallback(async () => {
    try {
      const page = await readThreadPage(api, key, null)
      lastRead.current = new Date().toISOString()
      // B-TH-229: the reading on arrival draws "New since your last visit" for the whole visit (marking read does not move it).
      setArrival((seen) => seen ?? { firstNewId: page.reading?.firstNewMessageId ?? null, newCount: page.reading?.newCount ?? 0 })
      setServer((current) => {
        const next = applyNewest(current, { thread: page.thread ? { status: page.thread.status, version: page.thread.version, partyId: page.thread.partyId } : null, messages: page.messages, nextCursor: page.nextCursor, reading: page.reading, head: page.head })
        setWork((now) => afterRead(now, next))
        return next
      })
    } catch (error) {
      setServer((current) => (current.status === 'ready' ? current : { ...current, status: readStatusOf(error) }))
    }
  }, [api, key])
  const loadOlder = useCallback(async () => {
    const cursor = server.cursor
    if (!cursor) return
    setServer((current) => ({ ...current, older: 'loading' }))
    try {
      const page = await readThreadPage(api, key, cursor)
      setServer((current) => applyOlder(current, page))
    } catch {
      setServer((current) => ({ ...current, older: 'failed' }))
    }
  }, [api, key, server.cursor])
  const loadEmails = useCallback(async () => {
    try {
      const { emails: list } = await listEmails(api, key)
      setEmails(new Map(list.flatMap((email) => (email.messageId ? [[email.messageId, email] as const] : []))))
    } catch {
      // The mail states are a detail of the cards: without them the messages still show.
    }
    try {
      const { messages } = await readDeliveries(api, key)
      setDeliveries(new Map(messages.flatMap((delivery) => (delivery.messageId ? [[delivery.messageId, delivery] as const] : []))))
    } catch {
      // Without the bounce tasks a bounce still says why.
    }
  }, [api, key])
  const loadFiles = useCallback(async () => {
    if (!can.readFiles) return
    try {
      setFiles((await listFiles(api, key)).files)
    } catch {
      // "From this record" then offers nothing; the cards still name their files.
    } finally {
      setFilesRead(true)
    }
  }, [api, key, can.readFiles])
  const loadTimeline = useCallback(async () => {
    try {
      const page = await readTimeline(api, key, 'change')
      setChanges(page.entries.flatMap((entry) => (entry.kind === 'change' ? [entry as ThreadApiChange] : [])))
    } catch {
      // The quiet steps are a detail: without them the messages still show.
    }
  }, [api, key])
  const loadPeople = useCallback(async () => {
    if (!can.post) return
    setPeopleState('loading')
    try {
      setPeople((await listPeople(api, key)).people)
      setPeopleState('ready')
    } catch {
      // Without the list a note mentions nobody (Change owner says it could not be read, with Try again).
      setPeopleState('failed')
    }
  }, [api, key, can.post])

  const loadAll = useCallback(() => {
    void loadThread()
    void loadEmails()
    void loadFiles()
    void loadTimeline()
  }, [loadThread, loadEmails, loadFiles, loadTimeline])

  useEffect(() => {
    if (!can.read) {
      setServer({ ...EMPTY_SERVER, status: 'forbidden' })
      return
    }
    loadAll()
    void loadPeople()
  }, [can.read, loadAll, loadPeople])

  // The customer's contacts, once a reply is wanted (To's suggestions and its first address).
  const contactsRead = useRef(false)
  useEffect(() => {
    if (work.draft.mode !== 'reply' || !partyId || contactsRead.current) return
    contactsRead.current = true
    readContacts(api, partyId)
      .then((list) => {
        setContacts(list)
        setWork((now) => (now.to.length === 0 ? { ...now, to: defaultTo(list, party?.name ?? null) } : now))
      })
      .catch(() => setNotice({ ns: 'record-thread', key: 'notice.partyUnread', tone: 'info' }))
  }, [api, work.draft.mode, partyId, party?.name])

  useLiveChanges({
    onChange: (change) => {
      for (const part of liveParts(change, key)) {
        if (part === 'thread') void loadThread()
        if (part === 'emails') void loadEmails()
        if (part === 'files') void loadFiles()
        if (part === 'timeline') void loadTimeline()
      }
    },
    onReconnect: loadAll,
  })

  // ── offline: the last messages and since when; Send waits; the text stays on this device ─────────────────────────────
  useEffect(() => {
    const down = () => setOffline({ since: lastRead.current })
    const up = () => {
      setOffline(null)
      loadAll()
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) down()
    window.addEventListener('offline', down)
    window.addEventListener('online', up)
    return () => {
      window.removeEventListener('offline', down)
      window.removeEventListener('online', up)
    }
  }, [loadAll])

  // The draft on this device (TH-1c's store, B-TH-208: per person, record and audience, 30 days): read once on arrival (every visit
  // starts on Office note, so the note's draft first), written a moment after typing stops under the box's audience (the other
  // audience's is forgotten: the text survives a switch), forgotten after a send.
  const storage = (): Storage | null => {
    try {
      return window.localStorage
    } catch {
      return null
    }
  }
  const personId = session.user.id
  useEffect(() => {
    const now = Date.now()
    const note = readDraft(storage(), draftKey(personId, key, 'note'), now)
    const reply = note ? null : readDraft(storage(), draftKey(personId, key, 'reply'), now)
    const found = note ?? reply
    if (!found) return
    setKept(found)
    setWork((latest) => (latest.draft.body === '' ? { ...latest, draft: { ...latest.draft, mode: reply && can.email && partyId ? 'reply' : 'note', body: found.text } } : latest))
    // Only on arrival: the record's draft.
  }, [personId, key])
  useEffect(() => {
    const id = setTimeout(() => {
      const now = Date.now()
      const other = work.draft.mode === 'note' ? 'reply' : 'note'
      writeDraft(storage(), draftKey(personId, key, other), '', now)
      setKept(writeDraft(storage(), draftKey(personId, key, work.draft.mode), work.draft.body, now))
    }, 600)
    return () => clearTimeout(id)
  }, [work.draft.body, work.draft.mode, personId, key])
  const forgetDraft = () => {
    const now = Date.now()
    writeDraft(storage(), draftKey(personId, key, 'note'), '', now)
    writeDraft(storage(), draftKey(personId, key, 'reply'), '', now)
    setKept(null)
  }

  // ── the leave guard (T5-F10; TH-1c's useLeaveGuard): the browser's own question on close; a link of this app outside the
  // thread waits for "Leave with unsent text?" (Stay / Discard; Discard forgets the draft, then the move goes on) ────────────
  const unsentFiles = work.files.filter((file) => file.phase !== 'refused').length
  const leave = useLeaveGuard({ text: work.draft.body, files: unsentFiles })
  const askRef = useRef(leave.ask)
  askRef.current = leave.ask
  const discardRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      const link = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!link || link.target === '_blank' || link.closest('.fw-rt-column')) return
      const to = new URL(link.href, window.location.href)
      if (to.origin !== window.location.origin || (to.pathname === window.location.pathname && to.search === window.location.search)) return
      const address = `${to.pathname}${to.search}${to.hash}`
      if (
        askRef.current(() => {
          discardRef.current()
          router.push(address)
        })
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [router])

  // ── the recipients as the check sees them (the chips' organisations), a moment after they change ────────────────────
  const lineKey = [...work.to, ...work.cc].map((item) => item.address).join(',')
  useEffect(() => {
    if (work.draft.mode !== 'reply' || lineKey === '' || !can.email) return
    const controller = new AbortController()
    const id = setTimeout(() => {
      const now = workRef.current
      checkReply(api, key, { addresses: [...now.to, ...now.cc].map((item) => item.address), subject: now.subject, body: now.draft.body, attachments: sendable(now.files).map((file) => file.fileId as string) }, controller.signal)
        .then((answer) => setWork((latest) => ({ ...latest, to: latest.to.map((item) => classify(item, answer)), cc: latest.cc.map((item) => classify(item, answer)) })))
        .catch(() => undefined)
    }, 700)
    return () => {
      clearTimeout(id)
      controller.abort()
    }
  }, [api, key, lineKey, work.draft.mode, can.email])

  // ── what the column draws ──────────────────────────────────────────────────────────────────────────────────────────
  const names = useMemo(() => new Map<string, string>([...people.map((person) => [person.id, person.name] as const), [session.user.id, session.user.displayName]]), [people, session.user])
  const cards = useMemo<CardMessage[]>(
    () => server.messages.map((message) => cardOf(message, { emails, deliveries, names, taskHref: (taskId) => `${prefix}/home/tasks?open=${encodeURIComponent(taskId)}` })),
    [server.messages, emails, deliveries, names, prefix],
  )
  const closed = server.thread?.status === 'CLOSED' ? closedBy(changes, names) : null
  const lastSubject = useMemo(() => {
    const mails = server.messages.filter((message) => emails.has(message.id))
    return mails.length > 0 ? (emails.get(mails[mails.length - 1].id)?.subject ?? null) : null
  }, [server.messages, emails])
  const recordFiles = useMemo<RecordFile[]>(
    () =>
      files
        .filter((file) => !file.supersededAt)
        .map((file) => ({ id: file.id, name: file.originalName, sizeBytes: file.sizeBytes, contentType: file.contentType, available: file.status === 'AVAILABLE', shared: partyId !== null && file.partyId === partyId && (file.visibility.includes('PARTNER') || file.visibility.includes('LINK')) })),
    [files, partyId],
  )
  const context: ComposerContext = {
    recordType: host.record.type,
    recordLabel: host.recordLabel,
    party: party ? { name: party.name } : null,
    prospect: host.prospect ?? null,
    can: { post: can.post, email: can.email, manage: can.manage },
    closed,
    offline: offline !== null,
    people: withMentionTags(key, people.filter((person) => person.id !== session.user.id)),
  }
  const feed: FeedModel = {
    state: server.status,
    messages: withOutbox(cards, work.outbox),
    events: changes.filter(feedShowsChange).map((entry) => eventOf(entry, names)),
    context: { partyName: party?.name ?? null, canReadFiles: can.readFiles, canReply: can.email && party !== null, canTask: false, anchorId: anchor },
    more: server.more,
    older: server.older,
    offline,
    now: new Date().toISOString(),
    // B-TH-229
    firstNewId: arrival?.firstNewId ?? null,
    newSince: arrival?.newCount ?? 0,
  }

  const model: RecordThreadModel = {
    title: host.title,
    feed,
    composer: {
      context,
      draft: work.draft,
      notes: work.notes,
      sending,
      files: work.files,
      recordFiles,
      canUpload: can.upload,
      canShare: can.share && partyId !== null,
      canPick: can.readFiles,
      to: work.to,
      cc: work.cc,
      subject: work.subject || defaultSubject(lastSubject, host.recordLabel),
      contacts,
    },
    pickerOpen,
    check,
    leaving: leave.asking,
    kept,
    notice,
  }

  // ── doing ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const patch = (next: Partial<Work>) => setWork((now) => ({ ...now, ...next }))

  const upload = async (row: DraftFile, file: File) => {
    const set = (next: Partial<DraftFile>) => setWork((now) => ({ ...now, files: now.files.map((item) => (item.key === row.key ? { ...item, ...next } : item)) }))
    let storeFailed = false
    try {
      const bytes = await file.arrayBuffer()
      const sha256 = await sha256Hex(bytes)
      const contentType = contentTypeOf(file)
      const announced = await requestUpload(api, {
        companyId: host.record.companyId,
        record: key,
        kind: kindOf(contentType),
        name: row.name,
        contentType,
        sizeBytes: file.size,
        sha256,
        visibility: row.audience === 'PARTY' ? ['OFFICE', 'PARTNER'] : ['OFFICE'],
        floorSiteId: null,
        partyId: row.audience === 'PARTY' ? partyId : null,
      })
      set({ fileId: announced.file.id, progress: 50 })
      try {
        await putToStore(announced.upload, new Blob([bytes], { type: contentType }))
      } catch (error) {
        storeFailed = error instanceof StoreError
        throw error
      }
      const { file: done } = await completeUpload(api, announced.file.id)
      if (done.status === 'AVAILABLE') {
        set({ phase: 'done', progress: undefined })
        uploads.current.delete(row.key)
      } else set({ phase: 'failed', problem: { key: 'failed.quarantined' } })
      void loadFiles()
    } catch (error) {
      set({ phase: 'failed', progress: undefined, problem: { key: uploadReason(error, storeFailed) } })
    }
  }

  const addFiles = (dropped: File[]) => {
    const audience = uploadAudience(workRef.current.draft.mode, can.share, partyId !== null)
    let current = workRef.current.files
    let leftOut = 0
    const added: Array<[DraftFile, File]> = []
    for (const file of dropped) {
      const result = addDropped(current, [{ name: file.name || 'Pasted image.png', type: file.type, size: file.size }], audience, () => `up-${newIdempotencyKey()}`)
      leftOut += result.leftOut
      current = result.files
      for (const row of result.added) added.push([row, file])
    }
    setWork((latest) => ({ ...latest, files: [...latest.files, ...added.map(([row]) => row)] }))
    if (leftOut > 0) setNotice({ ns: 'record-thread-attach', key: 'notice.leftOut', params: { count: leftOut }, tone: 'warning' })
    for (const [row, file] of added) {
      if (row.phase !== 'uploading') continue
      uploads.current.set(row.key, file)
      void upload(row, file)
    }
  }

  const sendNote = async (item: { key: string; idempotencyKey: string; body: string; mentions: string[]; attachments: string[]; forFloor: boolean; card: CardMessage }) => {
    setSending(true)
    try {
      const messageId = await postNoteKeyed(api, key, { body: item.body, mentions: item.mentions, attachments: item.attachments, forFloor: item.forFloor }, item.idempotencyKey)
      setWork((now) => ({ ...now, outbox: now.outbox.map((entry) => (entry.key === item.key ? { ...entry, messageId } : entry)) }))
      setNotice({ ns: 'record-thread', key: item.forFloor ? 'notice.noteAddedFloor' : 'notice.noteAdded', tone: 'success' })
      void loadThread()
      void loadTimeline()
    } catch (error) {
      setWork((now) => ({ ...now, outbox: now.outbox.map((entry) => (entry.key === item.key ? { ...entry, state: 'failed', reason: sendReason(error) } : entry)) }))
    } finally {
      setSending(false)
    }
  }

  const retries = useRef(new Map<string, () => Promise<void>>())

  const send = () => {
    const now = workRef.current
    if (now.draft.mode === 'reply') {
      runCheck()
      return
    }
    const outboxKey = `local-${newIdempotencyKey()}`
    const idempotencyKey = newIdempotencyKey()
    const attachments = sendable(now.files).map((file) => file.fileId as string)
    const card: CardMessage = { id: outboxKey, kind: 'note', channel: 'APP', author: session.user.displayName, authorKind: 'USER', at: new Date().toISOString(), body: now.draft.body, forFloor: now.draft.forFloor, mentions: [], files: [] }
    const item = { key: outboxKey, idempotencyKey, body: now.draft.body, mentions: mentionsIn(now.draft.body, context.people), attachments, forFloor: now.draft.forFloor, card }
    retries.current.set(outboxKey, () => sendNote(item))
    setWork((latest) => ({ ...latest, draft: { ...latest.draft, body: '', forFloor: false }, notes: [], files: [], outbox: [...latest.outbox, { key: outboxKey, card, state: 'sending' }] }))
    forgetDraft()
    void sendNote(item)
  }

  const runCheck = () => {
    const now = workRef.current
    const subject = model.composer.subject
    setCheck({ state: { status: 'checking' }, outside: false })
    checkReply(api, key, { addresses: [...now.to, ...now.cc].map((item) => item.address), subject, body: now.draft.body, attachments: sendable(now.files).map((file) => file.fileId as string) })
      .then((answer) => {
        setCheck((current) => (current ? { ...current, state: { status: 'ready', check: answer } } : current))
        setWork((latest) => ({ ...latest, to: latest.to.map((item) => classify(item, answer)), cc: latest.cc.map((item) => classify(item, answer)) }))
      })
      .catch((error) => setCheck((current) => (current ? { ...current, state: { status: 'error', ...checkProblemOf(error) } } : current)))
  }

  const confirm = () => {
    const now = workRef.current
    const outside = check?.outside ?? false
    const subject = model.composer.subject
    const body = sendBody({ to: now.to, cc: now.cc, subject, body: now.draft.body, attachments: sendable(now.files).map((file) => file.fileId as string), outside })
    const outboxKey = `local-${newIdempotencyKey()}`
    const idempotencyKey = newIdempotencyKey()
    const card: CardMessage = { id: outboxKey, kind: 'ours', channel: 'EMAIL', author: session.user.displayName, authorKind: 'USER', at: new Date().toISOString(), body: now.draft.body, mentions: [], files: [], email: { to: body.to, subject, status: 'QUEUED' } }
    const snapshot = now
    const go = async () => {
      setSending(true)
      try {
        const messageId = await sendReplyKeyed(api, key, body, idempotencyKey)
        setWork((latest) => ({ ...latest, outbox: latest.outbox.map((entry) => (entry.key === outboxKey ? { ...entry, messageId } : entry)) }))
        setNotice({ ns: 'record-thread', key: 'notice.emailQueued', tone: 'success' })
        void loadThread()
        void loadEmails()
      } catch (error) {
        const refusal = replyRefusal(error)
        if (refusal) {
          // The person must change it: the text, files and recipients come back into the box, with why.
          setWork((latest) => ({ ...latest, draft: snapshot.draft, files: snapshot.files, to: snapshot.to, cc: snapshot.cc, subject: snapshot.subject, outbox: latest.outbox.filter((entry) => entry.key !== outboxKey) }))
          setNotice({ ns: 'record-thread-send', key: refusal, tone: 'danger' })
        } else {
          setWork((latest) => ({ ...latest, outbox: latest.outbox.map((entry) => (entry.key === outboxKey ? { ...entry, state: 'failed', reason: sendReason(error) } : entry)) }))
        }
      } finally {
        setSending(false)
      }
    }
    retries.current.set(outboxKey, go)
    setCheck(null)
    // After a send the mode stays as used while the person stays on the record (T5-F02).
    setWork((latest) => ({ ...latest, draft: { ...latest.draft, body: '' }, notes: [], files: [], outbox: [...latest.outbox, { key: outboxKey, card, state: 'sending' }] }))
    forgetDraft()
    void go()
  }

  // ── B-TH-229 (T1-F04): reading marks the thread read for this person, forward only and once per message; the server's own mark
  // is known first, so an older message never sends. Office people only (this container); never the floor; no "seen by" list.
  const marker = useMemo(
    () =>
      readMarker(async (messageId) => {
        const reading = await markThreadRead(api, key, messageId)
        setServer((current) => (current.status === 'ready' ? { ...current, reading } : current))
      }),
    [api, key],
  )
  useEffect(() => {
    const id = server.reading?.lastReadMessageId
    const message = id ? server.messages.find((item) => item.id === id) : undefined
    marker.known(message ? { id: message.id, at: message.at } : null)
  }, [marker, server.reading?.lastReadMessageId, server.messages])
  const onSeen = useCallback(
    (messageId: string) => {
      const message = server.messages.find((item) => item.id === messageId)
      if (message && can.read) marker.seen({ id: message.id, at: message.at })
    },
    [server.messages, marker, can.read],
  )

  const actions: RecordThreadActions = {
    onSeen,
    onDraft: (draft, notes) => patch({ draft, notes }),
    onSend: send,
    onReopen: async () => {
      if (!server.thread) return
      try {
        await setThreadStatus(api, key, 'OPEN', server.thread.version)
        setNotice({ ns: 'record-thread', key: 'notice.reopened', tone: 'success' })
      } catch {
        setNotice({ ns: 'record-thread', key: 'notice.statusConflict', tone: 'warning' })
      } finally {
        void loadThread()
        void loadTimeline()
      }
    },
    onMakeCustomer: host.onMakeCustomer,
    onFiles: addFiles,
    onRemoveFile: (fileKey) => {
      uploads.current.delete(fileKey)
      setWork((now) => ({ ...now, files: now.files.filter((file) => file.key !== fileKey) }))
    },
    onRetryFile: (fileKey) => {
      const file = uploads.current.get(fileKey)
      const row = workRef.current.files.find((item) => item.key === fileKey)
      if (!file || !row) return
      const again = { ...row, phase: 'uploading' as const, problem: undefined, fileId: undefined }
      setWork((now) => ({ ...now, files: now.files.map((item) => (item.key === fileKey ? again : item)) }))
      void upload(again, file)
    },
    onShareFile: async (fileKey) => {
      const row = workRef.current.files.find((item) => item.key === fileKey)
      const file = files.find((item) => item.id === row?.fileId)
      if (!row || !file || !partyId) return
      try {
        await shareWithParty(api, file, partyId)
        setWork((now) => ({ ...now, files: now.files.map((item) => (item.key === fileKey ? { ...item, audience: 'PARTY' } : item)) }))
        setNotice({ ns: 'record-thread-attach', key: 'notice.shared', params: { name: row.name, party: party?.name ?? '' }, tone: 'success' })
        void loadFiles()
      } catch (error) {
        setNotice({ ns: 'record-thread-attach', key: 'notice.shareFailed', params: { name: row.name, reason: '' }, tone: 'danger' })
        void error
      }
    },
    onPicker: setPickerOpen,
    onAddRecordFiles: (ids) => setWork((now) => ({ ...now, files: [...now.files, ...recordFiles.filter((file) => ids.includes(file.id) && !now.files.some((item) => item.fileId === file.id)).map((file) => draftOfRecordFile(file, `record-${file.id}`))] })),
    onLines: (next) => patch({ to: next.to, cc: next.cc, subject: next.subject }),
    onCheckBack: () => setCheck(null),
    onCheckRetry: runCheck,
    onOutside: (ticked) => setCheck((current) => (current ? { ...current, outside: ticked } : current)),
    onConfirm: confirm,
    onStay: leave.stay,
    onDiscard: leave.discard,
    onDismissNotice: () => setNotice(null),
    onOlder: () => void loadOlder(),
    onReload: loadAll,
    onRetry: (messageId) => {
      const again = retries.current.get(messageId)
      if (!again) return
      setWork((now) => ({ ...now, outbox: now.outbox.map((entry) => (entry.key === messageId ? { ...entry, state: 'sending', reason: undefined } : entry)) }))
      void again()
    },
    onReply: (messageId) => {
      const message = server.messages.find((item) => item.id === messageId)
      const switched = switchMode(workRef.current.draft, 'reply', context.people)
      const contact = contacts.find((item) => item.name === message?.author.name && cleanAddress(item.email))
      setWork((now) => ({
        ...now,
        draft: switched.draft,
        notes: switched.notes,
        to: contact ? [{ address: contact.email.toLowerCase(), name: contact.name, kind: 'PARTY', organisation: party?.name ?? null } satisfies Recipient] : now.to,
      }))
    },
    onCopyLink: (messageId) => {
      const base = host.recordHref ?? `${window.location.pathname}${window.location.search}`
      const address = `${window.location.origin}${messageLink(base, messageId)}`
      navigator.clipboard
        ?.writeText(address)
        .then(() => setNotice({ ns: 'record-thread', key: 'notice.linkCopied', tone: 'success' }))
        .catch(() => setNotice({ ns: 'record-thread', key: 'notice.linkFailed', tone: 'warning' }))
    },
    onOpenFile: async (fileId) => {
      try {
        const { download } = await downloadLink(api, fileId)
        const anchor = document.createElement('a')
        anchor.href = storeUrl(download.url)
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      } catch {
        setNotice({ ns: 'record-thread', key: 'notice.openFailed', tone: 'danger' })
      }
    },
  }

  discardRef.current = () => {
    setWork((now) => ({ ...EMPTY_WORK(startDraft(context)), outbox: now.outbox }))
    forgetDraft()
  }

  const base: RecordThreadBase = { key, server, files, filesRead, closed, offline, held, can, partyId, people, loadFiles, loadThread, loadTimeline, notify: setNotice, newCount: server.reading?.newCount ?? 0, peopleState, loadPeople }
  return { model, actions, kept, guard: { ask: leave.ask }, base }
}
