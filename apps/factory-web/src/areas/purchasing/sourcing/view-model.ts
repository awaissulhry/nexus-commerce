import type { SampleLineKind } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import type { Choices, ListAnswer, SampleRow } from './api'
import type { LineDraft, Problem, SampleDraft, SourcingAddress, SourcingCan } from './model'

/**
 * The one view model of SCR-222 (B-W2b-347) and its actions: the container (SourcingPage.tsx) fills it from the API, the design
 * cases (fixtures.ts) from made-up data. Nothing in a view fetches.
 */

export type Read<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface NewState {
  readonly draft: SampleDraft
  readonly choices: Read<Choices>
  readonly busy: boolean
  readonly problem: Problem | null
}

export interface PageNotice {
  readonly tone: 'success' | 'warning' | 'danger' | 'info'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  /** The order the notice is about (its record opens from the notice). */
  readonly orderId?: string
}

export interface SourcingPageModel {
  /** `/w/<company>`. */
  readonly prefix: string
  readonly can: SourcingCan
  readonly companyId: string | null
  readonly address: SourcingAddress
  /** Today in the factory's zone (the dialog's earliest day). */
  readonly today: string
  readonly orders: Read<ListAnswer>
  /** Rows read after the first page ("Show more"). */
  readonly more: readonly SampleRow[]
  readonly moreBusy: boolean
  readonly notice: PageNotice | null
  readonly selected: readonly string[]
  readonly add: NewState | null
  /** Design cases: the keys list open. */
  readonly keysOpen?: boolean
}

export interface SourcingPageActions {
  onAddress?: (change: Partial<SourcingAddress>) => void
  onRetry?: () => void
  onMore?: () => void
  onDismissNotice?: () => void
  onSelected?: (ids: string[]) => void
  /** Enter on a row: its PO record (the container navigates; a view never holds the router). */
  onOpenRecord?: (orderId: string) => void
  onDraft?: (draft: SampleDraft) => void
  onStyle?: (styleId: string | null) => void
  onLine?: (key: string, line: LineDraft) => void
  onLineWhat?: (key: string, what: SampleLineKind) => void
  onLineMaterial?: (key: string, itemId: string | null) => void
  onAddLine?: () => void
  onRemoveLine?: (key: string) => void
  onRetryChoices?: () => void
  onCreate?: () => void
}
