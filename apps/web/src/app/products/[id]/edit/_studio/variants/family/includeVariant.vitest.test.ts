/**
 * 2.4 — the family page's inclusion ticks go one at a time: a second quick tick reads the version the first one left,
 * so it lands instead of answering 409 against the page's own write.
 */
import { expect, it } from 'vitest'

import type { ProjectionPage, ProjectionSaveResult } from '../channel/types'
import { writeQueue } from '../writeQueue'
import { includeVariant } from './includeVariant'

function stubServer() {
  const s = {
    version: 5,
    included: new Map([['c1', false], ['c2', false]]),
    sent: [] as number[],
    held: [] as Array<() => void>,
  }
  const source = {
    async read() { return { version: s.version } as unknown as ProjectionPage },
    async setIncluded(expectedVersion: number, changes: Array<{ id: string; included: boolean }>): Promise<ProjectionSaveResult> {
      s.sent.push(expectedVersion)
      await new Promise<void>(resolve => s.held.push(resolve)) // in flight until released
      if (expectedVersion !== s.version) return { ok: false, conflict: false, reason: 'This listing changed after you opened it.', code: 'version_conflict' }
      for (const c of changes) s.included.set(c.id, c.included)
      s.version += 1
      return { ok: true, version: s.version }
    },
  }
  return { s, source }
}
const drain = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

it('two quick ticks on the family page both land, the second at the version the first left', async () => {
  const { s, source } = stubServer()
  const inLine = writeQueue()
  const first = includeVariant(inLine, source, 'c1', true)
  const second = includeVariant(inLine, source, 'c2', true)
  await drain()
  expect(s.sent).toEqual([5]) // the second has not read yet
  s.held.shift()!()
  await drain()
  expect(s.sent).toEqual([5, 6])
  s.held.shift()!()
  expect(await first).toEqual({ ok: true, version: 6 })
  expect(await second).toEqual({ ok: true, version: 7 })
  expect([...s.included.values()]).toEqual([true, true])
})

it('a tick that fails does not stop the line', async () => {
  const { s, source } = stubServer()
  const inLine = writeQueue()
  const broken = { ...source, async read(): Promise<ProjectionPage> { throw new Error('offline') } }
  const first = includeVariant(inLine, broken, 'c1', true)
  const second = includeVariant(inLine, source, 'c2', true)
  await expect(first).rejects.toThrow('offline')
  await drain()
  s.held.shift()!()
  expect(await second).toEqual({ ok: true, version: 6 })
})
