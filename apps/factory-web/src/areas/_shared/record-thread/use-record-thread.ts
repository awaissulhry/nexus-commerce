'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { addDropped, contentTypeOf, draftOfRecordFile, kindOf, sendable, uploadAudience, type DraftFile, type RecordFile } from '../../../lib/record-thread/attachments/model'
import { messageLink, type CardMessage } from '../../../lib/record-thread/card/model'
import { cardDepth } from '../../../lib/record-thread/card/model' // B-TH-255
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
// B-TH-236 / B-TH-237: the portal reply, Undo, the links and the amount; refusals in words.
import { postPortalReplyKeyed, takeBackMail, type MessageLinks } from './api'
import { floorPriceRefused, NOT_SHAREABLE_TYPES, portalRefusal, undoRefusalKey } from './state'
import { amountBody, floorPriceFound } from '../../../lib/record-thread/helpers/amount'
import { correctionWay } from '../../../lib/record-thread/card/model'
import { floorLocked, type ComposerMode, type DraftLink } from '../../../lib/record-thread/composer/model'
import { afterRead, applyNewest, applyOlder, checkProblemOf, EMPTY_SERVER, readStatusOf, replyRefusal, sendReason, uploadReason, type ServerThread, type Work } from './state'
// B-TH-229: the person's own read mark (B-TH-027).
import { markThreadRead } from './api'
import { readMarker } from './state'
// B-TH-286: pins (B-TH-091).
import { pinMessage, readPins, unpinMessage, type ApiPin } from './api'
import { pinRefusalKey } from './state'
// B-TH-287: the draft on the server (B-TH-092).
import { discardServerDraft, readServerDraft, saveServerDraft } from './api'
import { draftFromServer, draftToSave, DRAFT_SAVE_MS, newerCopy, type DraftSaved } from '../../../lib/record-thread/composer/server-draft'
// B-TH-289: "Remind me in 3 days if no answer" (B-TH-096) — the person's own reminder on the message that went.
import { followUpAt, followUpOffered } from '../../../lib/record-thread/helpers/model'
import { removeReminder, setReminder, type Reminder } from '../../../shell/panels/remind-me/api'
import { rightRef } from '../../../lib/i18n/rights'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale } from '../../../lib/i18n/provider'

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
  // ---- B-TH-286 (B-TH-091): the conversation's pins (null: not read yet), Unpin from the files line.
  readonly pins: readonly ApiPin[] | null
  readonly unpin: (messageId: string) => Promise<void>
  // ---- B-TH-288 (B-TH-097): a message found by the Head's search, or a pin's line — older pages read until it is on screen, then
  // unfolded and focused (false: it is not in this conversation any more, or out of reach).
  readonly jumpTo: (messageId: string) => Promise<boolean>
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
  const locale = useLocale() // B-TH-289: the follow-up's day in words

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
  // ---- B-TH-237: the API said nobody of the customer reads this record in the portal (NO_PORTAL): the choice goes for this record.
  const [portalRefused, setPortalRefused] = useState(false)
  useEffect(() => setPortalRefused(false), [key])
  // ---- B-TH-236 (B-TH-048): the mails this screen just sent, until the mail list says when they may be taken back.
  const [undoable, setUndoable] = useState<ReadonlyMap<string, { emailId: string; until: string }>>(new Map())
  // ---- end B-TH-236 / B-TH-237
  // ---- B-TH-286: the conversation's pins (null until read; read again with the thread).
  const [pins, setPins] = useState<ApiPin[] | null>(null)
  useEffect(() => setPins(null), [key])
  // ---- B-TH-287: the draft on the server — its state for the line, the version last read, the arrival read done.
  const [saved, setSaved] = useState<DraftSaved | null>(null)
  // ---- B-TH-289: the follow-ups set on messages this screen sent (a mail taken back in its 10 seconds takes its follow-up with it).
  const followUps = useRef(new Map<string, Reminder>())
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
        const next = applyNewest(current, { thread: page.thread ? { status: page.thread.status, version: page.thread.version, partyId: page.thread.partyId } : null, messages: page.messages, nextCursor: page.nextCursor, reading: page.reading, head: page.head, waitingMail: page.waitingMail /* B-TH-255 */, done: page.done /* B-TH-288 */ })
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

  // ---- B-TH-286 (B-TH-091): the pins, as the reader may see them (every pin and who pinned it: the office).
  const loadPins = useCallback(async () => {
    if (!can.read) return
    try {
      setPins(await readPins(api, key))
    } catch {
      // The pins are a detail of the files line: without them the thread still shows.
    }
  }, [api, key, can.read])
  // ---- end B-TH-286

  const loadAll = useCallback(() => {
    void loadThread()
    void loadEmails()
    void loadFiles()
    void loadTimeline()
    void loadPins() // B-TH-286
  }, [loadThread, loadEmails, loadFiles, loadTimeline, loadPins])

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
        if (part === 'thread') {
          void loadThread()
          void loadPins() // B-TH-286: a pin of a colleague, a message erased
        }
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
    // B-TH-237: a message for the portal kept on this device comes back as an office note (the box always starts there).
    const portal = note || reply ? null : readDraft(storage(), draftKey(personId, key, 'portal'), now)
    const found = note ?? reply ?? portal
    arrivalLocal.current = found // B-TH-287: compared with the server's draft when it is read
    if (!found) return
    setKept(found)
    setWork((latest) => (latest.draft.body === '' ? { ...latest, draft: { ...latest.draft, mode: reply && can.email && partyId ? 'reply' : 'note', body: found.text } } : latest))
    // Only on arrival: the record's draft.
  }, [personId, key])
  useEffect(() => {
    const id = setTimeout(() => {
      const now = Date.now()
      // The other audiences' drafts are forgotten (the text survives a switch); B-TH-237: three audiences.
      for (const other of (['note', 'reply', 'portal'] as const).filter((mode) => mode !== work.draft.mode)) writeDraft(storage(), draftKey(personId, key, other), '', now)
      setKept(writeDraft(storage(), draftKey(personId, key, work.draft.mode), work.draft.body, now))
    }, 600)
    return () => clearTimeout(id)
  }, [work.draft.body, work.draft.mode, personId, key])
  const forgetDraft = () => {
    const now = Date.now()
    writeDraft(storage(), draftKey(personId, key, 'note'), '', now)
    writeDraft(storage(), draftKey(personId, key, 'reply'), '', now)
    writeDraft(storage(), draftKey(personId, key, 'portal'), '', now) // B-TH-237
    setKept(null)
    stopSaving() // B-TH-287: what was typed went (the send's own command clears the server's draft) or was discarded
  }

  // ---- B-TH-287 (B-TH-092; T5-F10, T8-F07): the draft on the server — one per person and record, so another computer finds it ("Draft
  // saved 10:42"). Read on arrival (the newer of it and the device copy goes in the box, while nothing was typed yet), saved a pause
  // after typing stops (DRAFT_SAVE_MS) and at once when the page is hidden or left, with the version last read (two tabs: the newest
  // wins, and the line says it replaced a newer one); an empty box discards it. A send clears it in the send's own command: a save
  // still on its way then is followed by a discard, so a sent text never comes back. The device copy stays as the fallback (offline,
  // a failed save).
  const arrivalLocal = useRef<LocalDraft | null>(null)
  const draftVersion = useRef<number | undefined>(undefined)
  const draftReady = useRef(false)
  const lastSaved = useRef('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveSeq = useRef(0)
  const stoppedAt = useRef(0)
  const inflight = useRef(0)
  const offlineRef = useRef(offline !== null)
  offlineRef.current = offline !== null
  const canReplyRef = useRef(false)
  canReplyRef.current = can.email && partyId !== null
  const partsOf = (now: Work) => draftToSave({ draft: now.draft, to: now.to, cc: now.cc, subject: now.subject, files: now.files })
  const saveNow = async (force = false) => {
    if (!draftReady.current || !can.post) return
    const parts = partsOf(workRef.current)
    const signature = parts ? JSON.stringify(parts) : ''
    if (!force && signature === lastSaved.current) return
    if (offlineRef.current) {
      setSaved({ state: 'offline' })
      return
    }
    if (!parts) {
      // An empty box: the server's draft goes — also one a save still on its way would make (none known: nothing to do).
      const known = draftVersion.current !== undefined || inflight.current > 0
      stopSaving()
      if (!known) return
      try {
        await discardServerDraft(api, key)
      } catch {
        // Kept on the server for now: the next visit reads it back, and the person may empty the box again.
      }
      return
    }
    const seq = ++saveSeq.current
    setSaved({ state: 'saving' })
    inflight.current += 1
    try {
      const answer = await saveServerDraft(api, key, { ...parts, ...(draftVersion.current !== undefined ? { version: draftVersion.current } : {}) })
      if (seq <= stoppedAt.current) {
        // Sent or discarded while this save was on its way: it never comes back (unless a newer save already started).
        if (saveSeq.current === stoppedAt.current) void discardServerDraft(api, key).catch(() => undefined)
        return
      }
      draftVersion.current = answer.draft.version
      lastSaved.current = signature
      setSaved(answer.replacedNewer ? { state: 'replaced', at: answer.draft.savedAt } : { state: 'saved', at: answer.draft.savedAt })
    } catch {
      if (seq > stoppedAt.current) setSaved({ state: 'failed' })
    } finally {
      inflight.current -= 1
    }
  }
  const saveRef = useRef(saveNow)
  saveRef.current = saveNow
  const scheduleSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void saveRef.current()
    }, DRAFT_SAVE_MS)
  }
  /** After a send or a discard: no save is waiting, one on its way is followed by a discard, the next starts a new draft. */
  function stopSaving() {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    stoppedAt.current = ++saveSeq.current
    draftVersion.current = undefined
    lastSaved.current = ''
    setSaved(null)
  }
  // The arrival read: the newer of the server's draft and the device copy goes in the box, while nothing was typed since.
  useEffect(() => {
    // Another record: a save still waiting for the one before is not sent under this one.
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    draftReady.current = false
    draftVersion.current = undefined
    lastSaved.current = ''
    setSaved(null)
    if (!can.post) {
      draftReady.current = true
      return
    }
    const controller = new AbortController()
    readServerDraft(api, key, controller.signal)
      .then((found) => {
        draftVersion.current = found?.version
        const local = arrivalLocal.current
        const choice = newerCopy(local, found)
        const now = workRef.current
        const untouched = (now.draft.body === '' || now.draft.body === (local?.text ?? '')) && now.files.length === 0
        if (found && choice === 'server' && untouched) {
          const parts = draftFromServer(found, { reply: canReplyRef.current })
          setWork((latest) => ({ ...latest, draft: parts.draft, notes: [], to: [...parts.to], cc: [...parts.cc], subject: parts.subject, files: [...parts.files] }))
          const restored = draftToSave(parts)
          lastSaved.current = restored ? JSON.stringify(restored) : ''
          setSaved({ state: 'saved', at: found.savedAt })
        }
        draftReady.current = true
        // A newer copy on this device (typed offline, or here before the server had it) goes to the server.
        if (choice === 'local' || (found && choice === 'server' && !untouched)) scheduleSave()
      })
      .catch(() => {
        // Not read (a fault, no right): the device copy stays; saving still tries (and says "Not saved" if it fails).
        draftReady.current = true
      })
    return () => controller.abort()
    // Only on arrival: the record's draft.
  }, [api, key, can.post])
  // A pause after the box changes: the draft is saved (a box the arrival read is still filling waits for it).
  const draftFiles = work.files.filter((file) => file.phase === 'done' && file.fileId).map((file) => `${file.fileId}:${file.audience}`).join(',')
  const draftLines = [...work.to, ...work.cc].map((item) => item.address).join(',')
  useEffect(() => {
    if (!draftReady.current || !can.post) return
    scheduleSave()
    // The box's own fields: scheduleSave reads the newest work.
  }, [work.draft.body, work.draft.mode, work.draft.forFloor, work.draft.link?.messageId, work.subject, draftLines, draftFiles, can.post])
  // Hidden, closed or left (the thread leaves the page): what waits is saved at once.
  useEffect(() => {
    const flush = () => {
      if (!saveTimer.current) return
      clearTimeout(saveTimer.current)
      saveTimer.current = null
      void saveRef.current()
    }
    const onHidden = () => document.visibilityState === 'hidden' && flush()
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])
  // Back online: what waited is saved.
  useEffect(() => {
    if (offline === null && draftReady.current && saved?.state === 'offline') void saveRef.current(true)
  }, [offline, saved?.state])
  // ---- end B-TH-287

  // ── the leave guard (T5-F10; TH-1c's useLeaveGuard): the browser's own question on close; a link of this app outside the
  // thread waits for "Leave with unsent text?" (Stay / Discard; Discard forgets the draft, then the move goes on) ────────────
  const unsentFiles = work.files.filter((file) => file.phase !== 'refused').length
  // ---- B-TH-287: with the draft on the server (saved, or being saved — leaving saves what waits) nothing is lost by leaving: no
  // question; only files still going up are not kept (a draft keeps the files that went up).
  const keptOnServer = saved !== null && (saved.state === 'saved' || saved.state === 'replaced' || saved.state === 'saving')
  const notKept = work.files.filter((file) => file.phase === 'uploading' || file.phase === 'failed').length
  const leave = useLeaveGuard(keptOnServer ? { text: '', files: notKept } : { text: work.draft.body, files: unsentFiles })
  // ---- end B-TH-287
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
  // B-TH-286: the pinned messages (the card's pin and its ⋯ "Unpin").
  const pinnedIds = useMemo(() => new Set((pins ?? []).map((pin) => pin.messageId)), [pins])
  const cards = useMemo<CardMessage[]>(
    // B-TH-255 (T3-F14, T3-F15): each card also says whether its writer was erased and which files of its mail were not kept.
    () => server.messages.map((message) => ({ ...cardOf(message, { emails, deliveries, names, taskHref: (taskId) => `${prefix}/home/tasks?open=${encodeURIComponent(taskId)}`, me: session.user.id, undo: undoable }), ...cardDepth(message), ...(pinnedIds.has(message.id) ? { pinned: true } : {}) /* B-TH-286 */ })),
    [server.messages, emails, deliveries, names, prefix, session.user.id, undoable, pinnedIds],
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
    can: { post: can.post, email: can.email, manage: can.manage, price: held.has('money.price') },
    closed,
    offline: offline !== null,
    people: withMentionTags(key, people.filter((person) => person.id !== session.user.id)),
    // B-TH-237: "In the portal only" — a customer, threads.post, a thread shared with customers, and no NO_PORTAL answer yet.
    portal: party !== null && can.post && !NOT_SHAREABLE_TYPES.has(host.record.type) && !portalRefused,
  }
  const feed: FeedModel = {
    state: server.status,
    messages: withOutbox(cards, work.outbox),
    events: changes.filter(feedShowsChange).map((entry) => eventOf(entry, names)),
    context: {
      partyName: party?.name ?? null,
      canReadFiles: can.readFiles,
      // B-TH-237: a customer's message may be answered by e-mail or in the portal.
      canReply: (can.email || context.portal === true) && party !== null,
      canTask: false,
      anchorId: anchor,
      // B-TH-236 (B-TH-050): Correct on one's own message, by the way it went.
      canCorrect: { note: can.post, email: can.email && party !== null, portal: context.portal === true },
      // B-TH-286 (B-TH-091): pin for everyone — whoever may write on the conversation, online.
      canPin: can.post && offline === null,
    },
    more: server.more,
    older: server.older,
    offline,
    now: new Date().toISOString(),
    // B-TH-229
    firstNewId: arrival?.firstNewId ?? null,
    newSince: arrival?.newCount ?? 0,
    // B-TH-255 (T4-F10): the mail for this conversation that waits for a person; Review opens Home › Mail to sort (email.triage only:
    // the API's `mayReview` says whether this reader may; anyone else reads that a reply waits for a colleague, never why or from whom).
    waitingMail: server.waitingMail ? { ...server.waitingMail, reviewHref: server.waitingMail.mayReview ? `${prefix}/home/mail-to-sort` : null } : null,
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
      // B-TH-289 (B-TH-096; T8-F05): on a message to the customer — reminders are Home's (home.view), held offline.
      followUp: followUpOffered(work.draft.mode, { remind: true })
        ? { on: work.followUp === true, held: !held.has('home.view') ? { key: 'followUp.held', params: { right: rightRef('home.view') } } : offline ? { key: 'followUp.offline' } : null, party: party?.name ?? host.prospect?.name ?? '' }
        : null,
    },
    pickerOpen,
    check,
    leaving: leave.asking,
    kept,
    notice,
    saved, // B-TH-287
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
        // B-TH-283 (B-TH-083): filed as a measurement sheet (body data).
        ...(row.sheet ? { measurementSheet: true } : {}),
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

  const addFiles = (dropped: File[], sheet = false) => {
    const audience = uploadAudience(workRef.current.draft.mode, can.share, partyId !== null)
    let current = workRef.current.files
    let leftOut = 0
    const added: Array<[DraftFile, File]> = []
    for (const file of dropped) {
      const result = addDropped(current, [{ name: file.name || 'Pasted image.png', type: file.type, size: file.size }], audience, () => `up-${newIdempotencyKey()}`, sheet)
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

  // ---- B-TH-289 (B-TH-096): the follow-up on a message that went to the customer — the person's own reminder at the message, three
  // days on; the API stops it when the customer answers (or the conversation closes). Said in words; a failure keeps the message sent.
  const setFollowUp = async (messageId: string) => {
    try {
      const reminder = await setReminder(api, { record: key, messageId, kind: 'AT_TIME', remindAt: followUpAt(Date.now()), note: null })
      followUps.current.set(messageId, reminder)
      setNotice({ ns: 'record-thread-helpers', key: 'followUp.set', params: { date: reminder.remindAt ? formatDate(reminder.remindAt, { locale }) : '' }, tone: 'success' })
    } catch {
      setNotice({ ns: 'record-thread-helpers', key: 'followUp.failed', tone: 'warning' })
    }
  }
  // ---- end B-TH-289

  const sendNote = async (item: { key: string; idempotencyKey: string; body: string; mentions: string[]; attachments: string[]; forFloor: boolean; card: CardMessage; amount?: { value: number; currency: string } | null; links?: MessageLinks; snapshot?: Work }) => {
    setSending(true)
    try {
      const messageId = await postNoteKeyed(api, key, { body: item.body, mentions: item.mentions, attachments: item.attachments, forFloor: item.forFloor, amount: item.amount ?? null, ...item.links }, item.idempotencyKey)
      setWork((now) => ({ ...now, outbox: now.outbox.map((entry) => (entry.key === item.key ? { ...entry, messageId } : entry)) }))
      setNotice({ ns: 'record-thread', key: item.forFloor ? 'notice.noteAddedFloor' : 'notice.noteAdded', tone: 'success' })
      void loadThread()
      void loadTimeline()
    } catch (error) {
      // B-TH-236 (B-TH-049): the API's price check held a floor note — the text comes back into the box with what looked like a price.
      if (floorPriceRefused(error) && item.snapshot) {
        const snapshot = item.snapshot
        setWork((now) => ({ ...now, draft: snapshot.draft, files: snapshot.files, outbox: now.outbox.filter((entry) => entry.key !== item.key) }))
        setNotice({ ns: 'record-thread', key: 'notice.floorPrice', params: { found: floorPriceFound(item.body, true) ?? item.body.slice(0, 40) }, tone: 'danger' })
        return
      }
      setWork((now) => ({ ...now, outbox: now.outbox.map((entry) => (entry.key === item.key ? { ...entry, state: 'failed', reason: sendReason(error) } : entry)) }))
    } finally {
      setSending(false)
    }
  }

  // ---- B-TH-237 (B-TH-044): a message the customer reads in its portal, no e-mail -------------------------------------------------
  const sendPortal = async (item: { key: string; idempotencyKey: string; body: string; attachments: string[]; links?: MessageLinks; snapshot: Work }) => {
    setSending(true)
    try {
      const messageId = await postPortalReplyKeyed(api, key, { body: item.body, attachments: item.attachments, ...item.links }, item.idempotencyKey)
      setWork((now) => ({ ...now, outbox: now.outbox.map((entry) => (entry.key === item.key ? { ...entry, messageId } : entry)) }))
      setNotice({ ns: 'record-thread', key: 'notice.portalPosted', tone: 'success' })
      if (item.snapshot.followUp && item.snapshot.draft.mode === 'portal') void setFollowUp(messageId) // B-TH-289
      void loadThread()
    } catch (error) {
      const refusal = portalRefusal(error)
      if (refusal) {
        // The person must change it: the text and files come back into the box, with why. Nobody reads the portal here: the choice goes.
        const snapshot = item.snapshot
        const noPortal = refusal === 'notice.portal.NO_PORTAL'
        if (noPortal) setPortalRefused(true)
        const back: ComposerMode = noPortal ? (can.email && party ? 'reply' : 'note') : snapshot.draft.mode
        setWork((now) => ({ ...now, draft: { ...snapshot.draft, mode: back, ...(noPortal && snapshot.draft.link?.kind === 'correct' ? { link: undefined } : {}) }, files: snapshot.files, outbox: now.outbox.filter((entry) => entry.key !== item.key) }))
        setNotice({ ns: 'record-thread', key: refusal, tone: 'danger' })
      } else {
        setWork((now) => ({ ...now, outbox: now.outbox.map((entry) => (entry.key === item.key ? { ...entry, state: 'failed', reason: sendReason(error) } : entry)) }))
      }
    } finally {
      setSending(false)
    }
  }
  // ---- end B-TH-237

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
    const links = linksOf(now.draft.link)
    // ---- B-TH-237: in the portal — ours, on the PORTAL channel, no mail.
    if (now.draft.mode === 'portal') {
      const card: CardMessage = { id: outboxKey, kind: 'ours', channel: 'PORTAL', author: session.user.displayName, authorKind: 'USER', at: new Date().toISOString(), body: now.draft.body, mentions: [], files: [] }
      const item = { key: outboxKey, idempotencyKey, body: now.draft.body, attachments, links, snapshot: now }
      retries.current.set(outboxKey, () => sendPortal(item))
      setWork((latest) => ({ ...latest, draft: { mode: latest.draft.mode, body: '', forFloor: false }, notes: [], files: [], followUp: false /* B-TH-289 */, outbox: [...latest.outbox, { key: outboxKey, card, state: 'sending' }] }))
      forgetDraft()
      void sendPortal(item)
      return
    }
    // ---- end B-TH-237
    const forFloor = now.draft.forFloor || floorLocked(now.draft)
    const amount = amountBody(now.draft.amount, now.draft.currency)
    const card: CardMessage = { id: outboxKey, kind: 'note', channel: 'APP', author: session.user.displayName, authorKind: 'USER', at: new Date().toISOString(), body: now.draft.body, forFloor, mentions: [], files: [], ...(amount ? { amount } : {}) }
    const item = { key: outboxKey, idempotencyKey, body: now.draft.body, mentions: mentionsIn(now.draft.body, context.people), attachments, forFloor, card, amount, links, snapshot: now }
    retries.current.set(outboxKey, () => sendNote(item))
    setWork((latest) => ({ ...latest, draft: { mode: latest.draft.mode, body: '', forFloor: false }, notes: [], files: [], outbox: [...latest.outbox, { key: outboxKey, card, state: 'sending' }] }))
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
    // B-TH-236 (B-TH-050): the message it answers or corrects goes with it.
    const body = { ...sendBody({ to: now.to, cc: now.cc, subject, body: now.draft.body, attachments: sendable(now.files).map((file) => file.fileId as string), outside }), ...linksOf(now.draft.link) }
    const outboxKey = `local-${newIdempotencyKey()}`
    const idempotencyKey = newIdempotencyKey()
    const card: CardMessage = { id: outboxKey, kind: 'ours', channel: 'EMAIL', author: session.user.displayName, authorKind: 'USER', at: new Date().toISOString(), body: now.draft.body, mentions: [], files: [], email: { to: body.to, subject, status: 'QUEUED' } }
    const snapshot = now
    const go = async () => {
      setSending(true)
      try {
        const { messageId, email } = await sendReplyKeyed(api, key, body, idempotencyKey)
        setWork((latest) => ({ ...latest, outbox: latest.outbox.map((entry) => (entry.key === outboxKey ? { ...entry, messageId } : entry)) }))
        if (snapshot.followUp) void setFollowUp(messageId) // B-TH-289
        // B-TH-236 (B-TH-048): "Sending to <customer>… · Undo" from the answer, before the next read of the mail list.
        if (email?.undoUntil) setUndoable((known) => new Map(known).set(messageId, { emailId: email.id, until: email.undoUntil! }))
        setNotice({ ns: 'record-thread', key: 'notice.emailQueued', tone: 'success' })
        void loadThread()
        void loadEmails()
      } catch (error) {
        const refusal = replyRefusal(error)
        if (refusal) {
          // The person must change it: the text, files and recipients come back into the box, with why.
          setWork((latest) => ({ ...latest, draft: snapshot.draft, files: snapshot.files, to: snapshot.to, cc: snapshot.cc, subject: snapshot.subject, followUp: snapshot.followUp, outbox: latest.outbox.filter((entry) => entry.key !== outboxKey) }))
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
    // After a send the mode stays as used while the person stays on the record (T5-F02); its link goes with the message.
    setWork((latest) => ({ ...latest, draft: { mode: latest.draft.mode, body: '', forFloor: latest.draft.forFloor }, notes: [], files: [], followUp: false /* B-TH-289 */, outbox: [...latest.outbox, { key: outboxKey, card, state: 'sending' }] }))
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

  // ---- B-TH-286 (B-TH-091): pin for everyone, unpin — the answer is the conversation's pins again; a refusal in words.
  const pinOrUnpin = async (messageId: string, pin: boolean) => {
    try {
      setPins(await (pin ? pinMessage(api, key, messageId) : unpinMessage(api, key, messageId)))
      setNotice({ ns: 'record-thread', key: pin ? 'notice.pinned' : 'notice.unpinned', tone: 'success' })
    } catch (error) {
      setNotice({ ns: 'record-thread', key: pinRefusalKey(error), tone: 'warning' })
      void loadPins()
    }
  }
  // ---- end B-TH-286

  // ---- B-TH-288 (B-TH-097): to a message — older pages read until it is there (a search hit, a pin), then unfolded and focused.
  const serverRef = useRef(server)
  serverRef.current = server
  const jumpTo = useCallback(
    async (messageId: string): Promise<boolean> => {
      let current = serverRef.current
      for (let pages = 0; !current.messages.some((message) => message.id === messageId) && current.cursor && pages < 20; pages += 1) {
        try {
          const page = await readThreadPage(api, key, current.cursor)
          current = applyOlder(current, page)
          setServer((now) => applyOlder(now, page))
        } catch {
          break
        }
      }
      if (!current.messages.some((message) => message.id === messageId)) {
        setNotice({ ns: 'record-thread', key: 'notice.messageGone', tone: 'warning' })
        return false
      }
      setAnchor(messageId)
      requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
        target?.scrollIntoView({ block: 'center' })
        target?.focus({ preventScroll: true })
      })
      return true
    },
    [api, key],
  )
  // ---- end B-TH-288

  const actions: RecordThreadActions = {
    onSeen,
    onDraft: (draft, notes) => patch({ draft, notes }),
    // ---- B-TH-286 / B-TH-287 / B-TH-289
    onPin: (messageId) => void pinOrUnpin(messageId, true),
    onUnpin: (messageId) => void pinOrUnpin(messageId, false),
    onRetryDraft: () => void saveRef.current(true),
    onFollowUp: (on) => patch({ followUp: on }),
    // ---- end B-TH-286 / B-TH-287 / B-TH-289
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
      // B-TH-237: a message from the portal is answered in the portal when it is offered; else by e-mail (or the portal alone).
      const way: ComposerMode = message?.channel === 'PORTAL' && context.portal ? 'portal' : can.email && party ? 'reply' : context.portal ? 'portal' : 'reply'
      const switched = switchMode(workRef.current.draft, way, context.people)
      const contact = contacts.find((item) => item.name === message?.author.name && cleanAddress(item.email))
      // B-TH-236 (B-TH-050): the box names the message it answers ("Replying to Alma, 14 Nov ×").
      const link: DraftLink | undefined = message ? { kind: 'reply', messageId: message.id, who: message.authorHidden ? null : message.author.name, at: message.at } : undefined
      setWork((now) => ({
        ...now,
        draft: { ...switched.draft, ...(link ? { link } : {}) },
        notes: switched.notes,
        to: contact && way === 'reply' ? [{ address: contact.email.toLowerCase(), name: contact.name, kind: 'PARTY', organisation: party?.name ?? null } satisfies Recipient] : now.to,
      }))
    },
    // ---- B-TH-236 (B-TH-050): Correct — a new message linked to the old one, the way it went (never an edit).
    onCorrect: (messageId) => {
      const card = cards.find((item) => item.id === messageId)
      const message = server.messages.find((item) => item.id === messageId)
      if (!card || !message) return
      const way = correctionWay(card, feed.context)
      if (!way) return
      const switched = switchMode(workRef.current.draft, way, context.people)
      const link: DraftLink = { kind: 'correct', messageId, who: null, at: message.at, way, ...(message.forFloor ? { forFloor: true } : {}) }
      const mail = emails.get(messageId)
      setWork((now) => ({
        ...now,
        draft: { ...switched.draft, ...(message.forFloor ? { forFloor: true } : {}), link },
        notes: switched.notes,
        // A mail's correction goes to whoever got it: To, Cc and the subject of the mail it corrects.
        ...(way === 'reply' && mail
          ? {
              to: mail.to.map((address) => ({ address, name: null, kind: null, organisation: null }) satisfies Recipient),
              cc: (mail.cc ?? []).map((address) => ({ address, name: null, kind: null, organisation: null }) satisfies Recipient),
              subject: mail.subject,
            }
          : {}),
      }))
    },
    // ---- B-TH-236 (B-TH-048): Undo in the mail's 10 seconds — taken back, its text, recipients, files and link come back into the box.
    onUndo: async (messageId) => {
      const emailId = undoable.get(messageId)?.emailId ?? emails.get(messageId)?.id
      if (!emailId) return
      try {
        const taken = await takeBackMail(api, key, emailId)
        const text = taken.text
        const linkedId = text.correctsMessageId ?? text.replyToMessageId ?? null
        const linked = linkedId ? server.messages.find((item) => item.id === linkedId) : undefined
        const link: DraftLink | undefined = linked
          ? text.correctsMessageId
            ? { kind: 'correct', messageId: linked.id, who: null, at: linked.at, way: 'reply' }
            : { kind: 'reply', messageId: linked.id, who: linked.authorHidden ? null : linked.author.name, at: linked.at }
          : undefined
        const asRecipient = (address: string): Recipient => {
          const contact = contacts.find((item) => item.email.toLowerCase() === address.toLowerCase())
          return { address, name: contact?.name ?? null, kind: contact ? 'PARTY' : null, organisation: contact ? (party?.name ?? null) : null }
        }
        const files = text.attachments.flatMap((id) => {
          const known = recordFiles.find((file) => file.id === id)
          return known ? [draftOfRecordFile(known, `record-${id}`)] : []
        })
        setWork((now) => ({ ...now, draft: { mode: 'reply', body: text.body, forFloor: false, ...(link ? { link } : {}) }, notes: [], to: text.to.map(asRecipient), cc: text.cc.map(asRecipient), subject: text.subject, files }))
        setUndoable((known) => {
          const next = new Map(known)
          next.delete(messageId)
          return next
        })
        // B-TH-289: a mail taken back takes its follow-up with it (nothing went to wait for an answer to).
        const followUp = followUps.current.get(messageId)
        if (followUp) {
          followUps.current.delete(messageId)
          void removeReminder(api, followUp).catch(() => undefined)
        }
        setNotice({ ns: 'record-thread-send', key: 'notice.takenBack', tone: 'success' })
      } catch (error) {
        setNotice({ ns: 'record-thread-send', key: undoRefusalKey(error), tone: 'warning' })
      } finally {
        void loadThread()
        void loadEmails()
      }
    },
    // ---- B-TH-283 (B-TH-083): files that go up as measurement sheets.
    onSheets: (dropped) => addFiles(dropped, true),
    // ---- end B-TH-236 / B-TH-283
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
    // B-TH-287: Discard is the person's word: the server's draft goes too.
    if (can.post) void discardServerDraft(api, key).catch(() => undefined)
  }

  const base: RecordThreadBase = { key, server, files, filesRead, closed, offline, held, can, partyId, people, loadFiles, loadThread, loadTimeline, notify: setNotice, newCount: server.reading?.newCount ?? 0, peopleState, loadPeople, pins, unpin: (messageId) => pinOrUnpin(messageId, false) /* B-TH-286 */, jumpTo /* B-TH-288 */ }
  return { model, actions, kept, guard: { ask: leave.ask }, base }
}

// ---- B-TH-236 (B-TH-050): what a draft's link sends — the message it answers, or the one it corrects (one at most). ----------------
function linksOf(link: DraftLink | undefined): MessageLinks {
  if (!link) return {}
  return link.kind === 'correct' ? { correctsMessageId: link.messageId } : { replyToMessageId: link.messageId }
}
