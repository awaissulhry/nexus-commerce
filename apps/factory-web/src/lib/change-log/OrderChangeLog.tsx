'use client'

import type { ApiClient } from '../api/client'
import { useDepartments } from '../department/use-departments'
import type { ReadOrderLog } from './api'
import { useChangeLog } from './use-change-log'
import { ChangeLog, type ChangeLogModel } from './view/ChangeLog'

export interface OrderChangeLogProps {
  /** The host's read port: `orderLogReader(api, orderLogPath(door, record, id))` (a stable value: `useMemo`). */
  readonly read: ReadOrderLog | null
  /** The client the departments are read with (office, floor); the portal passes none: the fixed table of the nine. */
  readonly departmentsApi?: ApiClient | null
  /** The record a picture value belongs to (its batch read). */
  readonly picture?: ChangeLogModel['picture']
}

/**
 * owb-b4 w4.4 — the change log ready to mount: its reads (useChangeLog, "Load more", "Try again") and the departments (useDepartments)
 * around the view. Office: S2's Changes tab · portal: S1's "All changes" window · floor: S5's basket (its own read, the floor face).
 * Not a view: it holds the reads; view/ChangeLog draws.
 */
export function OrderChangeLog({ read, departmentsApi = null, picture = null }: OrderChangeLogProps) {
  const { state, onMore, onRetry } = useChangeLog(read)
  const { departments } = useDepartments(departmentsApi)
  return <ChangeLog model={{ rows: state.rows, status: state.status, more: state.more, departments, picture }} actions={{ onMore, onRetry }} />
}
