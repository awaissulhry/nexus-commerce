'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Copy } from 'lucide-react'
import { KIND_RULES } from '@nexus/factory-domain/approvals-out/kinds'
import { isReplyRecordType } from '@nexus/factory-domain/templates/replies'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatDate } from '../../../lib/i18n/format'
import { rightRef } from '../../../lib/i18n/rights'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { feedForView, feedKinds } from '../../../lib/record-thread/model'
import { RecordThread, type RecordThreadActions, type RecordThreadModel } from '../../../lib/record-thread/RecordThread'
import { doorHolds, viewsOffered, whoAnswers, type HeadAbilities, type HeadDoor, type HeadModel, type ThreadView } from '../../../lib/record-thread/head/model'
// B-TH-229: the API's waiting and owner (B-TH-028), "Change owner…".
import { answersOf } from '../../../lib/record-thread/head/model'
import { OwnerDialog } from '../../../lib/record-thread/head/view/OwnerDialog'
import { setThreadOwner } from './api'
import { isApiError } from '../../../lib/api/errors'
import { HEAD_NS, RecordThreadHead } from '../../../lib/record-thread/head/view/RecordThreadHead'
import { fileSeries, fromApiFile, recordFiles, toViewerFile, type FilesParty, type ThreadFile } from '../../../lib/record-thread/files/model'
import { useStripOpen } from '../../../lib/record-thread/files/use-strip-open'
import { FILES_NS, FileStrip } from '../../../lib/record-thread/files/view/FileStrip'
import { START_AUDIENCE, type MissingDocument, type UploadAsk } from '../../../lib/record-thread/files-view/model'
import { FILES_VIEW_NS, FilesView, type BulkAction } from '../../../lib/record-thread/files-view/view/FilesView'
import type { SavedRepliesModel, SavedReplyLine } from '../../../lib/record-thread/helpers/model'
import { HELPERS_NS } from '../../../lib/record-thread/helpers/view/MentionInput'
import { SavedReplies } from '../../../lib/record-thread/helpers/view/SavedReplies'
import type { CountPopoverModel, ViewerFile } from '../../../lib/record-thread/popups/model'
import { CloseThreadConfirm } from '../../../lib/record-thread/popups/view/Confirms'
import { FileViewer, POPUPS_NS } from '../../../lib/record-thread/popups/view/FileViewer'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { downloadLink, requestUpload, completeUpload, setThreadStatus } from '../../../record-panels/api'
import { useApprovals } from '../../../record-panels/approvals/use-approvals'
import { takesApprovals } from '../../../record-panels/approvals/model'
import { AskDialog } from '../../../record-panels/approvals/view/AskDialog'
import { readDocuments, restoreVersion } from '../../../record-panels/files/api'
import { WithMessages } from '../../../record-panels/i18n'
import { useLiveChanges } from '../../../record-panels/live'
import { uploadChoices, uploadProblem, type FileKind, type RecordPanelsViewModel } from '../../../record-panels/model'
import type { RecordPanelsActions } from '../../../record-panels/view/actions'
import { contentTypeOf } from '../../../lib/record-thread/attachments/model'
import { SHARES_NS, takesShares } from '../../../record-panels/share/model'
import { useShares } from '../../../record-panels/share/use-shares'
import { InviteDialog } from '../../../record-panels/share/view/InviteDialog'
import { putToStore, readFromStore, sha256Hex, storeUrl } from '../../../record-panels/store'
import { addFollower, createTask, listAssignees, listTasks, readFollowers, setMyFollow, taskReadProblem, taskWriteProblem } from '../../../record-panels/tasks/api'
import { addTaskHeld, createBody, followersChangeFor, followReasonKey, taskChangeFor, type Assignable, type Followers, type TaskDraft, type TaskItem } from '../../../record-panels/tasks/model'
import type { PanelRead } from '../../../record-panels/model'
import { FollowersControl } from '../../../record-panels/view/FollowersControl'
import { TaskNewDialog } from '../../../record-panels/view/TaskNewDialog'
import { fillReply, listReplies } from '../document-send/template/api'
import { useRecordFrame } from '../record-frame/RecordFrame'
import { askedFiles } from '../record-frame/model' // B-TH-264 follow-up
import { officeOnly, removeFile, shareWithParty } from './api'
// B-TH-231: carry a file to another record (same customer or none); a refused file read in words.
import { readUseOnTargets, useFileOn } from './api'
import { carriable, offeredTargets, openRefusal, queryReady, targetLabel, useOnRefusal } from '../../../lib/record-thread/files/use-on'
import { UseOnDialog, type UseOnModel } from '../../../lib/record-thread/files/view/UseOnDialog'
import type { RecordThreadBase, RecordThreadHost } from './use-record-thread'
// B-TH-251 (PROJ.linked-F05): "In project …" on the head of a record a project may link.
import { useInProject } from '../../products/projects/record/linked/use-in-project'
import { companyPrefix } from '../../../lib/session/session'

/** What the docked thread needs of its record beyond RecordThread v1's host (B-TH-300). */
export interface DockedHost extends RecordThreadHost {
  /** Whom the record's party is to us ("Waiting on customer"; "Customer" marks on files). */
  partyRole?: 'customer' | 'supplier' | 'partner'
  /** The page's print view (the Head's "Print or save as PDF"); absent: no Print line. */
  printHref?: string
}

