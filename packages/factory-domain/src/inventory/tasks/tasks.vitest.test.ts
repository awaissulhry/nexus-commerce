import { describe, expect, it } from 'vitest'
import { events } from '../../inventory-tasks/events'
import { audienceOf, doneByTapRefusal, inboxOrder, inInbox, stepRefusal, TASK_ACTS, TASK_KINDS, taskShapeProblems } from './rules'
import { quarantinePlan, scheduleDue } from './sources'

/** The warehouse task inbox (B-W2b-292; SCM-274), the pure rules. Made-up ids only. */

const open = { status: 'OPEN' as const, takenByWorkerId: null, takenById: null }
const me = { kind: 'WORKER' as const, id: 'w-me' }

describe('steps', () => {
  it('takes an open task, refuses one in someone else’s hands, a done or a cancelled one', () => {
    expect(stepRefusal(open, 'TAKE', me)).toBeNull()
    expect(stepRefusal({ ...open, status: 'TAKEN', takenByWorkerId: 'w-me' }, 'TAKE', me)).toBeNull()
    expect(stepRefusal({ ...open, status: 'TAKEN', takenByWorkerId: 'w-other' }, 'TAKE', me)).toMatchObject({ code: 'TAKEN_BY_OTHER' })
    expect(stepRefusal({ ...open, status: 'DONE' }, 'DONE', me)).toMatchObject({ code: 'DONE' })
    expect(stepRefusal({ ...open, status: 'CANCELLED' }, 'CHANGE', { kind: 'USER', id: 'u' })).toMatchObject({ code: 'CANCELLED' })
  })

  it('gives back only a task one holds', () => {
    expect(stepRefusal(open, 'GIVE_BACK', me)).toMatchObject({ code: 'NOT_TAKEN' })
    expect(stepRefusal({ ...open, status: 'TAKEN', takenByWorkerId: 'w-other' }, 'GIVE_BACK', me)).toMatchObject({ code: 'NOT_YOURS' })
    expect(stepRefusal({ ...open, status: 'TAKEN', takenByWorkerId: 'w-me' }, 'GIVE_BACK', me)).toBeNull()
  })

  it('confirms a quarantine move only by the place scan; a put-away by a tap only once nothing is left', () => {
    expect(doneByTapRefusal('QUARANTINE', null, { label: 'Lot L-1', at: null })).toMatchObject({ code: 'SCAN_THE_PLACE' })
    expect(doneByTapRefusal('PUT_AWAY', '12.5', { label: 'Lot L-1', at: 'DOCK' })).toEqual({ code: 'STILL_THERE', message: 'Lot L-1 still lies at DOCK: scan it, then scan the place you put it in.' })
    expect(doneByTapRefusal('PUT_AWAY', '0', { label: 'Lot L-1', at: 'DOCK' })).toBeNull()
    expect(doneByTapRefusal('PICK', '3', { label: 'x', at: null })).toBeNull()
    expect(TASK_ACTS.QUARANTINE).toEqual({ permission: 'inventory.transfer', doneBy: 'PLACE_SCAN' })
    expect(Object.keys(TASK_ACTS)).toEqual([...TASK_KINDS])
  })
})

