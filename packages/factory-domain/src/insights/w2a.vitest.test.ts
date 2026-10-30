import { describe, expect, it } from 'vitest'
import { grainPermission } from '../auth/grains/grains'
import { templateOf } from '../auth/roles/templates'
import type { Actor, Grant, Permission } from '../core/permissions'
import { isSnoozed, rowActionsOf, snoozeRefusal, snoozeTimeProblem, withActions, type StoredAction } from './actions'
import { ACTION_EVENTS, attentionFor, liveEventsOf, presentItem, type AttentionCandidate, type Viewer } from './attention'
import { comingDays, comingKindsFor, comingWindow, landsOn } from './coming-up'
import { mentionWords, PERSONAL_TEMPLATES, personalPhrase, taskDueWords } from './personal'
import { nudgeNote, nudgeRefusal } from './waiting'

const NOW = new Date('2026-10-30T09:00:00.000Z')
const A = '00000000-0000-7000-8000-0000000000a1'
const B = '00000000-0000-7000-8000-0000000000b1'
const ME = '00000000-0000-7000-8000-0000000000e1'
const ORDER = '00000000-0000-7000-8000-000000000501'
const actor = (key: string, companies: Grant['companies'] = 'all'): Actor => {
  const template = templateOf(key)!
  return { audience: 'office', tenantId: 't', grants: [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies, sites: 'all', parties: 'all' }] }
}
const viewer = (key: string): Viewer => ({ actor: actor(key), personId: ME, today: '2026-10-30', now: NOW })
const late: AttentionCandidate = {
  kind: 'ORDER_PROMISE',
  state: 'LATE',
  severity: 'HIGH',
  record: { type: 'SalesOrder', id: ORDER, label: 'SO-1' },
  scope: { companyId: A, siteId: null, partyId: null },
  sentence: { key: 'x', params: {}, text: 'Order SO-1 is late.' },
  blocks: null,
  due: '2026-10-28',
  since: new Date('2026-10-01T00:00:00.000Z'),
}
const stored = (change: Partial<StoredAction>): StoredAction => ({ id: 'a', rowKey: 'k', version: 1, assignedToId: null, assignedById: null, assignedAt: null, resolvedCondition: null, resolvedById: null, resolvedAt: null, acknowledgedCondition: null, acknowledgedById: null, acknowledgedAt: null, ...change })

describe("Today's snooze (B-W2a-20; design home.today popup snooze)", () => {
  const item = presentItem(viewer('owner'), late, { key: 'why', params: {}, text: 'why' })

  it('hides a row snoozed in its condition until the time comes, or until the condition changes', () => {
    const untilTime = stored({ snoozedCondition: item.condition, snoozedById: ME, snoozedAt: NOW, snoozedUntil: new Date(NOW.getTime() + 3_600_000) })
    expect(isSnoozed(item, untilTime, NOW)).toBe(true)
    expect(isSnoozed(item, untilTime, new Date(NOW.getTime() + 3_600_001))).toBe(false)
    const untilChange = stored({ snoozedCondition: item.condition, snoozedById: ME, snoozedAt: NOW, snoozedUntil: null })
    expect(isSnoozed(item, untilChange, new Date(NOW.getTime() + 86_400_000 * 30))).toBe(true)
    expect(isSnoozed({ condition: 'another' }, untilChange, NOW)).toBe(false)
    expect(withActions([item], new Map([[item.key, untilChange]]), NOW)).toMatchObject({ items: [], snoozed: 1, resolved: 0 })
    // Without a time the caller knows nothing of snoozes (W1's callers).
    expect(withActions([item], new Map([[item.key, untilChange]])).items).toHaveLength(1)
  })

  it('snoozes only an alert, in the condition it was read in, never a resolved one; until a later time within 90 days', () => {
    expect(rowActionsOf(item, undefined).snoozable).toBe(true)
    expect(snoozeRefusal(item, undefined, { condition: item.condition })).toBeNull()
    expect(snoozeRefusal(item, undefined, { condition: 'stale' })).toBe('CHANGED')
    expect(snoozeRefusal(item, stored({ resolvedCondition: item.condition, resolvedById: ME, resolvedAt: NOW }), { condition: item.condition })).toBe('ALREADY_RESOLVED')
    expect(snoozeRefusal({ ...item, category: 'APPROVAL' }, undefined, { condition: item.condition })).toBe('NOT_AN_ALERT')
    expect(snoozeTimeProblem(null, NOW)).toBeNull()
    expect(snoozeTimeProblem(NOW, NOW)).toMatch(/later/)
    expect(ACTION_EVENTS).toContain('attention.snoozed')
    expect(liveEventsOf(['ORDER_PROMISE'])).toContain('attention.snoozed')
  })
})

