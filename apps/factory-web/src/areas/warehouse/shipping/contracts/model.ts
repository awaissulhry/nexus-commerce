import { ACCOUNT_NUMBER, CARRIER_CODE, CONTRACT_REFUSALS } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import { words, type Read, type Words } from '../../shipments/queue/shared/depth'
import type { DispatchAbilities } from '../../shipments/pickup/dispatch'
import type { StepUpView } from '../test-mode/settings-card'
import type { Contract } from './api'

/**
 * Our own carrier contracts, pure (SCR-659; design warehouse.shipping sec sp-carrier "W2b own carrier contracts (LOG-033)",
 * "credentials are stored sealed and never shown: 'Replace credentials…'", "Connect or Replace credentials → StepUpModal"):
 * the dialogs' fields and problems, what holds each action, the contract's scope and state in words.
 */

export { CONTRACT_REFUSALS }

export type ContractDialog =
  | null
  | { readonly kind: 'add'; readonly carrierCode: string; readonly everySite: boolean; readonly accountNumber: string; readonly ownRatesOnly: boolean }
  | { readonly kind: 'number'; readonly contractId: string; readonly accountNumber: string }
  | { readonly kind: 'rates'; readonly contractId: string; readonly ownRatesOnly: boolean }
  | { readonly kind: 'off'; readonly contractId: string }

/** A dialog's problem in words (null: it may be sent). */
export function contractProblem(dialog: Exclude<ContractDialog, null>): Words | null {
  if (dialog.kind === 'add' && !CARRIER_CODE.test(dialog.carrierCode.trim())) return words('contracts.problem.carrier')
  if ((dialog.kind === 'add' || dialog.kind === 'number') && !ACCOUNT_NUMBER.test(dialog.accountNumber.trim())) return words('contracts.problem.number')
  return null
}

/** Why Add a contract is held. */
export function addHeld(can: Pick<DispatchAbilities, 'settingsManage'>, busy: boolean): Words | null {
  if (!can.settingsManage) return words('contracts.held.noRight')
  if (busy) return words('contracts.held.busy')
  return null
}

/** Why a change of one contract is held. */
export function changeHeld(contract: Contract, can: Pick<DispatchAbilities, 'settingsManage'>, busy: boolean): Words | null {
  if (!can.settingsManage) return words('contracts.held.noRight')
  if (!contract.active) return words('contracts.refusal.SWITCHED_OFF')
  if (busy) return words('contracts.held.busy')
  return null
}

/** Where a contract applies, in words: one site, or every site of the company. */
export const scopeWords = (contract: Pick<Contract, 'siteId' | 'siteCode'>): Words => (contract.siteId ? words('contracts.scope.site', { site: contract.siteCode ?? '—' }) : words('contracts.scope.every'))

/** Live contracts first, then the switched-off ones; by carrier, then the site's before every site's. */
export const contractOrder = (rows: readonly Contract[]): Contract[] =>
  [...rows].sort((a, b) => Number(b.active) - Number(a.active) || a.carrierCode.localeCompare(b.carrierCode) || Number(a.siteId === null) - Number(b.siteId === null))

export interface ContractsModel {
  readonly contracts: Read<readonly Contract[]>
  readonly siteId: string | null
  readonly siteCode: string | null
  readonly can: Pick<DispatchAbilities, 'settingsManage'>
  readonly dialog: ContractDialog
  readonly busy: boolean
  readonly problem: Words | null
  readonly done: Words | null
  readonly stepUp: StepUpView
}

export interface ContractsActions {
  onDialog?: (dialog: ContractDialog) => void
  onGo?: () => void
  onRetry?: () => void
  onDismiss?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}
