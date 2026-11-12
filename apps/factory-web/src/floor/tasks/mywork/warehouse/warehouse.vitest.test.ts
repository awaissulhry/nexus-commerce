import { describe, expect, it } from 'vitest'
import { TASK_KINDS } from '@nexus/factory-domain/inventory/tasks/rules'
import { homeTiles, tilePage } from '../../../model'
import { designScreen } from '../fixtures'
import { taskSchema } from './api'
import { inboxOf, NOW, TASKS } from './fixtures'
import { changedTasks, codeOfTask, countsLine, doneByScans, doneHeld, inboxChanged, isLate, moveCount, moveTasks, screenOf, stepsStill, totalCount, withStep, withSteps, type OwnStep } from './model'

/** My work at the warehouse (B-W2b-308): the inbox's rules, this tablet's own steps, the Home tiles' counts, the design cases. */

describe('the warehouse task inbox', () => {
  it('counts what waits: the Move tile its put-aways, moves and quarantine moves; My work all; unknown is no number', () => {
    const counts = inboxOf(TASKS).counts
    expect(moveCount(counts)).toBe(3)
    expect(totalCount(counts)).toBe(6)
    expect(moveCount(null)).toBeNull()
    expect(totalCount(null)).toBeNull()
    expect(countsLine(counts).map((entry) => entry.kind)).toEqual(TASK_KINDS.filter((kind) => counts[kind] > 0))
    expect(moveTasks(inboxOf(TASKS)).map((task) => task.kind)).toEqual(['PUT_AWAY', 'QUARANTINE', 'MOVE'])
  })

  it('each kind is done its own way: moves by their scans, a quarantine move only by its place, the rest by a tap', () => {
    expect(TASK_KINDS.map((kind) => [kind, screenOf(kind)])).toEqual([
      ['RECEIVE', 'receive'],
      ['PUT_AWAY', 'move'],
      ['PICK', 'pick'],
      ['MOVE', 'move'],
      // B-W2b-310: Count on the task's place.
      ['COUNT', 'count'],
      ['QUARANTINE', 'move'],
    ])
    expect(doneHeld({ kind: 'QUARANTINE' })).toBe('scanPlace')
    expect(doneHeld({ kind: 'COUNT' })).toBeNull()
    expect(doneByScans({ kind: 'PUT_AWAY' })).toBe(true)
    expect(doneByScans({ kind: 'RECEIVE' })).toBe(false)
    expect(codeOfTask(TASKS.find((task) => task.id === 't-move')!)).toMatch(/^HD-/)
    expect(codeOfTask(TASKS[0]!)).toBe('LOT-DEMO-0031')
    expect(codeOfTask(TASKS.find((task) => task.id === 't-rcv')!)).toBeNull()
    expect(isLate(TASKS.find((task) => task.id === 't-count')!, new Date(NOW))).toBe(true)
  })

  it('shows this tablet\'s steps at once and drops them once the office\'s list says the same', () => {
    const inbox = inboxOf(TASKS)
    const at = NOW
    let steps: OwnStep[] = withStep([], { taskId: 't-rcv', step: 'done', at, clientEventId: 'c1' })
    steps = withStep(steps, { taskId: 't-move', step: 'take', at, clientEventId: null })
    const shown = withSteps(inbox, steps)!
    expect(shown.tasks.map((task) => task.id)).not.toContain('t-rcv')
    expect(shown.counts.RECEIVE).toBe(0)
    expect(shown.tasks.find((task) => task.id === 't-move')).toMatchObject({ mine: true, status: 'TAKEN' })
    // In hand first.
    expect(shown.tasks.filter((task) => task.mine).map((task) => task.id)).toEqual(['t-put', 't-move'])
    // A later step on the same task replaces the earlier one.
    expect(withStep(steps, { taskId: 't-move', step: 'giveBack', at, clientEventId: null }).filter((step) => step.taskId === 't-move')).toHaveLength(1)
    // The office's list: the delivery gone, the move in hand → both steps drop.
    const office = inboxOf([...TASKS.filter((task) => task.id !== 't-rcv').map((task) => (task.id === 't-move' ? { ...task, mine: true, status: 'TAKEN' as const } : task))])
    expect(stepsStill(steps, office)).toEqual([])
    expect(stepsStill(steps, inbox)).toHaveLength(2)
  })

  it('a fresher list waits behind "List changed · Show": it differs when a row, its order or its state differ', () => {
    const shown = inboxOf(TASKS)
    expect(inboxChanged(shown, inboxOf(TASKS))).toBe(false)
    expect(inboxChanged(null, inboxOf(TASKS))).toBe(false)
    const fresh = inboxOf([...TASKS.slice(1), { ...TASKS[0]!, version: 2 }])
    expect(inboxChanged(shown, fresh)).toBe(true)
    expect(changedTasks(shown, inboxOf(TASKS.slice(1)))).toBeGreaterThan(0)
  })

  it('reads the API\'s task (no person, no money): the viewer\'s fields default for the office\'s reads', () => {
    const { audience, mine, ...rest } = TASKS[0]!
    const parsed = taskSchema.parse(rest)
    expect(parsed.audience).toBe('ANYONE')
    expect(parsed.mine).toBe(false)
    expect(JSON.stringify(TASKS)).not.toMatch(/price|cost|worker/i)
    void audience
    void mine
  })
})

describe('My work at the warehouse on Home (B-W2b-308)', () => {
  it('My work joins the warehouse first; Move & put away follows Receive; Incident and Scan stay on page one', () => {
    const lead = ['floor.work', 'inventory.receive', 'inventory.transfer', 'inventory.issue', 'plant.report']
    const tiles = homeTiles('warehouse', lead, false)
    expect(tiles.map((tile) => tile.key).slice(0, 4)).toEqual(['mywork', 'receive', 'move', 'pick'])
    expect(tilePage(tiles, 0).tiles.map((tile) => tile.key)).toEqual(['mywork', 'receive', 'move', 'incident', 'scan'])
    // A line tablet or a phone has neither (no warehouse there).
    for (const device of ['LINE', 'PHONE']) expect(homeTiles(null, lead, false, device).map((tile) => tile.key)).not.toContain('move')
  })
})

describe('SCR-089\'s warehouse cases', () => {
  it('are on My work\'s screen as w2b-308-*: the inbox, each kind\'s card, the steps, offline, the states', () => {
    const ids = designScreen.cases.map((entry) => entry.id).filter((id) => id.startsWith('w2b-308-'))
    for (const id of ['inbox', 'card-put-away', 'card-receive', 'card-pick', 'card-count', 'card-quarantine', 'step-done-saved', 'step-refused-still-there', 'offline', 'offline-none', 'error', 'loading', 'empty', 'no-permission']) expect(ids).toContain(`w2b-308-${id}`)
    // The held list of W2b-1 is gone: the warehouse gets its inbox.
    expect(designScreen.cases.map((entry) => entry.id)).not.toContain('warehouse')
  })
})
