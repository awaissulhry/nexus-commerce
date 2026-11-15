'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { isStepUpCancelled, useStepUp } from '../../../quality/_shared/hooks'
import { useLive } from '../../shipments/hooks'
import { failed, LOADING, ready, words, writeWords } from '../../shipments/queue/shared/depth'
import type { DispatchAbilities } from '../../shipments/pickup/dispatch'
import { addContract, changeContract, listContracts, switchOffContract } from './api'
import { addHeld, changeHeld, CONTRACT_REFUSALS, contractProblem, type ContractsModel } from './model'
import { ContractsView } from './view/ContractsView'

/**
 * Carriers & shipping › Our own carrier contracts (SCR-659; B-W2b-412 on B-W2b-400): reads `GET /shipping/carrier-contracts`
 * of the company with the chosen site (`usedForSite`; again on shipping.carrier_contract_changed); each write is ONE call
 * with its own Idempotency-Key at the contract's version; adding one and a new number ask a fresh code on the API's 403
 * `stepUp` (then once more with the same key). The number typed leaves the screen's state once sent.
 */
export function Contracts({ companyId, siteId, siteCode, can }: { companyId: string; siteId: string | null; siteCode: string | null; can: Pick<DispatchAbilities, 'settingsManage'> }) {
  const api = useOfficeApi()
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const [state, setState] = useState<Omit<ContractsModel, 'stepUp' | 'siteId' | 'siteCode' | 'can'>>({ contracts: LOADING, dialog: null, busy: false, problem: null, done: null })
  const latest = useRef(state)
  latest.current = state
  const key = useRef<string | null>(null)

  const load = useCallback(
    async (quiet: boolean) => {
      if (!quiet) setState((current) => ({ ...current, contracts: current.contracts.state === 'ready' ? current.contracts : LOADING }))
      try {
        const contracts = await listContracts(api, { companyId, siteId })
        setState((current) => ({ ...current, contracts: ready(contracts) }))
      } catch (error) {
        setState((current) => (quiet && current.contracts.state === 'ready' ? current : { ...current, contracts: failed(error) }))
      }
    },
    [api, companyId, siteId],
  )
  useEffect(() => {
    void load(false)
  }, [load])
  useLive(
    (change) => {
      if (change.type === 'shipping.carrier_contract_changed') void load(true)
    },
    () => void load(true),
  )

  const go = async () => {
    const current = latest.current
    const dialog = current.dialog
    if (!dialog || current.busy || current.contracts.state !== 'ready' || contractProblem(dialog)) return
    const contract = dialog.kind === 'add' ? null : current.contracts.value.find((row) => row.id === dialog.contractId)
    if (dialog.kind !== 'add' && (!contract || changeHeld(contract, can, false))) return
    if (dialog.kind === 'add' && addHeld(can, false)) return
    key.current ??= newIdempotencyKey()
    const idempotencyKey = key.current
    setState({ ...current, busy: true, problem: null })
    try {
      let done
      switch (dialog.kind) {
        case 'add': {
          const answer = await guard('contracts.stepUp', () => addContract(api, { companyId, siteId: dialog.everySite || !siteId ? null : siteId, carrierCode: dialog.carrierCode.trim(), accountNumber: dialog.accountNumber.trim(), ownRatesOnly: dialog.ownRatesOnly }, idempotencyKey))
          done = words('contracts.done.added', { carrier: answer.contract.carrierName, end: answer.endsIn })
          break
        }
        case 'number': {
          const answer = await guard('contracts.stepUp', () => changeContract(api, contract!.id, { version: contract!.version, accountNumber: dialog.accountNumber.trim() }, idempotencyKey))
          done = words('contracts.done.number', { carrier: answer.contract.carrierName, end: answer.endsIn ?? '' })
          break
        }
        case 'rates': {
          const answer = await changeContract(api, contract!.id, { version: contract!.version, ownRatesOnly: dialog.ownRatesOnly }, idempotencyKey)
          done = words(answer.contract.ownRatesOnly ? 'contracts.done.ratesOn' : 'contracts.done.ratesOff', { carrier: answer.contract.carrierName })
          break
        }
        case 'off': {
          const answer = await switchOffContract(api, contract!.id, contract!.version, idempotencyKey)
          done = words('contracts.done.off', { carrier: answer.contract.carrierName })
          break
        }
      }
      key.current = null
      // The typed number leaves the screen's state with the dialog.
      setState((now) => ({ ...now, busy: false, dialog: null, done }))
      void load(true)
    } catch (error) {
      if (isStepUpCancelled(error)) return setState((now) => ({ ...now, busy: false, problem: words('contracts.stepUpCancelled') }))
      const problem = writeWords(error, 'contracts.refusal', CONTRACT_REFUSALS)
      setState((now) => ({ ...now, busy: false, problem: problem.key === 'problem.write.invalid' ? words('contracts.problem.invalid') : { key: problem.key, params: problem.params } }))
      if (problem.reload) void load(true)
    }
  }

  return (
    <ContractsView
      model={{ ...state, siteId, siteCode, can, stepUp }}
      actions={{
        onDialog: (dialog) => {
          if (latest.current.busy) return
          key.current = null
          setState((current) => ({ ...current, dialog, problem: null }))
        },
        onGo: () => void go(),
        onRetry: () => void load(false),
        onDismiss: () => setState((current) => ({ ...current, done: null, problem: null })),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
