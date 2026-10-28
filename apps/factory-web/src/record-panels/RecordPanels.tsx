'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isApiError } from '../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../lib/session/context'
import {
  completeUpload,
  downloadLink,
  listEmails,
  listFiles,
  listPeople,
  postNote,
  readThread,
  readTimeline,
  requestUpload,
  sendEmail,
  setThreadStatus,
  type ApiEmail,
  type ApiFile,
  type ApiMessage,
  type ApiTimelineEntry,
} from './api'
import { useLiveChanges } from './live'
import {
  contentTypeOf,
  liveParts,
  parseAddresses,
  uploadProblem,
  type ComposerDraft,
  type FileAudience,
  type FileKind,
  type Loaded,
  type PanelFile,
  type PanelMessage,
  type PanelParty,
  type PanelPerson,
  type PanelRecord,
  type PanelTimelineEntry,
  type PanelUpload,
  type RecordPanelsViewModel,
  type ThreadStatus,
  type TimelineFilter,
} from './model'
import { putToStore, readFromStore, sha256Hex, storeUrl, StoreError } from './store'
import { RecordPanelsView } from './view/RecordPanelsView'

/**
 * The record panels as a record page mounts them: `<RecordPanels record={{ type, id, companyId, siteId }} title party />`.
 * It loads the record's thread, mail states, files, history and the people a note may mention through the API client,
 * maps them to the view model, does what the view asks (a note, a mail, an upload, a download, a PDF, close/reopen),
 * and reads a part again when the live stream says it changed (thread.message_posted, file.available,
 * email.status_changed). Errors are shown in this app's words (a message key per kind); the API checks every call.
 */
export interface RecordPanelsProps {
  record: PanelRecord
  /** The record's name as its page shows it. */
  title: string
  /** The record's customer, supplier or brand, when it has one (the page knows it; the thread confirms it). */
  party?: PanelParty | null
}

type Notice = NonNullable<RecordPanelsViewModel['notice']>

const EMPTY: Loaded<never> = { items: null, more: false, problem: null }

/** The message key for a failed read. */
function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'panels.problem.read'
  if (error.kind === 'not_found') return 'panels.problem.notFound'
  if (error.kind === 'forbidden') return 'panels.problem.forbidden'
  if (error.kind === 'signed_out') return 'panels.problem.signedOut'
  if (error.kind === 'unavailable') return 'panels.problem.unavailable'
  return 'panels.problem.read'
}

/** Where a refusal's issue points (`body/identityId`); the API sends the path as text. */
const issuePaths = (error: { issues: readonly { path?: unknown }[] }): string[] =>
  error.issues.map((issue) => (Array.isArray(issue.path) ? issue.path.join('/') : String(issue.path ?? '')))