const NAMESPACES = [HEAD_NS, FILES_NS, FILES_VIEW_NS, POPUPS_NS, HELPERS_NS, 'records', 'record-approvals', SHARES_NS, 'record-files', 'home-mywork']

/** The files of the record the viewer walks: each document's version in force, newest first. */
const latestOf = (files: readonly ThreadFile[]): ThreadFile[] => fileSeries(files).map((series) => series.latest)

/**
 * The docked thread's office container (B-TH-300; pictures 6–11; T1, T2, T8, T9, T-POP, PL4): RecordThread v1's feed, cards and box
 * (the same container, use-record-thread) with the Head — who answers next, the View, the counts, the width menu of the frame, and
 * the "⋯" that ALWAYS holds Activity's doors (rule R-ACT): Add task, Ask a partner to approve, Share with a partner, Followers,
 * Follow / Mute, Remind me — each opening the EXISTING dialog of the record panels, plus Print and "Close thread…" for
 * threads.manage —, the files line and its strip, the ONE file viewer, the Files view, and Saved replies beside the box. Brand wall
 * (W06, W08, W24, W25, W34): Ask and Share reach only this record's party (the dialogs and the API check it again), the files are this
 * record's only, the @ list is office readers only (B-TH-208).
 */
export function DockedOfficeThread(props: { host: DockedHost; model: RecordThreadModel; actions: RecordThreadActions; base: RecordThreadBase; reminder: { mine: { remindAt: string | null } | null; open: (messageId: string | null) => void; dialog: ReactNode }; remind?: (messageId: string) => ReactNode }) {
  return (
    <WithMessages namespaces={NAMESPACES}>
      <Docked {...props} />
    </WithMessages>
  )
}

