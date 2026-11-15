import { TEST_MODE_REFUSALS } from '@nexus/factory-domain/shipping/test-mode/rules'
import { words, type Read, type Words } from '../../shipments/queue/shared/depth'
import type { DispatchAbilities } from '../../shipments/pickup/dispatch'
import type { StepUpView } from './settings-card'
import type { TestModeSite } from './api'

/**
 * Test mode, pure (SCR-656; design warehouse.shipping sec sp-test "A test carrier that makes labels marked TEST and sends
 * nothing (LOG-035)": "Toggle with the words of what it does", "ActionConfirm when switching to live"; pop sp-golive "Switch to
 * live labels: 'Labels will be bought and charged from now on'"): what holds each switch and with which words.
 */

export { TEST_MODE_REFUSALS }

/** Why Switch to live labels is held (null: it may go): the API's code first, then the right and a write running. */
export function liveHeld(site: TestModeSite, can: Pick<DispatchAbilities, 'settingsManage'>, busy: boolean): Words | null {
  if (!can.settingsManage) return words('test.held.noRight')
  if (!site.testMode) return words('test.refusal.ALREADY_LIVE')
  if (!site.goLive.ready) return words(`test.refusal.${site.goLive.refusal?.code ?? 'NO_SETTINGS'}`)
  if (busy) return words('test.held.busy')
  return null
}

/** Why Back to test mode is held. */
export function testHeld(site: TestModeSite, can: Pick<DispatchAbilities, 'settingsManage'>, busy: boolean): Words | null {
  if (!can.settingsManage) return words('test.held.noRight')
  if (site.testMode) return words('test.refusal.ALREADY_TEST')
  if (busy) return words('test.held.busy')
  return null
}

export interface TestModeModel {
  /** Every site the reader reaches (the chosen one is drawn; the others counted). */
  readonly sites: Read<readonly TestModeSite[]>
  readonly siteId: string | null
  readonly can: Pick<DispatchAbilities, 'settingsManage'>
  /** The confirm open: going live or back to test. */
  readonly confirm: null | 'live' | 'test'
  readonly busy: boolean
  readonly problem: Words | null
  readonly done: Words | null
  readonly stepUp: StepUpView
}

export interface TestModeActions {
  onConfirm?: (confirm: 'live' | 'test' | null) => void
  onGo?: () => void
  onRetry?: () => void
  onDismiss?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}
