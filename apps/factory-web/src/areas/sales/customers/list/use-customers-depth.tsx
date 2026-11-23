'use client'

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useToast, type MenuItemDef } from '@nexus/ui/components'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import { readUnreadWith } from '../../../../lib/last-message-cell/api'
import { useUnread } from '../../../../lib/last-message-cell/use-unread'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import type { PanelRead } from '../../../../record-panels/model'
import { createTasks, listAssignees, taskReadProblem, taskWriteProblem } from '../../../../record-panels/tasks/api'
import { batchBody, type Assignable, type BatchAnswer, type BatchAssignee, type BatchRecord, type TaskDraft } from '../../../../record-panels/tasks/model'
import { TaskNewDialog } from '../../../../record-panels/tasks/view/TaskNewDialog'
import { useLiveBus } from '../../../../shell/live/use-live'
import { romeToday } from '../../../finance/costing/model'
import type { PartyRow } from '../../../parties/_shared/api'
import type { ListDepthArgs, ListDepthSlot } from '../../../parties/_shared/PartiesList'
import { partyName, recordHref, SIDES } from '../../../parties/_shared/model'
import type { ListDepth } from '../../../parties/_shared/view/PartiesListView'
import { useOverdueColumns } from '../money/columns'
import { useOverdueList } from '../money/hooks'
import { customerBarActs, customerRowItems, useCustomerColumns } from './columns'
import { customerRightsOf, CUSTOMERS_LIST_NS, namesOtherCustomer } from './model'
import { useSupervisorMany } from './supervisor/use-supervisor-many'
import { SupervisorManyDialog } from './supervisor/view/SupervisorManyDialog'

/** The Add task window while open: the ticked customers as records, who may be given the tasks, the batch's one key. */
interface TaskWindow {
  readonly records: readonly BatchRecord[]
  readonly ticked: readonly PartyRow[]
  readonly people: PanelRead<readonly Assignable[]>
  readonly key: string
}

/**
 * F-CL-102 / F-CL-104 (customers list plan §1, 13-backend §8.1 / §8.4–§8.6): the customers' own parts of the shared list, with their
 * reads and windows. Reads fire only when shown and never per row: New messages = ONE `POST /threads/unread` per loaded page
 * (threads.read; read again, coalesced, on a live `thread.*` change), Overdue = the one read of who owes late (cu/money). The bar's
 * own acts — "Add task to N customers…" (the ONE batch window rp/tasks TaskNewDialog, in the customers' words, with the R-47 check)
 * and "Set production supervisor for N…" (the P2 window on the existing calls) — and the row's doors (Open thread, Open Work tab,
 * Add task…): each hidden without its own right. The slot it gives the list is called once per render of the list, at one place
 * (PartiesList.tsx), so its hooks keep their order; the windows mount beside the list.
 */
export function useCustomersDepth(): { readonly depth: ListDepthSlot; readonly windows: ReactNode } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const c = useT(CUSTOMERS_LIST_NS)
  const r = useT('records')
  const { toast } = useToast()
  const rights = useMemo(() => customerRightsOf(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const overdue = useOverdueColumns(useOverdueList())
  const [tick, setTick] = useState(0)
  useLiveBus({ onChange: (change) => change.type.startsWith('thread.') && setTick((count) => count + 1), onReconnect: () => setTick((count) => count + 1) }, rights.threads)
  const readUnread = useMemo(() => (rights.threads ? readUnreadWith(api) : null), [api, rights.threads])
  /** A name in a receipt opens the customer with its thread open. */
  const receiptHref = useCallback((id: string) => `${recordHref(prefix, SIDES.customers, id)}?thread=open`, [prefix])

  // ---- Add task to N customers… (tasks.manage + threads.post): ONE POST /tasks/batch, each customer's supervisor by default ----
  const [task, setTask] = useState<TaskWindow | null>(null)
  const taskNow = useRef(task)
  taskNow.current = task
  const readPeople = useCallback(
    (records: readonly BatchRecord[]) => {
      const first = records[0]
      if (!first) return
      setTask((now) => (now && now.records === records ? { ...now, people: { status: 'loading' } } : now))
      listAssignees(api, { type: 'Party', id: first.id }).then(
        (people) => setTask((now) => (now && now.records === records ? { ...now, people: { status: 'ready', data: people } } : now)),
        (error: unknown) => setTask((now) => (now && now.records === records ? { ...now, people: { status: 'error', problem: taskReadProblem(error) } } : now)),
      )
    },
    [api],
  )
  const openTask = useCallback(
    (rows: readonly PartyRow[]) => {
      if (!rights.tasks || rows.length === 0) return
      // The list knows no customer's supervisor: unknown (null), the server names one with none (NO_SUPERVISOR) in the receipt.
      const records: BatchRecord[] = rows.map((row) => ({ type: 'Party', id: row.id, label: partyName(row), supervisor: null }))
      setTask({ records, ticked: rows, people: { status: 'loading' }, key: newIdempotencyKey() })
      readPeople(records)
    },
    [rights.tasks, readPeople],
  )
  const sendTasks = useCallback(
    async (draft: TaskDraft, assignee: BatchAssignee): Promise<BatchAnswer | null> => {
      const now = taskNow.current
      if (!now) return null
      try {
        return await createTasks(api, batchBody(draft, assignee, now.records), now.key)
      } catch (error) {
        toast(r(taskWriteProblem(error).key), 'danger')
        return null
      }
    },
    [api, r, toast],
  )

  // ---- Set production supervisor for N… (production.brand.manage + partners.view) ----
  const supervisor = useSupervisorMany(api)
  const openSupervisor = supervisor.open
  const openSupervisorFor = useCallback((rows: readonly PartyRow[]) => (rights.supervisor ? openSupervisor(rows.map((row) => ({ id: row.id, name: partyName(row) }))) : undefined), [rights.supervisor, openSupervisor])

  // ---- the row's doors (after "Open in new tab"), each with its own right ----
  const rowItems = useCallback((row: PartyRow): MenuItemDef[] => customerRowItems(rights, prefix, row, c, openTask), [rights, prefix, c, openTask])

  const depth: ListDepthSlot = function useCustomersSlot(list: ListDepthArgs): ListDepth {
    const asked = useMemo(() => list.rows.map((row) => ({ recordType: 'Party', id: row.id })), [list.rows])
    const unread = useUnread(readUnread, asked, tick)
    const columns = useCustomerColumns({ prefix, unread: rights.threads ? unread : null, overdue })
    const acts = customerBarActs(rights, list.selectedRows, c, { onTask: openTask, onSupervisor: openSupervisorFor })
    return { nameColumn: columns.nameColumn, leadingColumns: columns.leadingColumns, hiddenColumns: columns.hiddenColumns, card: columns.card, rowItems, acts }
  }

  const windows = (
    <>
      {task && (
        <TaskNewDialog
          recordLabel={null}
          people={task.people}
          me={session.user.id}
          onRetryPeople={() => readPeople(task.records)}
          onClose={() => setTask(null)}
          batch={{
            records: task.records,
            today: romeToday(),
            onSend: sendTasks,
            words: { ns: CUSTOMERS_LIST_NS, prefix: 'task' },
            namesOther: (text) => namesOtherCustomer(text, task.ticked),
            hrefOf: (record) => receiptHref(record.id),
          }}
        />
      )}
      <SupervisorManyDialog model={supervisor.model} actions={supervisor.actions} hrefOf={receiptHref} />
    </>
  )
  return { depth, windows }
}