describe('the inbox', () => {
  const viewer = { workerId: 'w-me', roleIds: ['r-store'] }
  it('says for whom a task is', () => {
    expect(audienceOf({ assignedRoleId: null, assignedWorkerId: 'w-me' }, viewer)).toBe('MINE')
    expect(audienceOf({ assignedRoleId: null, assignedWorkerId: 'w-other' }, viewer)).toBe('OTHER')
    expect(audienceOf({ assignedRoleId: 'r-store', assignedWorkerId: null }, viewer)).toBe('ROLE')
    expect(audienceOf({ assignedRoleId: 'r-cut', assignedWorkerId: null }, viewer)).toBe('OTHER')
    expect(audienceOf({ assignedRoleId: null, assignedWorkerId: null }, viewer)).toBe('ANYONE')
  })

  it('shows open tasks for me, my role or anyone, and the ones in my hands; never another’s', () => {
    const task = { ...open, assignedRoleId: null, assignedWorkerId: null }
    expect(inInbox(task, viewer)).toBe(true)
    expect(inInbox({ ...task, status: 'TAKEN', takenByWorkerId: 'w-other' }, viewer)).toBe(false)
    expect(inInbox({ ...task, status: 'TAKEN', takenByWorkerId: 'w-me' }, viewer)).toBe(true)
    expect(inInbox({ ...task, assignedWorkerId: 'w-other' }, viewer)).toBe(false)
    expect(inInbox({ ...task, status: 'DONE' }, viewer)).toBe(false)
  })

  it('puts the next task first: in hand, then due, then the oldest, then the id', () => {
    const at = (iso: string) => new Date(iso)
    const rows = [
      { id: 'c', status: 'OPEN' as const, takenByWorkerId: null, dueAt: null, createdAt: at('2026-11-01T08:00:00Z') },
      { id: 'b', status: 'OPEN' as const, takenByWorkerId: null, dueAt: at('2026-11-12T10:00:00Z'), createdAt: at('2026-11-02T08:00:00Z') },
      { id: 'a', status: 'OPEN' as const, takenByWorkerId: null, dueAt: at('2026-11-12T10:00:00Z'), createdAt: at('2026-11-02T08:00:00Z') },
      { id: 'd', status: 'TAKEN' as const, takenByWorkerId: 'w-me', dueAt: null, createdAt: at('2026-11-03T08:00:00Z') },
    ]
    expect([...rows].sort(inboxOrder('w-me')).map((row) => row.id)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('checks a task by hand: a role or a person, two places, a hide with its lot', () => {
    expect(taskShapeProblems({ assignedRoleId: 'r', assignedWorkerId: 'w' })).toEqual([{ path: 'assignedWorkerId', message: 'A task is for a role or for one person, not both.' }])
    expect(taskShapeProblems({ fromLocationId: 'p', toLocationId: 'p' })[0]!.path).toBe('toLocationId')
    expect(taskShapeProblems({ hideId: 'h' })[0]!.path).toBe('lotId')
    expect(taskShapeProblems({ quantity: '0' })[0]!.path).toBe('quantity')
    expect(taskShapeProblems({ itemId: 'i', lotId: 'l', quantity: '2' })).toEqual([])
  })
})

describe('sources', () => {
  const hold = { status: 'ACTIVE', quarantine: 'ASKED', quarantineLocationId: 'q1', stock: true }
  it('gives a hold that asks quarantine one task, following its place', () => {
    expect(quarantinePlan(hold, [])).toEqual({ action: 'CREATE', toLocationId: 'q1' })
    expect(quarantinePlan(hold, [{ id: 't1', toLocationId: 'q1' }])).toEqual({ action: 'NONE' })
    expect(quarantinePlan({ ...hold, quarantineLocationId: 'q2' }, [{ id: 't1', toLocationId: 'q1' }])).toEqual({ action: 'FOLLOW', taskId: 't1', toLocationId: 'q2' })
    expect(quarantinePlan(hold, [{ id: 't1', toLocationId: 'q1' }, { id: 't2', toLocationId: 'q1' }])).toMatchObject({ action: 'CANCEL', taskIds: ['t2'] })
  })

  it('cancels it when the hold is released, closed, or no longer asks', () => {
    const task = [{ id: 't1', toLocationId: 'q1' }]
    expect(quarantinePlan({ ...hold, status: 'RELEASED' }, task)).toEqual({ action: 'CANCEL', taskIds: ['t1'], reason: 'The hold was released: nothing moves to quarantine.' })
    expect(quarantinePlan({ ...hold, status: 'CLOSED' }, task)).toMatchObject({ reason: 'The hold was closed: nothing moves to quarantine.' })
    expect(quarantinePlan({ ...hold, quarantine: 'MOVED' }, task)).toMatchObject({ reason: 'The move to quarantine was confirmed.' })
    expect(quarantinePlan({ ...hold, quarantine: 'NOT_NEEDED' }, [])).toEqual({ action: 'NONE' })
    expect(quarantinePlan({ ...hold, stock: false }, [])).toEqual({ action: 'NONE' })
  })

  it('says when a count schedule is due', () => {
    expect(scheduleDue({ active: true, nextDueOn: '2026-11-12' }, '2026-11-12')).toBe(true)
    expect(scheduleDue({ active: true, nextDueOn: '2026-11-13' }, '2026-11-12')).toBe(false)
    expect(scheduleDue({ active: false, nextDueOn: '2026-11-01' }, '2026-11-12')).toBe(false)
  })
})

describe('the event', () => {
  it('reaches the office and the site’s tablets, never a person', () => {
    const [changed] = events
    expect(changed.live).toEqual({ permission: 'inventory.stock.view', floor: 'floor.work', fields: ['taskId', 'kind', 'status', 'change', 'sourceType', 'sourceId', 'toLocationId'] })
    expect(Object.keys(changed.payload.shape)).not.toContain('assignedWorkerId')
  })
})
