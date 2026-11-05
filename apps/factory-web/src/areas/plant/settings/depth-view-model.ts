import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import type { StepUpState } from '../_shared/parts'
import type { CheckType, CheckTypesRead, EmployeePick, IncidentRules, LockRead, RoutingPreview, RoutingRead, RoutingRule, TeamPick } from './depth-api'
import type { DepthProblem, LockDraft, RuleDraft, Said, TypeDraft, TypeRows } from './depth-model'

/**
 * The view model of Plant settings' W2b sections (SCR-241): what the container read and what is in flight, section by
 * section (each reads and fails on its own), the one dialog open, the fresh-code dialog and the leave guard. The views
 * fetch nothing.
 */

/** A section's read: its own loading and its own failure (the other sections keep working). */
export type Section<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface SiteChoice {
  readonly id: string
  readonly name: string
  readonly code?: string
}

/** The rights the screen asks beside what each read's `canManage` says. */
export interface DepthCan {
  /** people.view: the team and person pickers of a routing rule. */
  readonly people: boolean
  /** audit.read: ⋯ History (audit log). */
  readonly audit: boolean
  /** safety.incidents.view: the Incidents card. */
  readonly incidents: boolean
}

export interface DepthNotice extends Said {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
}

export interface RoutingState {
  readonly read: Section<RoutingRead>
  readonly busy: boolean
  /** "Where does a request go?": the machine type tried and the API's answer. */
  readonly preview: { readonly classId: string | null; readonly read: Section<RoutingPreview> | { status: 'idle' } }
  /** Design cases: rows selected. */
  readonly selected?: readonly string[]
}

export interface LockState {
  readonly read: Section<LockRead>
  /** The card's edit (null: as read). */
  readonly draft: LockDraft | null
  readonly busy: boolean
  readonly problem: DepthProblem | null
}

export interface ChecksState {
  readonly read: Section<CheckTypesRead>
  readonly rows: TypeRows
  readonly busy: boolean
  /** Design cases. */
  readonly selected?: readonly string[]
  readonly query?: string
}

/** The pickers of a routing rule (people.view): the site's teams and the company's people. */
export type Pickers = Section<{ teams: readonly TeamPick[]; employees: readonly EmployeePick[] }> | { status: 'forbidden' }

export type DepthDialog =
  | { kind: 'rule'; draft: RuleDraft; busy: boolean; problem: DepthProblem | null; pickers: Pickers; confirmRemove?: boolean }
  | { kind: 'removeRules'; ids: readonly string[]; busy: boolean; problem: DepthProblem | null }
  | { kind: 'type'; draft: TypeDraft; busy: boolean; problem: DepthProblem | null }
  | { kind: 'typeState'; ids: readonly string[]; active: boolean; busy: boolean; problem: DepthProblem | null }
  | { kind: 'keys' }

export interface DepthModel {
  readonly can: DepthCan
  /** The site the routing and the lock are for (the top bar's, else the one chosen here, else the first). */
  readonly site: SiteChoice | null
  readonly sites: readonly SiteChoice[]
  /** The site is the top bar's (said beside it). */
  readonly siteFromTopBar: boolean
  readonly live: 'connecting' | 'live' | 'offline'
  readonly asOf: string | null
  readonly save: SaveStatusState
  /** Someone else changed these settings: "Changed by someone else · Reload". */
  readonly changedElsewhere: boolean
  readonly notice: DepthNotice | null
  readonly routing: RoutingState
  readonly lock: LockState
  readonly checks: ChecksState
  readonly incidents: Section<IncidentRules> | { status: 'forbidden' }
  readonly dialog: DepthDialog | null
  readonly stepUp: StepUpState
  /** Leaving with the lock card's edits: Save · Discard · Stay. */
  readonly leaving: { busy: boolean } | null
  /** The audit log's address (a new tab). */
  readonly historyHref: string
}

export interface DepthActions {
  onSite?: (siteId: string) => void
  onReload?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: DepthDialog | null) => void
  // routing
  onRoutingRetry?: () => void
  onRuleNew?: () => void
  onRuleOpen?: (rule: RoutingRule) => void
  onRuleSwitch?: (ids: readonly string[], active: boolean) => void
  onRuleMove?: (ids: readonly string[], delta: -1 | 1) => void
  onRuleRemoveMany?: (ids: readonly string[]) => void
  onPreviewClass?: (classId: string | null) => void
  onRuleDraft?: (patch: Partial<RuleDraft>) => void
  onRuleSave?: () => void
  /** Remove from the rule's dialog: ask (true) or keep it (false). */
  onRuleRemove?: (ask: boolean) => void
  onRemoveConfirm?: () => void
  // lock
  onLockRetry?: () => void
  onLockDraft?: (patch: Partial<LockDraft>) => void
  onLockSave?: () => void
  onLockDiscard?: () => void
  // check types
  onChecksRetry?: () => void
  onTypeRows?: (rows: TypeRows) => void
  onTypeNew?: () => void
  onTypeOpen?: (type: CheckType) => void
  onTypeDraft?: (patch: Partial<TypeDraft>) => void
  onTypeSave?: () => void
  onTypeState?: (ids: readonly string[], active: boolean) => void
  onTypeStateConfirm?: () => void
  // incidents
  onIncidentsRetry?: () => void
  // the fresh code, leaving
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  onLeaveSave?: () => void
  onLeaveDiscard?: () => void
  onLeaveStay?: () => void
}
