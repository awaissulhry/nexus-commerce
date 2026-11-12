import type { EvidenceRule } from '@nexus/factory-domain/quality/lab/rules'
import type { ComplianceGate } from '@nexus/factory-domain/compliance/requirements/rules'
import type { OperatorRole } from '@nexus/factory-domain/compliance/operators/rules'
import type { PhraseKind } from '@nexus/factory-domain/compliance/phrases/rules'
import type { RegulationKind, RegulationStatus } from '@nexus/factory-domain/compliance/register-of-rules/rules'
import type { StepUpState } from '../../quality/_shared/hooks'
import type { LiveState } from '../../quality/_shared/model'
import type { Change, CrViMaterial, CrViSettings, EntriesAnswer, EntryRecord, GateMatrix, LanguagesAnswer, MarketsAnswer, OperatorsAnswer, PartyChoice, PhraseRecord, PhrasesAnswer, Requirement, StyleChoice } from './api'
// B-W2b-288 (FU2:01): the Templates tab's state and actions.
import type { TemplatesActions, TemplatesState } from './ppe-texts/use-ppe-texts'
import type {
  AssessDraft,
  ChangeDraft,
  Cr6Scope,
  EntryCell,
  EntryDraft,
  GateDraft,
  Mark,
  MarketDraft,
  MarketList,
  OperatorCell,
  OperatorDraft,
  PhraseDraft,
  Problem,
  Read,
  RequirementDraft,
  RuleDraft,
  RulesCan,
  SettingsAddress,
  SettingsTab,
  StatusMove,
} from './model'

/**
 * The view model of SCR-262 (Compliance › Settings › Rules & markets): one model for the page, one state per tab (only the tab
 * shown is read), the dialogs each tab opens from the address, and the actions the views call. The views fetch nothing.
 */

/** A line the page says after a write, in our words. */
export interface Notice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** A dialog's write: busy, and the problem in our words (never the API's sentence). */
export interface Writing {
  readonly busy: boolean
  readonly problem: Problem | null
}
export const IDLE: Writing = Object.freeze({ busy: false, problem: null })

// ---- Chromium VI ----------------------------------------------------------------------------------------------------------

export interface Cr6State {
  readonly settings: Read<CrViSettings>
  /** The materials that need a Cr VI test; null: the person does not read materials. */
  readonly materials: Read<{ materials: CrViMaterial[]; count: number }> | null
  /** The rule chosen, before Apply (null: as in force). */
  readonly draft: EvidenceRule | null
  readonly loosen: { readonly reason: string } | null
  readonly writing: Writing
}

export interface Cr6Actions {
  onScope?: (scope: Cr6Scope) => void
  onDraft?: (rule: EvidenceRule | null) => void
  onApply?: () => void
  onReason?: (reason: string) => void
  onConfirm?: () => void
  onCancel?: () => void
  onRetry?: () => void
}

// ---- Gates ----------------------------------------------------------------------------------------------------------------

export interface AddRequirementState {
  readonly way: 'suggested' | 'own'
  /** Every requirement (archived too): the suggestions leave out what exists. */
  readonly requirements: Read<Requirement[]>
  /** The market codes a requirement of one market may name. */
  readonly markets: Read<string[]>
  readonly picked: readonly string[]
  readonly reason: string
  readonly draft: RequirementDraft
  readonly writing: Writing
}

export interface GatesState {
  readonly matrix: Read<GateMatrix>
  readonly drafts: Readonly<Record<string, GateDraft>>
  readonly selected: readonly string[]
  readonly loosen: { readonly reason: string } | null
  /** "Who may override and for how long" of one row. */
  readonly override: { readonly code: string; readonly roles: readonly string[]; readonly days: number } | null
  readonly add: AddRequirementState | null
  readonly writing: Writing
}

