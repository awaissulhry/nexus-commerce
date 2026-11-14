import type { Grains } from '../../model'
import type { ApprovalTask, CompareView, SeasonOption, VersionRecord, VersionRow, VersionsView } from './api'
import { typedAmount, typedMargin, typedPieces, type CostSheetAbilities, type Phrase, type Read } from './model'

/**
 * The view model of the Cost tab's "Cost sheet versions and approval" (B-W2b-430, SCR-500 and SCR-501) and the pure rules of
 * its dialogs: a new version (from the components of the revision in view, or a copy of a version), sending one for its
 * yes, the yes itself (the approval engine's), taking an approved one back, deleting a draft, comparing two.
 */

export type VersionDialog =
  | { readonly kind: 'new'; readonly from: 'COMPONENTS' }
  | { readonly kind: 'new'; readonly from: 'COPY'; readonly basedOnId: string }
  | { readonly kind: 'send' }
  | { readonly kind: 'approve' }
  | { readonly kind: 'takeBack' }
  | { readonly kind: 'remove' }

export interface CompareModel {
  readonly a: string
  readonly b: string
  readonly result: Read<CompareView>
}

/** The fresh-code dialog an approval rule may ask for (the engine's step-up). */
export interface CostStepUp {
  readonly open: boolean
  readonly busy: boolean
  readonly problem: string | null
}

export interface VersionsModel {
  readonly styleId: string
  /** The revision in view (a new version is written from its components). */
  readonly revision: { readonly id: string; readonly revision: number } | null
  /** The style's sizes (a new version's base size) and its base size. */
  readonly sizes: readonly string[]
  readonly baseSize: string | null
  readonly can: CostSheetAbilities
  readonly grains: Grains
  readonly list: Read<VersionsView>
  /** The version shown below the list (picked, else the approved one, else the newest draft). */
  readonly inView: VersionRow | null
  readonly record: Read<VersionRecord>
  /** The engine's request of the version in view while it waits for its yes. */
  readonly task: Read<ApprovalTask> | null
  readonly seasons: Read<readonly SeasonOption[]>
  readonly dialog: VersionDialog | null
  readonly compare: CompareModel | null
  readonly busy: boolean
  /** A refused write in the open dialog, in words. */
  readonly problem: Phrase | null
  readonly notice: { readonly tone: 'success' | 'info' | 'danger'; readonly words: Phrase } | null
  readonly stepUp: CostStepUp
  /** Design cases: what a dialog starts with. */
  readonly draft?: Partial<NewVersionDraft> & { readonly note?: string; readonly reason?: string }
}

export interface VersionsActions {
  onPick?: (sheetId: string) => void
  onDialog?: (dialog: VersionDialog | null) => void
  onCreate?: (draft: NewVersionDraft) => void
  onSend?: (input: { note: string; coveredByTyped: boolean }) => void
  onApprove?: (comment: string) => void
  onTakeBack?: (reason: string) => void
  onRemove?: () => void
  onCompareOpen?: () => void
  onCompare?: (a: string, b: string) => void
  onCompareClose?: () => void
  onRetry?: (part: 'list' | 'record' | 'task') => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

/** What the New version dialog holds while the person types. */
export interface NewVersionDraft {
  readonly from: 'COMPONENTS' | 'COPY'
  readonly basedOnId: string | null
  /** '' = no season. */
  readonly seasonId: string
  readonly baseSize: string
  readonly piecesPerCarton: string
  readonly targetPrice: string
  readonly targetMarginPct: string
  readonly note: string
  readonly leaveOutMissing: boolean
}

export function newVersionDraft(from: 'COMPONENTS' | 'COPY', basedOnId: string | null, baseSize: string | null, given?: Partial<NewVersionDraft>): NewVersionDraft {
  return { from, basedOnId, seasonId: '', baseSize: baseSize ?? '', piecesPerCarton: '', targetPrice: '', targetMarginPct: '', note: '', leaveOutMissing: false, ...given }
}

/** The New version dialog's problems by field (message keys): a figure above 0, a margin below 100, garments 1 … 10 000, a note ≤ 2000. */
export function newVersionProblems(draft: NewVersionDraft): Partial<Record<'piecesPerCarton' | 'targetPrice' | 'targetMarginPct' | 'note', string>> {
  const problems: Partial<Record<'piecesPerCarton' | 'targetPrice' | 'targetMarginPct' | 'note', string>> = {}
  if (draft.piecesPerCarton.trim() !== '' && typedPieces(draft.piecesPerCarton) === null) problems.piecesPerCarton = 'verNew.problem.pieces'
  if (draft.targetPrice.trim() !== '' && typedAmount(draft.targetPrice) === null) problems.targetPrice = 'verNew.problem.price'
  if (draft.targetMarginPct.trim() !== '' && typedMargin(draft.targetMarginPct) === null) problems.targetMarginPct = 'verNew.problem.margin'
  if (draft.note.trim().length > 2000) problems.note = 'verNew.problem.note'
  return problems
}

/** The body of POST /costing/cost-sheets from the dialog (the figures only when typed; the grains decide what may be sent). */
export function newVersionBody(draft: NewVersionDraft, input: { styleId: string; revisionId: string | null; companyId: string | null; colourwayId: string | null; grains: Grains }) {
  const price = typedAmount(draft.targetPrice)
  const margin = typedMargin(draft.targetMarginPct)
  const pieces = typedPieces(draft.piecesPerCarton)
  return {
    styleId: input.styleId,
    from: draft.from,
    ...(draft.from === 'COMPONENTS' && input.revisionId ? { revisionId: input.revisionId } : {}),
    ...(draft.from === 'COPY' && draft.basedOnId ? { basedOnId: draft.basedOnId } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
    ...(draft.from === 'COMPONENTS' ? { seasonId: draft.seasonId === '' ? null : draft.seasonId } : {}),
    ...(draft.from === 'COMPONENTS' && draft.baseSize ? { baseSize: draft.baseSize } : {}),
    ...(draft.from === 'COMPONENTS' && pieces !== null ? { piecesPerCarton: pieces } : {}),
    ...(draft.from === 'COMPONENTS' && input.colourwayId ? { colourwayId: input.colourwayId } : {}),
    ...(input.grains.price && price !== null ? { targetPrice: price } : {}),
    ...(input.grains.margin && margin !== null ? { targetMarginPct: margin } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    ...(draft.from === 'COMPONENTS' && draft.leaveOutMissing ? { leaveOutMissing: true } : {}),
  }
}

/** A version's name in a sentence and a list ("Version 3"); the series' season, when it has one, after it. */
export const versionLabel = (row: Pick<VersionRow, 'sheetVersion'>): { key: string; params: { version: number } } => ({ key: 'ver.name', params: { version: row.sheetVersion } })

/** A reason typed to take a version back: 3 … 500 characters (the audit row keeps it). */
export function reasonProblem(reason: string): string | null {
  const text = reason.trim()
  if (text.length < 3) return 'verBack.problem.short'
  if (text.length > 500) return 'verBack.problem.long'
  return null
}
