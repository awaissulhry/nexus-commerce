import type { LiveState, Notice, Read } from '../../../quality/_shared/model'
import type { PlansAnswer, RulesAnswer, SubstancesAnswer, VersionsAnswer } from './api'
import type { PageFrame } from './frame/views'
import type { PlanDraft, SubstancesAddress, SubstancesCan, VersionDraft } from './model'

/**
 * The view model of the Substance list, its rules and the test plan rules (B-W2b-267): what the view draws. The container
 * fills it; the view fetches nothing; the design cases build it by hand.
 */

export interface MaterialChoice {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
}

export interface SwitchDialog {
  readonly id: string
  readonly kind: 'rule' | 'plan'
  readonly reason: string
}

export interface PlanDialog {
  /** A plan rule's id, or 'new'. */
  readonly id: string
  readonly draft: PlanDraft
}

export interface SubstancesViewModel {
  readonly prefix: string
  readonly can: SubstancesCan
  readonly online: boolean
  readonly today: string
  readonly frame: PageFrame
  readonly address: SubstancesAddress
  readonly substances: Read<SubstancesAnswer>
  readonly rules: Read<RulesAnswer>
  readonly versions: Read<VersionsAnswer>
  readonly plans: Read<PlansAnswer>
  /** The materials a plan rule may name (read when its dialog opens). */
  readonly materials: Read<readonly MaterialChoice[]>
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly selected: readonly string[]
  readonly notice: Notice | null
  readonly busy: boolean
  readonly switchDialog: SwitchDialog | null
  readonly planDialog: PlanDialog | null
  readonly versionDraft: VersionDraft | null
  readonly starterConfirm: boolean
  readonly keysOpen: boolean
  /** A write refused inside a dialog, in our words. */
  readonly dialogProblem: string | null
}
