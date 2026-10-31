'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { getBankDetails, getFinanceSettings, saveBankDetails, type BankDetails, type FinanceSettings } from '../_shared/api'
import { isStepUpCancelled, useStepUp } from '../_shared/hooks'
import { abilitiesOf, readProblem, writeProblem } from '../_shared/model'
import type { Loaded, Part } from '../invoices/record/record-model'
import { useCoalesced, useLive } from '../_shared/hooks'
import { chooseMethod, readMethod, type DecidedMethod, type MethodState } from './costing/api'
import { chooseProblem, costingAbilitiesOf, costingTouched } from './costing/model'
import type { BankInput, FinanceSettingsModel } from './settings-model'
import { createTerms, listTerms, moveTerms, updateTerms, type PaymentTerms } from './terms/api'
import { fieldsOf, patchOf, rulesChanged, termsAbilitiesOf, termsStatusOf, termsTouched, termsWriteProblem, type TermsDraft, type TermsRows } from './terms/model'
import type { TermsSectionModel } from './terms/view/TermsSection'
import { FinanceSettingsView } from './view/FinanceSettingsView'

/**
 * `/w/<company>/finance/settings` (SCR-083): reads what invoicing reads per company (GET /invoicing/settings:
 * invoices.view) and the company's bank account (companies.bank.view), and saves the bank account (companies.bank.manage
 * and a fresh authenticator code, asked first). The address's company is shown first.
 */
export function FinanceSettingsPage() {
  return (
    <WithMessages namespaces={['finance', 'finance-daily', 'finance-costing', 'lists']}>
      <SettingsContainer />
    </WithMessages>
  )
}

function SettingsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/finance\/settings\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const [settings, setSettings] = useState<Loaded<FinanceSettings>>({ status: 'loading' })
  const [companyId, setCompanyId] = useState<string | null>(session.company?.id ?? null)
  const [bank, setBank] = useState<Part<BankDetails> | null>(can.viewBank ? { value: null, problem: null } : null)
  const [editingBank, setEditingBank] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<FinanceSettingsModel['notice']>(null)
  const [bankProblem, setBankProblem] = useState<FinanceSettingsModel['bankProblem']>(null)
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)
  // B-W2a-80: the payment terms library and the costing method of the company shown.
  const termsCan = useMemo(() => termsAbilitiesOf(session.permissions), [session.permissions])
  const costingCan = useMemo(() => costingAbilitiesOf(session.permissions), [session.permissions])
  const [termsRows, setTermsRows] = useState<TermsRows>('active')
  const [terms, setTerms] = useState<{ value: PaymentTerms[] | null; problem: string | null }>({ value: null, problem: null })
  const [termsDialog, setTermsDialog] = useState<TermsSectionModel['dialog']>(null)
  const [termsProblem, setTermsProblem] = useState<TermsSectionModel['dialogProblem']>(null)
  const [termsNotice, setTermsNotice] = useState<TermsSectionModel['notice']>(null)
  const [method, setMethod] = useState<{ value: MethodState | null; problem: string | null; forbidden?: boolean }>({ value: null, problem: null })
  const [choosing, setChoosing] = useState<DecidedMethod | null>(null)
  const [methodProblem, setMethodProblem] = useState<FinanceSettingsModel['bankProblem']>(null)

  const readTermsList = useCallback(async () => {
    if (!termsCan.view) return
    setTerms((current) => ({ value: current.value, problem: null }))
    try {
      setTerms({ value: await listTerms(api, companyId, termsStatusOf(termsRows)), problem: null })
    } catch (error) {
      setTerms({ value: null, problem: readProblem(error) })
    }
  }, [api, companyId, termsCan.view, termsRows])

  const readCosting = useCallback(async () => {
    if (!costingCan.view || !companyId) return
    setMethod({ value: null, problem: null })
    try {
      setMethod({ value: await readMethod(api, companyId), problem: null })
    } catch (error) {
      if (isApiError(error) && error.kind === 'forbidden') setMethod({ value: null, problem: null, forbidden: true })
      else setMethod({ value: null, problem: readProblem(error) })
    }
  }, [api, companyId, costingCan.view])

  useEffect(() => {
    void readTermsList()
  }, [readTermsList])
  useEffect(() => {
    void readCosting()
  }, [readCosting])
  const reread = useCoalesced(() => {
    void readTermsList()
    void readCosting()
  }, 800)
  useLive(
    (change) => {
      if (termsTouched(change) || costingTouched(change)) reread()
    },
    () => reread(),
  )

  const load = useCallback(async () => {
    try {
      const answer = await getFinanceSettings(api)
      setSettings({ status: 'ready', value: answer })
      setCompanyId((current) => (current && answer.companies.some((entry) => entry.id === current) ? current : (answer.companies[0]?.id ?? null)))
    } catch (error) {
      if (isApiError(error) && error.kind === 'forbidden') setSettings({ status: 'forbidden' })
      else setSettings({ status: 'error', problem: readProblem(error) })
    }
  }, [api])

  const readBank = useCallback(async () => {
    if (!can.viewBank || !companyId) return
    setBank({ value: null, problem: null })
    try {
      setBank({ value: await getBankDetails(api, companyId), problem: null })
    } catch (error) {
      setBank({ value: null, problem: readProblem(error) })
    }
  }, [api, can.viewBank, companyId])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void readBank()
  }, [readBank])

  const saveBank = useCallback(
    async (input: BankInput) => {
      const current = bank?.value
      if (busy || !current || !companyId) return
      setBusy(true)
      setBankProblem(null)
      const key = newIdempotencyKey()
      const blank = (value: string) => (value.trim() === '' ? null : value.trim())
      try {
        await ensureFresh('stepUp.sentence.bank')
        const saved = await guard('stepUp.sentence.bank', () =>
          saveBankDetails(api, companyId, { version: current.version, accountHolder: blank(input.accountHolder), iban: blank(input.iban.replace(/\s+/g, '').toUpperCase()), bic: blank(input.bic.toUpperCase()), bankName: blank(input.bankName) }, key),
        )
        setBank({ value: saved, problem: null })
        setEditingBank(false)
        setNotice({ tone: 'success', words: { key: 'notice.bankSaved' } })
      } catch (error) {
        if (isStepUpCancelled(error)) return
        const words = writeProblem(error)
        setBankProblem(words)
        if (words.reload) void readBank()
      } finally {
        setBusy(false)
      }
    },
    [api, bank, busy, companyId, ensureFresh, guard, readBank],
  )

  const saveTerms = async (dialog: NonNullable<TermsSectionModel['dialog']>, draft: TermsDraft) => {
    if (busy) return
    setBusy(true)
    setTermsProblem(null)
    const key = newIdempotencyKey()
    const changed = dialog.mode === 'edit' ? rulesChanged(dialog.terms, draft) : true
    try {
      const saved = dialog.mode === 'edit' ? await updateTerms(api, dialog.terms, patchOf(dialog.terms, draft), key) : await createTerms(api, { ...fieldsOf(draft), companyId }, key)
      setTermsDialog(null)
      setTermsNotice({ tone: 'success', words: { key: dialog.mode === 'edit' ? 'terms.saved' : 'terms.created', params: { code: saved.code } } })
      void readTermsList()
    } catch (error) {
      const words = termsWriteProblem(error, changed)
      setTermsProblem(words)
      if (words.reload) void readTermsList()
    } finally {
      setBusy(false)
    }
  }

  const moveMany = async (rows: PaymentTerms[], move: 'archive' | 'reactivate') => {
    if (busy || rows.length === 0) return
    setBusy(true)
    let done = 0
    let refused = 0
    for (const row of rows) {
      try {
        await moveTerms(api, row, move, newIdempotencyKey())
        done += 1
      } catch {
        refused += 1
      }
    }
    setBusy(false)
    setTermsNotice(refused === 0 ? { tone: 'success', words: { key: `terms.moved.${move}`, params: { count: done } } } : { tone: 'danger', words: { key: 'terms.movedSome', params: { done, refused } } })
    void readTermsList()
  }

  const choose = async (input: { method: DecidedMethod; reason: string }) => {
    const current = method.value
    if (busy || !companyId || !current) return
    setBusy(true)
    setMethodProblem(null)
    const key = newIdempotencyKey()
    try {
      await ensureFresh('stepUp.sentence.costing')
      const saved = await guard('stepUp.sentence.costing', () => chooseMethod(api, { companyId, method: input.method, version: current.from === 'COMPANY' ? current.version : null, reason: input.reason || null }, key))
      setMethod({ value: saved, problem: null })
      setChoosing(null)
      setNotice({ tone: 'success', words: { key: 'notice.methodChosen' } })
    } catch (error) {
      if (isStepUpCancelled(error)) return
      const words = chooseProblem(error)
      setMethodProblem(words)
      if (words.reload) void readCosting()
    } finally {
      setBusy(false)
    }
  }

  const model: FinanceSettingsModel = {
    prefix,
    can,
    settings,
    companyId,
    bank,
    editingBank,
    busy,
    notice,
    bankProblem,
    stepUp,
    terms: termsCan.view ? { can: termsCan, rows: termsRows, terms: terms.value, problem: terms.problem, dialog: termsDialog, busy, dialogProblem: termsProblem, notice: termsNotice } : null,
    costing: { can: costingCan, method, choosing, busy, problem: methodProblem },
  }
  return (
    <FinanceSettingsView
      key={`${companyId ?? ''}-${bank?.value?.version ?? 0}-${editingBank ? 'edit' : 'read'}`}
      model={model}
      actions={{
        onRetry: () => void load(),
        onRetryBank: () => void readBank(),
        onCompany: (id) => {
          setCompanyId(id)
          setEditingBank(false)
        },
        onEditBank: (editing) => {
          setEditingBank(editing)
          setBankProblem(null)
        },
        onSaveBank: (input) => void saveBank(input),
        onDismissNotice: () => setNotice(null),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
        terms: {
          onRows: (next) => setTermsRows(next),
          onRetry: () => void readTermsList(),
          onDialog: (next) => {
            setTermsDialog(next)
            setTermsProblem(null)
          },
          onSave: (dialog, draft) => void saveTerms(dialog, draft),
          onMove: (rows, move) => void moveMany(rows, move),
          onDismissNotice: () => setTermsNotice(null),
        },
        costing: {
          onRetry: () => void readCosting(),
          onPick: (next) => {
            setChoosing(next)
            setMethodProblem(null)
          },
          onChoose: (input) => void choose(input),
        },
      }}
    />
  )
}
