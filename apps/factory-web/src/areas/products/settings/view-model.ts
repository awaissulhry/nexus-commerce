import type { LiveState } from '../../_shared/buying/hooks'
import type { CostingDefaults, LabelRef, ProductSettings, ProductType, ScaleRef } from './api'
import type { Address, ChangedBy, Loosening, Notice, Read, RulesDraft, Scope, ToleranceDraft, TypeDraft, TypeFilter, WriteProblem } from './model'

/** The page's catalogues: its own, and the list frame's words (`lists`). */
export const SETTINGS_NAMESPACES = ['products-settings', 'lists'] as const

/** What the person's role lets this page show (the API checks every call itself). */
export interface SettingsCan {
  /** product.styles.view: the page itself. */
  readonly view: boolean
  /** audit.read: "Changed by <name>" and the link to the audit log. */
  readonly audit: boolean
  /** costing.view: the costing defaults' values. */
  readonly costing: boolean
  /** money.cost: the cost per minute (else "Not in your role"). */
  readonly cost: boolean
  /** invoices.view: Finance settings opens. */
  readonly finance: boolean
  /** compliance.certificates.view: the label templates a type may name. */
  readonly labels: boolean
}

export interface TypeDialogState {
  readonly draft: TypeDraft
  /** Problems shown at their fields (after the first Save). */
  readonly shown: boolean
  readonly problem: WriteProblem | null
  /** The type's newest audited change (audit.read), when read. */
  readonly changedBy: ChangedBy | null
}

export interface ProductSettingsModel {
  readonly prefix: string
  readonly address: Address
  /** The company of the address. */
  readonly companyId: string | null
  /** The scope's settings row (the company's id, or the tenant's for every company): its audit log. */
  readonly rowId: string | null
  readonly companyName: string
  readonly can: SettingsCan
  /** The scope's row: the company's, or every company's. */
  readonly settings: Read<ProductSettings>
  /** Every company's row (what a company follows; the same read for "every company"). */
  readonly tenant: Read<ProductSettings>
  readonly rules: RulesDraft | null
  readonly tolerance: ToleranceDraft | null
  readonly types: Read<ProductType[]>
  readonly selected: readonly string[]
  readonly typeDialog: TypeDialogState | null
  /** Read when the type dialog opens. */
  readonly scales: Read<ScaleRef[]> | null
  readonly labels: Read<LabelRef[]> | null
  /** null: not read (no costing.view). */
  readonly costing: Read<CostingDefaults> | null
  readonly changed: { readonly rules: ChangedBy | null; readonly tolerance: ChangedBy | null; readonly types: ChangedBy | null }
  readonly busy: 'rules' | 'tolerance' | 'type' | 'types' | null
  readonly notice: Notice | null
  /** "Confirm a looser rule": what it lets through from now on, and the reason (sent to the audit trail). */
  readonly loosen: { readonly reason: string; readonly loosenings: readonly Loosening[] } | null
  readonly live: LiveState
  readonly asOf: string | null
  /** The settings changed on another screen while this one holds unsaved changes. */
  readonly changedElsewhere: boolean
  readonly keysOpen: boolean
}

export interface ProductSettingsActions {
  onScope?: (scope: Scope) => void
  onStatus?: (status: TypeFilter) => void
  onRules?: (draft: RulesDraft) => void
  onDiscardRules?: () => void
  onApplyRules?: () => void
  onLoosenReason?: (reason: string) => void
  onLoosenConfirm?: () => void
  onLoosenCancel?: () => void
  onTolerance?: (draft: ToleranceDraft) => void
  onDiscardTolerance?: () => void
  onApplyTolerance?: () => void
  onSelect?: (ids: readonly string[]) => void
  /** A type's dialog (`?type=<id>`), or `new`. */
  onTypeOpen?: (id: string) => void
  onTypeDraft?: (draft: TypeDraft) => void
  onTypeSave?: () => void
  onTypeClose?: () => void
  onTypeMove?: (type: ProductType, to: 'archive' | 'restore') => void
  onBulkMove?: (to: 'archive' | 'restore') => void
  onRetry?: () => void
  onRetryTypes?: () => void
  onRetryCosting?: () => void
  onReload?: () => void
  onDismissNotice?: () => void
  onKeys?: () => void
  onKeysClose?: () => void
}