/** The notice for a refused mail or note: what the API pointed at, in this app's words. */
export function sendNotice(error: unknown): Notice {
  if (isApiError(error) && error.kind === 'invalid') {
    const paths = issuePaths(error)
    if (paths.some((path) => path === 'body/identityId')) return { key: 'notice.noSender', tone: 'danger' }
    if (paths.some((path) => /^body\/(to|cc|bcc)\//.test(path) || path === 'body/to')) return { key: 'notice.badRecipient', tone: 'danger' }
    if (paths.some((path) => path === 'body/subject')) return { key: 'notice.noSubject', tone: 'danger' }
    if (paths.some((path) => path.startsWith('body/attachments'))) return { key: 'notice.attachmentsRefused', tone: 'danger' }
    if (paths.some((path) => path.startsWith('body/mentions'))) return { key: 'notice.mentionsRefused', tone: 'danger' }
  }
  return writeNotice(error, 'notice.sendConflict')
}

/** The notice for a failed write. */
function writeNotice(error: unknown, conflictKey: string): Notice {
  if (!isApiError(error)) return { key: 'notice.failed', tone: 'danger' }
  switch (error.kind) {
    case 'conflict':
      return { key: conflictKey, tone: 'warning' }
    case 'invalid':
      return { key: 'notice.invalid', tone: 'danger' }
    case 'forbidden':
      return { key: 'notice.forbidden', tone: 'danger' }
    case 'step_up':
      return { key: 'notice.stepUp', tone: 'warning' }
    case 'signed_out':
      return { key: 'panels.problem.signedOut', tone: 'danger' }
    case 'rate_limited':
      return { key: 'notice.rateLimited', tone: 'warning' }
    case 'unavailable':
      return { key: 'notice.unavailable', tone: 'danger' }
    default:
      return { key: 'notice.failed', tone: 'danger' }
  }
}

function fileOf(file: ApiFile): PanelFile {
  return {
    id: file.id,
    name: file.originalName,
    kind: file.kind,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    visibility: file.visibility,
    partyId: file.partyId ?? null,
    retainUntil: file.retainUntil,
    legalHold: file.legalHold ?? false,
    quarantineReason: file.quarantineReason,
    availableAt: file.availableAt,
    createdAt: file.createdAt,
  }
}

export function RecordPanels({ record, title, party: givenParty = null }: RecordPanelsProps) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const key = useMemo(() => ({ type: record.type, id: record.id }), [record.type, record.id])
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const can = useMemo(
    () => ({
      post: held.has('threads.post'),
      email: held.has('email.send'),
      manage: held.has('threads.manage'),
      readFiles: held.has('files.read'),
      upload: held.has('files.upload'),
      share: held.has('files.manage'),
    }),
    [held],
  )

  const [thread, setThread] = useState<{ status: ThreadStatus; version: number; partyId: string | null } | null>(null)
  const [messages, setMessages] = useState<Loaded<ApiMessage> & { cursor: string | null }>({ ...EMPTY, cursor: null })
  const [emails, setEmails] = useState<ReadonlyMap<string, ApiEmail>>(new Map())
  const [files, setFiles] = useState<Loaded<ApiFile>>(EMPTY)
  const [timeline, setTimeline] = useState<Loaded<ApiTimelineEntry> & { cursor: string | null }>({ ...EMPTY, cursor: null })
  const [filter, setFilter] = useState<TimelineFilter>('all')
  const [people, setPeople] = useState<PanelPerson[]>([])
  const [uploads, setUploads] = useState<PanelUpload[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [preview, setPreview] = useState<RecordPanelsViewModel['preview']>(null)
  const [sending, setSending] = useState(false)
  const filterRef = useRef(filter)
  filterRef.current = filter

  const loadThread = useCallback(
    async (more = false, cursor: string | null = null) => {
      try {
        const page = await readThread(api, key, more ? cursor : null)
        setThread(page.thread ? { status: page.thread.status, version: page.thread.version, partyId: page.thread.partyId } : null)
        setMessages((current) => ({
          items: more && current.items ? [...current.items, ...page.messages] : page.messages,
          more: page.nextCursor !== null,
          cursor: page.nextCursor,
          problem: null,
        }))
      } catch (error) {
        setMessages((current) => ({ ...current, problem: readProblem(error) }))
      }
    },
    [api, key],
  )
  const loadEmails = useCallback(async () => {
    try {
      const { emails: list } = await listEmails(api, key)
      setEmails(new Map(list.flatMap((email) => (email.messageId ? [[email.messageId, email] as const] : []))))
    } catch {
      // The mail states are a detail of the thread: without them the messages still show.
    }
  }, [api, key])
  const loadFiles = useCallback(async () => {
    if (!can.readFiles) return
    try {
      const { files: list } = await listFiles(api, key)
      setFiles({ items: list, more: false, problem: null })
    } catch (error) {
      setFiles((current) => ({ ...current, problem: readProblem(error) }))
    }
  }, [api, key, can.readFiles])
  const loadTimeline = useCallback(
    async (more = false, cursor: string | null = null) => {
      const wanted = filterRef.current
      try {
        const page = await readTimeline(api, key, wanted, more ? cursor : null)
        if (wanted !== filterRef.current) return
        setTimeline((current) => ({
          items: more && current.items ? [...current.items, ...page.entries] : page.entries,
          more: page.nextCursor !== null,
          cursor: page.nextCursor,
          problem: null,
        }))
      } catch (error) {
        setTimeline((current) => ({ ...current, problem: readProblem(error) }))
      }
    },
    [api, key],
  )
  const loadPeople = useCallback(async () => {
    if (!can.post) return
    try {
      setPeople((await listPeople(api, key)).people)
    } catch {
      // Without the list a note simply mentions nobody.
    }
  }, [api, key, can.post])

  const loadAll = useCallback(() => {
    void loadThread()
    void loadEmails()
    void loadFiles()
    void loadTimeline()
    void loadPeople()
  }, [loadThread, loadEmails, loadFiles, loadTimeline, loadPeople])
  // On arrival: everything but the history, which the filter's effect below reads (once, also on arrival).
  useEffect(() => {
    void loadThread()
    void loadEmails()
    void loadFiles()
    void loadPeople()
  }, [loadThread, loadEmails, loadFiles, loadPeople])
  useEffect(() => {
    setTimeline((current) => ({ ...current, items: null, problem: null }))
    void loadTimeline()
  }, [filter, loadTimeline])

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

  const threadParty = thread?.partyId ?? null
  const party = useMemo<PanelParty | null>(() => givenParty ?? (threadParty ? { id: threadParty, name: '', emails: [] } : null), [givenParty, threadParty])
  const names = useMemo(() => new Map<string, string>([...people.map((person) => [person.id, person.name] as const), [session.user.id, session.user.displayName]]), [people, session.user])

  const send = async (draft: ComposerDraft): Promise<boolean> => {
    setSending(true)
    setNotice(null)
    try {
      if (draft.mode === 'note') await postNote(api, key, { body: draft.body, mentions: draft.mentions, attachments: draft.attachments })
      else await sendEmail(api, key, { to: parseAddresses(draft.to).valid, subject: draft.subject.trim() || undefined, body: draft.body, attachments: draft.attachments })
      setNotice({ key: draft.mode === 'note' ? 'notice.noteAdded' : 'notice.emailQueued', tone: 'success' })
      void loadThread()
      void loadEmails()
      void loadTimeline()
      return true
    } catch (error) {
      setNotice(sendNotice(error))
      void loadThread()
      return false
    } finally {
      setSending(false)
    }
  }

  const changeStatus = async (status: ThreadStatus) => {
    if (!thread) return
    setNotice(null)
    try {
      await setThreadStatus(api, key, status, thread.version)
      setNotice({ key: status === 'CLOSED' ? 'notice.closed' : 'notice.reopened', tone: 'success' })
    } catch (error) {
      // COL-078: someone changed the thread since it was read; it is read again before anything else is tried.
      setNotice(writeNotice(error, 'notice.statusConflict'))
    } finally {
      void loadThread()
      void loadTimeline()
    }
  }

  const upload = async (file: File, choice: { kind: FileKind; visibility: FileAudience[] }) => {
    const uploadKey = globalThis.crypto.randomUUID()
    const row = (phase: PanelUpload['phase'], problem?: string): PanelUpload => ({ key: uploadKey, name: file.name, sizeBytes: file.size, phase, ...(problem ? { problem } : {}) })
    const set = (next: PanelUpload | null) => setUploads((list) => (next ? [...list.filter((item) => item.key !== uploadKey), next] : list.filter((item) => item.key !== uploadKey)))
    const contentType = file.type || contentTypeOf(file.name)
    const problem = uploadProblem({ name: file.name, type: contentType, size: file.size }, choice.kind)
    if (problem) return set(row('failed', problem.key))
    set(row('hashing'))
    try {
      const bytes = await file.arrayBuffer()
      const sha256 = await sha256Hex(bytes)
      set(row('uploading'))
      const announced = await requestUpload(api, {
        companyId: record.companyId,
        record: key,
        kind: choice.kind,
        name: file.name,
        contentType,
        sizeBytes: file.size,
        sha256,
        visibility: choice.visibility,
        floorSiteId: record.siteId ?? null,
        partyId: party?.id ?? null,
      })
      await putToStore(announced.upload, new Blob([bytes], { type: contentType }))
      set(row('confirming'))
      const { file: done } = await completeUpload(api, announced.file.id)
      set(null)
      setNotice(done.status === 'QUARANTINED' ? { key: 'files.notice.quarantined', tone: 'danger' } : { key: 'files.notice.uploaded', tone: 'success' })
      void loadFiles()
      void loadTimeline()
    } catch (error) {
      const why =
        error instanceof StoreError
          ? 'files.problem.store'
          : isApiError(error) && error.kind === 'invalid'
            ? 'files.problem.refused'
            : isApiError(error) && (error.kind === 'forbidden' || error.kind === 'step_up')
              ? 'files.problem.forbidden'
              : 'files.problem.failed'
      set(row('failed', why))
    }
  }

  const download = async (fileId: string) => {
    try {
      const { download: link } = await downloadLink(api, fileId)
      const anchor = document.createElement('a')
      anchor.href = storeUrl(link.url)
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } catch (error) {
      setNotice(writeNotice(error, 'notice.failed'))
    }
  }

  const openPreview = async (fileId: string) => {
    const file = files.items?.find((item) => item.id === fileId)
    if (!file) return
    try {
      const { download: link } = await downloadLink(api, fileId)
      setPreview({ fileId, name: file.originalName, src: await readFromStore(link) })
    } catch (error) {
      setNotice(error instanceof StoreError ? { key: 'files.problem.store', tone: 'danger' } : writeNotice(error, 'notice.failed'))
    }
  }

  const panelMessages: PanelMessage[] | null =
    messages.items?.map((message) => {
      const email = emails.get(message.id)
      return {
        id: message.id,
        direction: message.direction,
        channel: message.channel,
        authorKind: message.author.kind,
        authorName: message.author.name,
        at: message.at,
        body: message.body,
        mentions: (message.mentions ?? []).map((id) => names.get(id) ?? null),
        attachments: message.attachments.map((file) => ({ id: file.id, name: file.originalName, sizeBytes: file.sizeBytes, contentType: file.contentType, status: file.status })),
        email: email ? { to: email.to, subject: email.subject, status: email.status } : null,
      }
    }) ?? null

  const panelTimeline: PanelTimelineEntry[] | null =
    timeline.items?.map((entry): PanelTimelineEntry => {
      if (entry.kind === 'message') return { kind: 'message', id: entry.id, at: entry.at, direction: entry.direction, channel: entry.channel, authorName: entry.author.name, excerpt: entry.excerpt, attachmentCount: entry.attachmentCount }
      if (entry.kind === 'file') return { kind: 'file', id: entry.id, at: entry.at, name: entry.originalName, fileKind: entry.fileKind, status: entry.status, visibility: entry.visibility }
      const before = entry.before ?? null
      const after = entry.after ?? null
      return {
        kind: 'change',
        id: entry.id,
        at: entry.at,
        action: entry.action,
        actorName: names.get(entry.actor.id) ?? null,
        actorAudience: entry.actor.audience,
        status: entry.status,
        fields: entry.fields,
        values: before === null && after === null ? null : { before, after },
        reason: entry.reason,
      }
    }) ?? null

  const model: RecordPanelsViewModel = {
    record,
    title,
    party,
    can,
    thread: thread ? { status: thread.status, version: thread.version } : null,
    messages: { items: panelMessages, more: messages.more, problem: messages.problem },
    files: { items: files.items?.map(fileOf) ?? null, more: false, problem: files.problem },
    uploads,
    timeline: { items: panelTimeline, more: timeline.more, problem: timeline.problem },
    timelineFilter: filter,
    people: people.filter((person) => person.id !== session.user.id),
    me: session.user.id,
    notice,
    preview,
    sending,
  }

  return (
    <RecordPanelsView
      model={model}
      actions={{
        onSend: send,
        onThreadStatus: (status) => void changeStatus(status),
        onMoreMessages: () => void loadThread(true, messages.cursor),
        onUpload: (file, choice) => void upload(file, choice),
        onDismissUpload: (uploadKey) => setUploads((list) => list.filter((item) => item.key !== uploadKey)),
        onDownload: (fileId) => void download(fileId),
        onPreview: (fileId) => void openPreview(fileId),
        onClosePreview: () => setPreview(null),
        onTimelineFilter: setFilter,
        onMoreTimeline: () => void loadTimeline(true, timeline.cursor),
        onRetry: (part) => {
          if (part === 'thread') {
            setMessages((current) => ({ ...current, problem: null }))
            void loadThread()
          } else if (part === 'files') {
            setFiles({ ...EMPTY })
            void loadFiles()
          } else {
            setTimeline((current) => ({ ...current, items: null, problem: null }))
            void loadTimeline()
          }
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
