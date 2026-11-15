import { personalPhrase } from '@nexus/factory-domain/insights/personal'
import { designScreen as todayScreen } from '../../../../areas/home/today/fixtures'
import type { ComingUpView, QueueItem, TodayViewModel } from '../../../../areas/home/today/model'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { TodayRemindCase } from './TodayRemindCase'

/**
 * SCR-548 — Today with reminders (B-W2b-388; design home.today needs-me "reminders that came back (W2b)", coming-up "'Remind me the
 * day before' per item (W2b)"), on SCR-029's made-up W2a day.
 */

const id = (n: number) => `0190f0e2-eeee-7000-8000-${String(n).padStart(12, '0')}`
const ref = (phrase: { key: string; params: Readonly<Record<string, string | number | readonly string[]>> }) => ({
  key: phrase.key,
  params: Object.fromEntries(Object.entries(phrase.params).map(([name, value]) => [name, typeof value === 'object' ? [...value] : value])) as Record<string, string | number | string[]>,
})

const w2a = todayScreen.cases.find((entry) => entry.id === 'w2a-owner')?.model
if (!w2a) throw new Error('SCR-548: SCR-029 has no case w2a-owner')

function reminder(n: number, record: { type: string; label: string }, note: string | null, kind: 'AT_TIME' | 'ON_CHANGE', minutesAgo: number): QueueItem {
  const recordId = id(n)
  const since = new Date(w2a!.now - minutesAgo * 60_000).toISOString()
  const sentence = note ? personalPhrase('REMINDER.BACK_NOTE', { record: record.label, note }) : personalPhrase('REMINDER.BACK', { record: record.label })
  const why = personalPhrase(kind === 'AT_TIME' ? 'why.REMINDER.AT_TIME' : 'why.REMINDER.ON_CHANGE')
  return {
    key: `REMINDER:${recordId}:${id(100 + n)}`,
    kind: 'REMINDER',
    state: kind,
    category: 'TASK',
    severity: 'MEDIUM',
    severityWord: 'Needs action',
    group: 'TODAY',
    record: { type: record.type, id: recordId, label: record.label },
    companyId: id(900),
    siteId: null,
    partyId: null,
    sentence: sentence.text,
    why: why.text,
    blocks: null,
    words: { sentence: ref(sentence), why: ref(why), blocks: null },
    sentenceFigure: null,
    due: null,
    since,
    ageDays: 0,
    decide: 'OPEN',
    figures: null,
    condition: since,
    actions: { version: 0, verbs: [], assigned: null, acknowledged: null },
    href: `/w/DEMO/records/${record.type}/${recordId}`,
    reviewHref: null,
  }
}

const REMINDERS = [reminder(1, { type: 'PurchaseOrder', label: 'PO-2026-0031' }, 'Supplier promised a date', 'AT_TIME', 12), reminder(2, { type: 'SalesOrder', label: 'SO-2026-0047' }, null, 'ON_CHANGE', 40)]

const queue = w2a.queue.status === 'ready' ? w2a.queue.data : null
const coming = w2a.comingUp?.status === 'ready' ? w2a.comingUp.data : null
const COMING: ComingUpView | null = coming
  ? { ...coming, days: coming.days.map((day) => ({ ...day, items: day.items.map((item, index) => ({ ...item, record: { type: item.kind === 'TASK' ? 'Task' : item.kind === 'ORDER' ? 'SalesOrder' : item.kind === 'DELIVERY' ? 'PurchaseOrder' : 'Certificate', id: id(200 + index) } })) })) }
  : null

const model: TodayViewModel = {
  ...w2a,
  queue: queue ? { status: 'ready', data: { ...queue, items: [...REMINDERS, ...queue.items], total: queue.total + 2, needYou: queue.needYou + 2 } } : w2a.queue,
  ...(COMING ? { comingUp: { status: 'ready' as const, data: COMING } } : {}),
}

export const designScreen = defineDesignScreen<TodayViewModel>({
  screen: 'SCR-548',
  title: 'Today with reminders (B-W2b-388)',
  view: TodayRemindCase,
  cases: [
    {
      id: 'reminders',
      label: 'Reminders that came back, Remind me the day before',
      model,
      note: 'Two reminders back among my rows (the alarm clock; my note in the sentence; why: its time came, or the record changed) with Done (e) and Snooze (h); Coming up has "Remind me the day before" per item (08:00 the day before; held once the day before has passed).',
    },
    { id: 'reminder-snooze', label: 'Snooze a reminder', model: { ...model, dialog: { kind: 'snooze', key: REMINDERS[0]!.key } }, note: 'Today’s "Snooze until" with "Until something changes on the record".' },
    { id: 'offline', label: 'Offline', model: { ...model, live: 'offline' }, note: 'Done, Snooze and Remind me the day before held with the reason.' },
  ],
})
