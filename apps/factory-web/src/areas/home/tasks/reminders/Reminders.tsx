'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReminderView } from '@nexus/factory-domain/reminders/rules'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { bulkReminders, fetchReminders, putOffReminder, reminderReadProblem, reminderWriteProblem, removeReminder, setReminderDone, type Reminder } from '../../../../shell/panels/remind-me/api'
import { doneable, rowOf, type RemindersModel, type ReminderRow } from './model'
import { RemindersView } from './view/RemindersView'

const REMINDER_EVENTS = new Set(['reminder.set', 'reminder.came_back', 'reminder.changed'])

/**
 * Home › My tasks › Reminders, the container (B-W2b-388): reads my reminders of the chosen list (GET /reminders?view=), reads them
 * again on a reminder event, and finishes, puts off, undoes and removes them (one by one with the version as read, or Done N ·
 * Remove N all or none). A done one offers Undo in the notice. My tasks mounts it under the tasks.
 */
export function Reminders() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const [view, setView] = useState<ReminderView>('OPEN')
  const [list, setList] = useState<RemindersModel['list']>({ status: 'loading' })
  const [selected, setSelected] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<RemindersModel['notice']>(null)
  const [putOff, setPutOff] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const lastDone = useRef<Reminder | null>(null)

  const load = useCallback(async () => {
    try {
      const answer = await fetchReminders(api, { view })
      setList({ status: 'ready', data: { rows: answer.items.map((item) => rowOf(item, prefix, OFFICE_PAGES)), counts: answer.counts, asOf: answer.asOf, complete: answer.complete } })
      setSelected((current) => current.filter((id) => answer.items.some((item) => item.id === id)))
      setNow(Date.now())
    } catch (error) {
      setList({ status: 'error', problem: reminderReadProblem(error) })
    }
  }, [api, prefix, view])
  useEffect(() => {
    void load()
  }, [load])
  const live = useLiveBus({ onChange: (change) => REMINDER_EVENTS.has(change.type) && void load(), onReconnect: () => void load() })

  const act = async (run: () => Promise<unknown>, done: RemindersModel['notice']): Promise<boolean> => {
    setBusy(true)
    try {
      await run()
      setNotice(done)
      return true
    } catch (error) {
      setNotice({ key: reminderWriteProblem(error).key, tone: 'warning' })
      return false
    } finally {
      setBusy(false)
      void load()
    }
  }
  const rows = list.status === 'ready' ? list.data.rows : []

  const model = useMemo<RemindersModel>(() => ({ view, list, selected, now, held: live === 'offline' ? 'held.offline' : busy ? 'held.busy' : null, notice, putOff }), [view, list, selected, now, live, busy, notice, putOff])
  return (
    <RemindersView
      model={model}
      actions={{
        onView: (next) => {
          setView(next)
          setSelected([])
          setList({ status: 'loading' })
        },
        onSelect: setSelected,
        onDone: (row: ReminderRow) =>
          void act(
            async () => {
              lastDone.current = await setReminderDone(api, row, true)
            },
            { key: 'reminders.notice.done', tone: 'success', params: { record: row.record.label }, undo: true },
          ),
        onUndo: (row: ReminderRow) => void act(() => setReminderDone(api, row, false), { key: 'reminders.notice.undone', tone: 'success', params: { record: row.record.label } }),
        onUndoLast: () => {
          const done = lastDone.current
          if (!done) return
          lastDone.current = null
          void act(() => setReminderDone(api, done, false), { key: 'reminders.notice.undone', tone: 'success', params: { record: done.record.label } })
        },
        onRemove: (row: ReminderRow) => void act(() => removeReminder(api, row), { key: 'reminders.notice.removed', tone: 'success', params: { record: row.record.label } }),
        onPutOff: (row) => {
          setNow(Date.now())
          setPutOff(row?.id ?? null)
        },
        onPutOffTo: (row, until) => act(() => putOffReminder(api, row, until), { key: until === null ? 'reminders.notice.putOffChange' : 'reminders.notice.putOff', tone: 'success', params: { record: row.record.label } }),
        onBulkDone: () => {
          const ids = doneable(rows, selected).map((row) => row.id)
          if (ids.length === 0) return
          void act(() => bulkReminders(api, 'DONE', ids), { key: 'reminders.notice.bulkDone', tone: 'success', params: { count: ids.length } }).then((ok) => ok && setSelected([]))
        },
        onBulkRemove: () => {
          const ids = [...selected]
          if (ids.length === 0) return
          void act(() => bulkReminders(api, 'REMOVE', ids), { key: 'reminders.notice.bulkRemoved', tone: 'success', params: { count: ids.length } }).then((ok) => ok && setSelected([]))
        },
        onRetry: () => void load(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
