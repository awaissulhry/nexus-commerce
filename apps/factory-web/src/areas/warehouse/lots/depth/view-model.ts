import type { Phrase } from '../../../_shared/stock/model'
import type { Part } from '../shared/model'
import type { LotDepth, SplitAnswer, SplitRead, TraceReportAnswer, TraceReportRow } from './api'
import type { AttributeDraft, DepthCan, ReportDraft, SplitDraft } from './model'

/**
 * B-W2b-320 — what the lot record's W2b parts draw (SCR-201-record): the lot's W2b facts, the attributes form, Split into
 * shade groups (lt-split), the Trace report dialog (lt-report) and the reports made. The views take these and fetch
 * nothing; the container hook (use-lot-depth.ts) reads and writes; the design cases fill them with made-up data.
 */

export interface AttributesDialog {
  draft: AttributeDraft
  busy: boolean
  problem: Phrase | null
}

export interface SplitDialog {
  read: Part<SplitRead>
  draft: SplitDraft | null
  busy: boolean
  problem: Phrase | null
  /** What the split or regroup made: the lots and the new tags to print. */
  done: SplitAnswer | null
}

export interface ReportDialog {
  draft: ReportDraft
  /** Today in the site's zone: the request's limit. */
  today: string
  busy: boolean
  problem: Phrase | null
  /** The report made (its file opened in a new tab). */
  done: TraceReportAnswer | null
}

export interface LotDepthModel {
  can: DepthCan
  depth: Part<LotDepth>
  /** The reports made for the lot (the Trace tab; null: not read). */
  reports: Part<TraceReportRow[]> | null
  attributes: AttributesDialog | null
  split: SplitDialog | null
  report: ReportDialog | null
  checking: boolean
  notice: { tone: 'success' | 'info' | 'warning' | 'danger'; words: Phrase } | null
}

export interface LotDepthActions {
  onRetry?: () => void
  onRetryReports?: () => void
  onCheck?: () => void
  onAttributes?: (open: boolean) => void
  onAttributeDraft?: (patch: AttributeDraft) => void
  onSaveAttributes?: () => void
  onSplit?: (open: boolean) => void
  onRetrySplit?: () => void
  onSplitDraft?: (next: SplitDraft) => void
  onConfirmSplit?: () => void
  onReport?: (open: boolean) => void
  onReportDraft?: (patch: Partial<ReportDraft>) => void
  onConfirmReport?: () => void
  onOpenFile?: (fileId: string) => void
  onDismissNotice?: () => void
}
