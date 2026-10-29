import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { StepUpCancelled } from '../shared/step-up'
import { runBulk } from './bulk'
import { bulkHeld, bulkNotice, leftCounts, onScreen, reachOf } from './bulk-model'

/**
 * The B-W0-28 bulk actions' shared rules: the runner (one call per row, in order; refusals in our words; closing the code
 * dialog stops the run), which rows an action applies to, why its button is held, and the one notice after the run.
 */

const conflict = () => new ApiError('conflict', 409, 'conflict', 'Version mismatch.')
const forbidden = () => new ApiError('forbidden', 403, 'forbidden', 'No.')

describe('runBulk', () => {
  it('runs one item after the other, never two at once, and says what was done', async () => {
    const order: string[] = []
    let running = 0
    let most = 0
    const result = await runBulk(['a', 'b', 'c'], async (item) => {
      running += 1
      most = Math.max(most, running)
      order.push(`start ${item}`)
      await new Promise((resolve) => setTimeout(resolve, 2))
      order.push(`end ${item}`)
      running -= 1
    })
    expect(most).toBe(1)
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(result).toEqual({ done: ['a', 'b', 'c'], refused: [] })
  })

  it('a refusal of one row is that row\'s problem in our words; the rest still run', async () => {
    const tried: number[] = []
    const result = await runBulk([1, 2, 3, 4], async (item) => {
      tried.push(item)
      if (item === 2) throw conflict()
      if (item === 3) throw forbidden()
      if (item === 4) throw new Error('boom')
    })
    expect(tried).toEqual([1, 2, 3, 4])
    expect(result.done).toEqual([1])
    expect(result.refused).toEqual([
      { item: 2, problem: 'problem.conflict' },
      { item: 3, problem: 'problem.forbidden' },
      { item: 4, problem: 'problem.internal' },
    ])
  })

  it('closing the code dialog stops the run at once and goes up: the rest is not tried', async () => {
    const tried: string[] = []
    const run = runBulk(['a', 'b', 'c'], async (item) => {
      tried.push(item)
      if (item === 'b') throw new StepUpCancelled()
    })
    await expect(run).rejects.toBeInstanceOf(StepUpCancelled)
    expect(tried).toEqual(['a', 'b'])
  })

  it('nothing selected: nothing done, nothing refused', async () => {
    expect(await runBulk([], async () => undefined)).toEqual({ done: [], refused: [] })
  })
})

describe('the reach of a bulk action', () => {
  const rows = [
    { id: 'a', open: true },
    { id: 'b', open: false },
    { id: 'c', open: true },
    { id: 'd', open: false },
  ]
  const reach = reachOf(rows, (row) => (row.open ? null : 'x.left.closed'))

  it('splits the selection into the rows it applies to and the ones left out, each with why', () => {
    expect(reach.applies.map((row) => row.id)).toEqual(['a', 'c'])
    expect(reach.left.map((entry) => [entry.item.id, entry.why])).toEqual([
      ['b', 'x.left.closed'],
      ['d', 'x.left.closed'],
    ])
    expect(leftCounts(reach)).toEqual([{ why: 'x.left.closed', count: 2 }])
    expect(leftCounts(reachOf(['p', 'q', 'r'], (item) => (item === 'p' ? 'one' : item === 'q' ? 'two' : 'one')))).toEqual([
      { why: 'one', count: 2 },
      { why: 'two', count: 1 },
    ])
  })

  it('a button is held without the right first, then when it applies to nothing', () => {
    const keys = { right: 'x.right', none: 'x.none' }
    expect(bulkHeld(reach, false, keys)).toBe('x.right')
    expect(bulkHeld(reachOf([rows[1]!], (row) => (row.open ? null : 'closed')), true, keys)).toBe('x.none')
    expect(bulkHeld(reach, true, keys)).toBeNull()
  })

  it('only the selected rows still on screen count (a filter hides the others)', () => {
    expect(onScreen(['a', 'z', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'c'])
    expect(onScreen(undefined, ['a'])).toEqual([])
  })
})

describe('the one notice after a bulk run', () => {
  const keys = { done: 'x.done', partial: 'x.partial', failed: 'x.failed' }
  const id = (item: { id: string }) => item.id

  it('every row done: a receipt counting them', () => {
    expect(bulkNotice({ done: [{ id: 'a' }, { id: 'b' }], refused: [] }, keys, id)).toEqual({ key: 'x.done', tone: 'success', params: { count: 2, total: 2 } })
  })

  it('some refused: how many of how many, and each refused row with its problem', () => {
    expect(bulkNotice({ done: [{ id: 'a' }], refused: [{ item: { id: 'b' }, problem: 'problem.conflict' }] }, keys, id)).toEqual({
      key: 'x.partial',
      tone: 'warning',
      params: { count: 1, done: 1, refused: 1, total: 2 },
      refused: [{ id: 'b', problem: 'problem.conflict' }],
    })
  })

  it('none done: a refusal counting the rows, each with its problem', () => {
    expect(bulkNotice({ done: [], refused: [{ item: { id: 'a' }, problem: 'problem.forbidden' }] }, keys, id)).toEqual({
      key: 'x.failed',
      tone: 'danger',
      params: { count: 1, total: 1 },
      refused: [{ id: 'a', problem: 'problem.forbidden' }],
    })
  })
})
