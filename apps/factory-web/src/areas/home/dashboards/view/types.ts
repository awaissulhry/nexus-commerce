import type { SectionLayoutValue } from '@nexus/ui/patterns'
import type { BoardEntry, Boards, ByCompany, DashboardKey, DashLayout, NeedsAction, Numbers, Trends, Wip } from '../api'
import type { DashboardAddress, DashboardsAbilities } from '../model'

/** A panel's read: each panel loads and fails on its own (design: "other sections keep working"). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly value: T }

export interface DashboardsModel {
  readonly can: DashboardsAbilities
  /** `/w/<company>`. */
  readonly prefix: string
  readonly address: DashboardAddress
  /** The picker and the scope's choices. */
  readonly boards: Read<Boards>
  /** The dashboard shown (the address's, else the person's first). */
  readonly board: BoardEntry | null
  readonly numbers: Read<Numbers>
  readonly needs: Read<NeedsAction>
  readonly trends: Read<Trends>
  readonly wip: Read<Wip>
  readonly byCompany: Read<ByCompany>
  /** My arrangement (loading or failed: the dashboard's own order). */
  readonly layout: Read<DashLayout>
  /** The office pages that are built (a link only to a page that exists). */
  readonly built: ReadonlySet<string>
  /** `present`: the meeting view in its own window — the same panels large, no controls (design tab:present). */
  readonly mode: 'page' | 'present'
  readonly arranging?: boolean
  /** Saving the arrangement: running, or its refusal (a message key). */
  readonly arrange?: { readonly busy: boolean; readonly problem: string | null }
  readonly keysOpen?: boolean
  /** The read's clock, for "as of" (design cases). */
  readonly now?: number
  /** The explain popover open on this number (design cases). */
  readonly explain?: string | null
}

export interface DashboardsActions {
  onAddress?: (address: DashboardAddress) => void
  onBoard?: (board: DashboardKey) => void
  onRetry?: (panel: 'boards' | 'numbers' | 'needs' | 'trends' | 'wip' | 'byCompany') => void
  onOpen?: (href: string) => void
  onArrange?: (open: boolean) => void
  onArranged?: (value: SectionLayoutValue) => void
  onReset?: () => void
  onKeys?: (open: boolean) => void
}
