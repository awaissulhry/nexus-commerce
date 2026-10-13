/**
 * The save line (#592's pattern for every page): writes one at a time, reads ticketed, versions re-based on the page's
 * own writes.
 */
import { describe, expect, it } from 'vitest'
import { ownVersions, saveLine } from './save-line'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('saveLine — writes', () => {
  it('runs writes one at a time, in the order they were asked', async () => {
    const line = saveLine()
    const order: string[] = []
    const first = deferred<void>()
    const a = line.write(async () => { order.push('a:start'); await first.promise; order.push('a:end') })
    const b = line.write(async () => { order.push('b:start') })
    await flush()
    expect(order).toEqual(['a:start'])
    expect(line.pending).toBe(2)
    first.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
    expect(line.pending).toBe(0)
  })

  it('a failed write never stops the line, and rejects to its own caller', async () => {
    const line = saveLine()
    const a = line.write(async () => { throw new Error('refused') })
    const b = line.write(async () => 'second')
    await expect(a).rejects.toThrow('refused')
    await expect(b).resolves.toBe('second')
    expect(line.pending).toBe(0)
  })
})

describe('saveLine — reads', () => {
  it('an older read never paints over a newer one', async () => {
    const line = saveLine()
    const older = deferred<string>()
    const newer = deferred<string>()
    const first = line.read(() => older.promise)
    const second = line.read(() => newer.promise)
    newer.resolve('new')
    expect(await second).toEqual({ kind: 'fresh', value: 'new', ticket: 2 })
    older.resolve('old')
    expect(await first).toEqual({ kind: 'stale' })
  })

  it('quietWhileWriting drops an answer that lands while a write is waiting or in flight', async () => {
    const line = saveLine()
    const write = deferred<void>()
    const read = deferred<string>()
    const reading = line.read(() => read.promise, { quietWhileWriting: true })
    const writing = line.write(() => write.promise)
    read.resolve('before the write')
    expect(await reading).toEqual({ kind: 'stale' })
    write.resolve()
    await writing
    expect(await line.read(async () => 'after', { quietWhileWriting: true })).toMatchObject({ kind: 'fresh', value: 'after' })
  })

  it('quietWhileWriting drops a read that started before a write and lands after it settled', async () => {
    const line = saveLine()
    const read = deferred<string>()
    const reading = line.read(() => read.promise, { quietWhileWriting: true })
    await line.write(async () => undefined) // started and settled while the read was out
    expect(line.pending).toBe(0)
    read.resolve('from before the write')
    expect(await reading).toEqual({ kind: 'stale' })
  })

  it('a read `keep` refuses is dropped without counting as painted', async () => {
    const line = saveLine()
    const older = deferred<string>()
    const wanted = line.read(() => older.promise, { keep: (v) => v === 'listing-b' })
    const unwanted = line.read(async () => 'listing-a', { keep: (v) => v === 'listing-b' })
    expect(await unwanted).toEqual({ kind: 'stale' })
    older.resolve('listing-b')
    expect(await wanted).toMatchObject({ kind: 'fresh', value: 'listing-b' })
  })

  it('only the newest read reports a failure', async () => {
    const line = saveLine()
    const older = deferred<string>()
    const first = line.read(() => older.promise)
    const second = line.read(async () => { throw new Error('offline') })
    older.reject(new Error('older offline'))
    expect(await first).toEqual({ kind: 'stale' })
    expect(await second).toMatchObject({ kind: 'failed' })
  })
})

describe('ownVersions', () => {
  it('sends at the version this page’s own write left until a read at least as new arrives', () => {
    const versions = ownVersions()
    expect(versions.at('row-1', 3)).toBe(3)
    versions.record('row-1', 4)
    expect(versions.at('row-1', 3)).toBe(4) // the read is older than the page's own write
    expect(versions.at('row-1', 7)).toBe(7) // someone else moved it after; the read says so
    expect(versions.at('row-1', 4)).toBe(4)
    expect(versions.at('row-2', undefined)).toBeUndefined()
  })
})
