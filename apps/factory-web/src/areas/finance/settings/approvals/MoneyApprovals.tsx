'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { collectionsSettings, setCollections, type CollectionsSettings } from '../../payments/riba/api'
import { payProblem, scoped, type PayProblem, type Phrase } from '../../payments/riba/depth'
import { PayStepUp } from '../../payments/riba/view/PayStepUp'
import { moneyControls, remittanceSettings, setRemittance, type MoneyControls, type RemittanceSettings } from './api'
import { approvalsCanOf, approvalsTouched, type SwitchName } from './model'
import { ApprovalsCard } from './view/ApprovalsCard'

/**
 * Approvals & notifications' container (B-W2b-425 on B-W2b-403's and B-W2b-402's API; Finance › Settings, the company shown):
 * reads the money controls and the two mail switches (payables.view; the customer notice with receivables.view), and moves a
 * switch — the Owner's: turning one ON asks a fresh code FIRST; one write each with an Idempotency-Key and the row's version.
 * Live: a settings change or an approval rule reads it again.
 */
export function MoneyApprovals({ companyId }: { companyId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => approvalsCanOf(session.permissions), [session.permissions])
  const receivables = session.permissions.includes('receivables.view')
  const [controls, setControls] = useState<MoneyControls | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [remittance, setRemittanceState] = useState<RemittanceSettings | null>(null)
  const [collections, setCollectionsState] = useState<CollectionsSettings | null>(null)
  const [busy, setBusy] = useState<SwitchName | null>(null)
  const [switchProblem, setSwitchProblem] = useState<PayProblem | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)

  const read = useCallback(async () => {
    if (!can.view) return
    try {
      const [nextControls, nextRemittance, nextCollections] = await Promise.all([moneyControls(api, companyId), remittanceSettings(api, companyId), receivables ? collectionsSettings(api, companyId) : Promise.resolve(null)])
      setControls(nextControls)
      setRemittanceState(nextRemittance)
      setCollectionsState(nextCollections)
      setProblem(null)
    } catch (error) {
      setProblem(readProblem(error))
    }
  }, [api, companyId, can.view, receivables])
  useEffect(() => {
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 700)
  useLive(
    (change) => {
      if (approvalsTouched(change)) reread()
    },
    () => reread(),
    can.view,
  )

  const move = (name: SwitchName, on: boolean) => {
    if (busy) return
    setBusy(name)
    setSwitchProblem(null)
    setNotice(null)
    const key = newIdempotencyKey()
    // B-W2b-GB02 (G088): + the automatic carry's own sentence.
    const sentence = scoped(name === 'remittance' ? 'stepUp.remittance' : name === 'autoCarry' ? 'stepUp.autoCarry' : 'stepUp.notice')
    void (async () => {
      try {
        if (on) await ensureFresh(sentence)
        if (name === 'remittance') {
          const next = await guard(sentence, () => setRemittance(api, { companyId, remittanceMailOn: on, ...(remittance?.source === 'COMPANY' && remittance.version !== null ? { version: remittance.version } : {}) }, key))
          setRemittanceState(next)
        } else {
          // B-W2b-GB02 (G088): the collections row holds the notice and the automatic carry.
          const next = await guard(sentence, () => setCollections(api, { companyId, ...(name === 'autoCarry' ? { depositAutoCarryOn: on } : { paymentNoticeToCustomerOn: on }), ...(collections?.source === 'COMPANY' && collections.version !== null ? { version: collections.version } : {}) }, key))
          setCollectionsState(next)
        }
        setNotice({ key: scoped(`approvals.notice.${name}.${on ? 'on' : 'off'}`) })
      } catch (error) {
        if (!isStepUpCancelled(error)) {
          setSwitchProblem(payProblem(error, 'approvals', []))
          void read()
        }
      } finally {
        setBusy(null)
      }
    })()
  }

  return (
    <>
      <ApprovalsCard model={{ can, controls, problem, remittance, collections, busy, switchProblem, notice }} actions={{ onRetry: () => void read(), onSwitch: move, onDismissNotice: () => setNotice(null) }} />
      <PayStepUp stepUp={stepUp} onSubmit={(code) => void submitStepUp(code)} onCancel={cancelStepUp} />
    </>
  )
}
