'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { dryRun, FORMAT_EXTENSIONS, importStatement, listAccounts, uploadStatement, type BankFormat, type ReadAsk, type StatementColumn } from './api'
import { formatOfName, isSheet, mappingOf, readProblem, writeProblem, type BankCan } from './model'
import type { ImportModel } from './view/ImportDialog'

const START: ImportModel = { step: 'file', fileName: null, format: null, accounts: null, accountsProblem: null, accountId: null, plan: null, mapping: {}, numberFormat: 'it', sheetName: null, skipErrors: false, busy: false, problems: null, imported: null }

/**
 * Import a bank statement (B-W2b-406 on B-W2b-393's routes; design pop:import): the file chosen → uploaded ONCE (announce,
 * PUT to the store, confirm) → the dry run (`POST …/statements/dry-run`: every line NEW / DUPLICATE / ERROR; a CSV or Excel
 * sheet comes back with its mapping, mapped again until `ready`) → "Import n lines" (`POST …/statements` with the dry run's
 * count as `expectNew`, lines that cannot be read only with `skipErrors`; one Idempotency-Key per import) → done (the lines
 * and their suggestions; the page reads again).
 */
export function useImport(api: ApiClient, can: BankCan, companyId: string | null, open: boolean, onImported: () => void) {
  const [model, setModel] = useState<ImportModel>(START)
  const file = useRef<File | null>(null)
  const uploaded = useRef<{ fileId: string; format: BankFormat } | null>(null)
  const importKey = useRef(newIdempotencyKey())

  // Opened: the company's accounts (a sheet needs one chosen).
  useEffect(() => {
    if (!open || !companyId || model.accounts !== null || model.accountsProblem !== null) return
    listAccounts(api, companyId)
      .then((accounts) => setModel((state) => ({ ...state, accounts })))
      .catch((error: unknown) => setModel((state) => ({ ...state, accountsProblem: readProblem(error) })))
  }, [open, companyId, api, model.accounts, model.accountsProblem])

  const reset = useCallback(() => {
    file.current = null
    uploaded.current = null
    importKey.current = newIdempotencyKey()
    setModel(START)
  }, [])

  const ask = (state: ImportModel, fileId: string): ReadAsk => ({
    fileId,
    ...(state.format ? { format: state.format } : {}),
    ...(state.accountId ? { bankAccountId: state.accountId } : {}),
    ...(isSheet(state.format) && state.plan?.mapping ? { mapping: { ...state.mapping } } : {}),
    ...(isSheet(state.format) ? { numberFormat: state.numberFormat } : {}),
    ...(state.sheetName ? { sheetName: state.sheetName } : {}),
  })

  const read = async () => {
    if (!companyId || !can.import || !can.upload || model.busy) return
    const state = model
    if (!file.current || !state.format) return
    setModel((current) => ({ ...current, busy: true, problems: null, step: current.step === 'file' ? 'reading' : current.step }))
    try {
      if (!uploaded.current || uploaded.current.format !== state.format) {
        const sent = await uploadStatement(api, companyId, file.current, state.format)
        uploaded.current = { fileId: sent.fileId, format: sent.format }
      }
      const plan = await dryRun(api, ask(state, uploaded.current.fileId))
      const mapping = plan.mapping ? mappingOf(plan) : {}
      importKey.current = newIdempotencyKey()
      setModel((current) => ({ ...current, busy: false, plan, mapping, sheetName: plan.sheet?.name ?? current.sheetName, accountId: current.accountId ?? plan.account.id, step: isSheet(state.format) && !plan.ready ? 'mapping' : 'review' }))
    } catch (error) {
      setModel((current) => ({ ...current, busy: false, problems: writeProblem(error), step: current.step === 'reading' ? 'file' : current.step }))
    }
  }

  const run = async () => {
    const state = model
    if (!uploaded.current || !state.plan || state.busy) return
    setModel((current) => ({ ...current, busy: true, problems: null, step: 'importing' }))
    try {
      const imported = await importStatement(api, { ...ask(state, uploaded.current.fileId), expectNew: state.plan.counts.new, ...(state.skipErrors ? { skipErrors: true } : {}) }, importKey.current)
      setModel((current) => ({ ...current, busy: false, imported, step: 'done' }))
      onImported()
    } catch (error) {
      setModel((current) => ({ ...current, busy: false, problems: writeProblem(error), step: 'review' }))
    }
  }

  return {
    model,
    reset,
    actions: {
      onFile: (chosen: File | null) => {
        file.current = chosen
        uploaded.current = null
        setModel((state) => ({ ...START, accounts: state.accounts, accountsProblem: state.accountsProblem, fileName: chosen?.name ?? null, format: chosen ? formatOfName(chosen.name, FORMAT_EXTENSIONS) : null }))
      },
      onFormat: (format: BankFormat) => setModel((state) => ({ ...state, format, plan: null, mapping: {}, step: 'file' })),
      onAccount: (accountId: string | null) => setModel((state) => ({ ...state, accountId })),
      onRead: () => void read(),
      onMapping: (header: string, column: StatementColumn | null) => setModel((state) => ({ ...state, mapping: { ...state.mapping, [header]: column } })),
      onNumberFormat: (numberFormat: 'it' | 'en') => setModel((state) => ({ ...state, numberFormat })),
      onSheet: (sheetName: string) => setModel((state) => ({ ...state, sheetName })),
      onSkipErrors: (skipErrors: boolean) => setModel((state) => ({ ...state, skipErrors })),
      onImport: () => void run(),
      onBack: () => setModel((state) => ({ ...state, step: isSheet(state.format) && state.plan?.mapping ? 'mapping' : 'file', problems: null })),
    },
  }
}
