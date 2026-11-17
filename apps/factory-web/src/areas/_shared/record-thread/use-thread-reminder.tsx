'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useOfficeApi } from '../../../lib/session/context'
import { useLiveBus } from '../../../shell/live/use-live'
import { fetchReminders, reminderWriteProblem, setReminder, type Reminder } from '../../../shell/panels/remind-me/api'
import { REMIND_ME_EVENT, type RemindMeRequest } from '../../../shell/panels/remind-me/model'
import { RemindMeDialog } from '../../../shell/panels/remind-me/view/RemindMeDialog'

const REMINDER_EVENTS = new Set(['reminder.set', 'reminder.came_back', 'reminder.changed'])

/**
 * B-TH-300 — Remind me in the office thread (T1 "Remind me", the cards' own Remind me, B-W2b-388): the record panels' Remind me control
 * (RecordRemindMe) is not on a page that shows RecordThread, so a message's "Remind me" (it sends `factory:remind-me`) and the Head's
 * door open the SAME existing dialog here, and the person's next open reminder on the record is read for the Head's line ("Reminder
 * set for 18 Nov"). Reminders are Home's (home.view): without it the door is held and nothing is read.
 */
export function useThreadReminder(record: { readonly type: string; readonly id: string }, label: string, allowed: boolean): { readonly mine: Reminder | null; readonly open: (messageId: string | null) => void; readonly dialog: ReactNode } {
  const api = useOfficeApi()
  const [mine, setMine] = useState<Reminder | null>(null)
  const [asking, setAsking] = useState<{ readonly messageId: string | null; readonly now: number } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!allowed) return
    try {
      const answer = await fetchReminders(api, { view: 'OPEN', record })
      const waiting = answer.items.filter((item) => item.state === 'WAITING' && item.remindAt !== null).sort((a, b) => (a.remindAt! < b.remindAt! ? -1 : 1))
      setMine(waiting[0] ?? null)
    } catch {
      // Only the Head's line: without it the door still opens.
    }
  }, [api, record, allowed])
  useEffect(() => {
    void load()
  }, [load])
  const live = useLiveBus(
    {
      onChange: (change) => {
        if (REMINDER_EVENTS.has(change.type) && change.fields.recordType === record.type && change.fields.recordId === record.id) void load()
      },
      onReconnect: () => void load(),
    },
    allowed,
  )

  const open = useCallback((messageId: string | null) => {
    setProblem(null)
    setAsking({ messageId, now: Date.now() })
  }, [])
  // A message's own "Remind me" (MessageRemindMe) asks through the window event.
  useEffect(() => {
    if (!allowed) return
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<RemindMeRequest>).detail
      if (!detail || detail.recordType !== record.type || detail.recordId !== record.id) return
      open(detail.messageId)
    }
    window.addEventListener(REMIND_ME_EVENT, onAsk)
    return () => window.removeEventListener(REMIND_ME_EVENT, onAsk)
  }, [record.type, record.id, allowed, open])

  const dialog = asking ? (
    <RemindMeDialog
      what={label}
      aboutMessage={asking.messageId !== null}
      now={asking.now}
      held={live === 'offline' ? 'remind.held.offline' : null}
      problem={problem}
      onSet={async (ask) => {
        try {
          await setReminder(api, { record: { type: record.type, id: record.id }, messageId: asking.messageId, ...ask })
          void load()
          return true
        } catch (error) {
          setProblem(reminderWriteProblem(error).key)
          return false
        }
      }}
      onClose={() => setAsking(null)}
    />
  ) : null
  return { mine, open, dialog }
}
