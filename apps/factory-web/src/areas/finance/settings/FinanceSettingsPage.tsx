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
import type { BankInput, FinanceSettingsModel } from './settings-model'
import { FinanceSettingsView } from './view/FinanceSettingsView'

/**
 * `/w/<company>/finance/settings` (SCR-083): reads what invoicing reads per company (GET /invoicing/settings:
 * invoices.view) and the company's bank account (companies.bank.view), and saves the bank account (companies.bank.manage
 * and a fresh authenticator code, asked first). The address's company is shown first.
 */
export function FinanceSettingsPage() {
  return (
    <WithMessages namespaces={['finance']}>
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

  const model: FinanceSettingsModel = { prefix, can, settings, companyId, bank, editingBank, busy, notice, bankProblem, stepUp }
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
      }}
    />
  )
}