export interface GatesActions {
  onCell?: (code: string, gate: ComplianceGate, blocks: boolean) => void
  onSwitch?: (code: string, on: boolean) => void
  onSelected?: (codes: string[]) => void
  onBulkSwitch?: (codes: readonly string[], on: boolean) => void
  onOverride?: (code: string | null) => void
  onOverrideDraft?: (roles: string[], days: number) => void
  onOverrideKeep?: () => void
  onDiscard?: () => void
  onApply?: () => void
  onReason?: (reason: string) => void
  onConfirm?: () => void
  onCancel?: () => void
  onWriteW1?: () => void
  onAddWay?: (way: 'suggested' | 'own') => void
  onAddPick?: (codes: string[]) => void
  onAddReason?: (reason: string) => void
  onAddDraft?: (draft: RequirementDraft) => void
  onAddSave?: () => void
  onRetry?: () => void
}

// ---- Regulations & standards ----------------------------------------------------------------------------------------------

export interface EntryWindowState {
  readonly id: string
  readonly read: Read<EntryRecord>
  readonly mode: 'view' | 'move' | 'change' | 'delete'
  readonly move: StatusMove
  readonly change: ChangeDraft
  readonly writing: Writing
  readonly saved: Notice | null
}

export interface ChangeWindowState {
  readonly id: string
  readonly read: Read<Change>
  readonly assess: AssessDraft
  readonly writing: Writing
  readonly saved: Notice | null
}

export interface RegsState {
  readonly entries: Read<EntriesAnswer>
  readonly changes: Read<Change[]>
  readonly marks: Readonly<Record<string, Mark>>
  readonly selected: readonly string[]
  readonly add: { readonly draft: EntryDraft; readonly writing: Writing } | null
  readonly entry: EntryWindowState | null
  readonly change: ChangeWindowState | null
}

export interface RegsActions {
  onCell?: (id: string, field: EntryCell, value: string) => void
  onSelected?: (ids: string[]) => void
  onAddDraft?: (draft: EntryDraft) => void
  onAddSave?: () => void
  onEntryMode?: (mode: EntryWindowState['mode']) => void
  onMove?: (move: StatusMove) => void
  onMoveSave?: () => void
  onChangeDraft?: (draft: ChangeDraft) => void
  onChangeSave?: () => void
  onDelete?: () => void
  onAssess?: (draft: AssessDraft) => void
  onAssessSave?: () => void
  onTask?: () => void
  onClose?: () => void
  onCloseMany?: (ids: readonly string[]) => void
  onRetry?: () => void
  onRetryOpen?: () => void
}

// ---- Markets --------------------------------------------------------------------------------------------------------------

export interface MarketWindowState {
  readonly code: string
  readonly rules: readonly RuleDraft[]
  readonly note: string
  readonly writing: Writing
}

export interface MarketsState {
  readonly markets: Read<MarketsAnswer>
  readonly languages: Read<LanguagesAnswer>
  readonly marks: Readonly<Record<string, Mark>>
  readonly selected: readonly string[]
  readonly add: { readonly draft: MarketDraft; readonly writing: Writing } | null
  readonly open: MarketWindowState | null
  /** Switching a market off asks why. */
  readonly off: { readonly code: string; readonly reason: string; readonly writing: Writing } | null
}

export interface MarketsActions {
  onList?: (code: string, field: MarketList, text: string) => void
  onName?: (code: string, name: string) => void
  onNeed?: (code: string, field: 'importerNeeded' | 'gpsrContactNeeded', value: boolean) => void
  onSwitch?: (code: string, on: boolean) => void
  onOffReason?: (reason: string) => void
  onOffConfirm?: () => void
  onOffCancel?: () => void
  onSelected?: (codes: string[]) => void
  onSwitchOnMany?: (codes: readonly string[]) => void
  onAddDraft?: (draft: MarketDraft) => void
  onAddSave?: () => void
  onRules?: (rules: RuleDraft[]) => void
  onNote?: (note: string) => void
  onWindowSave?: () => void
  onArchive?: (code: string, archived: boolean) => void
  onRetry?: () => void
}

// ---- Phrases & translations -----------------------------------------------------------------------------------------------

export interface PhraseWindowState {
  readonly key: string
  readonly read: Read<PhraseRecord>
  /** The language whose words are typed (a proposal), or null. */
  readonly language: string | null
  readonly text: string
  /** New source words being typed (the next revision), or null. */
  readonly source: string | null
  readonly writing: Writing
  readonly saved: Notice | null
}