function Docked({ host, model, actions, base, reminder, remind }: { host: DockedHost; model: RecordThreadModel; actions: RecordThreadActions; base: RecordThreadBase; reminder: { mine: { remindAt: string | null } | null; open: (messageId: string | null) => void; dialog: ReactNode }; remind?: (messageId: string) => ReactNode }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const frame = useRecordFrame()
  const tr = useT('records')
  const tf = useT('record-files')
  const tv = useT(FILES_VIEW_NS)
  const th = useT(HEAD_NS)
  const ta = useT('record-approvals')
  const ts = useT(SHARES_NS)
  const { key, held, can, notify } = base
  const party = host.party ?? null
  const partyId = base.partyId
  const role = host.partyRole ?? 'customer'
  const offline = base.offline !== null

  // ── the Head's View (T1-F04) ────────────────────────────────────────────────────────────────────────────────────────
  const [view, setView] = useState<ThreadView>('all')
  const kinds = feedKinds(model.feed.messages)
  const views = viewsOffered({ ...kinds, canAudit: held.has('audit.read') })
  const shown: ThreadView = views.includes(view) ? view : 'all'

  // ── tasks (B-W2a-40: Home's tasks; reading them is home.view, adding tasks.manage + threads.post) ──────────────────────
  const seesTasks = held.has('home.view')
  const [tasks, setTasks] = useState<TaskItem[] | null>(null)
  const [taskDialog, setTaskDialog] = useState<{ people: PanelRead<readonly Assignable[]>; initial?: Partial<TaskDraft> } | null>(null)
  const [taskBusy, setTaskBusy] = useState(false)
  const loadTasks = useCallback(async () => {
    if (!seesTasks) return
    try {
      setTasks((await listTasks(api, { scope: 'RECORD', record: key, status: 'OPEN', limit: 100 })).items)
    } catch {
      // The count is a detail of the Head: without it the door still opens.
    }
  }, [api, key, seesTasks])
  const loadAssignees = useCallback(async () => {
    try {
      const people = await listAssignees(api, key)
      setTaskDialog((current) => (current ? { ...current, people: { status: 'ready', data: people } } : current))
    } catch (error) {
      setTaskDialog((current) => (current ? { ...current, people: { status: 'error', problem: taskReadProblem(error) } } : current))
    }
  }, [api, key])
  const openTask = (initial?: Partial<TaskDraft>) => {
    setTaskDialog({ people: { status: 'loading' }, ...(initial ? { initial } : {}) })
    void loadAssignees()
  }

  // ── followers (B-W2a-40) ────────────────────────────────────────────────────────────────────────────────────────────
  const [followers, setFollowers] = useState<{ data: Followers | null; problem: string | null }>({ data: null, problem: null })
  const [followersOpen, setFollowersOpen] = useState(false)
  const [followBusy, setFollowBusy] = useState(false)
  const loadFollowers = useCallback(async () => {
    if (!can.read) return
    try {
      setFollowers({ data: await readFollowers(api, key), problem: null })
    } catch (error) {
      setFollowers((current) => ({ ...current, problem: taskReadProblem(error) }))
    }
  }, [api, key, can.read])
  const follow = async (wanted: { following: boolean; muted: boolean }) => {
    setFollowBusy(true)
    try {
      setFollowers({ data: await setMyFollow(api, key, wanted), problem: null })
      base.notify({ ns: 'records', key: !wanted.following ? 'followers.notice.unfollowed' : wanted.muted ? 'followers.notice.muted' : 'followers.notice.following', tone: 'success' })
    } catch (error) {
      base.notify({ ns: 'records', key: taskWriteProblem(error).key, tone: 'danger' })
      void loadFollowers()
    } finally {
      setFollowBusy(false)
    }
  }
  const addColleague = async (userId: string) => {
    setFollowBusy(true)
    try {
      setFollowers({ data: await addFollower(api, key, userId), problem: null })
      base.notify({ ns: 'records', key: 'followers.notice.added', tone: 'success' })
    } catch (error) {
      const problem = taskWriteProblem(error)
      base.notify({ ns: 'records', key: problem.key === 'tasks.problem.invalid' ? 'followers.notice.refused' : problem.key, tone: 'danger' })
      void loadFollowers()
    } finally {
      setFollowBusy(false)
    }
  }

  useEffect(() => {
    void loadTasks()
    void loadFollowers()
  }, [loadTasks, loadFollowers])
  useLiveChanges({
    onChange: (change) => {
      if (taskChangeFor(change, key)) void loadTasks()
      if (followersChangeFor(change, key)) void loadFollowers()
    },
    onReconnect: () => {
      void loadTasks()
      void loadFollowers()
    },
  })

  // ---- B-TH-251 (PROJ.linked-F05): the projects this record is in that the reader may open (threads.read), read once and again when
  // this record is linked or unlinked; the Head's "In project: …" chip opens the first.
  const inProject = useInProject(api, key, held.has('threads.read'), companyPrefix(session.company?.code ?? ''))
  // ---- end B-TH-251

  // ── Ask a partner to approve, Share with a partner (the record panels' own containers and dialogs) ─────────────────────
  const approvals = useApprovals({ api, record: key, title: host.title, can: { view: held.has('partners.approvals.view'), ask: held.has('partners.approvals.ask') }, files: base.files, party: party ? { name: party.name, emails: [] } : null, reloadPanels: () => void base.loadThread() })
  const shares = useShares({ api, record: key, can: { view: held.has('partners.shares.view'), manage: held.has('partners.shares.manage') }, reloadPanels: () => void base.loadThread() })
  // R-8: `panel=approvals` (an old address) opens Ask once the frame says so.
  const askOnArrival = frame?.door === 'approve'
  useEffect(() => {
    if (!askOnArrival || !approvals.model) return
    approvals.actions.onAsk?.(true)
    frame?.clearDoor()
  }, [askOnArrival, approvals.model, approvals.actions, frame])

  // ── the files line, the viewer and the Files view (T2, T9, T-POP) ──────────────────────────────────────────────────────
  const strip = useStripOpen(session.user.id)
  const threadFiles = useMemo(() => recordFiles(base.files.map((file) => fromApiFile(file)), key), [base.files, key])
  const filesParty: FilesParty | null = partyId ? { id: partyId, role } : null
  const lineFiles = can.readFiles ? (base.filesRead ? threadFiles : null) : []
  const [viewer, setViewer] = useState<{ files: readonly ThreadFile[]; index: number; returnTo: HTMLElement | null } | null>(null)
  const [links, setLinks] = useState<Readonly<Record<string, { src: string | Uint8Array | null; downloadHref: string | null }>>>({})
  const asked = useRef(new Set<string>())
  const fetchLinks = useCallback(
    async (file: ThreadFile) => {
      // B-TH-231: a sheet locked for this reader is never asked for (the viewer says it cannot be opened).
      if (asked.current.has(file.id) || file.status !== 'AVAILABLE' || file.locked) return
      asked.current.add(file.id)
      try {
        const { download } = await downloadLink(api, file.id)
        const href = storeUrl(download.url)
        const pdf = file.contentType.toLowerCase() === 'application/pdf'
        const src = pdf ? await readFromStore(download) : file.contentType.toLowerCase().startsWith('image/') ? href : null
        setLinks((known) => ({ ...known, [file.id]: { src, downloadHref: href } }))
      } catch (error) {
        asked.current.delete(file.id)
        // B-TH-231 (B-TH-029): a file out of the reader's reach says so ("One file you cannot open").
        notify({ ns: 'record-thread', key: openRefusal(error), tone: 'danger' })
      }
    },
    [api, notify],
  )
  const openViewer = (files: readonly ThreadFile[], fileId: string, opener: HTMLElement | null) => {
    const list = files.filter((file) => file.status !== 'PENDING_UPLOAD' && file.status !== 'DELETED')
    const index = Math.max(0, list.findIndex((file) => file.id === fileId))
    setViewer({ files: list, index, returnTo: opener })
  }
  const current = viewer ? viewer.files[viewer.index] : undefined
  useEffect(() => {
    if (current) void fetchLinks(current)
  }, [current, fetchLinks])
  // ---- B-TH-264 follow-up (TH-6 part B): a body part's files (the shipment's Documents) open in this ONE viewer, over the files it lists.
  const filesAsk = frame?.filesAsk ?? null
  const clearFilesAsk = frame?.clearFiles
  useEffect(() => {
    if (!filesAsk) return
    const { files, index } = askedFiles(filesAsk, threadFiles, key)
    clearFilesAsk?.()
    if (files.length === 0) return
    setViewer({ files, index, returnTo: filesAsk.returnTo ?? (document.activeElement as HTMLElement | null) })
  }, [filesAsk, clearFilesAsk, threadFiles, key])
  // ---- end B-TH-264 follow-up
  const fw = useT(FILES_NS)
  const viewerFiles: ViewerFile[] = viewer ? viewer.files.map((file) => toViewerFile(file, links[file.id] ?? { src: null, downloadHref: null }, fw('locked.sheet'))) : []

  const [filesOpen, setFilesOpen] = useState(false)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [upload, setUpload] = useState<UploadAsk | null>(null)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [refused, setRefused] = useState<readonly { name: string; reason: string }[]>([])
  const [filesBusy, setFilesBusy] = useState(false)
  const [missing, setMissing] = useState<readonly MissingDocument[]>([])
  useEffect(() => {
    if (!filesOpen || !can.readFiles) return
    const controller = new AbortController()
    readDocuments(api, key, controller.signal)
      .then((docs) =>
        setMissing(
          docs.moves.flatMap((move) =>
            move.requirements
              .filter((requirement) => requirement.reason !== 'MET')
              .map((requirement) => ({ id: `${move.toStatus}:${requirement.ruleId}`, document: tf(`category.${requirement.category}`), before: tf(`status.${move.toStatus}`), level: requirement.level })),
          ),
        ),
      )
      .catch(() => setMissing([]))
    return () => controller.abort()
  }, [filesOpen, can.readFiles, api, key, tf])
  const choices = uploadChoices({ can: { share: can.share }, party: party ? { id: party.id, name: party.name, emails: [] } : null, record: { type: key.type, siteId: host.record.siteId ?? null, companyId: host.record.companyId } })

  const sendUploads = async (ask: UploadAsk, dropped: readonly File[]) => {
    setFilesBusy(true)
    const failed: { name: string; reason: string }[] = []
    for (const file of dropped) {
      const contentType = contentTypeOf(file)
      const problem = uploadProblem({ name: file.name, type: contentType, size: file.size }, ask.kind)
      if (problem) {
        failed.push({ name: file.name, reason: tr(problem.key, problem.params) })
        continue
      }
      try {
        const bytes = await file.arrayBuffer()
        const announced = await requestUpload(api, {
          companyId: host.record.companyId,
          record: key,
          kind: ask.kind,
          name: file.name,
          contentType,
          sizeBytes: file.size,
          sha256: await sha256Hex(bytes),
          visibility: ask.audience === 'OFFICE' ? ['OFFICE'] : ['OFFICE', ask.audience],
          floorSiteId: ask.audience === 'FLOOR' ? (host.record.siteId ?? null) : null,
          partyId: ask.audience === 'PARTNER' ? partyId : null,
        })
        await putToStore(announced.upload, new Blob([bytes], { type: contentType }))
        await completeUpload(api, announced.file.id)
      } catch {
        failed.push({ name: file.name, reason: tr('files.problem.failed') })
      }
    }
    setRefused(failed)
    setUpload(null)
    setUploadFiles([])
    setFilesBusy(false)
    void base.loadFiles()
  }

  const bulk = async (action: BulkAction, ids: readonly string[]) => {
    const chosen = threadFiles.filter((file) => ids.includes(file.id))
    const raw = base.files.filter((file) => ids.includes(file.id))
    if (action === 'download') {
      for (const file of chosen) {
        try {
          const { download } = await downloadLink(api, file.id)
          const anchor = document.createElement('a')
          anchor.href = storeUrl(download.url)
          anchor.rel = 'noopener'
          anchor.download = file.name
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
        } catch (error) {
          base.notify({ ns: 'record-thread', key: openRefusal(error), tone: 'danger' })
        }
      }
      return
    }
    setFilesBusy(true)
    try {
      for (const file of raw) {
        if (action === 'share' && partyId) await shareWithParty(api, file, partyId)
        else if (action === 'officeOnly') await officeOnly(api, file)
        else if (action === 'remove') await removeFile(api, file)
      }
      setSelected([])
    } catch {
      base.notify({ ns: 'record-thread', key: 'notice.failed', tone: 'danger' })
    } finally {
      setFilesBusy(false)
      void base.loadFiles()
    }
  }

  // ── B-TH-231: "Use on another record…" (a message's files, a Files view row, the chosen files) ───────────────────────────
  const emptyUseOn = (files: readonly ThreadFile[]): UseOnModel => ({ files: files.map((file) => ({ id: file.id, name: file.name })), party: party ? { name: party.name } : null, query: '', targets: null, searching: false, chosen: null, share: false, canShare: can.share, busy: false, problem: null, failed: [], copied: 0 })
  const [useOn, setUseOn] = useState<UseOnModel | null>(null)
  const useOnKeys = useRef(new Map<string, string>())
  const useOnSeq = useRef(0)
  const openUseOn = (ids: readonly string[]) => {
    const files = carriable(threadFiles.filter((file) => ids.includes(file.id)))
    if (files.length === 0) return
    useOnKeys.current = new Map()
    setUseOn(emptyUseOn(files))
  }
  const useOnQuery = useOn?.query ?? ''
  const useOnFirst = useOn?.files[0]?.id ?? null
  useEffect(() => {
    if (!useOnFirst) return
    const mine = ++useOnSeq.current
    if (!queryReady(useOnQuery)) {
      setUseOn((now) => (now ? { ...now, targets: null, searching: false } : now))
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setUseOn((now) => (now ? { ...now, searching: true } : now))
      readUseOnTargets(api, useOnFirst, useOnQuery, controller.signal)
        .then((answer) => {
          if (mine !== useOnSeq.current) return
          const targets = answer.tooShort ? null : offeredTargets(answer.targets, { recordType: key.type, recordId: key.id, partyId })
          setUseOn((now) => (now ? { ...now, targets, searching: false, chosen: targets?.some((target) => target.key === now.chosen) ? now.chosen : null } : now))
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || mine !== useOnSeq.current) return
          setUseOn((now) => (now ? { ...now, searching: false, targets: [], problem: useOnRefusal(error) } : now))
        })
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, key.type, key.id, partyId, useOnFirst, useOnQuery])
  const confirmUseOn = async () => {
    const asked = useOn
    const target = asked?.targets?.find((one) => one.key === asked.chosen)
    if (!asked || !target || asked.busy) return
    setUseOn({ ...asked, busy: true, problem: null })
    const failed: { name: string; reason: string }[] = []
    const left: { id: string; name: string }[] = []
    let copied = asked.copied
    for (const file of asked.files) {
      // One key per file and target: "Copy" again after a lost answer never copies twice.
      const keyOf = `${file.id}:${target.key}:${asked.share ? 'shared' : 'office'}`
      const idempotencyKey = useOnKeys.current.get(keyOf) ?? globalThis.crypto.randomUUID()
      useOnKeys.current.set(keyOf, idempotencyKey)
      try {
        await useFileOn(api, file.id, { recordType: target.recordType, recordId: target.recordId, share: asked.share && target.partyId !== null }, idempotencyKey)
        copied += 1
      } catch (error) {
        failed.push({ name: file.name, reason: useOnRefusal(error) })
        left.push(file)
      }
    }
    if (failed.length === 0) {
      setUseOn(null)
      base.notify({ ns: 'record-thread', key: 'notice.copied', params: { target: targetLabel(target) }, tone: 'success' })
      return
    }
    setUseOn((now) => (now ? { ...now, busy: false, files: left, failed, copied, problem: failed.length === asked.files.length && failed.every((one) => one.reason === failed[0]!.reason) ? failed[0]!.reason : null } : now))
  }
  // ── end B-TH-231

  // ── saved replies beside the box (B-TH-208; GET /templates/replies, POST …/fill from THIS record) ──────────────────────
  const mayReply = can.email && isReplyRecordType(key.type)
  const [replies, setReplies] = useState<SavedRepliesModel>({ status: isReplyRecordType(key.type) ? 'loading' : 'notForThis', replies: [], language: locale === 'en' ? 'en' : 'it' })
  const [repliesSeq, setRepliesSeq] = useState(0)
  useEffect(() => {
    if (!mayReply || !isReplyRecordType(key.type)) return
    const recordType = key.type
    const controller = new AbortController()
    setReplies((now) => ({ ...now, status: 'loading' }))
    Promise.all((['it', 'en'] as const).map((language) => listReplies(api, { language, recordType, companyId: host.record.companyId }, controller.signal)))
      .then((lists) => {
        const lines: SavedReplyLine[] = lists.flat().flatMap((reply) => (reply.language === 'it' || reply.language === 'en' ? [{ id: reply.id, name: reply.name, language: reply.language, shared: reply.shared }] : []))
        setReplies((now) => ({ ...now, status: 'ready', replies: lines }))
      })
      .catch(() => !controller.signal.aborted && setReplies((now) => ({ ...now, status: 'failed' })))
    return () => controller.abort()
  }, [api, key.type, host.record.companyId, mayReply, repliesSeq])
  const pickReply = (replyId: string) => {
    if (!isReplyRecordType(key.type)) return
    setReplies((now) => ({ ...now, filling: true, missing: [] }))
    fillReply(api, replyId, { recordType: key.type, recordId: key.id })
      .then((filled) => {
        const before = model.composer.draft.body.trim()
        actions.onDraft({ ...model.composer.draft, body: before ? `${model.composer.draft.body}\n\n${filled.body}` : filled.body }, model.composer.notes)
        setReplies((now) => ({ ...now, filling: false, missing: filled.missing }))
      })
      .catch(() => {
        setReplies((now) => ({ ...now, filling: false }))
        base.notify({ ns: 'record-thread', key: 'notice.failed', tone: 'danger' })
      })
  }

  // ── Close thread? (threads.manage) ────────────────────────────────────────────────────────────────────────────────────
  const [closing, setClosing] = useState<{ problem: string | null } | null>(null)
  const closeThread = async () => {
    const thread = base.server.thread
    if (!thread) return
    try {
      await setThreadStatus(api, key, 'CLOSED', thread.version)
      setClosing(null)
      base.notify({ ns: 'records', key: 'notice.closed', tone: 'success' })
    } catch {
      setClosing({ problem: 'close.conflict' })
    } finally {
      void base.loadThread()
      void base.loadTimeline()
    }
  }

  // ── B-TH-229: who answers the thread (B-TH-028), changed by whoever may write on it; the band's "Thread · 2 new" ──────────
  const [owning, setOwning] = useState<{ busy: boolean; problem: string | null } | null>(null)
  const pickOwner = async (ownerId: string | null) => {
    setOwning({ busy: true, problem: null })
    try {
      const owner = await setThreadOwner(api, key, ownerId)
      setOwning(null)
      base.notify(owner && ownerId ? { ns: HEAD_NS, key: 'owner.done', params: { name: owner.name }, tone: 'success' } : { ns: HEAD_NS, key: 'owner.doneRecord', tone: 'success' })
      void base.loadThread()
    } catch (error) {
      const kind = isApiError(error) ? error.kind : 'network'
      setOwning({ busy: false, problem: th(`owner.problem.${kind === 'forbidden' || kind === 'step_up' ? 'forbidden' : kind === 'invalid' ? 'invalid' : kind === 'not_found' ? 'notFound' : kind === 'network' || kind === 'unavailable' ? 'network' : 'failed'}`) })
    }
  }
  const reportNew = frame?.reportNew
  useEffect(() => reportNew?.(base.newCount), [reportNew, base.newCount])
  useEffect(() => () => reportNew?.(0), [reportNew])

  // ── the Head (T1, R-ACT) ──────────────────────────────────────────────────────────────────────────────────────────────
  const abilities: HeadAbilities = {
    task: addTaskHeld(held, true) === null,
    approve: held.has('partners.approvals.ask'),
    share: held.has('partners.shares.manage'),
    follow: can.read,
    remind: seesTasks,
    manage: can.manage,
    audit: held.has('audit.read'),
  }
  const holds = doorHolds({
    can: abilities,
    hasParty: partyId !== null,
    offline,
    shareable: takesApprovals(key.type) || takesShares(key.type),
    rights: { task: rightRef(held.has('tasks.manage') ? 'threads.post' : 'tasks.manage'), approve: rightRef('partners.approvals.ask'), share: rightRef('partners.shares.manage'), follow: rightRef('threads.read'), remind: rightRef('home.view') },
  })
  const counts: HeadModel['counts'] = {}
  if (tasks) counts.tasks = { kind: 'tasks', count: tasks.length, lines: tasks.map((task) => ({ id: task.id, label: task.title, meta: [task.assignee?.name, task.dueDate ? formatDate(task.dueDate, { locale }) : null].filter(Boolean).join(' · ') || null })) }
  const requests = approvals.model?.read.status === 'ready' ? approvals.model.read.requests.filter((request) => request.status === 'OPEN') : null
  if (requests) counts.approvals = { kind: 'approvals', count: requests.length, lines: requests.map((request) => ({ id: request.id, label: request.question || KIND_RULES[request.kind].name[locale === 'en' ? 'en' : 'it'], meta: `${request.party.name} · ${formatDate(request.dueAt, { locale })}` })) }
  const live = shares.model?.read.status === 'ready' ? shares.model.read.data.shares.filter((share) => share.state === 'LIVE') : null
  if (live) counts.partners = { kind: 'partners', count: live.length, lines: live.map((share) => ({ id: share.id, label: share.contact?.name ?? share.email, meta: formatDate(share.expiresAt, { locale }) })) }
  if (followers.data) counts.followers = { kind: 'followers', count: followers.data.count, lines: followers.data.followers.map((entry) => ({ id: entry.userId, label: entry.name, meta: tr(followReasonKey(entry.reason)) })) } satisfies CountPopoverModel
  const closed = base.closed?.at ? { by: base.closed.by, at: base.closed.at } : null
  const head: HeadModel = {
    record: host.recordLabel,
    party: party ? { name: party.name, role } : null,
    // B-TH-229: the API's one waiting rule and owner; a thread read without them (a design case) keeps the clock-time reading.
    answers: base.server.head ? answersOf(base.server.head.waiting) : whoAnswers(base.server.messages, partyId !== null),
    owner: base.server.head ? base.server.head.owner : undefined,
    ownerHeld: base.server.head ? (offline ? { key: 'held.offline' } : can.post ? null : { key: 'held.noRight', params: { right: rightRef('threads.post') } }) : undefined,
    newCount: base.newCount,
    projects: inProject, // B-TH-251
    closed,
    offline: base.offline ? { asOf: base.offline.since } : null,
    view: shown,
    views,
    counts,
    holds,
    follow: followers.data ? { following: followers.data.me.following, muted: followers.data.me.muted } : null,
    reminder: reminder.mine?.remindAt ? { at: reminder.mine.remindAt } : null,
    canManage: can.manage,
    width: frame?.width ?? null,
    compact: frame?.phone ?? false,
    print: Boolean(host.printHref),
    now: Date.now(),
  }
  const onDoor = (door: HeadDoor) => {
    const following = followers.data?.me.following ?? false
    const muted = followers.data?.me.muted ?? false
    if (door === 'task') openTask()
    else if (door === 'approve') approvals.actions.onAsk?.(true)
    else if (door === 'share') shares.actions.onInvite?.(true)
    else if (door === 'followers') setFollowersOpen((open) => !open)
    else if (door === 'follow') void follow({ following: !following, muted: false })
    else if (door === 'mute') void follow({ following: true, muted: !muted })
    else reminder.open(null)
  }

  // B-TH-231: "Use on another record…" on a message's ⋯ for a person who may add files (files.upload), online.
  const feed = feedForView({ ...model.feed, context: { ...model.feed.context, canTask: abilities.task && !offline, canUseOn: can.upload && !offline } }, shown)
  const shownModel: RecordThreadModel = { ...model, feed }
  const fileOf = (fileId: string) => threadFiles.find((file) => file.id === fileId)
  const threadActions: RecordThreadActions = {
    ...actions,
    onTask: (messageId) => {
      const message = model.feed.messages.find((item) => item.id === messageId)
      openTask(message ? { title: message.body.replace(/\s+/g, ' ').trim().slice(0, 120) } : undefined)
    },
    // A file of a message opens the ONE viewer over that message's files (else the download as before).
    onOpenFile: (fileId) => {
      const message = model.feed.messages.find((item) => item.files.some((file) => file.id === fileId))
      const files = (message?.files ?? []).flatMap((file) => {
        const known = fileOf(file.id)
        return known ? [{ ...known, messageId: message?.id ?? null }] : []
      })
      if (files.some((file) => file.id === fileId)) openViewer(files, fileId, document.activeElement as HTMLElement | null)
      else actions.onOpenFile?.(fileId)
    },
    onMoreFiles: () => setFilesOpen(true),
    // B-TH-231: the message's files the reader opens, carried to another record.
    onUseOn: (messageId) => openUseOn(model.feed.messages.find((item) => item.id === messageId)?.files.map((file) => file.id) ?? []),
  }

  const doorResults = (
    <>
      {approvals.model?.link && (
        <Banner
          tone="info"
          title={ta('link.title', { label: approvals.model.link.label })}
          action={
            <span className="fw-rt-door-actions">
              <Button size="sm" onClick={() => approvals.actions.onCopyLink?.()}>
                <Copy size={14} aria-hidden /> {ta('link.copy')}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => approvals.actions.onDismissLink?.()}>
                {ta('link.dismiss')}
              </Button>
            </span>
          }
        >
          <span className="fw-rt-door-url">{approvals.model.link.url}</span> {ta('link.once')}
        </Banner>
      )}
      {approvals.model?.notice && !approvals.model.ask && (
        <Banner tone={approvals.model.notice.tone} title={ta(approvals.model.notice.key, approvals.model.notice.params)} onDismiss={() => approvals.actions.onDismissNotice?.()} />
      )}
      {shares.model?.link && (
        <Banner
          tone="info"
          title={ts('link.title', { email: shares.model.link.email })}
          action={
            <span className="fw-rt-door-actions">
              <Button size="sm" onClick={() => shares.actions.onCopyLink?.()}>
                <Copy size={14} aria-hidden /> {ts('link.copy')}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => shares.actions.onDismissLink?.()}>
                {ts('link.dismiss')}
              </Button>
            </span>
          }
        >
          <span className="fw-rt-door-url">{shares.model.link.url}</span> {ts('link.once')}
        </Banner>
      )}
      {shares.model?.notice && !shares.model.invite && <Banner tone={shares.model.notice.tone} title={ts(shares.model.notice.key, shares.model.notice.params)} onDismiss={() => shares.actions.onDismissNotice?.()} />}
    </>
  )
  const hasResults = Boolean(approvals.model?.link || (approvals.model?.notice && !approvals.model.ask) || shares.model?.link || (shares.model?.notice && !shares.model.invite))

  const headSlot = (
    <>
      <RecordThreadHead
        model={head}
        actions={{
          onDoor,
          onView: setView,
          onWidth: (choice) => frame?.choose(choice),
          onPrint: () => host.printHref && window.open(host.printHref, '_blank', 'noopener'),
          onCloseThread: () => setClosing({ problem: null }),
          onReopen: () => actions.onReopen?.(),
          onOwner: () => setOwning({ busy: false, problem: null }),
        }}
      />
      {followersOpen && followers.data && (
        <div className="fw-rt-door">
          <FollowersControl
            model={{ followers: { count: followers.data.count, me: followers.data.me, list: followers.data.followers.map((entry) => ({ userId: entry.userId, name: entry.name, me: entry.me, reason: entry.reason, muted: entry.muted, since: entry.since, addedBy: entry.addedBy?.name ?? null })), candidates: base.people.filter((person) => person.id !== session.user.id && !followers.data!.followers.some((entry) => entry.userId === person.id)), canAdd: can.post, problem: followers.problem, busy: followBusy, open: true } } as unknown as RecordPanelsViewModel}
            actions={{ onFollow: (wanted) => void follow(wanted), onAddFollower: (userId) => void addColleague(userId), onRetry: () => void loadFollowers() } satisfies RecordPanelsActions}
          />
        </div>
      )}
      {hasResults && <div className="fw-rt-door">{doorResults}</div>}
    </>
  )

  const filesLine =
    lineFiles === null || lineFiles.length > 0 ? (
      <FileStrip
        model={{ files: lineFiles, party: filesParty, open: strip.open }}
        actions={{ onToggle: strip.toggle, onOpen: (fileId, opener) => openViewer(latestOf(threadFiles), fileId, opener), onAllFiles: () => setFilesOpen(true) }}
      />
    ) : null

  const overlays = (
    <>
      {viewer && (
        <FileViewer
          files={viewerFiles}
          index={viewer.index}
          onIndex={(index) => setViewer((now) => (now ? { ...now, index } : now))}
          onClose={() => setViewer(null)}
          returnFocusTo={viewer.returnTo}
          onGoToMessage={(messageId) => {
            setViewer(null)
            setFilesOpen(false)
            const target = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
            target?.scrollIntoView({ block: 'center' })
            target?.focus()
          }}
        />
      )}
      {filesOpen && (
        <FilesView
          model={{
            record: { type: key.type, id: key.id, label: host.recordLabel },
            party: party && partyId ? { id: partyId, role, name: party.name } : null,
            files: lineFiles,
            problem: can.readFiles ? null : 'forbidden',
            can: { upload: can.upload, share: can.share, delete: held.has('files.delete') },
            uploadHeld: !can.upload ? tv('upload.noRight') : null,
            selected,
            refused,
            missing,
            upload,
            busy: filesBusy,
            now: Date.now(),
          }}
          actions={{
            onClose: () => setFilesOpen(false),
            onRetry: () => void base.loadFiles(),
            onSelect: setSelected,
            onOpen: (fileId, opener) => openViewer(latestOf(threadFiles), fileId, opener),
            onRestore: (fileId) =>
              void restoreVersion(api, fileId)
                .catch(() => base.notify({ ns: 'record-thread', key: 'notice.failed', tone: 'danger' }))
                .finally(() => void base.loadFiles()),
            onBulk: (action, ids) => void bulk(action, ids),
            onDrop: (dropped) => {
              setUploadFiles(dropped)
              setUpload({ files: dropped.map((file) => ({ name: file.name, sizeBytes: file.size })), kind: (choices.kinds.includes('ATTACHMENT') ? 'ATTACHMENT' : choices.kinds[0]) as FileKind, audience: START_AUDIENCE as UploadAsk['audience'], kinds: choices.kinds, audiences: choices.audiences })
            },
            onUploadChange: (change) => setUpload((ask) => (ask ? { ...ask, ...change } : ask)),
            onUploadConfirm: () => upload && void sendUploads(upload, uploadFiles),
            onUploadCancel: () => {
              setUpload(null)
              setUploadFiles([])
            },
            onDismissRefused: () => setRefused([]),
            // B-TH-231: one row's file, or the chosen ones.
            onUseOn: (ids) => openUseOn(ids),
          }}
        />
      )}
      {useOn && (
        <UseOnDialog
          model={useOn}
          actions={{
            onQuery: (query) => setUseOn((now) => (now ? { ...now, query, problem: null } : now)),
            onChoose: (choice) => setUseOn((now) => (now ? { ...now, chosen: choice, problem: null } : now)),
            onShare: (share) => setUseOn((now) => (now ? { ...now, share } : now)),
            onConfirm: () => void confirmUseOn(),
            onClose: () => setUseOn(null),
          }}
        />
      )}
      {taskDialog && (
        <TaskNewDialog
          recordLabel={host.recordLabel}
          people={taskDialog.people}
          me={session.user.id}
          busy={taskBusy}
          held={offline ? tr('tasks.held.offline') : null}
          {...(taskDialog.initial ? { initial: taskDialog.initial } : {})}
          onRetryPeople={() => void loadAssignees()}
          onCreate={async (draft) => {
            setTaskBusy(true)
            try {
              await createTask(api, createBody(draft, key))
              base.notify({ ns: 'records', key: 'tasks.notice.created', tone: 'success' })
              setTaskDialog(null)
              void loadTasks()
              void loadFollowers()
              return true
            } catch (error) {
              base.notify({ ns: 'records', key: taskWriteProblem(error).key, tone: 'danger' })
              return false
            } finally {
              setTaskBusy(false)
            }
          }}
          onClose={() => setTaskDialog(null)}
        />
      )}
      {approvals.model?.ask && <AskDialog model={approvals.model} actions={approvals.actions} />}
      {shares.model?.invite && <InviteDialog model={shares.model} actions={shares.actions} />}
      {closing && <CloseThreadConfirm record={host.recordLabel} party={party?.name ?? null} problem={closing.problem} onClose={() => void closeThread()} onCancel={() => setClosing(null)} />}
      {owning && (
        <OwnerDialog
          model={{ record: host.recordLabel, owner: base.server.head?.owner ?? null, people: base.people, peopleState: base.peopleState, meId: session.user.id, busy: owning.busy, problem: owning.problem }}
          onPick={(ownerId) => void pickOwner(ownerId)}
          onClose={() => setOwning(null)}
          onRetry={() => void base.loadPeople()}
        />
      )}
      {reminder.dialog}
    </>
  )

  const helpers = mayReply ? <SavedReplies model={{ ...replies, held: offline ? th('held.offline') : null }} onPick={pickReply} onRetry={() => setRepliesSeq((value) => value + 1)} /> : null

  return <RecordThread model={shownModel} actions={threadActions} remind={remind} slots={{ head: headSlot, filesLine, helpers, overlays }} />
}
