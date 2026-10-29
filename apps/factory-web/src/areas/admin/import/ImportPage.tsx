'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { StoreError } from '../../../record-panels/store'
import { listUsers } from '../shared/api'
import { failed, loaded, loading, problemKey, type Loaded } from '../shared/model'
import { runBulk } from '../shared/bulk'
import { bulkNotice, type BulkNotice } from '../kit/bulk-model'
import { applyImport, cancelImport, getImport, listImporters, listImportRows, listImports, uploadSheet, type ImportJob, type Importer, type ImportRow, type NumberFormat } from './api'
import { applicable, blankDraft, emptyWizard, isMoving, phaseOf, POLL_MS, RECENT_LIMIT, type ImportRights, type UploadDraft, type WizardModel } from './model'
import { ImportView } from './view/ImportView'

const NONE: Loaded<ImportRow> = { items: [], problem: null }

/** The rows a job's step shows: refused and planned changes for a review, skipped ones for a result. */
async function rowsFor(api: ReturnType<typeof useOfficeApi>, job: ImportJob): Promise<Pick<WizardModel, 'refused' | 'changes' | 'skipped'>> {
  const phase = phaseOf(job)
  const read = (work: () => Promise<ImportRow[]>): Promise<Loaded<ImportRow>> => work().then(loaded, (error: unknown) => failed<ImportRow>(problemKey(error)))
  if (phase === 'planned' || phase === 'applyFailed') {
    const [refused, changes] = await Promise.all([
      job.errorCount > 0 ? read(() => listImportRows(api, job.id, { action: 'ERROR', limit: 50 }).then((answer) => answer.rows)) : Promise.resolve(NONE),
      applicable(job) > 0
        ? read(async () => {
            const [created, updated] = await Promise.all([
              job.createCount > 0 ? listImportRows(api, job.id, { action: 'CREATE', limit: 50 }).then((answer) => answer.rows) : Promise.resolve([]),
              job.updateCount > 0 ? listImportRows(api, job.id, { action: 'UPDATE', limit: 50 }).then((answer) => answer.rows) : Promise.resolve([]),
            ])
            return [...created, ...updated].sort((a, b) => a.rowNumber - b.rowNumber).slice(0, 50)
          })
        : Promise.resolve(NONE),
    ])
    return { refused, changes, skipped: NONE }
  }
  if (phase === 'applied' && job.skippedCount > 0) return { refused: NONE, changes: NONE, skipped: await read(() => listImportRows(api, job.id, { outcome: 'SKIPPED', limit: 50 }).then((answer) => answer.rows)) }
  return { refused: NONE, changes: NONE, skipped: NONE }
}

/** A failed start in the wizard's words. */
function startProblem(error: unknown): string {
  if (error instanceof StoreError) return 'imp.problem.store'
  if (error instanceof TypeError && !isApiError(error)) return 'imp.problem.fileType'
  return problemKey(error)
}

/**
 * `/w/<company>/admin/import` (SCR-017): the importers this person may use (`GET /imports/importers`), the import jobs
 * (`GET /imports`), the people who started them (`GET /auth/users`, users.view). `?importer=<key>` opens the wizard on
 * that importer, `?new=1` on the picker, `?job=<id>` on a job. While a job moves (the worker reads the sheet or applies
 * it) the wizard asks for it every 2 s; no live event reaches this page yet.
 */
