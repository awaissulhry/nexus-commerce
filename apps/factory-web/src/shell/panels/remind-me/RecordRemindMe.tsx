'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOfficeApi } from '../../../lib/session/context'
import { useLiveBus } from '../../live/use-live'
import { fetchReminders, reminderReadProblem, reminderWriteProblem, removeReminder, setReminder, setReminderDone, type Reminder } from './api'
import { REMIND_ME_EVENT, type RemindMeRequest } from './model'
import { RemindMeDialog } from './view/RemindMeDialog'
import { RemindersISet, type RemindersISetModel } from './view/RemindersISet'

const REMINDER_EVENTS = new Set(['reminder.set', 'reminder.came_back', 'reminder.changed'])

/**
 * The record's Remind me (B-W2b-388; design shell.panels popup remind-me and side panel "Reminders I set"): the container the
 * record panels mount beside Follow. It reads my open reminders on the record (GET /reminders?recordType&recordId), reads them
 * again on a reminder event of this record, opens Remind me from its button or from a message of the thread (the window event
 * `factory:remind-me`: the message's own "Remind me"), and sets, finishes and removes with the reminder's version as read.
 */
export function RecordRemindMe({ record }: { record: { readonly type: string; readonly id: string; readonly label: string } }) {
  const api = useOfficeApi()
  const [reminders, setReminders] = useState<RemindersISetModel['reminders']>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<RemindersISetModel['notice']>(null)
  const [asking, setAsking] = useState<{ readonly messageId: string | null } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const answer = await fetchReminders(api, { view: 'OPEN', record: { type: record.type, id: record.id } })
      setReminders({ status: 'ready', items: answer.items })
    } catch (error) {
      setReminders({ status: 'error', problem: reminderReadProblem(error) })
    }
  }, [api, record.type, record.id])
  useEffect(() => {
    void load()
  }, [load])
  const live = useLiveBus({
    onChange: (change) => {
      if (REMINDER_EVENTS.has(change.type) && change.fields.recordType === record.type && change.fields.recordId === record.id) void load()
    },
    onReconnect: () => void load(),
  })
  useEffect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<RemindMeRequest>).detail
      if (!detail || detail.recordType !== record.type || detail.recordId !== record.id) return
      setNow(Date.now())
      setProblem(null)
      setAsking({ messageId: detail.messageId })
    }
    window.addEventListener(REMIND_ME_EVENT, onAsk)
    return () => window.removeEventListener(REMIND_ME_EVENT, onAsk)
  }, [record.type, record.id])

  const change = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await run()
      setNotice({ key: done, tone: 'success' })
    } catch (error) {
      const problemOf = reminderWriteProblem(error)
      setNotice({ key: problemOf.key, tone: 'warning' })
    } finally {
      setBusy(false)
      void load()
    }
  }

  const held = live === 'offline' ? 'remind.held.offline' : busy ? 'remind.held.busy' : null
  return (
    <>
      <RemindersISet
        model={{ reminders, held, notice }}
        actions={{
          onRemind: () => {
            setNow(Date.now())
            setProblem(null)
            setAsking({ messageId: null })
          },
          onDone: (reminder: Reminder) => void change(() => setReminderDone(api, reminder, true), 'set.notice.done'),
          onRemove: (reminder: Reminder) => void change(() => removeReminder(api, reminder), 'set.notice.removed'),
          onRetry: () => void load(),
        }}
      />
      {asking && (
        <RemindMeDialog
          what={record.label}
          aboutMessage={asking.messageId !== null}
          now={now}
          held={live === 'offline' ? 'remind.held.offline' : null}
          problem={problem}
          onSet={async (ask) => {
            try {
              await setReminder(api, { record: { type: record.type, id: record.id }, messageId: asking.messageId, ...ask })
              setNotice({ key: 'set.notice.set', tone: 'success' })
              void load()
              return true
            } catch (error) {
              setProblem(reminderWriteProblem(error).key)
              return false
            }
          }}
          onClose={() => setAsking(null)}
        />
      )}
    </>
  )
}
