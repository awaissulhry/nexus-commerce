import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import type { LiveState } from '../../_shared/buying/hooks'
import type { StepUpState } from '../../quality/_shared/hooks'
import type { AlertRule, KindsAnswer, MaterialRef, ReminderSettings, RulesAnswer, SupplierRef, Tolerance } from './api'
import type { Address, ChangedBy, DefaultDraft, Notice, Read, Scope, StatusFilter, ToleranceDraft, WriteProblem } from './model'

/** The page's catalogues: its own, and the list frame's words (`lists`). */
export const SETTINGS_NAMESPACES = ['purchasing-settings', 'lists'] as const

/** What the person's role lets this page show (the API checks every call itself). */
export interface SettingsCan {
  /** purchasing.view: the page itself (tolerances, the reminder switch). */
  readonly view: boolean
  /** approvals.view: the PO approval rules. */
  readonly approvals: boolean
  /** approvals.rules.manage: New PO rule opens Admin › Automation ready to write. */
  readonly rulesManage: boolean
  /** purchasing.tolerances.manage: the default and the exceptions. */
  readonly tolerances: boolean
  /** alerts.view: the buyer's alert. */
  readonly alerts: boolean
  /** audit.read: "Changed by <name>" and the audit log. */
  readonly audit: boolean
  /** parties.view, product.materials.view: the dialog's pickers. */
  readonly suppliers: boolean
  readonly materials: boolean
}

export interface DialogState {
  readonly draft: ToleranceDraft
  /** Problems shown at their fields (after the first Save). */
  readonly shown: boolean
  readonly problem: WriteProblem | null
}

export interface PurchasingSettingsModel {
  readonly prefix: string
  readonly address: Address
  /** The company of the address. */
  readonly companyId: string | null
  readonly companyName: string
  readonly can: SettingsCan
  /** null: not read (no approvals.view). */
  readonly rules: Read<RulesAnswer> | null
  readonly kinds: Read<KindsAnswer> | null
  /** Every tolerance the scope reads (its own and what it follows). */
  readonly tolerances: Read<Tolerance[]>
  /** The default's form (every supplier, every material). */
  readonly defaultDraft: DefaultDraft | null
  readonly selected: readonly string[]
  readonly dialog: DialogState | null
  /** Read when the dialog opens for a new exception (null: not read, or not in the role). */
  readonly suppliers: Read<SupplierRef[]> | null
  readonly materials: Read<MaterialRef[]> | null
  readonly reminders: Read<ReminderSettings>
  /** The switch as set on the page (null until read). */
  readonly reminderDraft: boolean | null
  /** null: not read (no alerts.view). */
  readonly alerts: Read<{ rules: AlertRule[]; canAdd: boolean }> | null
  readonly changed: { readonly approval: ChangedBy | null; readonly tolerance: ChangedBy | null; readonly confirm: ChangedBy | null }
  readonly busy: 'default' | 'dialog' | 'bulk' | 'reminders' | null
  readonly save: SaveStatusState
  readonly notice: Notice | null
  readonly live: LiveState
  readonly asOf: string | null
  /** The settings changed on another screen while this one holds unsaved changes. */
  readonly changedElsewhere: boolean
  readonly keysOpen: boolean
  readonly stepUp: StepUpState
}

export interface PurchasingSettingsActions {
  onScope?: (scope: Scope) => void
  onStatus?: (status: StatusFilter) => void
  onOpenRule?: (ruleId: string) => void
  onDefault?: (draft: DefaultDraft) => void
  onDiscardDefault?: () => void
  onApplyDefault?: () => void
  onRemoveDefault?: () => void
  onSelect?: (ids: readonly string[]) => void
  /** A tolerance in its dialog (`?tolerance=<id>`), or `new`. */
  onToleranceOpen?: (id: string) => void
  onDraft?: (draft: ToleranceDraft) => void
  onDialogSave?: () => void
  onDialogClose?: () => void
  onMove?: (tolerance: Tolerance, to: 'archive' | 'reactivate') => void
  onBulkMove?: (to: 'archive' | 'reactivate') => void
  onReminder?: (on: boolean) => void
  onDiscardReminder?: () => void
  onApplyReminder?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  onRetry?: () => void
  onRetryRules?: () => void
  onRetryTolerances?: () => void
  onRetryReminders?: () => void
  onRetryAlerts?: () => void
  onRetryPickers?: () => void
  onReload?: () => void
  onDismissNotice?: () => void
  onKeys?: () => void
  onKeysClose?: () => void
}
