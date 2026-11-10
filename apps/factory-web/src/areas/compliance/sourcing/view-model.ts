import type { StepUpState } from '../../quality/_shared/hooks'
import type { Choices, ClaimRecord, CountsAnswer, ListAnswer } from './api'
import type { ClaimDraft, ClaimMode, ClaimTab, Problem, SourcingAddress, SourcingCan, UseDraft } from './model'

/** One read of one section: loading, its answer, or the problem in words (never drawn as empty). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

/** A line the page says after a write (and what was refused, in words). */
export interface PageNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  /** What a bulk action could not do, in words. */
  readonly refused?: readonly { readonly label: string; readonly key: string }[]
}

/** New claim (design pop:sc-new): the draft, the choices, the claim it replaces. */
export interface NewState {
  readonly draft: ClaimDraft
  readonly choices: Read<Choices> | null
  readonly busy: boolean
  readonly problem: Problem | null
  /** The draft is saved but a file chosen here was not taken: it says so and opens the draft. */
  readonly savedWithoutFile: string | null
}

/** The claim's window (design pop:sc-claim, a DetailModal; J / K over the list's rows). */
export interface OpenState {
  readonly id: string
  readonly read: Read<ClaimRecord>
  readonly mode: ClaimMode
  readonly tab: ClaimTab
  readonly draft: ClaimDraft | null
  readonly choices: Read<Choices> | null
  readonly use: UseDraft
  readonly reason: string
  readonly busy: boolean
  readonly problem: Problem | null
  /** What the last write did, said in the window. */
  readonly saved: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
}

/** Withdraw N (the list's bulk action): one reason for every claim chosen, one call each. */
export interface WithdrawManyState {
  readonly ids: readonly string[]
  readonly reason: string
  readonly busy: boolean
}

export interface SourcingPageModel {
  readonly prefix: string
  readonly can: SourcingCan
  readonly companyId: string | null
  /** The company's name (a claim about the whole company says it). */
  readonly companyName: string
  readonly address: SourcingAddress
  readonly today: string
  readonly counts: Read<CountsAnswer>
  readonly claims: Read<ListAnswer>
  readonly readAt: string | null
  readonly notice: PageNotice | null
  readonly selected?: readonly string[]
  readonly add: NewState | null
  readonly open: OpenState | null
  readonly withdrawMany: WithdrawManyState | null
  readonly stepUp: StepUpState
  readonly keysOpen?: boolean
}

export interface SourcingPageActions {
  onAddress?: (change: Partial<SourcingAddress>) => void
  onRetryCounts?: () => void
  onRetryClaims?: () => void
  onDismissNotice?: () => void
  onSelected?: (ids: string[]) => void
  onNewDraft?: (draft: ClaimDraft) => void
  onNewFiles?: (files: File[]) => void
  onSaveNew?: () => void
  onRetryChoices?: () => void
  onEditDraft?: (draft: ClaimDraft) => void
  onEditFiles?: (files: File[]) => void
  onSaveEdit?: () => void
  onApprove?: () => void
  onReason?: (reason: string) => void
  onWithdraw?: () => void
  onUseDraft?: (use: UseDraft) => void
  onAddUse?: () => void
  onEndUse?: (useId: string) => void
  onOpenEvidence?: (fileId: string) => void
  onRetryOpen?: () => void
  onWithdrawMany?: (ids: readonly string[] | null) => void
  onWithdrawManyReason?: (reason: string) => void
  onApplyWithdrawMany?: () => void
  onStepUp?: (code: string) => void
  onStepUpCancel?: () => void
}