export interface PhrasesState {
  readonly phrases: Read<PhrasesAnswer>
  readonly selected: readonly string[]
  readonly add: { readonly draft: PhraseDraft; readonly writing: Writing } | null
  readonly open: PhraseWindowState | null
}

export interface PhrasesActions {
  onSelected?: (keys: string[]) => void
  onArchiveMany?: (keys: readonly string[]) => void
  onAddDraft?: (draft: PhraseDraft) => void
  onAddSave?: () => void
  onLanguage?: (language: string | null) => void
  onText?: (text: string) => void
  onPropose?: () => void
  onApprove?: (language: string) => void
  onWithdraw?: (language: string) => void
  onSource?: (text: string | null) => void
  onSourceSave?: () => void
  onRetry?: () => void
  onRetryOpen?: () => void
}

// ---- Operators ------------------------------------------------------------------------------------------------------------

export interface OperatorPickers {
  readonly styleQ: string
  readonly styles: Read<StyleChoice[]> | null
  readonly brands: Read<PartyChoice[]> | null
  readonly partyQ: string
  readonly parties: Read<PartyChoice[]> | null
}

export interface OperatorWindowState {
  readonly id: string
  readonly draft: { readonly partyId: string | null; readonly printedName: string; readonly printedAddress: string; readonly contact: string; readonly validFrom: string; readonly validTo: string | null; readonly note: string }
  readonly pickers: OperatorPickers
  readonly writing: Writing
}

export interface OperatorsState {
  readonly operators: Read<OperatorsAnswer>
  /** The market codes (for the filter and the new row). */
  readonly markets: readonly string[]
  readonly marks: Readonly<Record<string, Mark>>
  readonly selected: readonly string[]
  readonly add: { readonly draft: OperatorDraft; readonly pickers: OperatorPickers; readonly writing: Writing } | null
  readonly open: OperatorWindowState | null
}

export interface OperatorsActions {
  onCell?: (id: string, field: OperatorCell, value: string) => void
  onSelected?: (ids: string[]) => void
  /** End N today: each row's last day is today (a row is never removed). */
  onEndMany?: (ids: readonly string[]) => void
  onAddDraft?: (draft: OperatorDraft) => void
  onAddSave?: () => void
  onStyleQ?: (q: string) => void
  onPartyQ?: (q: string) => void
  onWindowDraft?: (draft: OperatorWindowState['draft']) => void
  onWindowSave?: () => void
  onRetry?: () => void
}

// ---- the page -------------------------------------------------------------------------------------------------------------

export interface RulesMarketsModel {
  readonly prefix: string
  readonly can: RulesCan
  /** The person's id (a translation is never approved by its author). */
  readonly me: string
  readonly companyId: string | null
  readonly companyName: string
  readonly address: SettingsAddress
  readonly today: string
  readonly readAt: string | null
  readonly live: LiveState
  readonly notice: Notice | null
  readonly stepUp: StepUpState
  readonly keysOpen?: boolean
  readonly cr6?: Cr6State
  readonly gates?: GatesState
  readonly regs?: RegsState
  readonly markets?: MarketsState
  readonly phrases?: PhrasesState
  readonly operators?: OperatorsState
  /** B-W2b-288 (FU2:01): Templates (the PPE consultant's yes per template). */
  readonly templates?: TemplatesState
}

export interface RulesMarketsActions {
  onAddress?: (change: Partial<SettingsAddress>) => void
  onDismissNotice?: () => void
  onStepUp?: (code: string) => void
  onStepUpCancel?: () => void
  onReload?: () => void
  cr6?: Cr6Actions
  gates?: GatesActions
  regs?: RegsActions
  markets?: MarketsActions
  phrases?: PhrasesActions
  operators?: OperatorsActions
  /** B-W2b-288 (FU2:01). */
  templates?: TemplatesActions
}

export type { SettingsTab, RegulationKind, RegulationStatus, PhraseKind, OperatorRole }
