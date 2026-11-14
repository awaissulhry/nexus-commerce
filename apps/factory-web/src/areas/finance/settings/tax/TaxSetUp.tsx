'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../_shared/hooks'
import { readProblem, romeToday } from '../../_shared/model'
import { putDepthRules } from '../../invoices/test-mode/api'
import { depthProblem, scoped, type DepthProblem } from '../../invoices/test-mode/depth'
import { DepthStepUp } from '../../invoices/test-mode/view/DepthStepUp'
import { archiveTaxCode, confirmTaxCode, createTaxCode, deleteTaxCode, getTaxCodes, getTaxSettings, newTaxCodeVersion, putTaxSwitch, taxTouched, updateTaxCode, type CompanyTax, type TaxCodes } from './api'
import { codeDraftOf, codeFieldsOf, TAX_REFUSALS, taxSetUpAbilitiesOf, type CodeDraft, type CodeRows, type TaxDialog } from './model'
import { TaxSetUpCard, type TaxSetUpModel } from './view/TaxSetUpCard'

/**
 * Finance settings › Tax set-up's container (B-W2b-417 on B-W2b-392's and B-W2b-401's API), for the company the settings
 * page shows: reads its switches and its tax codes; each write one command with an Idempotency-Key and the version as read
 * (a moved code or row is read again and said); a switch and a code's confirmation ask a fresh authenticator code first.
 */
export function TaxSetUp({ companyId }: { companyId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => taxSetUpAbilitiesOf(session.permissions), [session.permissions])
  const today = romeToday()
  const [company, setCompany] = useState<{ value: CompanyTax | null; problem: string | null }>({ value: null, problem: null })
  const [codes, setCodes] = useState<{ value: TaxCodes | null; problem: string | null }>({ value: null, problem: null })
  const [rows, setRows] = useState<CodeRows>('current')
  const [dialog, setDialog] = useState<TaxDialog | null>(null)
  const [draft, setDraft] = useState<CodeDraft>(codeDraftOf('new', null, today))
  const [ticked, setTicked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DepthProblem | null>(null)
  const [notice, setNotice] = useState<TaxSetUpModel['notice']>(null)
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)

  const read = useCallback(async () => {
    if (!can.view) return
    const [settings, list] = await Promise.allSettled([getTaxSettings(api), getTaxCodes(api, companyId)])
    if (settings.status === 'fulfilled') {
      const mine = settings.value.find((entry) => entry.companyId === companyId) ?? null
      setCompany(mine ? { value: mine, problem: null } : { value: null, problem: 'problem.read.not_found' })
    } else setCompany({ value: null, problem: readProblem(settings.reason) })
    if (list.status === 'fulfilled') setCodes({ value: list.value, problem: null })
    else setCodes({ value: null, problem: readProblem(list.reason) })
  }, [api, can.view, companyId])
  useEffect(() => {
    setCompany({ value: null, problem: null })
    setCodes({ value: null, problem: null })
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 900)
  useLive(
    (change) => {
      if (taxTouched(change)) reread()
    },
    () => reread(),
    can.view,
  )

  /** One write (or a few in a row): busy, the dialog closed and a notice when done, the refusal said inside the dialog. */
  const write = async (work: () => Promise<TaxSetUpModel['notice']>) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      const done = await work()
      setDialog(null)
      setNotice(done)
      await read()
    } catch (error) {
      if (isStepUpCancelled(error)) return
      const words = depthProblem(error, TAX_REFUSALS)
      setProblem(words)
      if (words.reload) void read()
    } finally {
      setBusy(false)
    }
  }

  const model: TaxSetUpModel = { can, today, company, codes, rows, dialog, draft, ticked, busy, problem, notice }
  return (
    <>
      <TaxSetUpCard
        model={model}
        actions={{
          onRows: setRows,
          onRetry: () => void read(),
          onDismissNotice: () => setNotice(null),
          onDraft: (patch) => setDraft((current) => ({ ...current, ...patch })),
          onTick: setTicked,
          onDialog: (next) => {
            setProblem(null)
            setTicked(false)
            if (next?.kind === 'form') setDraft(codeDraftOf(next.mode, next.code, today))
            setDialog(next)
          },
          onSave: () => {
            if (dialog?.kind !== 'form') return
            const { mode, code } = dialog
            const fields = codeFieldsOf(mode, draft)
            void write(async () => {
              if (mode === 'new') {
                const made = await createTaxCode(api, { companyId, country: fields.country ?? 'IT', code: fields.code ?? '', label: fields.label ?? '', ratePct: fields.ratePct ?? '0', validFrom: fields.validFrom ?? today, natura: fields.natura ?? null, legalRef: fields.legalRef ?? null, accountCodeKey: fields.accountCodeKey ?? null, ruleId: fields.ruleId ?? null, validTo: fields.validTo ?? null }, newIdempotencyKey())
                return { tone: 'success', words: { key: 'tax.saved.new', params: { code: made.code } } }
              }
              if (!code) return null
              if (mode === 'version') {
                const next = await newTaxCodeVersion(api, code, { ...fields, validFrom: fields.validFrom ?? today }, newIdempotencyKey())
                return { tone: 'success', words: { key: 'tax.saved.version', params: { code: next.code } } }
              }
              await updateTaxCode(api, code, fields, newIdempotencyKey())
              return { tone: 'success', words: { key: `tax.saved.${mode}`, params: { code: code.code } } }
            })
          },
          onVerb: () => {
            if (dialog?.kind !== 'verb') return
            const { verb, codes: picked } = dialog
            void write(async () => {
              if (verb === 'confirm') await ensureFresh(scoped('tax.stepUp.confirm'))
              for (const code of picked) {
                const key = newIdempotencyKey()
                if (verb === 'archive') await archiveTaxCode(api, code, key)
                else if (verb === 'delete') await deleteTaxCode(api, code, key)
                else await guard(scoped('tax.stepUp.confirm'), () => confirmTaxCode(api, code, key))
              }
              return { tone: 'success', words: { key: `tax.done.${verb}`, params: { count: picked.length } } }
            })
          },
          onSwitch: () => {
            if (dialog?.kind !== 'switch' || !company.value) return
            const { name, on } = dialog
            const current = company.value
            const key = newIdempotencyKey()
            void write(async () => {
              await ensureFresh(scoped('tax.stepUp.switch'))
              if (name === 'selfInvoicesOn') await guard(scoped('tax.stepUp.switch'), () => putDepthRules(api, companyId, { selfInvoicesOn: on }, key))
              else await guard(scoped('tax.stepUp.switch'), () => putTaxSwitch(api, companyId, { ...(current.version !== null ? { version: current.version } : {}), [name]: on }, key))
              return { tone: 'success', words: { key: `tax.switched.${name}.${on ? 'on' : 'off'}` } }
            })
          },
        }}
      />
      <DepthStepUp stepUp={stepUp} onSubmit={(code) => void submitStepUp(code)} onCancel={cancelStepUp} />
    </>
  )
}
