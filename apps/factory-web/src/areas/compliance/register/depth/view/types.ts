import type { StepUpState } from '../../../../quality/_shared/hooks'
import type { Read } from '../../../../quality/_shared/model'
import type { AuthorityNotice, MarketOption, PublicWords, Recipients, RecallKind, SendAnswer, Surveillance } from '../api'
import type { DepthCan, EntryFacts, NoticeDraftForm, RequestForm, SentForm } from '../model'
import type { DialogProblem } from './parts'

/**
 * The register entry's W2b parts as ONE view model (B-W2b-271): the surveillance read (notices, requests, recalls, the
 * distributors' counts), the distributors' log, the dialog open, what it needs read, and the step-up. EntryRecord's
 * container fills it through `use-depth.ts`; the design cases fill it from made-up data.
 */

export type DepthDialogKind =
  | { kind: 'notice'; noticeId: string | null }
  | { kind: 'request' }
  | { kind: 'requestEvidence'; requestId: string }
  | { kind: 'requestAnswer'; requestId: string }
  | { kind: 'requestCancel'; requestId: string }
  | { kind: 'distributorEdit'; noticeId: string }
  | { kind: 'distributorAnswer'; noticeId: string }
  | { kind: 'distributorFail'; noticeId: string }
  | { kind: 'distributorCancel'; noticeId: string }
  | { kind: 'distributorSend' }
  | { kind: 'startRecall' }

export interface NoticeModalState {
  /** The notice as read when the dialog opened (fresh), null for a new one. */
  readonly notice: AuthorityNotice | null
  /** The draft's PDF in the language chosen (the API makes it on the fly). */
  readonly pdf: Read<Uint8Array> | null
  readonly language: string | null
}

export interface DepthModel {
  readonly prefix: string
  readonly can: DepthCan
  readonly entry: EntryFacts & { readonly kind: string; readonly reportedAt: string; readonly styleCode: string }
  readonly surveillance: Read<Surveillance>
  /** The distributors' log (null: not read yet). */
  readonly recipients: Read<Recipients> | null
  readonly dialog: DepthDialogKind | null
  readonly busy: boolean
  readonly problem: DialogProblem | null
  readonly noticeModal: NoticeModalState | null
  /** The market profiles a notice or a request names (null: the person cannot list them; a code is typed). */
  readonly markets: Read<readonly MarketOption[]> | null
  /** The last "Send to N distributors": a result per recipient. */
  readonly sendResults: SendAnswer | null
  readonly stepUp: StepUpState
  readonly today: string
  /** The clock of the read (design cases: fixed, so a Countdown draws the same every time). */
  readonly now?: number
}

export interface DepthActions {
  onDialog?(dialog: DepthDialogKind | null): void
  onRetry?(): void
  onDraftNotice?(form: NoticeDraftForm): void
  onSaveNotice?(edit: { authorityName: string; channel: NoticeDraftForm['channel']; decision: NoticeDraftForm['decision']; words: Readonly<Record<string, string>> }): void
  onNoticeLanguage?(language: string): void
  onMarkSent?(form: SentForm, copy: File | null): void
  onNoticeReference?(input: { reference: string; copy: File | null }): void
  onCancelNotice?(reason: string): void
  onLogRequest?(form: RequestForm): void
  onRequestEvidence?(requestId: string, language: string | null): void
  onAnswerRequest?(requestId: string, input: { answerSummary: string; day: string }): void
  onCancelRequest?(requestId: string, reason: string): void
  onDraftDistributors?(): void
  onSendDistributors?(): void
  onEditDistributor?(noticeId: string, input: { subject: string; message: string }): void
  onAnswerDistributor?(noticeId: string, input: { answer: string; day: string; byName: string }): void
  onFailDistributor?(noticeId: string, reason: string): void
  onCancelDistributor?(noticeId: string, reason: string): void
  onStartRecall?(kind: RecallKind): void
  onSubmitStepUp?(code: string): void
  onCancelStepUp?(): void
  onDismissResults?(): void
}

export type { PublicWords }