export function ImportPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const can: ImportRights = useMemo(
    () => ({ view: held.has('imports.view'), run: held.has('imports.run') && held.has('files.upload'), apply: held.has('imports.apply'), people: held.has('users.view') }),
    [held],
  )
  const prefix = companyPrefix(session.company?.code ?? '')
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const [importers, setImporters] = useState<Loaded<Importer>>(loading())
  const [jobs, setJobs] = useState<Loaded<ImportJob>>(loading())
  const [people, setPeople] = useState<Record<string, string>>({})
  const [asOf, setAsOf] = useState<string | null>(null)
  const [wizard, setWizard] = useState<WizardModel | null>(null)
  const [notice, setNotice] = useState<BulkNotice | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [cancelMany, setCancelMany] = useState<readonly string[] | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const file = useRef<File | null>(null)

  const draftFor = useCallback(
    (importerKey: string | null): UploadDraft => blankDraft(importerKey ?? '', session.company?.id ?? (companies.length === 1 ? companies[0]!.id : ''), locale as NumberFormat),
    [companies, locale, session.company?.id],
  )

  const loadJobs = useCallback(async () => {
    try {
      setJobs(loaded(await listImports(api, { limit: RECENT_LIMIT })))
      setAsOf(new Date().toISOString())
    } catch (error) {
      setJobs(failed(problemKey(error)))
    }
  }, [api])

  const load = useCallback(async () => {
    if (!can.view) return
    await Promise.all([
      listImporters(api).then(
        (items) => setImporters(loaded(items)),
        (error: unknown) => setImporters(failed(problemKey(error))),
      ),
      loadJobs(),
      can.people ? listUsers(api).then((users) => setPeople(Object.fromEntries(users.map((user) => [user.id, user.displayName]))), () => setPeople({})) : Promise.resolve(),
    ])
  }, [api, can.people, can.view, loadJobs])
  useEffect(() => {
    void load()
  }, [load])

  /** Shows a job in the wizard and reads the rows its step shows. */
  const showJob = useCallback(
    async (job: ImportJob, draft?: UploadDraft) => {
      setWizard((current) => ({ ...emptyWizard(draft ?? current?.draft ?? blankDraft(job.importerKey, job.companyId ?? '', job.numberFormat), job), confirmCancel: false }))
      const rows = await rowsFor(api, job)
      setWizard((current) => (current?.job?.id === job.id ? { ...current, ...rows } : current))
    },
    [api],
  )

  // The address opens the wizard: ?job=<id>, ?importer=<key>, ?new=1.
  const asked = { job: params?.get('job') ?? null, importer: params?.get('importer') ?? null, fresh: params?.get('new') ?? null }
  useEffect(() => {
    if (!can.view) return
    if (asked.job) {
      if (wizard?.job?.id === asked.job) return
      getImport(api, asked.job).then(
        (job) => void showJob(job),
        (error: unknown) => {
          setNotice({ key: problemKey(error), tone: 'warning' })
          router.replace(pathname ?? '')
        },
      )
    } else if (asked.importer !== null || asked.fresh) {
      if (wizard && !wizard.job) return
      file.current = null
      setWizard(emptyWizard(draftFor(asked.importer)))
    } else if (wizard) setWizard(null)
    // Only the address decides; the wizard's own moves keep it in step.
  }, [asked.job, asked.importer, asked.fresh, can.view])

  // While the job moves, ask again; a move to another state reads its rows and the list.
  const moving = wizard?.job && isMoving(wizard.job) ? wizard.job : null
  useEffect(() => {
    if (!moving) return
    const timer = window.setInterval(() => {
      getImport(api, moving.id)
        .then((job) => {
          if (job.status !== moving.status || job.version !== moving.version) {
            if (isMoving(job)) setWizard((current) => (current?.job?.id === job.id ? { ...current, job } : current))
            else {
              void showJob(job)
              void loadJobs()
            }
          }
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [api, moving, showJob, loadJobs])

  const open = (query: string) => router.push(`${pathname ?? ''}${query}`)
  const close = () => {
    setWizard(null)
    file.current = null
    router.replace(pathname ?? '')
    void loadJobs()
  }
  const patch = (next: Partial<WizardModel>) => setWizard((current) => (current ? { ...current, ...next } : current))

  return (
    <ImportView
      model={{ prefix, can, importers, jobs, companies, people, asOf, wizard, selected, cancelMany, bulkBusy, notice }}
      actions={{
        onNew: (key) => open(key ? `?importer=${encodeURIComponent(key)}` : '?new=1'),
        onRetry: () => {
          setImporters(loading())
          setJobs(loading())
          void load()
        },
        onApplyAgain: (job) => open(`?job=${encodeURIComponent(job.id)}`),
        onOpenJob: (job) => open(`?job=${encodeURIComponent(job.id)}`),
        onSelect: setSelected,
        onCancelMany: setCancelMany,
        onCancelManyGo: async (chosen) => {
          setBulkBusy(true)
          // One call per job (the API cancels one at a time), each with the version read.
          const result = await runBulk(chosen, (job) => cancelImport(api, job.id, { version: job.version }))
          const done = new Set(result.done.map((job) => job.id))
          setSelected((current) => current.filter((id) => !done.has(id)))
          setNotice(bulkNotice(result, { done: 'imp.bulk.done', partial: 'imp.bulk.partial', failed: 'imp.bulk.failed' }, (job) => job.id))
          setCancelMany(null)
          setBulkBusy(false)
          void loadJobs()
        },
        onDismissNotice: () => setNotice(null),
        onClose: close,
        onDraft: (next) => setWizard((current) => (current ? { ...current, problem: null, draft: { ...current.draft, ...next } } : current)),
        onFile: (picked) => {
          file.current = picked
          setWizard((current) => (current ? { ...current, problem: null, draft: { ...current.draft, file: picked ? { name: picked.name, size: picked.size } : null } } : current))
        },
        onStart: () => {
          const current = wizard
          if (!current || !file.current) return
          const draft = current.draft
          patch({ busy: true, problem: null })
          uploadSheet(api, { importerKey: draft.importerKey, companyId: draft.companyId || null, numberFormat: draft.numberFormat, sheetName: draft.sheetName.trim() || null }, file.current)
            .then((job) => {
              file.current = null
              setWizard({ ...emptyWizard(draft, job) })
              router.replace(`${pathname ?? ''}?job=${encodeURIComponent(job.id)}`)
              void loadJobs()
            })
            .catch((error: unknown) => patch({ busy: false, problem: startProblem(error) }))
        },
        onApply: () => {
          const job = wizard?.job
          if (!job) return
          patch({ busy: true, problem: null })
          applyImport(api, job.id, job.version)
            .then((next) => {
              setWizard((current) => (current ? { ...current, job: next, busy: false } : current))
              void loadJobs()
            })
            .catch(async (error: unknown) => {
              const fresh = await getImport(api, job.id).catch(() => null)
              setWizard((current) => (current ? { ...current, ...(fresh ? { job: fresh } : {}), busy: false, problem: problemKey(error) } : current))
            })
        },
        onCancelAsk: (show) => patch({ confirmCancel: show }),
        onCancelConfirm: () => {
          const job = wizard?.job
          if (!job) return
          patch({ busy: true, problem: null })
          cancelImport(api, job.id, { version: job.version })
            .then((next) => {
              setWizard((current) => (current ? { ...current, job: next, busy: false, confirmCancel: false } : current))
              setNotice({ key: 'imp.notice.cancelled', tone: 'info', params: { file: next.fileName } })
              void loadJobs()
            })
            .catch((error: unknown) => patch({ busy: false, confirmCancel: false, problem: problemKey(error) }))
        },
        onRestart: () => {
          const draft = wizard?.draft ?? draftFor(wizard?.job?.importerKey ?? null)
          const key = wizard?.job?.importerKey ?? draft.importerKey
          file.current = null
          setWizard(emptyWizard({ ...draft, importerKey: key, companyId: wizard?.job?.companyId ?? draft.companyId, file: null }))
          router.replace(`${pathname ?? ''}?importer=${encodeURIComponent(key)}`)
        },
      }}
    />
  )
}
