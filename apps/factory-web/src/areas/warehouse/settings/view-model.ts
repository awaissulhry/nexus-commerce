import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import type { LiveState } from '../../_shared/buying/hooks'
import type { StepUpState } from '../../quality/_shared/hooks'
import type { CrViRule, DefaultRow, RulesAnswer, RulesView, SeparationView, SitePlaces } from './api'
import type { Address, AlertsDraft, CellKey, AmountDraft, ChangedBy, DaysDraft, DefaultsDraft, DirtyCard, HeldItemKind, Notice, Read, Scope, SeparationDraft } from './model'

/** The page's catalogues: its own, and the list frame's words (`lists`). */
export const SETTINGS_NAMESPACES = ['warehouse-settings', 'lists'] as const

/** What the person's role lets this page show (the API checks every call itself). */
export interface SettingsCan {
  /** inventory.stock.view: the page itself (the rules and the switches). */
  readonly view: boolean
  /** inventory.rules.manage: change the rules (the API says it per scope: `mayChange`). */
  readonly rules: boolean
  /** inventory.locations.view / .manage: the default places. */
  readonly locations: boolean
  readonly locationsManage: boolean
  /** money.cost: the adjustment value is a cost. */
  readonly cost: boolean
  /** approvals.view: who approves an adjustment (the engine's STOCK_ADJUSTMENT rules); approvals.rules.manage: write one. */
  readonly approvals: boolean
  readonly approvalsManage: boolean
  /** quality.lots.view: the Cr VI evidence rule in force. */
  readonly crVi: boolean
  /** audit.read: "Changed by <name>" and the audit log. */
  readonly audit: boolean
}

/** One card being saved (every change of the page waits meanwhile). */
export type Busy = DirtyCard | null

/** The reason a loosening card asks before Save (its field shows once a change loosens, or the API asked). */
export interface Reasons {
  readonly separation: string
  readonly posting: string
  readonly adjust: string
}

export interface WarehouseSettingsModel {
  readonly prefix: string
  readonly address: Address
  readonly companyId: string | null
  readonly companyName: string
  readonly can: SettingsCan
  /** The scope's rules (posting dates, the adjustment value, low-stock alerts). */
  readonly rules: Read<RulesView>
  /** Every company's rules, read in company scope for what a company follows (null: not read, or the scope is every company). */
  readonly tenantRules: RulesView | null
  readonly separation: Read<SeparationView>
  readonly tenantSeparation: SeparationView | null
  /** The drafts (null until read). */
  readonly separationDraft: SeparationDraft | null
  readonly daysDraft: DaysDraft | null
  readonly amountDraft: AmountDraft | null
  readonly alertsDraft: AlertsDraft | undefined
  readonly reasons: Reasons
  /** The cards whose reason field the API asked for. */
  readonly reasonAsked: readonly ('separation' | 'posting' | 'adjust')[]
  /** null: not read (no inventory.locations.view). */
  readonly sites: Read<SitePlaces[]> | null
  readonly defaults: Read<DefaultRow[]> | null
  readonly defaultsDraft: DefaultsDraft
  /** Kinds of material added as rows on the page (not saved yet). */
  readonly addedKinds: readonly HeldItemKind[]
  /** null: not read (no approvals.view). */
  readonly approvalRules: Read<RulesAnswer> | null
  /** null: not read (no quality.lots.view). */
  readonly crVi: Read<CrViRule> | null
  readonly changed: {
    readonly separation: ChangedBy | null
    readonly posting: ChangedBy | null
    readonly adjust: ChangedBy | null
    readonly alerts: ChangedBy | null
    readonly defaults: ChangedBy | null
  }
  /** The scope's InventorySettings row (audit links). */
  readonly rowId: string | null
  readonly busy: Busy
  readonly save: SaveStatusState
  readonly notice: Notice | null
  readonly live: LiveState
  readonly asOf: string | null
  /** The rules changed on another screen while this one holds unsaved changes. */
  readonly changedElsewhere: boolean
  readonly keysOpen: boolean
  readonly stepUp: StepUpState
}

export interface WarehouseSettingsActions {
  onScope?: (scope: Scope) => void
  onSite?: (siteId: string) => void
  onSeparation?: (draft: SeparationDraft) => void
  onDays?: (draft: DaysDraft) => void
  onAmount?: (draft: AmountDraft) => void
  onAlerts?: (draft: AlertsDraft) => void
  onReason?: (card: keyof Reasons, reason: string) => void
  onDiscard?: (card: Exclude<Busy, null>) => void
  onApply?: (card: Exclude<Busy, null>) => void
  onCell?: (key: CellKey, locationId: string | null) => void
  onOpenRule?: (ruleId: string) => void
  onAddKind?: (kind: HeldItemKind) => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  onRetry?: () => void
  onRetryRules?: () => void
  onRetrySeparation?: () => void
  onRetrySites?: () => void
  onRetryDefaults?: () => void
  onRetryApprovals?: () => void
  onRetryCrVi?: () => void
  onReload?: () => void
  onDismissNotice?: () => void
  onKeys?: () => void
  onKeysClose?: () => void
}
