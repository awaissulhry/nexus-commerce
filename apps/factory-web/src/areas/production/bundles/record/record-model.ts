import type { LiveState } from '../../_shared/hooks'
import type { Phrase } from '../../_shared/model'
import type { BundleRecord, RecordScan } from '../api'
import type { Part, ReprintRun } from '../list-model'
import type { BundlesCan, BundleTab } from '../model'

/** SCR-259-record — the Bundle record's view model (BundleRecordView draws it and fetches nothing). */

export type LoadedBundle = { status: 'loading' } | { status: 'ready'; value: BundleRecord } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

export interface BundleRecordModel {
  /** `/w/<company>`. */
  prefix: string
  can: BundlesCan
  tab: BundleTab
  bundle: LoadedBundle
  /** The Scans tab (workorders.view); null without the right. */
  scans: Part<RecordScan[]> | null
  live: LiveState
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  /** Void bundle (the Bundle's ⋯). */
  voiding: { busy: boolean; problem: Phrase | null; reason?: string } | null
  reprint: ReprintRun | null
}

export interface BundleRecordActions {
  onRetry?: () => void
  onRetryScans?: () => void
  onDismissNotice?: () => void
  onVoidDialog?: (open: boolean) => void
  onVoid?: (reason: string) => void
  onReprintDialog?: (open: boolean) => void
  onRunReprint?: (reason: string, printerId: string | null) => void
}
