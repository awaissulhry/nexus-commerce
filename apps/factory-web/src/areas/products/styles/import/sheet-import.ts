'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { StoreError } from '../../../../record-panels/store'
import { applyImport, cancelImport, getImport, listImporters, listImportRows, uploadSheet, type ImportJob, type Importer, type ImportRow, type NumberFormat } from '../../../admin/import/api'
import { applicable, blankDraft, emptyWizard, isMoving, phaseOf, POLL_MS, type ImportRights, type WizardModel } from '../../../admin/import/model'
import type { WizardActions } from '../../../admin/import/view/ImportWizard'
import { failed, loaded, problemKey, type Loaded } from '../../../admin/shared/model'

/**
 * One sheet import from a product screen (W2a): Import BOM in the studio (importer `product.bom`, design
 * pop:styles.importBom) and Import on the operations library (`product.operations`). The same flow as Admin › Import &
 * export (SCR-017, design D14 ImportFlow: upload → the dry run, nothing written → apply what was seen → the result),
 * drawn by its own wizard; this hook is its container with the importer fixed. The job lives on the server: closing
 * keeps it (Admin › Import & export reopens it). No live event reaches a job: while it moves it is read every 2 s.
 */

export interface SheetImport {
  wizard: WizardModel
  /** The one importer, as the API describes it (a stand-in with our words until that answer is read). */
  importers: Importer[]
  rights: ImportRights
  companies: ReadonlyArray<{ id: string; name: string }>
}

/**
 * The wizard's company choice for "every company": a style or an operation of every company is imported by a job for
 * every company (the importers' rule; the job's companyId is null). The admin wizard needs a choice, so this one
 * stands for it and is sent as null.
 */
export const EVERY_COMPANY = 'every-company'

export interface SheetImportOptions {
  importerKey: string
  /** The company the rows belong to, or EVERY_COMPANY (an import writes one company's records, or every company's). */
  companyId: string
  companies: ReadonlyArray<{ id: string; name: string }>
  /** The words for "every company" in the page's language. */
  everyCompany: string
  rights: ImportRights
  locale: NumberFormat
  /** After a job applied something (the screen reads its records again). */
  onApplied?: () => void
}

const NONE: Loaded<ImportRow> = { items: [], problem: null }

/** The importer before `GET /imports/importers` answers: our words name it (KNOWN_IMPORTERS). */
export const standInImporter = (key: string): Importer => ({ key, label: key, description: null, columns: [], keyColumns: [], maxRows: 0 })

/** The rows a job's step shows (as Admin › Import & export): refused and planned changes for a review, skipped ones after. */
async function rowsFor(api: ApiClient, job: ImportJob): Promise<Pick<WizardModel, 'refused' | 'changes' | 'skipped'>> {
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

function startProblem(error: unknown): string {
  if (error instanceof StoreError) return 'imp.problem.store'
  if (error instanceof TypeError && !isApiError(error)) return 'imp.problem.fileType'
  return problemKey(error)
}

export function useSheetImport(api: ApiClient, options: SheetImportOptions): { model: SheetImport | null; open: () => void; actions: WizardActions } {
  const { importerKey, companyId, rights, locale, onApplied } = options
  const companies = [{ id: EVERY_COMPANY, name: options.everyCompany }, ...options.companies]
  const [wizard, setWizard] = useState<WizardModel | null>(null)
  const [importers, setImporters] = useState<Importer[]>([standInImporter(importerKey)])
  const file = useRef<File | null>(null)
  const applied = useRef(false)
  const latest = useRef(wizard)
  latest.current = wizard
  const patch = (next: Partial<WizardModel>) => setWizard((current) => (current ? { ...current, ...next } : current))

  const showJob = useCallback(
    async (job: ImportJob) => {
      if (job.status === 'APPLIED' || job.appliedCount > 0) applied.current = true
      setWizard((current) => ({ ...emptyWizard(current?.draft ?? blankDraft(job.importerKey, job.companyId ?? EVERY_COMPANY, job.numberFormat), job), confirmCancel: false }))
      const rows = await rowsFor(api, job)
      setWizard((current) => (current?.job?.id === job.id ? { ...current, ...rows } : current))
    },
    [api, companyId],
  )

  const open = useCallback(() => {
    file.current = null
    applied.current = false
    setWizard(emptyWizard(blankDraft(importerKey, companyId, locale)))
    listImporters(api)
      .then((list) => {
        const own = list.find((item) => item.key === importerKey)
        if (own) setImporters([own])
      })
      .catch(() => undefined)
  }, [api, importerKey, companyId, locale])

  // While the job moves, ask again; a move to another state reads its rows.
  const moving = wizard?.job && isMoving(wizard.job) ? wizard.job : null
  useEffect(() => {
    if (!moving) return
    const timer = window.setInterval(() => {
      getImport(api, moving.id)
        .then((job) => {
          if (job.status !== moving.status || job.version !== moving.version) {
            if (isMoving(job)) setWizard((current) => (current?.job?.id === job.id ? { ...current, job } : current))
            else void showJob(job)
          }
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [api, moving, showJob])

  const actions: WizardActions = {
    onClose: () => {
      setWizard(null)
      file.current = null
      if (applied.current) onApplied?.()
      applied.current = false
    },
    onDraft: (next) => setWizard((current) => (current ? { ...current, problem: null, draft: { ...current.draft, ...next, importerKey } } : current)),
    onFile: (picked) => {
      file.current = picked
      setWizard((current) => (current ? { ...current, problem: null, draft: { ...current.draft, file: picked ? { name: picked.name, size: picked.size } : null } } : current))
    },
    onStart: () => {
      const current = latest.current
      if (!current || !file.current) return
      const draft = current.draft
      patch({ busy: true, problem: null })
      uploadSheet(api, { importerKey, companyId: draft.companyId === EVERY_COMPANY ? null : draft.companyId || null, numberFormat: draft.numberFormat, sheetName: draft.sheetName.trim() || null }, file.current)
        .then((job) => {
          file.current = null
          setWizard({ ...emptyWizard(draft, job) })
        })
        .catch((error: unknown) => patch({ busy: false, problem: startProblem(error) }))
    },
    onApply: () => {
      const job = latest.current?.job
      if (!job) return
      patch({ busy: true, problem: null })
      applyImport(api, job.id, job.version)
        .then((next) => setWizard((current) => (current ? { ...current, job: next, busy: false } : current)))
        .catch(async (error: unknown) => {
          const fresh = await getImport(api, job.id).catch(() => null)
          setWizard((current) => (current ? { ...current, ...(fresh ? { job: fresh } : {}), busy: false, problem: problemKey(error) } : current))
        })
    },
    onCancelAsk: (show) => patch({ confirmCancel: show }),
    onCancelConfirm: () => {
      const job = latest.current?.job
      if (!job) return
      patch({ busy: true, problem: null })
      cancelImport(api, job.id, { version: job.version })
        .then((next) => setWizard((current) => (current ? { ...current, job: next, busy: false, confirmCancel: false } : current)))
        .catch((error: unknown) => patch({ busy: false, confirmCancel: false, problem: problemKey(error) }))
    },
    onRestart: () => {
      const draft = latest.current?.draft ?? blankDraft(importerKey, companyId, locale)
      file.current = null
      setWizard(emptyWizard({ ...draft, importerKey, file: null }))
    },
  }

  return { model: wizard ? { wizard, importers, rights, companies } : null, open, actions }
}
