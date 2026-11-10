import type { LiveState, Notice, Read } from '../../../quality/_shared/model'
import type { AskAnswer, DeclarationList, DeclarationRecord } from './api'
import type { AskDraftState, AskMaterialOption, DeclarationsAddress, DeclarationsCan } from './model'

/**
 * The view models of Supplier declarations (B-W2b-267): what the list view, the record's DetailModal and the Request
 * declarations dialog draw. The containers fill them; the views fetch nothing; the design cases build them by hand.
 */

export type { PageFrame } from '../substances/frame/views'
import type { PageFrame } from '../substances/frame/views'

/** One line's answer being typed in the Answer tab. */
export interface LineDraft {
  readonly lineId: string
  /** '' not answered, 'none', 'below' (yes, below the threshold), 'above'. */
  readonly answer: '' | 'none' | 'below' | 'above'
  readonly substanceName: string
  readonly concentration: string
}

/** The office's answer being recorded (a request asked by the office: the supplier's file and its validity). */
export interface AnswerDraft {
  readonly fileName: string | null
  readonly validTo: string
}

export interface RecordModel {
  readonly id: string
  readonly read: Read<DeclarationRecord>
  /** The answer's file for the viewer: its address, a failure, or null when there is none / not read yet. */
  readonly pdf: Read<string | Uint8Array> | null
  /** The lines being answered (Answer tab's edit), or null. */
  readonly lines: readonly LineDraft[] | null
  readonly answer: AnswerDraft | null
  /** Accept's validity day ('' = no end) and Reject's reason, as typed in the Decision tab. */
  readonly validTo: string
  readonly reason: string
  readonly problem: string | null
}

export interface AskModel {
  readonly draft: AskDraftState
  readonly options: Read<readonly AskMaterialOption[]>
  readonly review: Read<AskAnswer> | null
  readonly result: AskAnswer | null
  readonly today: string
  readonly problem: string | null
}

/** The verbs that ask something first: cancel with a reason, ask again with a new due day. */
export type VerbDialog =
  | { readonly kind: 'cancel'; readonly id: string; readonly reason: string }
  | { readonly kind: 'askAgain'; readonly id: string; readonly dueOn: string; readonly reminderEveryDays: string; readonly message: string }
  | { readonly kind: 'keys' }

export interface DeclarationsViewModel {
  readonly prefix: string
  readonly can: DeclarationsCan
  readonly online: boolean
  /** The site's day (YYYY-MM-DD): the validity bar, the due days. */
  readonly today: string
  readonly frame: PageFrame
  readonly address: DeclarationsAddress
  readonly list: Read<DeclarationList>
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly selected: readonly string[]
  readonly notice: Notice | null
  readonly record: RecordModel | null
  readonly ask: AskModel | null
  readonly dialog: VerbDialog | null
  readonly busy: boolean
  /** Design cases: the row with the focus, the keys panel open. */
  readonly focusRow?: number
}
