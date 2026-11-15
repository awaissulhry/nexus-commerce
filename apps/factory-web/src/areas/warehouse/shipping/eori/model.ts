import { eoriOf } from '@nexus/factory-domain/shipping/customs/rules'
import { words, type Read, type Words } from '../../shipments/queue/shared/depth'
import type { DispatchAbilities } from '../../shipments/pickup/dispatch'
import type { StepUpView } from '../test-mode/settings-card'
import type { CustomsSettings } from './api'

/**
 * EORI, pure (SCR-658; design warehouse.shipping sec sp-eori "Each company's EORI for customs documents (LOG-095)": a Field;
 * B-W2b-409's broker-pack switch per site beside it): the typed EORI normalised as the API keeps it (capitals, no spaces, dots
 * or dashes), its problem in words, what holds Save and the switch.
 */

export const EORI_MAX = 40

/** The EORI as it will be kept, or null when it is not one (empty: clearing it). */
export function eoriProblem(typed: string): Words | null {
  if (typed.trim() === '') return null
  return eoriOf(typed) ? null : words('eori.problem')
}

/** Why Save is held (null: it may be saved). */
export function saveHeld(settings: CustomsSettings, typed: string, can: Pick<DispatchAbilities, 'settingsManage'>, busy: boolean): Words | null {
  if (!can.settingsManage || !settings.company.mayManage) return words('eori.held.noRight')
  const problem = eoriProblem(typed)
  if (problem) return problem
  const next = typed.trim() === '' ? null : eoriOf(typed)
  if (next === settings.company.eori) return words('eori.held.same')
  if (busy) return words('eori.held.busy')
  return null
}

/** Why the chosen site's broker-pack switch is held. */
export function packSwitchHeld(site: CustomsSettings['sites'][number], can: Pick<DispatchAbilities, 'settingsManage'>, busy: boolean): Words | null {
  if (!can.settingsManage || !site.mayManage) return words('eori.held.noRight')
  if (!site.hasSettings || site.version === null) return words('eori.held.noSettings')
  if (busy) return words('eori.held.busy')
  return null
}

export interface EoriModel {
  readonly settings: Read<CustomsSettings>
  readonly siteId: string | null
  readonly typed: string | null
  readonly can: Pick<DispatchAbilities, 'settingsManage'>
  /** The broker-pack switch's confirm open (on: papers go to a third party). */
  readonly confirm: null | 'on' | 'off'
  readonly busy: boolean
  readonly problem: Words | null
  readonly done: Words | null
  readonly stepUp: StepUpView
}

export interface EoriActions {
  onType?: (typed: string) => void
  onSave?: () => void
  onConfirm?: (confirm: 'on' | 'off' | null) => void
  onSwitch?: () => void
  onRetry?: () => void
  onDismiss?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}
