'use client'

import { fixedDepartments } from '../../department/model'
import { useDepartmentWords } from '../../department/words'
import type { ChangeLogState } from '../model'
import { ChangeLog } from './ChangeLog'

/**
 * owb-b4 w4.4 — the lab of the change log (`/design/change-log-parts`): the office's face (names, reasons), the customer's ("The factory",
 * no reason: the server sent none), the floor's ("You", "Office", a department), in a PC's room (a table) and a phone's (a list: the
 * part's own room, here a 375 px box), and its states (reading, failed, empty, Load more, a failed page). Departments: the fixed table.
 * Made-up data only.
 */

export interface ChangeLogLabModel {
  readonly rows: ChangeLogState['rows']
  readonly status: ChangeLogState['status']
  readonly more: ChangeLogState['more']
  /** Draw it in a phone's room (375 px): the list. */
  readonly narrow?: boolean
}

const noop = () => undefined

export function ChangeLogLab({ model }: { model: ChangeLogLabModel }) {
  const departments = fixedDepartments(useDepartmentWords())
  return (
    <div style={{ padding: 'var(--nds-space-16)', maxWidth: model.narrow ? 375 : undefined, border: model.narrow ? '1px solid var(--nds-border-subtle)' : undefined }}>
      <ChangeLog model={{ rows: model.rows, status: model.status, more: model.more, departments, picture: { source: 'order', recordId: 'demo-log', number: 'Your order 12', read: null } }} actions={{ onMore: noop, onRetry: noop }} />
    </div>
  )
}
