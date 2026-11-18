'use client'

import { SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { taskDueWords } from '../../../../../record-panels/tasks/model'
import type { Read, TasksRead } from '../use-customer-work'
import { pickOfTask } from '../use-customer-work'
import type { DockPick } from './WorkTab'
import './customer-work.css'

/**
 * F-SA-278 (sales page plan N5; 11-customer-page §3.2 "Open tasks"): the open tasks on one customer's records, in a centred window —
 * title, the record (a chip that picks it in the page's dock: an order, a quote, a request; the customer's own record picks the
 * customer's thread), who it is for and its due day in words ("Overdue 2 days", "Due today", "Due 3 Dec"; an icon-free tag, never
 * colour alone). Only tasks on records the reader may read (the API's B-SA-072); "only the newest 200" when the read was capped.
 */
export function OpenTasksDialog(props: { customer: string; tasks: Read<TasksRead>; onPick: (pick: DockPick | null) => void; onClose: () => void }) {
  return (
    <WithMessages namespaces={['records']}>
      <Dialog {...props} />
    </WithMessages>
  )
}

function Dialog({ customer, tasks, onPick, onClose }: { customer: string; tasks: Read<TasksRead>; onPick: (pick: DockPick | null) => void; onClose: () => void }) {
  const t = useT('parties')
  const r = useT('records')
  const locale = useLocale()
  const items = tasks.status === 'ready' ? tasks.value.items : null
  return (
    <Modal open onClose={onClose} size="lg" title={t('customers.work.window.tasksTitle', { customer })}>
      <div className="fw-cw">
        {tasks.status === 'reading' ? (
          <Skeleton height={120} />
        ) : tasks.status === 'failed' ? (
          <p className="fw-cw-line">{t('customers.work.tile.failed')}</p>
        ) : !items || items.length === 0 ? (
          <p className="fw-cw-line">{t('customers.work.window.tasksNone', { customer })}</p>
        ) : (
          <SummaryTable
            label={t('customers.work.window.tasksTitle', { customer })}
            stackOnPhone
            columns={[t('customers.work.window.col.task'), t('customers.work.window.col.record'), t('customers.work.window.col.for'), t('customers.work.window.col.due')]}
            rows={items.map((task) => {
              const due = taskDueWords(task.due)
              const record = task.record
              return {
                id: task.id,
                cells: [
                  task.title,
                  record ? (
                    <Button
                      key="record"
                      size="sm"
                      variant="quiet"
                      title={t('customers.work.window.pickTip', { record: record.label })}
                      onClick={() => {
                        onPick(pickOfTask(task))
                        onClose()
                      }}
                    >
                      {record.label}
                    </Button>
                  ) : (
                    '—'
                  ),
                  task.assignee?.name ?? r('tasks.new.field.nobody'),
                  due ? (
                    <Tag key="due" tone={due.late ? 'danger' : due.key === 'tasks.due.today' ? 'warning' : 'neutral'}>
                      {r(due.key, { count: due.count, date: formatDate(`${due.date}T12:00:00Z`, { locale }) })}
                    </Tag>
                  ) : (
                    r('tasks.due.none')
                  ),
                ],
              }
            })}
          />
        )}
        {tasks.status === 'ready' && !tasks.value.complete && <p className="fw-cw-line">{t('customers.work.window.tasksMore')}</p>}
      </div>
    </Modal>
  )
}
