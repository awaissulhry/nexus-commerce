'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { downloadLink, listFiles, type ApiFile } from '../../../../record-panels/api'
import type { PanelRead } from '../../../../record-panels/model'
import { ThreadPrint } from '../../../_shared/record-thread/ThreadPrint'
import { storeUrl } from '../../../../record-panels/store'
import { createTask, listAssignees, listTasks, taskReadProblem } from '../../../../record-panels/tasks/api'
import { addTaskHeld, createBody, type TaskItem } from '../../../../record-panels/tasks/model'
import { useLiveBus } from '../../../../shell/live/use-live'
import { printHref } from '../../../../shell/print/print-model'
import { OfficeRecordThread } from '../../../_shared/record-thread/OfficeRecordThread'
import { closeProject, moveProject, peopleChoices, readProject, updateProject, type ProjectLinks, type ProjectPage, type ProjectPeople, type ProjectView } from '../api'
import { fieldOfPath, projectHref, projectsCan, readProblem, writeProblem, type Notice } from '../model'
import { LinkedSection } from './linked/LinkedSection'
import { closeBody, editBody, editDraftOf, emptyCloseDraft, leadChoices, threadAudience } from './model'
import { LinkedNews } from './news/LinkedNews'
import { PeopleSection } from './people/PeopleSection'
import type { Loaded, ProjectDialog, ProjectRecordModel } from './view-model'
import { ProjectRecordView } from './view/ProjectRecordView'

/**
 * `/w/<company>/products/projects/<id>` (SCR-701; B-TH-249): the project page's container. It reads the page (GET /projects/:id:
 * the project, its people, its linked records, its task and file counts, my follow), the project's open tasks (with home.view) and
 * its files (with files.read), and reads them again on the project's live events. It puts the project on hold, resumes, closes
 * (Done or Stopped with one line) and reopens it, saves its details — each with the version read; a stale or refused answer reads
 * the project again and says it in words. The thread is the office's docked RecordThread on the project's own record (its ONE outside
 * company, or none: office notes only); People (B-TH-250) and Linked (B-TH-251) are their own sections, kept in step through the
 * page's state. A project the person may not read answers 404: "not found", never "you may not" (W38).
 */
