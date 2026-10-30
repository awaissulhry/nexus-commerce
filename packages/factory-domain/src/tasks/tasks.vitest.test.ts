import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { canTransition } from '../state/machine'
import { checklistOf, checklistProgress, dueOf, isSnoozed, nextChecklist, relationOf, snoozeProblem, taskFieldProblems, taskMachine, tileOf } from './rules'

const NOW = new Date('2026-10-30T09:00:00.000Z')
const TODAY = '2026-10-30'
const ME = 'me'

describe('tasks on any record (B-W2a-20: COL-037)', () => {
  it('checks a task’s title, words, due day and time, and checklist', () => {
    expect(taskFieldProblems({ title: 'Call Conceria Alfa about lot L-88', dueDate: TODAY, dueTime: '16:00', checklist: [{ text: 'Ask for the test report' }] }, true)).toEqual([])
    expect(taskFieldProblems({ title: '   ' }, true).map((issue) => issue.path)).toEqual(['body/title'])
    expect(taskFieldProblems({}, true).map((issue) => issue.path)).toEqual(['body/title'])
    expect(taskFieldProblems({}, false)).toEqual([])
    expect(taskFieldProblems({ title: 'x'.repeat(201), dueDate: '30/10/2026', dueTime: '25:00' }, true).map((issue) => issue.path)).toEqual(['body/title', 'body/dueDate', 'body/dueTime'])
    expect(taskFieldProblems({ dueDate: null, dueTime: '10:00' }, false).map((issue) => issue.path)).toEqual(['body/dueTime'])
    expect(taskFieldProblems({ checklist: [{ id: 'a', text: 'one' }, { id: 'a', text: '' }] }, false).map((issue) => issue.path)).toEqual(['body/checklist/1/text', 'body/checklist'])
  })

  it('keeps who ticked an item and when; a new tick is the editor’s; an untick forgets', () => {
    let next = 0
    const by = { userId: ME, now: '2026-10-30T09:00:00.000Z', newId: () => `id-${++next}` }
    const first = nextChecklist([], [{ text: 'Ask' }, { text: 'Chase', done: true }], by)
    expect(first).toEqual([
      { id: 'id-1', text: 'Ask', done: false, doneAt: null, doneById: null },
      { id: 'id-2', text: 'Chase', done: true, doneAt: by.now, doneById: ME },
    ])
    const later = nextChecklist(first, [{ id: 'id-2', text: 'Chase' }, { id: 'id-1', text: 'Ask', done: true }, { id: 'unknown', text: 'New' }], { ...by, userId: 'other', now: '2026-10-31T09:00:00.000Z' })
    expect(later.map((item) => [item.id, item.done, item.doneById])).toEqual([
      ['id-2', true, ME],
      ['id-1', true, 'other'],
      ['id-3', false, null],
    ])
    expect(checklistProgress(later)).toEqual({ done: 2, total: 3 })
    expect(checklistProgress([])).toBeNull()
    expect(checklistOf([{ id: 'x', text: 'ok' }, { nope: true }, null])).toEqual([{ id: 'x', text: 'ok', done: false, doneAt: null, doneById: null }])
  })

  it('moves OPEN → DONE | CANCELLED and back to OPEN; snoozes only an open task, at most 90 days', () => {
    expect(canTransition(taskMachine, 'OPEN', 'DONE').ok).toBe(true)
    expect(canTransition(taskMachine, 'DONE', 'OPEN').ok).toBe(true)
    expect(canTransition(taskMachine, 'DONE', 'CANCELLED').ok).toBe(false)
    expect(snoozeProblem(new Date(NOW.getTime() + 3_600_000), NOW)).toBeNull()
    expect(snoozeProblem(NOW, NOW)).toMatch(/later/)
    expect(isSnoozed({ status: 'OPEN', snoozedUntil: new Date(NOW.getTime() + 1) }, NOW)).toBe(true)
    expect(isSnoozed({ status: 'DONE', snoozedUntil: new Date(NOW.getTime() + 1) }, NOW)).toBe(false)
  })

  it('counts My tasks’ tiles: overdue, today, this week, no date, done in 7 days', () => {
    const open = (dueDate: string | null) => ({ status: 'OPEN' as const, dueDate, closedAt: null })
    expect(tileOf(open('2026-10-29'), TODAY, NOW)).toBe('OVERDUE')
    expect(tileOf(open(TODAY), TODAY, NOW)).toBe('TODAY')
    expect(tileOf(open('2026-11-06'), TODAY, NOW)).toBe('THIS_WEEK')
    expect(tileOf(open('2026-11-07'), TODAY, NOW)).toBeNull()
    expect(tileOf(open(null), TODAY, NOW)).toBe('NO_DATE')
    expect(tileOf({ status: 'DONE', dueDate: null, closedAt: new Date(NOW.getTime() - 86_400_000) }, TODAY, NOW)).toBe('DONE_7D')
    expect(tileOf({ status: 'DONE', dueDate: null, closedAt: new Date(NOW.getTime() - 8 * 86_400_000) }, TODAY, NOW)).toBeNull()
    expect(tileOf({ status: 'CANCELLED', dueDate: TODAY, closedAt: NOW }, TODAY, NOW)).toBeNull()
    expect(dueOf('2026-10-28', TODAY)).toEqual({ date: '2026-10-28', days: -2, word: 'OVERDUE' })
    expect(dueOf(null, TODAY)).toBeNull()
  })

  it('a task is its maker’s and its assignee’s, and a record’s readers’', () => {
    expect(relationOf({ createdById: ME, assigneeId: 'x', recordType: null }, ME, false)).toBe('CREATOR')
    expect(relationOf({ createdById: 'x', assigneeId: ME, recordType: null }, ME, false)).toBe('ASSIGNEE')
    expect(relationOf({ createdById: 'x', assigneeId: 'y', recordType: 'Quote' }, ME, true)).toBe('RECORD')
    // A task of its own is nobody else's, whatever they read.
    expect(relationOf({ createdById: 'x', assigneeId: 'y', recordType: null }, ME, true)).toBeNull()
  })

  it('declares tasks.manage (a write) for the office templates that write notes, never read-only or the floor; and its events', () => {
    expect(FACTORY_PERMISSIONS.get('tasks.manage')?.risk).toBe('write')
    for (const key of ['owner', 'admin', 'finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor']) expect(templateOf(key)!.permissions, key).toContain('tasks.manage')
    for (const key of ['read_only', 'operator', 'team_leader']) expect(templateOf(key)!.permissions, key).not.toContain('tasks.manage')
    for (const type of ['task.created', 'task.assigned', 'task.completed', 'task.changed']) expect(EVENT_CATALOGUE.get(type, 1).live?.permission, type).toBe('home.view')
  })
})
