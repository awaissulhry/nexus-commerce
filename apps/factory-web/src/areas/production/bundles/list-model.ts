import type { LiveState } from '../_shared/hooks'
import type { Phrase } from '../_shared/model'
import type { WhoAnswer, BundleTiles, Finding, FindingsSummary, TrackedBundle } from './api'
import type { BundlesCan, BundleView, FindingsAsk, WhoPurpose } from './model'

/** SCR-259 — the Bundles page's view model (BundlesView draws it and fetches nothing). */

export interface Part<T> {
  value: T | null
  problem: string | null
}

/** One run of "Reprint N tickets": each bundle gets a new code, or says why not. `pdf`: no printer, the ticket opens as a PDF. */
export interface ReprintRun {
  rows: Array<{ id: string; code: string }>
  printers: Part<{ printers: Array<{ id: string; code: string; name: string }>; defaultPrinterId: string | null }>
  running: boolean
  done: boolean
  results: Record<string, { state: 'done'; code: string; pdf: boolean } | { state: 'failed'; words: Phrase }>
}

/** "Show who" (one finding): the dialog holds the answer only while it is open; closing it drops the names. */
export interface WhoDialog {
  finding: Finding
  /** The legal basis on record, when this person may read it. */
  basis: { kind: string; reference: string; recordedAt: string } | null
  busy: boolean
  problem: Phrase | null
  answer: WhoAnswer | null
}

/** A count pressed: the bundles behind it (never the people). */
export interface FindingsDialog {
  ask: FindingsAsk
  rows: { items: Finding[] | null; more: boolean; problem: string | null }
  busy: boolean
  notice: { tone: 'success' | 'danger'; words: Phrase } | null
  /** The finding being dismissed (a dismissal says why). */
  dismiss: Finding | null
  who: WhoDialog | null
}

export interface BundlesModel {
  /** `/w/<company>`. */
  prefix: string
  can: BundlesCan
  view: BundleView
  q: string
  rows: { items: TrackedBundle[] | null; more: boolean; problem: string | null }
  tiles: BundleTiles | null
  asOf: string | null
  live: LiveState
  /** Live changes waiting behind "N updates · Show". */
  updates: number
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  /** The scan-pattern panel's counts. */
  summary: Part<FindingsSummary>
  findings: FindingsDialog | null
  reprint: ReprintRun | null
  /** Design cases: the starting selection and focused row, the keys panel, a typed dismissal or purpose. */
  selected?: string[]
  focusRow?: number
  helpOpen?: boolean
  whoPurpose?: WhoPurpose
}

export interface BundlesActions {
  onView?: (view: BundleView) => void
  onSearch?: (q: string) => void
  /** Enter in the search (a scanner ends with Enter): one hit opens it. */
  onScan?: (q: string) => void
  onMore?: () => void
  onRetry?: () => void
  onRetrySummary?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onDismissNotice?: () => void
  onReprintMany?: (ids: string[]) => void
  onRunReprint?: (reason: string, printerId: string | null) => void
  onCloseReprint?: () => void
  onExport?: (ids: string[]) => void
  onAsk?: (ask: FindingsAsk | null) => void
  onMoreFindings?: () => void
  onRetryFindings?: () => void
  onReviewed?: (ids: string[]) => void
  onDismiss?: (finding: Finding | null) => void
  onSendDismiss?: (note: string) => void
  onWho?: (finding: Finding | null) => void
  onShowWho?: (purpose: WhoPurpose, note: string) => void
}
