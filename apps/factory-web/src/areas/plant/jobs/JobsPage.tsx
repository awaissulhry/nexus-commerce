'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { formatDateTime } from '../../../lib/i18n/format'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { assignJobs, createJob, getMachine, jobTiles, listJobs, listMachines, moveJob, plantPlaces, plantTechnicians, updateJob, type JobChange, type JobMove, type JobTiles, type MaintenanceJob } from '../_shared/api'
import { downloadText, useCoalesced, useLive } from '../_shared/hooks'
import { assigneeFields, assigneeWords, csvText, instantOf, isJobEvent, jobsAddressOf, jobsAddressText, jobsQuery, labelOf, plantCan, problemOf, readProblem, TIME_ZONE, type JobsAddress } from '../_shared/model'
import { getDeepJob, handBackJob } from '../requests/depth/api'
import { closeBody, closeDraftOf, depthProblemOf } from '../requests/depth/model'
import { PlantMessages, useWords, type Notice } from '../_shared/parts'
import type { CellState, JobRows, JobsDialog, JobsListModel, SiteChoice, TechniciansBySite } from './view-model'
import { JobsView } from './view/JobsView'

/**
 * `/w/<company>/plant/jobs` (SCR-149): the saved row (`?view=`), the site (`?site=`), one machine (`?machine=`), list or
 * board (`?mode=board`), New job (`?new=1`); pages of 50 with "Show more"; the tiles; live job changes behind "N updates ·
 * Show" (the tiles follow at once). Inline priority, due and technician autosave with the job's version; a board move is
 * the job's own move (plan, start, wait, reopen, close); a drop on Hand-back opens the Hand back dialog (B-W2b-140: the
 * one-screen close over the board, the job's record read as it opens).
 */
export function JobsPage() {
  // The container speaks too (the CSV's header, a notice's words): the plant catalogue around it, not only its view.
  return (
    <PlantMessages>
      <JobsContainer />
    </PlantMessages>
  )
}

const PAGE = 50

function JobsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const t = useWords()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => plantCan(session.permissions), [session.permissions])
  const address = useMemo(() => jobsAddressOf(params), [params])
  const { view, siteId, machineId, mode } = address

  const go = useCallback((next: Partial<JobsAddress>) => router.replace(`${pathname}${jobsAddressText({ ...address, ...next })}`, { scroll: false }), [router, pathname, address])

  const [sites, setSites] = useState<SiteChoice[]>([])
  useEffect(() => {
    if (!can.view) return
    plantPlaces(api)
      .then((found) => setSites(found.map((site) => ({ id: site.id, code: site.code, name: site.name }))))
      .catch(() => setSites([]))
  }, [api, can.view])

  const [machine, setMachine] = useState<{ id: string; assetNumber: string } | null>(null)
  useEffect(() => {
    if (!machineId || !can.view) {
      setMachine(null)
      return
    }
    getMachine(api, machineId)
      .then((answer) => setMachine({ id: answer.card.machine.id, assetNumber: answer.card.machine.assetNumber }))
      .catch(() => setMachine(null))
  }, [api, machineId, can.view])

  // ---- rows and tiles -----------------------------------------------------------------------------------------------------
  const [rows, setRows] = useState<JobRows>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [tiles, setTiles] = useState<JobTiles | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [opened] = useState(() => new Date().toISOString())
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const readId = useRef(0)
  const query = useMemo(() => jobsQuery({ view, siteId, machineId }), [view, siteId, machineId])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const page = await listJobs(api, { ...query, limit: mode === 'board' ? 200 : PAGE })
      const counted = await jobTiles(api, siteId).catch(() => null)
      if (id !== readId.current) return
      setRows({ items: page.jobs, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setTiles(counted)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
      setTiles(null)
    }
  }, [api, can.view, query, siteId, mode])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listJobs(api, { ...query, cursor, limit: PAGE })
      setRows((current) => ({ items: [...(current.items ?? []), ...page.jobs.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: problemOf(error) })
    }
  }, [api, cursor, query])

  const refreshTiles = useCoalesced(() => {
    jobTiles(api, siteId)
      .then(setTiles)
      .catch(() => undefined)
  }, 1000)
  const live = useLive(
    (change) => {
      if (!isJobEvent(change.type)) return
      setUpdates((count) => count + 1)
      refreshTiles()
    },
    () => void load(),
    can.view,
  )

  // ---- technicians per site -------------------------------------------------------------------------------------------------
  const [technicians, setTechnicians] = useState<TechniciansBySite>({})
  const asked = useRef(new Set<string>())
  const needTechnicians = useCallback(
    (site: string) => {
      if (!can.manageJobs || asked.current.has(site)) return
      asked.current.add(site)
      setTechnicians((current) => ({ ...current, [site]: null }))
      plantTechnicians(api, site)
        .then((answer) => setTechnicians((current) => ({ ...current, [site]: { ...answer, problem: null } })))
        .catch((error: unknown) => setTechnicians((current) => ({ ...current, [site]: { technicians: [], floorListed: false, problem: isApiError(error) && error.kind === 'forbidden' ? 'field.assigneeNoRight' : readProblem(error) } })))
    },
    [api, can.manageJobs],
  )
  // The list's sites (usually one): their technicians, for the inline cell.
  const rowSites = useMemo(() => [...new Set((rows.items ?? []).map((row) => row.siteId))].join(','), [rows.items])
  useEffect(() => {
    if (!can.manageJobs || !rowSites) return
    for (const site of rowSites.split(',')) needTechnicians(site)
  }, [rowSites, can.manageJobs, needTechnicians])

  // ---- inline edits --------------------------------------------------------------------------------------------------------
  const [cells, setCells] = useState<Record<string, CellState>>({})
  const replaceRow = useCallback((job: MaintenanceJob) => setRows((current) => ({ ...current, items: current.items?.map((row) => (row.id === job.id ? job : row)) ?? null })), [])
  const edit = useCallback(
    async (job: MaintenanceJob, change: Omit<JobChange, 'version'>, cell: 'priority' | 'due' | 'assignee') => {
      const key = `${job.id}:${cell}`
      setCells((current) => ({ ...current, [key]: { state: 'saving' } }))
      try {
        const saved = await updateJob(api, job.id, { version: job.version, ...change })
        replaceRow(saved)
        setCells((current) => ({ ...current, [key]: { state: 'saved' } }))
        refreshTiles()
      } catch (error) {
        setCells((current) => ({ ...current, [key]: { state: 'failed', words: problemOf(error) } }))
        setNotice({ tone: 'danger', words: { key: 'cell.refused', params: { number: job.number } }, detail: problemOf(error) })
      }
    },
    [api, replaceRow, refreshTiles],
  )

  // ---- board moves ---------------------------------------------------------------------------------------------------------
  const [moving, setMoving] = useState<string | null>(null)
  const boardMove = useCallback(
    async (job: MaintenanceJob, move: JobMove): Promise<boolean> => {
      // A hand-back is the job's one-screen close: the Hand back dialog over the board (design pop:close "Board drop on Hand-back").
      if (move === 'handBack') {
        openHandBack(job.id, job.number)
        return false
      }
      setMoving(job.id)
      try {
        const answer = await moveJob(api, job.id, move, { version: job.version })
        replaceRow(answer.job)
        setNotice({ tone: 'success', words: { key: `done.move.${move}`, params: { number: answer.job.number } } })
        refreshTiles()
        return true
      } catch (error) {
        setNotice({ tone: 'danger', words: { key: 'done.moveRefused', params: { number: job.number } }, detail: problemOf(error) })
        return false
      } finally {
        setMoving(null)
      }
    },
    [api, replaceRow, refreshTiles],
  )

  // ---- dialogs --------------------------------------------------------------------------------------------------------------
  const [dialog, setDialog] = useState<JobsDialog | null>(null)
  const handBackRead = useRef(0)
  const readHandBack = useCallback(
    (jobId: string) => {
      const read = ++handBackRead.current
      getDeepJob(api, jobId)
        .then((value) => read === handBackRead.current && setDialog((current) => (current?.kind === 'handBack' && current.jobId === jobId ? { ...current, loaded: { status: 'ready', value }, draft: closeDraftOf(value.close) } : current)))
        .catch((error: unknown) => read === handBackRead.current && setDialog((current) => (current?.kind === 'handBack' && current.jobId === jobId ? { ...current, loaded: isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) } } : current)))
    },
    [api],
  )
  function openHandBack(jobId: string, number: string) {
    setDialog({ kind: 'handBack', jobId, number, loaded: { status: 'loading' }, draft: closeDraftOf(null), busy: false, problem: null })
    readHandBack(jobId)
  }
  useEffect(() => {
    if (address.isNew && can.view) {
      setDialog((current) =>
        current?.kind === 'new'
          ? current
          : { kind: 'new', draft: { query: '', machine: null, type: 'CORRECTIVE', problem: '', priority: 'P2', source: 'MANUAL', assignee: '', due: '', plan: false }, found: null, searching: false, busy: false, problem: null },
      )
      if (machineId)
        getMachine(api, machineId)
          .then((answer) => setDialog((current) => (current?.kind === 'new' && !current.draft.machine ? { ...current, draft: { ...current.draft, machine: answer.card.machine, query: answer.card.machine.assetNumber }, found: [answer.card.machine] } : current)))
          .catch(() => undefined)
    } else setDialog((current) => (current?.kind === 'new' ? null : current))
  }, [address.isNew, can.view, api, machineId])

  const newMachineSite = dialog?.kind === 'new' ? (dialog.draft.machine?.siteId ?? null) : null
  useEffect(() => {
    if (newMachineSite) needTechnicians(newMachineSite)
  }, [newMachineSite, needTechnicians])

  const findMachine = useCallback(
    (text: string) => {
      if (text.trim().length < 1) {
        setDialog((current) => (current?.kind === 'new' ? { ...current, found: null } : current))
        return
      }
      setDialog((current) => (current?.kind === 'new' ? { ...current, searching: true } : current))
      listMachines(api, { q: text, limit: 20 })
        .then((answer) => setDialog((current) => (current?.kind === 'new' ? { ...current, searching: false, found: answer.machines, draft: answer.machines.length === 1 && !current.draft.machine ? { ...current.draft, machine: answer.machines[0]! } : current.draft } : current)))
        .catch(() => setDialog((current) => (current?.kind === 'new' ? { ...current, searching: false, found: [] } : current)))
    },
    [api],
  )

  const submitDialog = useCallback(async () => {
    if (!dialog || dialog.busy) return
    setDialog({ ...dialog, busy: true, problem: null } as JobsDialog)
    try {
      if (dialog.kind === 'handBack') {
        if (dialog.loaded.status !== 'ready') return
        const answer = await handBackJob(api, dialog.jobId, closeBody(dialog.draft, dialog.loaded.value.job.version))
        replaceRow(answer.job)
        setDialog(null)
        setNotice({ tone: 'success', words: { key: 'done.move.handBack', params: { number: answer.job.number } } })
        refreshTiles()
      } else if (dialog.kind === 'new') {
        const draft = dialog.draft
        const job = await createJob(api, {
          machineId: draft.machine!.id,
          type: draft.type,
          problem: draft.problem.trim(),
          priority: draft.priority,
          source: draft.source,
          ...assigneeFields(draft.assignee),
          dueAt: instantOf(draft.due, TIME_ZONE),
          ...(draft.plan ? { plan: true } : {}),
        })
        setDialog(null)
        router.push(`${prefix}/plant/jobs/${encodeURIComponent(job.id)}`)
      } else {
        const saved = await assignJobs(api, { jobs: dialog.jobs.map((job) => ({ id: job.id, version: job.version })), ...assigneeFields(dialog.assignee) })
        for (const job of saved) replaceRow(job)
        setDialog(null)
        setNotice({ tone: 'success', words: { key: 'done.assigned', params: { count: saved.length } } })
        refreshTiles()
      }
    } catch (error) {
      setDialog((current) => (current ? { ...current, busy: false, problem: depthProblemOf(error) } : current))
    }
  }, [dialog, api, router, prefix, replaceRow, refreshTiles])

  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const place = { locale, timeZone: TIME_ZONE }
      const header = ['number', 'type', 'site', 'machine', 'class', 'problem', 'priority', 'line', 'assignee', 'due', 'state', 'source', 'created'].map((column) => t(`csvJob.${column}`))
      const lines = picked.map((row) => [
        row.number,
        t(`jobType.${row.type}`),
        sites.find((site) => site.id === row.siteId)?.code ?? '',
        row.machine.assetNumber,
        labelOf(row.machine.class, locale),
        row.problem,
        t(`priority.${row.priority}`),
        row.machine.line?.code ?? '',
        assigneeWords(t, row),
        row.dueAt ? formatDateTime(row.dueAt, place) : '',
        t(`jobStatus.${row.status}`),
        t(`jobSource.${row.source}`),
        formatDateTime(row.createdAt, place),
      ])
      downloadText(`maintenance-jobs-${new Date().toISOString().slice(0, 10)}.csv`, csvText(header, lines))
    },
    [rows.items, sites, locale, t],
  )

  const model: JobsListModel = {
    prefix,
    can,
    address: { view, siteId, machineId, mode },
    machine,
    sites,
    rows,
    tiles,
    asOf,
    live,
    updates,
    timeZone: TIME_ZONE,
    // The due words read against the last read's clock (a fresh clock per render would rebuild the grid's columns).
    now: asOf ?? opened,
    technicians,
    cells,
    dialog,
    notice,
    moving,
  }

  return (
    <JobsView
      model={model}
      actions={{
        onView: (next) => go({ view: next }),
        onSite: (next) => go({ siteId: next }),
        onMachine: (next) => go({ machineId: next }),
        onMode: (next) => go({ mode: next }),
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/plant/jobs/${encodeURIComponent(id)}`),
        onEdit: (job, change, cell) => void edit(job, change, cell),
        onNeedTechnicians: needTechnicians,
        onBoardMove: boardMove,
        onNew: () => go({ isNew: true }),
        onAssign: (jobs) => {
          if (jobs[0]) needTechnicians(jobs[0].siteId)
          setDialog({ kind: 'assign', jobs, assignee: '', busy: false, problem: null })
        },
        onDialogClose: () => {
          if (dialog?.kind === 'new') go({ isNew: false })
          setDialog(null)
        },
        onNewDraft: (patch) => setDialog((current) => (current?.kind === 'new' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onFindMachine: findMachine,
        onAssignee: (assignee) => setDialog((current) => (current?.kind === 'assign' ? { ...current, assignee } : current)),
        onCloseDraft: (patch) => setDialog((current) => (current?.kind === 'handBack' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onRetryHandBack: () => dialog?.kind === 'handBack' && readHandBack(dialog.jobId),
        onSubmitDialog: () => void submitDialog(),
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
