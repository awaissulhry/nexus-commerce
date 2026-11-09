'use client'

import { useCallback, useRef, useState } from 'react'
import { COMMERCE_IMPORTER_KEY } from '@nexus/factory-domain/product/commerce-import/importer'
import type { ApiClient } from '../../../../../lib/api/client'
import type { ImportJob, NumberFormat } from '../../../../admin/import/api'
import type { ImportRights } from '../../../../admin/import/model'
import type { WizardActions } from '../../../../admin/import/view/ImportWizard'
import { useSheetImport, type SheetImport } from '../sheet-import'
import { readCommerceImport, readStartedStyles } from './api'
import { commerceHeld, continueHeld, readProblemKey, type CommerceImportActions, type CommerceImportModel } from './commerce-model'

export interface CommerceImportOptions {
  /** product.styles.manage (over the person's companies). */
  manage: boolean
  rights: ImportRights
  /** The company the styles belong to (the import's company), or the wizard's "every company". */
  companyId: string
  companies: ReadonlyArray<{ id: string; name: string }>
  everyCompany: string
  locale: NumberFormat
  /** After the file wrote something (the list reads its styles again). */
  onApplied?: () => void
}

export interface CommerceImportState {
  model: CommerceImportModel | null
  sheet: SheetImport | null
}

/**
 * The container of New style › "Nexus Commerce product" and the header's Import (B-W2b-209): the source step reads
 * the sources (`GET /product/commerce-import`), Continue opens the import wizard on `product.commerceStyles`
 * (../sheet-import), and closing a wizard whose job wrote something opens the done step with the styles the job
 * started (`GET /product/commerce-import/jobs/:jobId`). Nothing here reads or writes Nexus Commerce.
 */
export function useCommerceImport(api: ApiClient, options: CommerceImportOptions): { state: CommerceImportState; open: () => void; actions: CommerceImportActions; sheetActions: WizardActions } {
  const { manage, rights, onApplied } = options
  const [model, setModel] = useState<CommerceImportModel | null>(null)
  const infoSeq = useRef(0)
  const doneSeq = useRef(0)
  const sheet = useSheetImport(api, { importerKey: COMMERCE_IMPORTER_KEY, companyId: options.companyId, companies: options.companies, everyCompany: options.everyCompany, rights, locale: options.locale, onApplied })
  const latest = useRef(model)
  latest.current = model
  const job = useRef<ImportJob | null>(null)
  job.current = sheet.model?.wizard.job ?? null

  const loadInfo = useCallback(() => {
    const mine = ++infoSeq.current
    setModel((current) => (current ? { ...current, info: { status: 'loading' } } : current))
    readCommerceImport(api)
      .then((value) => mine === infoSeq.current && setModel((current) => (current ? { ...current, info: { status: 'ready', value } } : current)))
      .catch((error: unknown) => mine === infoSeq.current && setModel((current) => (current ? { ...current, info: { status: 'error', problem: readProblemKey(error) } } : current)))
  }, [api])

  const loadDone = useCallback(
    (jobId: string) => {
      const mine = ++doneSeq.current
      setModel((current) => (current?.done ? { ...current, done: { jobId, styles: { status: 'loading' } } } : current))
      readStartedStyles(api, jobId)
        .then((value) => mine === doneSeq.current && setModel((current) => (current?.done?.jobId === jobId ? { ...current, done: { jobId, styles: { status: 'ready', value } } } : current)))
        .catch((error: unknown) => mine === doneSeq.current && setModel((current) => (current?.done?.jobId === jobId ? { ...current, done: { jobId, styles: { status: 'error', problem: readProblemKey(error) } } } : current)))
    },
    [api],
  )

  const open = useCallback(() => {
    setModel({ step: 'source', info: { status: 'loading' }, held: commerceHeld({ manage, imports: rights }), done: null })
    loadInfo()
  }, [loadInfo, manage, rights])

  const actions: CommerceImportActions = {
    onClose: () => setModel(null),
    onContinue: () => {
      const current = latest.current
      if (!current || continueHeld(current)) return
      setModel(null)
      sheet.open()
    },
    onRetry: () => {
      const current = latest.current
      if (current?.step === 'done' && current.done) loadDone(current.done.jobId)
      else loadInfo()
    },
  }

  const sheetActions: WizardActions = {
    ...sheet.actions,
    onClose: () => {
      const seen = job.current
      sheet.actions.onClose?.()
      // A job that wrote something: the styles it started, with Open.
      if (seen && (seen.status === 'APPLIED' || seen.appliedCount > 0)) {
        setModel({ step: 'done', info: { status: 'loading' }, held: null, done: { jobId: seen.id, styles: { status: 'loading' } } })
        loadDone(seen.id)
      }
    },
  }

  return { state: { model, sheet: sheet.model }, open, actions, sheetActions }
}
