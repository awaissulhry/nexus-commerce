import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFormulaSaveQueue } from './formulaSaveQueue'
afterEach(() => vi.useRealTimers())
describe('formula save queue', () => {
  it('serialises edits to one product and refreshes once after all rows finish', async () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    const queue = createFormulaSaveQueue(settled)
    let release!: () => void
    const first = queue.enqueue('one', () => new Promise<void>(resolve => { release = resolve }))
    const next = vi.fn(async () => 'next')
    const second = queue.enqueue('one', next)
    await queue.enqueue('two', async () => 'independent')
    expect(next).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled()
    release(); await Promise.all([first, second]); await vi.runAllTimersAsync()
    expect(next).toHaveBeenCalledTimes(1); expect(settled).toHaveBeenCalledTimes(1)
  })
  it('continues after a failed save', async () => {
    vi.useFakeTimers()
    const queue = createFormulaSaveQueue(vi.fn())
    const failed = queue.enqueue('one', async () => { throw new Error('offline') })
    const next = queue.enqueue('one', async () => 'saved')
    await expect(failed).rejects.toThrow('offline'); await expect(next).resolves.toBe('saved')
    queue.dispose()
  })
})


it('does not refresh after unmount, and can be reactivated by Strict Mode', async () => {
  vi.useFakeTimers()
  const settled = vi.fn()
  const queue = createFormulaSaveQueue(settled)
  let release!: () => void
  const task = queue.enqueue('one', () => new Promise<void>(resolve => { release = resolve }))
  await Promise.resolve(); await Promise.resolve()
  queue.dispose(); release(); await task; await vi.runAllTimersAsync()
  expect(settled).not.toHaveBeenCalled()
  queue.activate(); await queue.enqueue('two', async () => {}); await vi.runAllTimersAsync()
  expect(settled).toHaveBeenCalledTimes(1)
})
