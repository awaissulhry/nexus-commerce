import type { GateKind, WaitingTile } from '@nexus/factory-domain/planning/milestones/rules'
import type { LiveState } from '../../../shell/live/bus'
import type { GateChoices, Milestones } from './api'
import type { Can, Controls, GateDraft, ReadProblem, View } from './model'

/** What the Time & action screen draws (SCR-253): one typed model, filled by MilestonesPage or a design case. */

export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: ReadProblem }

export interface Notice {
  readonly tone: 'success' | 'danger' | 'info'
  readonly key: string
  readonly params?: Record<string, string | number>
}

export type MilestonesDialog =
  | { readonly kind: 'add'; readonly orderId: string | null; readonly draft: GateDraft; readonly choices: Loaded<GateChoices> | null; readonly busy: boolean; readonly problem: string | null }
  | { readonly kind: 'edit'; readonly gateId: string; readonly draft: GateDraft; readonly choices: Loaded<GateChoices> | null; readonly busy: boolean; readonly problem: string | null }
  | { readonly kind: 'pass'; readonly gateIds: readonly string[]; readonly on: string; readonly busy: boolean; readonly problem: string | null }
  | { readonly kind: 'startBefore'; readonly gateIds: readonly string[]; readonly reason: string; readonly busy: boolean; readonly problem: string | null }
  | { readonly kind: 'remove'; readonly gateId: string; readonly busy: boolean; readonly problem: string | null }
  | { readonly kind: 'keys' }

export interface MilestonesModel {
  readonly prefix: string
  readonly can: Can
  readonly me: string
  readonly controls: Controls
  readonly world: Loaded<Milestones>
  readonly live: LiveState
  readonly updates: number
  readonly notice: Notice | null
  readonly dialog: MilestonesDialog | null
  /** Design cases: rows ticked, the focused row and the keys panel, the calendar's day. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
  readonly day?: string | null
}

export interface MilestonesActions {
  readonly onView?: (view: View) => void
  readonly onTile?: (tile: WaitingTile | null) => void
  readonly onSearch?: (q: string) => void
  readonly onRetry?: () => void
  readonly onShowUpdates?: () => void
  readonly onOpen?: (milestoneId: string | null) => void
  /** Open the sales order (its record; ⌘-click or the dialog's link: a new tab). */
  readonly onOpenOrder?: (orderId: string, newTab: boolean) => void
  readonly onAdd?: (orderId: string | null) => void
  readonly onPickOrder?: (orderId: string) => void
  readonly onEdit?: (gateId: string) => void
  readonly onDraft?: (draft: GateDraft) => void
  readonly onSaveGate?: () => void
  readonly onPass?: (gateIds: readonly string[]) => void
  readonly onPassDay?: (on: string) => void
  readonly onPassConfirm?: () => void
  readonly onStartBefore?: (gateIds: readonly string[]) => void
  readonly onReason?: (reason: string) => void
  readonly onStartConfirm?: () => void
  readonly onRemove?: (gateId: string) => void
  readonly onRemoveConfirm?: () => void
  readonly onKeys?: () => void
  readonly onCloseDialog?: () => void
  readonly onDismissNotice?: () => void
}

export type { GateKind }