describe("Today's own rows (my tasks due, my mentions)", () => {
  it('words a task due today, at a time, or overdue, and a mention, from their own templates', () => {
    expect(taskDueWords({ title: 'Call Alfa', dueDate: '2026-10-30', dueTime: null, overdueDays: 0, recordLabel: null })).toMatchObject({ sentence: { text: 'Your task "Call Alfa" is due today.' }, blocks: null })
    expect(taskDueWords({ title: 'Call Alfa', dueDate: '2026-10-30', dueTime: '16:00', overdueDays: 0, recordLabel: 'LOT-88' }).blocks?.text).toBe('It is on LOT-88.')
    expect(taskDueWords({ title: 'Call Alfa', dueDate: '2026-10-28', dueTime: null, overdueDays: 2, recordLabel: null }).sentence.text).toBe('Your task "Call Alfa" is 2 days overdue: it was due on 28/10/2026.')
    expect(mentionWords({ actor: 'Marco', recordLabel: 'SO-1' }).text).toBe('Marco mentioned you in a note on SO-1.')
    expect(() => personalPhrase('nope')).toThrow(/no template/)
    expect(Object.keys(PERSONAL_TEMPLATES)).toContain('why.TASK_DUE.assigned')
  })

  it('a task row is mine with tasks.manage; a mention row with home.view', () => {
    const task: AttentionCandidate = { ...late, kind: 'TASK_DUE', state: 'TODAY', record: { type: 'Task', id: ORDER, label: 'Call' }, why: () => personalPhrase('why.TASK_DUE.assigned') }
    expect(attentionFor(viewer('sales'), [task]).map((row) => [row.category, row.why])).toEqual([['TASK', 'It is assigned to you.']])
    expect(attentionFor(viewer('read_only'), [task])).toEqual([])
    const mention: AttentionCandidate = { ...late, kind: 'MENTION', state: 'MENTIONED', subKey: 'n1', why: () => personalPhrase('why.MENTION.mentioned') }
    expect(attentionFor(viewer('read_only'), [mention]).map((row) => [row.category, row.key])).toEqual([['MENTION', `MENTION:${ORDER}:n1`]])
  })
})

describe('Coming up and Nudge', () => {
  it('lists the next five working days after today, and a closed day only when something lands on it', () => {
    const plus = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
    const weekday = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1
    const window = comingWindow('2026-10-30', (date) => weekday(date) <= 5, plus)
    expect(window.filter((day) => day.working).map((day) => day.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'])
    const words = { key: 'COMING.TASK', params: {}, text: 't' }
    const days = comingDays(window, [
      { kind: 'ORDER', date: '2026-10-31', record: { type: 'SalesOrder', id: '2', label: 'SO-2' }, scope: { companyId: A, siteId: null, partyId: null }, words },
      { kind: 'TASK', date: '2026-11-02', record: { type: 'Task', id: '1', label: 'Call' }, scope: { companyId: null, siteId: null, partyId: null }, words },
    ])
    expect(days.map((day) => [day.date, day.working, day.items.length])).toEqual([
      ['2026-10-31', false, 1],
      ['2026-11-02', true, 1],
      ['2026-11-03', true, 0],
      ['2026-11-04', true, 0],
      ['2026-11-05', true, 0],
      ['2026-11-06', true, 0],
    ])
  })

  it('reads only the kinds a person acts on, where they act', () => {
    expect(comingKindsFor(actor('sales'))).toEqual(['TASK', 'ORDER'])
    expect(comingKindsFor(actor('buyer'))).toEqual(['TASK', 'DELIVERY'])
    expect(comingKindsFor(actor('read_only'))).toEqual(['TASK'])
    expect(landsOn(actor('sales', [A]), 'ORDER', { companyId: B })).toBe(false)
  })

  it('nudges only an approval I asked for, once a day, when someone may decide it; the note names no figure', () => {
    expect(nudgeRefusal('APPROVAL_REQUEST', false, 2)).toBeNull()
    expect(nudgeRefusal('PO_CONFIRMATION', false, 2)).toBe('OUTSIDE')
    expect(nudgeRefusal('APPROVAL_REQUEST', true, 2)).toBe('TODAY_ALREADY')
    expect(nudgeRefusal('APPROVAL_REQUEST', false, 0)).toBe('NOBODY')
    expect(nudgeNote({ label: 'Q-1', ageDays: 3, byName: 'Sara' })).toBe('Reminder from Sara: Q-1 still waits for an approval (for 3 days).')
  })
})
