import { afterEach, expect, it, vi } from 'vitest'
import { createIdleCommit } from './idleCommit'

afterEach(() => vi.useRealTimers())
it('saves only the latest draft and drains it once when the drawer closes or publication starts', () => {
  vi.useFakeTimers()
  const queue = createIdleCommit(900), save = vi.fn()
  queue.schedule(() => save('first')); queue.schedule(() => save('latest'))
  queue.flush(); queue.flush(); vi.advanceTimersByTime(900)
  expect(save.mock.calls).toEqual([['latest']])
})
it('never saves an abandoned draft after Escape or switching to formula mode', () => {
  vi.useFakeTimers()
  const queue = createIdleCommit(900), save = vi.fn()
  queue.schedule(save); queue.cancel(); vi.advanceTimersByTime(900); queue.flush()
  expect(save).not.toHaveBeenCalled()
})
