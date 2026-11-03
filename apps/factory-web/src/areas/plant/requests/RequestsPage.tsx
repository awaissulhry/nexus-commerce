'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { formatDateTime } from '../../../lib/i18n/format'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import {
  acknowledgeRequest,
  closeRequest,
  getMachine,
  listMachines,
  listSymptoms,
  makeJobOfRequest,
  photoAddress,
  plantPlaces,
  plantTechnicians,
  reportProblem,
  requestTiles,
  signSafe,
  uploadRequestPhoto,
  type RequestTiles,
} from '../_shared/api'
import { downloadText, isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../_shared/hooks'
import { csvText, instantOf, isRequestEvent, labelOf, personWords, plantCan, readProblem, requestsAddressOf, requestsAddressText, requestsQuery, TIME_ZONE, type RequestsAddress } from '../_shared/model'
import { PlantMessages, useWords, type Notice } from '../_shared/parts'
import { confirmWorks, getDeepRequest, listDeepRequests, lockAsUnsafe, mergeRequests, readDuplicates, readLocks, sayOnTheWay, type DeepRequest, type DeepRequestRecord, type MachineLock } from './depth/api'
import { depthProblemOf, groupOfDuplicates, mediaViews, mergeBody, mergeDraftOf, routedWords, type MergeGroup } from './depth/model'
import type { RequestDetailModel, RequestDialog, RequestRows, RequestsListModel, SectionRead, SiteChoice } from './view-model'
import { RequestsView } from './view/RequestsView'

/**
 * `/w/<company>/plant/requests` (SCR-148): the queue of the address (`?view=` a saved row, `?tile=` a tile pressed,
 * `?site=`), the tiles, live changes ("N new · Show"; an unsafe report reads everything at once), the request open in its
 * detail (`?open=`), and the decisions: acknowledge, make a job (or add it to the machine's open job), close without a
 * job, sign safe (a fresh code), Report a problem (`?report=1`, `&machine=` from a machine's record). After a decision
 * that takes the request out of the queue, the next request opens by itself. B-W2b-140: the machines locked now (always
 * first: GET /plant/requests/locks), the possible duplicates (GET /plant/requests/duplicates) and Merge requests, Lock as
 * unsafe, the requester's progress (on the way, it works again), photos and voice notes, routing and escalation.
 */
export function RequestsPage() {
  // The container speaks too (a notice's words, the CSV's header): the plant catalogue around it, not only its view.
  return (
    <PlantMessages>
      <RequestsContainer />
    </PlantMessages>
  )
}

const QUEUE = 200
const PAGE = 50

/** What a step's answer says of its request (acknowledge answers W2a's request, on the way and it works the deep one). */
type StepRequest = { id: string; machine: { assetNumber: string } }

function RequestsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => plantCan(session.permissions), [session.permissions])
  const address = useMemo(() => requestsAddressOf(params), [params])
  const { view, tile, siteId } = address

  const go = useCallback((next: Partial<RequestsAddress>) => router.replace(`${pathname}${requestsAddressText({ ...address, ...next })}`, { scroll: false }), [router, pathname, address])

  const [sites, setSites] = useState<SiteChoice[]>([])
  useEffect(() => {
    if (!can.view) return
    plantPlaces(api)
      .then((found) => setSites(found.map((site) => ({ id: site.id, code: site.code, name: site.name }))))
      .catch(() => setSites([]))
  }, [api, can.view])

  // ---- the machines locked now (first on the page) and the possible duplicates -------------------------------------------
  const [locks, setLocks] = useState<SectionRead<MachineLock>>({ items: null, problem: null })
  const [duplicates, setDuplicates] = useState<SectionRead<MergeGroup>>({ items: null, problem: null })
  const locksRead = useRef(0)
  const dupesRead = useRef(0)
  const loadLocks = useCallback(async () => {
    if (!can.view) return
    const id = ++locksRead.current
    try {
      const items = await readLocks(api, siteId)
      if (id === locksRead.current) setLocks({ items, problem: null })
    } catch (error) {
      if (id === locksRead.current) setLocks({ items: null, problem: readProblem(error) })
    }
  }, [api, can.view, siteId])
  const loadDuplicates = useCallback(async () => {
    if (!can.view) return
    const id = ++dupesRead.current
    try {
      const groups = await readDuplicates(api, siteId)
      if (id === dupesRead.current) setDuplicates({ items: groups.map(groupOfDuplicates), problem: null })
    } catch (error) {
      if (id === dupesRead.current) setDuplicates({ items: null, problem: readProblem(error) })
    }
  }, [api, can.view, siteId])
  useEffect(() => {
    setLocks({ items: null, problem: null })
    setDuplicates({ items: null, problem: null })
    void loadLocks()
    void loadDuplicates()
  }, [loadLocks, loadDuplicates])

  // ---- the queue and the tiles -------------------------------------------------------------------------------------------
  const [rows, setRows] = useState<RequestRows>({ items: null, truncated: false, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [tiles, setTiles] = useState<RequestTiles | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const readId = useRef(0)
  const query = useMemo(() => requestsQuery({ view, tile, siteId }), [view, tile, siteId])
  const queued = query.open === true || query.tile !== undefined

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const page = await listDeepRequests(api, { ...query, limit: queued ? QUEUE : PAGE })
      const counted = await requestTiles(api, siteId).catch(() => null)
      if (id !== readId.current) return
      setRows({ items: page.requests, truncated: page.truncated, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setTiles(counted)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, truncated: false, more: false, problem: readProblem(error) })
      setTiles(null)
    }
  }, [api, can.view, query, queued, siteId])

  useEffect(() => {
    setRows({ items: null, truncated: false, more: false, problem: null })
    void load()
  }, [load])

  /** The queue, the locks and the duplicates again (after a decision). */
  const loadAll = useCallback(() => {
    void load()
    void loadLocks()
    void loadDuplicates()
  }, [load, loadLocks, loadDuplicates])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listDeepRequests(api, { ...query, cursor, limit: PAGE })
      setRows((current) => ({ ...current, items: [...(current.items ?? []), ...page.requests.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: depthProblemOf(error) })
    }
  }, [api, cursor, query])

  // ---- the open request --------------------------------------------------------------------------------------------------
  const [detail, setDetail] = useState<RequestDetailModel | null>(null)
  const detailRead = useRef(0)
  const loadDetail = useCallback(
    async (id: string) => {
      const read = ++detailRead.current
      setDetail((current) => (current && current.id === id ? current : { id, loaded: { status: 'loading' }, media: [], lightbox: null, busy: false, problem: null }))
      try {
        const record = await getDeepRequest(api, id)
        if (read !== detailRead.current) return
        setDetail((current) => ({ id, loaded: { status: 'ready', value: record }, media: mediaViews(record.files, current?.id === id ? current.media : []), lightbox: null, busy: false, problem: current?.id === id ? current.problem : null }))
        // The addresses one after another (parallel reads made the shared database busy: 503).
        if (can.readFiles) {
          for (const file of record.files) {
            if (read !== detailRead.current) return
            try {
              const src = await photoAddress(api, file.id)
              setDetail((current) => (current && current.id === id ? { ...current, media: current.media.map((entry) => (entry.id === file.id ? { ...entry, src } : entry)) } : current))
            } catch {
              // Said on screen: "couldn't be shown".
            }
          }
        }
      } catch (error) {
        if (read !== detailRead.current) return
        const status = isApiError(error) && error.kind === 'not_found' ? 'notFound' : isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'error'
        setDetail({ id, loaded: status === 'error' ? { status, problem: readProblem(error) } : { status }, media: [], lightbox: null, busy: false, problem: null })
      }
    },
    [api, can.readFiles],
  )
  useEffect(() => {
    if (!address.open || !can.view) {
      detailRead.current += 1
      setDetail(null)
      return
    }
    void loadDetail(address.open)
  }, [address.open, can.view, loadDetail])

  const record: DeepRequestRecord | null = detail?.loaded.status === 'ready' ? detail.loaded.value : null

  // ---- live ----------------------------------------------------------------------------------------------------------------
  const refreshTiles = useCoalesced(() => {
    requestTiles(api, siteId)
      .then(setTiles)
      .catch(() => undefined)
  }, 1000)
  const refreshNow = useCoalesced(() => void load(), 500)
  const refreshLocks = useCoalesced(() => void loadLocks(), 300)
  const refreshDuplicates = useCoalesced(() => void loadDuplicates(), 1500)
  const live = useLive(
    (change) => {
      if (!isRequestEvent(change.type)) return
      refreshTiles()
      refreshDuplicates()
      // A lock raises its banner at once; a sign-safe takes it down (design: "unsafe → Banner at once").
      if (change.type === 'maintenance_request.locked' || change.type === 'maintenance_request.signed_safe' || change.type === 'machine.status_changed' || (change.type === 'maintenance_request.reported' && change.fields.unsafe === true)) refreshLocks()
      if (change.type === 'maintenance_request.reported') {
        // An unsafe report raises the banner and the row at once; any other waits behind "N new · Show".
        if (change.fields.unsafe === true) refreshNow()
        else setUpdates((count) => count + 1)
      }
      // An escalation changes the Age tone (design live "request.escalated → Age tone"): the rows quietly again.
      if (change.type === 'maintenance_request.escalated') refreshNow()
      const open = address.open
      if (open && (change.fields.requestId === open || (record && change.fields.machineId === record.request.machine.id))) void loadDetail(open)
    },
    () => loadAll(),
    can.view,
  )

  // ---- the dialogs ---------------------------------------------------------------------------------------------------------
  const [dialog, setDialog] = useState<RequestDialog | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const t = useWords()

  const nextAfter = useCallback(
    (id: string): string | null => {
      const items = rows.items ?? []
      const at = items.findIndex((row) => row.id === id)
      const after = items.slice(at + 1).find((row) => row.status === 'NEW' || row.status === 'ACKNOWLEDGED')
      const before = items.slice(0, Math.max(0, at)).find((row) => row.status === 'NEW' || row.status === 'ACKNOWLEDGED')
      return (after ?? before)?.id ?? null
    },
    [rows.items],
  )

  /** A decision went through: the queue, the locks and the duplicates again; the next request opens when this one left the queue. */
  const decided = useCallback(
    (request: { id: string }, words: Notice['words'], leaves: boolean) => {
      setDialog(null)
      setNotice({ tone: 'success', words })
      loadAll()
      if (leaves) {
        const next = nextAfter(request.id)
        go({ open: next })
      } else void loadDetail(request.id)
    },
    [go, loadAll, loadDetail, nextAfter],
  )

  const dialogOpen = useRef(false)
  dialogOpen.current = dialog !== null
  /** A refused decision: in the dialog when one is open, else in the detail (or the page's notice). */
  const failed = useCallback((error: unknown) => {
    const words = depthProblemOf(error)
    setDialog((current) => (current ? { ...current, busy: false, problem: words } : current))
    setDetail((current) => (current ? { ...current, busy: false, problem: dialogOpen.current ? current.problem : words } : current))
  }, [])

  /** One step of the open request without a dialog (acknowledge, on the way, it works). */
  const step = useCallback(
    async (run: (request: DeepRequest) => Promise<{ request: StepRequest }>, words: (request: StepRequest) => Notice['words']) => {
      if (!record) return
      setDetail((current) => (current ? { ...current, busy: true, problem: null } : current))
      try {
        const answer = await run(record.request)
        decided(answer.request, words(answer.request), false)
      } catch (error) {
        failed(error)
      }
    },
    [record, decided, failed],
  )

  const openMakeJob = useCallback(() => {
    if (!record) return
    const request = record.request
    const symptom = request.symptom ? labelOf(request.symptom, locale) : null
    const problem = [symptom, request.description?.trim() || null].filter(Boolean).join(': ') || t('makeJob.defaultProblem')
    const openJob = record.card.openJob ? { id: record.card.openJob.id, number: record.card.openJob.number } : null
    setDialog({
      kind: 'makeJob',
      draft: { mode: openJob ? 'join' : 'new', type: request.unsafe ? 'SAFETY' : 'CORRECTIVE', problem, priority: request.unsafe || request.machine.status === 'DOWN' ? 'P1' : 'P2', assignee: '', due: '', plan: false },
      technicians: null,
      floorListed: false,
      techniciansProblem: null,
      openJob,
      busy: false,
      problem: null,
    })
    plantTechnicians(api, request.siteId)
      .then((answer) => setDialog((current) => (current?.kind === 'makeJob' ? { ...current, technicians: answer.technicians, floorListed: answer.floorListed } : current)))
      .catch((error: unknown) => setDialog((current) => (current?.kind === 'makeJob' ? { ...current, technicians: [], techniciansProblem: isApiError(error) && error.kind === 'forbidden' ? 'field.assigneeNoRight' : readProblem(error) } : current)))
  }, [api, record, locale, t])

  const openClose = useCallback(() => {
    if (!record) return
    setDialog({ kind: 'close', draft: { reason: null, note: '', keepDown: false }, machineDown: record.card.machine.status === 'DOWN', busy: false, problem: null })
  }, [record])

  const openSignSafe = useCallback(() => {
    if (!record) return
    setDialog({ kind: 'signSafe', draft: { note: '', machineAfter: null }, busy: false, problem: null })
  }, [record])

  const lockKey = useRef<string | null>(null)
  const openLock = useCallback(() => {
    if (!record) return
    lockKey.current = newIdempotencyKey()
    setDialog({ kind: 'lock', note: '', busy: false, problem: null })
  }, [record])

  const openMerge = useCallback((group: MergeGroup, target?: string | null) => setDialog({ kind: 'mergeMany', group, draft: mergeDraftOf(group, target ?? null), busy: false, problem: null }), [])

  // ---- Report a problem ------------------------------------------------------------------------------------------------------
  const reportKey = useRef<string | null>(null)
  useEffect(() => {
    if (!address.report || !can.view) {
      setDialog((current) => (current?.kind === 'report' ? null : current))
      return
    }
    reportKey.current = newIdempotencyKey()
    setDialog({ kind: 'report', draft: { query: '', machine: null, symptomId: null, description: '', unsafe: false, down: true, photo: null, photoStep: false }, found: null, searching: false, symptoms: null, busy: false, problem: null })
    if (address.machineId) {
      getMachine(api, address.machineId)
        .then((machine) => setDialog((current) => (current?.kind === 'report' ? { ...current, draft: { ...current.draft, machine: machine.card.machine, query: machine.card.machine.assetNumber }, found: [machine.card.machine] } : current)))
        .catch(() => undefined)
    }
  }, [address.report, address.machineId, api, can.view])

  const reportMachine = dialog?.kind === 'report' ? dialog.draft.machine : null
  useEffect(() => {
    if (!reportMachine) return
    const controller = new AbortController()
    setDialog((current) => (current?.kind === 'report' ? { ...current, symptoms: null } : current))
    listSymptoms(api, reportMachine.class.id, controller.signal)
      .then((symptoms) => setDialog((current) => (current?.kind === 'report' ? { ...current, symptoms } : current)))
      .catch(() => setDialog((current) => (current?.kind === 'report' ? { ...current, symptoms: [] } : current)))
    return () => controller.abort()
  }, [api, reportMachine])

  const findMachine = useCallback(
    (text: string) => {
      if (text.trim().length < 1) {
        setDialog((current) => (current?.kind === 'report' ? { ...current, found: null } : current))
        return
      }
      setDialog((current) => (current?.kind === 'report' ? { ...current, searching: true } : current))
      listMachines(api, { q: text, limit: 20 })
        .then((answer) => setDialog((current) => (current?.kind === 'report' ? { ...current, found: answer.machines, searching: false, draft: answer.machines.length === 1 && !current.draft.machine ? { ...current.draft, machine: answer.machines[0]! } : current.draft } : current)))
        .catch(() => setDialog((current) => (current?.kind === 'report' ? { ...current, found: [], searching: false } : current)))
    },
    [api],
  )

  // ---- submit ----------------------------------------------------------------------------------------------------------------
  const signKey = useRef<string | null>(null)
  const submitDialog = useCallback(async () => {
    if (!dialog || dialog.busy) return
    setDialog({ ...dialog, busy: true, problem: null } as RequestDialog)
    try {
      if (dialog.kind === 'report') {
        const draft = dialog.draft
        const answer = await reportProblem(
          api,
          {
            machineId: draft.machine!.id,
            ...(draft.symptomId ? { symptomId: draft.symptomId } : {}),
            ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
            ...(draft.unsafe ? { unsafe: true } : {}),
            down: draft.down,
          },
          reportKey.current ?? newIdempotencyKey(),
        )
        let photoFailed = false
        if (draft.photo) {
          try {
            await uploadRequestPhoto(api, answer.request, draft.photo.marked ?? draft.photo.photo, `${answer.request.machine.assetNumber}.jpg`)
          } catch {
            photoFailed = true
          }
        }
        setDialog(null)
        setNotice({ tone: photoFailed ? 'warning' : 'success', words: { key: answer.request.unsafe ? 'done.reportedUnsafe' : 'done.reported', params: { machine: answer.request.machine.assetNumber } }, detail: photoFailed ? { key: 'done.photoFailed' } : null })
        loadAll()
        go({ report: false, machineId: null, open: answer.request.id })
        return
      }
      if (dialog.kind === 'mergeMany') {
        const body = mergeBody(dialog.group, dialog.draft)
        const answer = await mergeRequests(api, body)
        const target: Notice['words'] = answer.job ? { key: 'done.mergedIntoJob', params: { count: answer.requests.length, number: answer.job.number } } : { key: 'done.mergedMany', params: { count: answer.requests.length, machine: dialog.group.machine.assetNumber } }
        const open = record?.request.id ?? null
        if (open) decided({ id: open }, target, body.requests.some((entry) => entry.id === open))
        else {
          setDialog(null)
          setNotice({ tone: 'success', words: target })
          loadAll()
        }
        return
      }
      if (!record) return
      const request = record.request
      if (dialog.kind === 'makeJob') {
        const draft = dialog.draft
        const [kind, id] = draft.assignee.split(':') as [string, string | undefined]
        const body =
          draft.mode === 'join' && dialog.openJob
            ? { version: request.version, jobId: dialog.openJob.id }
            : {
                version: request.version,
                type: draft.type,
                problem: draft.problem.trim(),
                priority: draft.priority,
                assigneeId: kind === 'USER' ? (id ?? null) : null,
                assigneeWorkerId: kind === 'WORKER' ? (id ?? null) : null,
                dueAt: instantOf(draft.due, TIME_ZONE),
                ...(draft.plan ? { plan: true } : {}),
              }
        const answer = await makeJobOfRequest(api, request.id, body)
        decided(answer.request, { key: draft.mode === 'join' ? 'done.joined' : 'done.jobMade', params: { number: answer.job?.number ?? answer.request.job?.number ?? '—' } }, true)
      } else if (dialog.kind === 'close') {
        const draft = dialog.draft
        const answer = await closeRequest(api, request.id, { version: request.version, reason: draft.reason!, ...(draft.note.trim() ? { note: draft.note.trim() } : {}), ...(dialog.machineDown && draft.keepDown ? { keepDown: true } : {}) })
        decided(answer.request, { key: 'done.closed', params: { machine: answer.request.machine.assetNumber } }, true)
      } else if (dialog.kind === 'lock') {
        lockKey.current = lockKey.current ?? newIdempotencyKey()
        const answer = await lockAsUnsafe(api, request.id, { version: request.version, ...(dialog.note.trim() ? { note: dialog.note.trim() } : {}) }, lockKey.current)
        lockKey.current = null
        setDialog(null)
        setNotice({ tone: 'warning', words: { key: answer.joined ? 'done.lockedJoined' : 'done.locked', params: { machine: answer.machine.assetNumber } } })
        loadAll()
        go({ open: answer.lock.id })
      } else if (dialog.kind === 'signSafe') {
        signKey.current = signKey.current ?? newIdempotencyKey()
        const key = signKey.current
        const draft = dialog.draft
        const answer = await guard('stepUp.sentence.signSafe', () => signSafe(api, request.id, { version: request.version, note: draft.note.trim(), ...(draft.machineAfter ? { machineAfter: draft.machineAfter } : {}) }, key))
        signKey.current = null
        decided(answer.request, { key: 'done.signedSafe', params: { machine: answer.machine.assetNumber, status: t(`machineStatus.${answer.machine.status}`) } }, false)
      }
    } catch (error) {
      if (isStepUpCancelled(error)) {
        setDialog((current) => (current ? { ...current, busy: false } : current))
        return
      }
      if (dialog.kind === 'signSafe') signKey.current = null
      failed(error)
    }
  }, [dialog, api, record, decided, failed, guard, go, loadAll, t])

  // ---- bulk, export ----------------------------------------------------------------------------------------------------------
  const [busy, setBusy] = useState(false)
  const acknowledgeMany = useCallback(
    async (ids: readonly string[]) => {
      if (busy || ids.length === 0) return
      setBusy(true)
      let done = 0
      let refused = 0
      for (const id of ids) {
        const row = rows.items?.find((entry) => entry.id === id)
        if (!row) continue
        try {
          await acknowledgeRequest(api, row.id, row.version)
          done += 1
        } catch {
          refused += 1
        }
      }
      setBusy(false)
      setNotice({ tone: refused > 0 ? 'warning' : 'success', words: { key: 'done.acknowledgedMany', params: { count: done } }, detail: refused > 0 ? { key: 'done.refusedMany', params: { count: refused } } : null })
      void load()
    },
    [api, busy, rows.items, load],
  )

  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const place = { locale, timeZone: TIME_ZONE }
      const header = ['reportedAt', 'site', 'machine', 'class', 'symptom', 'words', 'unsafe', 'station', 'reportedBy', 'photos', 'voiceNotes', 'duplicates', 'routedTo', 'escalation', 'state', 'job'].map((column) => t(`csv.${column}`))
      const lines = picked.map((row) => {
        const routed = routedWords(row.routing)
        return [
          formatDateTime(row.reportedAt, place),
          sites.find((site) => site.id === row.siteId)?.code ?? '',
          row.machine.assetNumber,
          labelOf(row.machine.class, locale),
          row.symptom ? labelOf(row.symptom, locale) : '',
          row.description ?? '',
          row.unsafe ? t('common.yes') : t('common.no'),
          row.station?.code ?? '',
          personWords(t, row.reportedBy),
          row.photos,
          row.voiceNotes,
          row.duplicates,
          t(routed.key, routed.params),
          row.routing.escalationLevel,
          t(`requestStatus.${row.status}`),
          row.job?.number ?? '',
        ]
      })
      downloadText(`machine-requests-${new Date().toISOString().slice(0, 10)}.csv`, csvText(header, lines))
    },
    [rows.items, sites, locale, t],
  )

  const model: RequestsListModel = { prefix, can, address: { view, tile, siteId }, sites, rows, locks, duplicates, tiles, asOf, live, updates, timeZone: TIME_ZONE, detail, dialog, stepUp, notice, busy }

  return (
    <RequestsView
      model={model}
      actions={{
        onView: (next) => go({ view: next, tile: null }),
        onTile: (next) => go({ tile: next }),
        onSite: (next) => go({ siteId: next }),
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: () => void load(),
        onOpen: (id) => {
          setDialog(null)
          go({ open: id })
        },
        onRetryDetail: () => address.open && void loadDetail(address.open),
        onPhoto: (index) => setDetail((current) => (current ? { ...current, lightbox: index !== null && index < 0 ? null : index } : current)),
        onAcknowledge: () => void step((request) => acknowledgeRequest(api, request.id, request.version), (request) => ({ key: 'done.acknowledged', params: { machine: request.machine.assetNumber } })),
        onMakeJob: openMakeJob,
        onClose: openClose,
        onSignSafe: openSignSafe,
        onRetryLocks: () => void loadLocks(),
        onRetryDuplicates: () => void loadDuplicates(),
        onMergeGroup: openMerge,
        onMergeDraft: (draft) => setDialog((current) => (current?.kind === 'mergeMany' ? { ...current, draft, problem: null } : current)),
        onLock: openLock,
        onLockNote: (note) => setDialog((current) => (current?.kind === 'lock' ? { ...current, note } : current)),
        onOnTheWay: () => void step((request) => sayOnTheWay(api, request.id, request.version), (request) => ({ key: 'done.onTheWay', params: { machine: request.machine.assetNumber } })),
        onWorks: () => void step((request) => confirmWorks(api, request.id, request.version), (request) => ({ key: 'done.works', params: { machine: request.machine.assetNumber } })),
        onDialogClose: () => {
          if (dialog?.kind === 'report') go({ report: false, machineId: null })
          setDialog(null)
        },
        onMakeJobDraft: (patch) => setDialog((current) => (current?.kind === 'makeJob' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onCloseDraft: (patch) => setDialog((current) => (current?.kind === 'close' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onSignSafeDraft: (patch) => setDialog((current) => (current?.kind === 'signSafe' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onReportDraft: (patch) => setDialog((current) => (current?.kind === 'report' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onSubmitDialog: () => void submitDialog(),
        onReport: () => go({ report: true, open: null }),
        onFindMachine: findMachine,
        onSubmitStepUp: (code) => void submitStepUp(code),
        onCancelStepUp: cancelStepUp,
        onAcknowledgeMany: (ids) => void acknowledgeMany(ids),
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
