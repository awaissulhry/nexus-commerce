import type { BankDetails, FinanceSettings } from '../_shared/api'
import type { StepUpState } from '../_shared/hooks'
import type { FinanceAbilities, Phrase } from '../_shared/model'
import type { Loaded, Part } from '../invoices/record/record-model'

/** SCR-083 — the finance settings' view model (FinanceSettingsView draws it and fetches nothing). */
export interface FinanceSettingsModel {
  prefix: string
  can: FinanceAbilities
  settings: Loaded<FinanceSettings>
  /** The company shown (several: the person picks). */
  companyId: string | null
  /** The company's bank account (companies.bank.view); null without the right. */
  bank: Part<BankDetails> | null
  /** The bank card is being edited. */
  editingBank: boolean
  busy: boolean
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  bankProblem: Phrase | null
  stepUp: StepUpState
  /** Design cases: what the bank form holds typed. */
  draft?: { accountHolder?: string; iban?: string; bic?: string; bankName?: string }
}

export interface BankInput {
  accountHolder: string
  iban: string
  bic: string
  bankName: string
}

export interface FinanceSettingsActions {
  onRetry?: () => void
  onRetryBank?: () => void
  onCompany?: (companyId: string) => void
  onEditBank?: (editing: boolean) => void
  onSaveBank?: (input: BankInput) => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

/** An IBAN as typed (spaces, lower case) as the API takes it; the problem as a message key, or null. */
export function ibanProblem(value: string): string | null {
  const compact = value.replace(/\s+/g, '').toUpperCase()
  if (compact === '') return null
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) return 'bank.problem.iban'
  // ISO 13616 check digits (mod 97 = 1).
  const moved = `${compact.slice(4)}${compact.slice(0, 4)}`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55))
  let rest = 0
  for (const digit of moved) rest = (rest * 10 + Number(digit)) % 97
  return rest === 1 ? null : 'bank.problem.ibanCheck'
}

/** An IBAN read in groups of four. */
export const ibanGroups = (iban: string): string => iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()