export function ProjectRecord({ projectId }: { projectId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const me = session.user.id
  const can = useMemo(() => projectsCan(session.permissions), [session.permissions])
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const record = useMemo(() => ({ type: 'Project', id: projectId }), [projectId])

  // ---- the page -------------------------------------------------------------------------------------------------------------
  const [page, setPage] = useState<Loaded<ProjectPage>>({ status: 'loading' })
  const readId = useRef(0)
  const load = useCallback(async () => {
    const id = ++readId.current
    try {
      const answer = await readProject(api, projectId)
      if (id === readId.current) setPage({ status: 'ready', data: answer })
      return answer
    } catch (error) {
      if (id === readId.current) setPage((now) => (now.status === 'ready' && readProblem(error) === 'problem.unavailable' ? now : { status: 'error', problem: readProblem(error) }))
      return null
    }
  }, [api, projectId])
  useEffect(() => {
    setPage({ status: 'loading' })
    void load()
  }, [load])
  const project = page.status === 'ready' ? page.data.project : null

  // ---- tasks (Home's tasks: home.view) and files (files.read) ----------------------------------------------------------------
  const seesTasks = held.has('home.view')
  const seesFiles = held.has('files.read')
  const [tasks, setTasks] = useState<PanelRead<readonly TaskItem[]>>({ status: 'loading' })
  const [files, setFiles] = useState<PanelRead<readonly ApiFile[]>>({ status: 'loading' })
  const loadTasks = useCallback(async () => {
    if (!seesTasks) return
    try {
      setTasks({ status: 'ready', data: (await listTasks(api, { scope: 'RECORD', record, status: 'OPEN', limit: 50 })).items })
    } catch (error) {
      setTasks({ status: 'error', problem: taskReadProblem(error) })
    }
  }, [api, record, seesTasks])
  const loadFiles = useCallback(async () => {
    if (!seesFiles) return
    try {
      setFiles({ status: 'ready', data: (await listFiles(api, record)).files })
    } catch {
      setFiles({ status: 'error', problem: 'files.problemRead' })
    }
  }, [api, record, seesFiles])
  const found = project !== null
  useEffect(() => {
    if (!found) return
    void loadTasks()
    void loadFiles()
  }, [found, loadTasks, loadFiles])

  // ---- live: the project's own events read the page again; tasks and files theirs --------------------------------------------
  const later = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (later.current && clearTimeout(later.current)), [])
  const live = useLiveBus({
    onChange: (change) => {
      const mine = change.fields.projectId === projectId || (change.fields.recordType === 'Project' && change.fields.recordId === projectId)
      if (!mine) return
      if (change.type.startsWith('project.')) {
        if (later.current) clearTimeout(later.current)
        later.current = setTimeout(() => void load(), 400)
      }
      if (change.type.startsWith('task.')) void loadTasks()
      if (change.type.startsWith('file.')) void loadFiles()
    },
    onReconnect: () => {
      void load()
      void loadTasks()
      void loadFiles()
    },
  })
  const offline = live === 'offline'

  // ---- moves, close, edit -------------------------------------------------------------------------------------------------------
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<ProjectDialog | null>(null)
  const keyRef = useRef<string | null>(null)

  const withProject = useCallback((next: ProjectView) => setPage((now) => (now.status === 'ready' ? { status: 'ready', data: { ...now.data, project: next } } : now)), [])

  const move = useCallback(
    async (kind: 'HOLD' | 'RESUME' | 'REOPEN') => {
      if (!project || busy) return
      setBusy(true)
      setNotice(null)
      try {
        const next = await moveProject(api, project.id, kind, project.version)
        withProject(next)
        setNotice({ key: kind === 'HOLD' ? 'notice.held' : kind === 'RESUME' ? 'notice.resumed' : 'notice.reopened', tone: 'success', params: { number: next.number } })
        void load()
      } catch (error) {
        const refused = writeProblem(error)
        setNotice({ key: refused.key, ...(refused.params ? { params: refused.params } : {}), tone: 'danger' })
        void load()
      } finally {
        setBusy(false)
      }
    },
    [api, project, busy, withProject, load],
  )

  const submitClose = useCallback(async () => {
    if (!project || dialog?.kind !== 'close' || dialog.busy) return
    const body = closeBody(project, dialog.draft)
    if (!body) return
    setDialog({ ...dialog, busy: true, problem: null })
    keyRef.current ??= newIdempotencyKey()
    try {
      const next = await closeProject(api, project.id, body, keyRef.current)
      keyRef.current = null
      withProject(next)
      setDialog(null)
      setNotice({ key: 'notice.closed', tone: 'success', params: { number: next.number } })
      void load()
    } catch (error) {
      const refused = writeProblem(error)
      // A lost answer keeps its key (the same close sent again is one close); a refusal starts a new attempt.
      if (refused.key !== 'problem.unavailable') keyRef.current = null
      setDialog((now) => (now?.kind === 'close' ? { ...now, busy: false, problem: { key: refused.key, ...(refused.params ? { params: refused.params } : {}) } } : now))
      if (refused.stale) void load()
    }
  }, [api, project, dialog, withProject, load])

  const readLeads = useCallback(
    async (current: ProjectView, office: ProjectPeople['office']['people']) => {
      if (!current.may.post) {
        setDialog((now) => (now?.kind === 'edit' ? { ...now, leads: { status: 'ready', data: leadChoices(current.lead, office, []) } } : now))
        return
      }
      setDialog((now) => (now?.kind === 'edit' ? { ...now, leads: { status: 'loading' } } : now))
      try {
        const choices = await peopleChoices(api, current.id)
        setDialog((now) => (now?.kind === 'edit' ? { ...now, leads: { status: 'ready', data: leadChoices(current.lead, office, choices.office) } } : now))
      } catch {
        // The colleagues outside the project could not be read: its own office people can still lead it.
        setDialog((now) => (now?.kind === 'edit' ? { ...now, leads: { status: 'ready', data: leadChoices(current.lead, office, []) } } : now))
      }
    },
    [api],
  )

  const openEdit = useCallback(() => {
    if (page.status !== 'ready') return
    keyRef.current = null
    const current = page.data.project
    setDialog({ kind: 'edit', draft: editDraftOf(current), leads: { status: 'loading' }, busy: false, problem: null, stale: false, fields: [] })
    void readLeads(current, page.data.people.office.people)
  }, [page, readLeads])

  const submitEdit = useCallback(async () => {
    if (!project || dialog?.kind !== 'edit' || dialog.busy || dialog.stale) return
    const body = editBody(project, dialog.draft)
    if (!body) return
    setDialog({ ...dialog, busy: true, problem: null, fields: [] })
    keyRef.current ??= newIdempotencyKey()
    try {
      const next = await updateProject(api, project.id, body, keyRef.current)
      keyRef.current = null
      withProject(next)
      setDialog(null)
      setNotice({ key: 'notice.saved', tone: 'success', params: { number: next.number } })
      void load()
    } catch (error) {
      const refused = writeProblem(error)
      if (refused.key !== 'problem.unavailable') keyRef.current = null
      setDialog((now) =>
        now?.kind === 'edit'
          ? { ...now, busy: false, stale: refused.stale, problem: refused.stale ? null : { key: refused.key, ...(refused.params ? { params: refused.params } : {}) }, fields: [...new Set(refused.paths.map(fieldOfPath))] }
          : now,
      )
    }
  }, [api, project, dialog, withProject, load])

  const reloadEdit = useCallback(async () => {
    const answer = await load()
    if (!answer) return
    setDialog((now) => (now?.kind === 'edit' ? { ...now, draft: editDraftOf(answer.project), stale: false, problem: null, fields: [] } : now))
    void readLeads(answer.project, answer.people.office.people)
  }, [load, readLeads])

  // ---- tasks: the ONE New task dialog --------------------------------------------------------------------------------------------
  const readAssignees = useCallback(async () => {
    setDialog((now) => (now?.kind === 'task' ? { ...now, people: { status: 'loading' } } : now))
    try {
      const people = await listAssignees(api, record)
      setDialog((now) => (now?.kind === 'task' ? { ...now, people: { status: 'ready', data: people } } : now))
    } catch (error) {
      setDialog((now) => (now?.kind === 'task' ? { ...now, people: { status: 'error', problem: taskReadProblem(error) } } : now))
    }
  }, [api, record])

  // ---- People and Linked keep the page's state in step (their writes answer the new lists) -----------------------------------------
  const onPeople = useCallback((people: ProjectPeople) => setPage((now) => (now.status === 'ready' ? { status: 'ready', data: { ...now.data, people } } : now)), [])
  const onLinks = useCallback((links: ProjectLinks) => setPage((now) => (now.status === 'ready' ? { status: 'ready', data: { ...now.data, links } } : now)), [])

  const model: ProjectRecordModel = {
    prefix,
    me,
    can,
    page,
    offline,
    busy,
    notice,
    tasks: seesTasks ? tasks : null,
    addTaskHeld: addTaskHeld(held, true),
    files: seesFiles ? files : null,
    dialog,
  }

  // The thread: the project's own record, its ONE outside company or nobody outside (W01, W20, W38).
  const audience = project ? threadAudience(project) : null
  const threadRecord = useMemo(() => (project ? { type: 'Project', id: project.id, companyId: project.companyId, siteId: null } : null), [project?.id, project?.companyId])
  const title = project ? `${project.number} · ${project.name}` : ''
  const thread =
    project && threadRecord && audience ? (
      <OfficeRecordThread
        docked
        record={threadRecord}
        title={title}
        recordLabel={project.number}
        party={audience.party}
        {...(audience.partyRole ? { partyRole: audience.partyRole } : {})}
        recordHref={projectHref(prefix, project.id)}
        printHref={printHref(pathname, params?.toString() ?? '')}
        // TH-5 follow-up: a closed project's thread opens only with the project (the closed banner's Reopen), never from the thread's head.
        reopenWithRecord={project.status === 'CLOSED'}
      />
    ) : null
  const printThread = project && threadRecord ? <ThreadPrint record={threadRecord} title={title} party={project.party ? { id: project.party.id, name: project.party.name } : null} {...(audience?.partyRole ? { partyRole: audience.partyRole } : {})} /> : null

  return (
    <ProjectRecordView
      model={model}
      thread={thread}
      printThread={printThread}
      people={page.status === 'ready' ? <PeopleSection project={page.data.project} people={page.data.people} offline={offline} onChanged={onPeople} /> : null}
      linked={page.status === 'ready' ? <LinkedSection project={page.data.project} links={page.data.links} offline={offline} onChanged={onLinks} /> : null}
      news={project ? <LinkedNews projectId={project.id} /> : null}
      actions={{
        onRetry: () => {
          setPage({ status: 'loading' })
          void load()
        },
        onEdit: openEdit,
        onHold: () => void move('HOLD'),
        onResume: () => void move('RESUME'),
        onReopen: () => void move('REOPEN'),
        onClose: () => {
          keyRef.current = null
          setDialog({ kind: 'close', draft: emptyCloseDraft(), busy: false, problem: null })
        },
        onCopyLink: () => {
          if (!project) return
          void navigator.clipboard
            ?.writeText(`${window.location.origin}${projectHref(prefix, project.id)}`)
            .then(() => setNotice({ key: 'notice.copied', tone: 'success' }))
            .catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
        close: {
          onDraft: (patch) => setDialog((now) => (now?.kind === 'close' ? { ...now, draft: { ...now.draft, ...patch }, problem: null } : now)),
          onSubmit: () => void submitClose(),
          onCancel: () => setDialog(null),
        },
        edit: {
          onDraft: (patch) => setDialog((now) => (now?.kind === 'edit' ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onSubmit: () => void submitEdit(),
          onReload: () => void reloadEdit(),
          onRetryLeads: () => {
            if (page.status === 'ready') void readLeads(page.data.project, page.data.people.office.people)
          },
          onCancel: () => setDialog(null),
        },
        task: {
          onOpen: () => {
            setDialog({ kind: 'task', people: { status: 'loading' }, busy: false })
            void readAssignees()
          },
          onCreate: async (draft) => {
            setDialog((now) => (now?.kind === 'task' ? { ...now, busy: true } : now))
            try {
              await createTask(api, createBody(draft, record))
              setDialog(null)
              setNotice({ key: 'notice.taskMade', tone: 'success' })
              void loadTasks()
              void load()
              return true
            } catch {
              setDialog((now) => (now?.kind === 'task' ? { ...now, busy: false } : now))
              setNotice({ key: 'notice.taskFailed', tone: 'danger' })
              return false
            }
          },
          onRetryPeople: () => void readAssignees(),
          onCancel: () => setDialog(null),
          onRetry: () => {
            setTasks({ status: 'loading' })
            void loadTasks()
          },
        },
        files: {
          onOpen: (fileId) => {
            downloadLink(api, fileId)
              .then(({ download }) => {
                const anchor = document.createElement('a')
                anchor.href = storeUrl(download.url)
                anchor.rel = 'noopener'
                anchor.target = '_blank'
                document.body.appendChild(anchor)
                anchor.click()
                anchor.remove()
              })
              .catch(() => setNotice({ key: 'notice.fileFailed', tone: 'danger' }))
          },
          onRetry: () => {
            setFiles({ status: 'loading' })
            void loadFiles()
          },
        },
      }}
    />
  )
}
