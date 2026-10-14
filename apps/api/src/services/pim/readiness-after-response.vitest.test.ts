/**
 * Editing speed (2026-10-13) — the in-process run that rebuilds a family's readiness after a sheet save's response
 * (`readiness-after-response.ts`). No database: the rebuild is a stand-in that records when it ran.
 */
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn() } }))
import { logger } from '../../utils/logger.js'
import { LEGACY_WORKSPACE_ID, withWorkspace, workspaceContext } from '../../lib/workspace-context.js'
import { familiesRebuildingAfterResponse, familyReadinessSettled, rebuildAfterResponse } from './readiness-after-response.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
/** A rebuild that stays running until `finish()` is called. */
function heldRebuild() {
  let finish: () => void = () => {}
  const rebuild = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  return { rebuild, finish: () => finish() }
}

afterEach(async () => {
  for (const rootId of familiesRebuildingAfterResponse()) await familyReadinessSettled(rootId)
  vi.mocked(logger.warn).mockClear()
})

it('starts after the response, not while the save answers', async () => {
  const rebuild = vi.fn(async () => undefined)
  rebuildAfterResponse('root-start', rebuild)
  expect(rebuild).not.toHaveBeenCalled()
  expect(familiesRebuildingAfterResponse()).toEqual(['root-start'])
  await familyReadinessSettled('root-start')
  expect(rebuild).toHaveBeenCalledTimes(1)
  expect(familiesRebuildingAfterResponse()).toEqual([])
})

it('a burst of saves while the family is rebuilding costs ONE more rebuild, not one each', async () => {
  const held = heldRebuild()
  rebuildAfterResponse('root-burst', held.rebuild)
  await vi.waitFor(() => expect(held.rebuild).toHaveBeenCalledTimes(1))
  for (let i = 0; i < 5; i++) rebuildAfterResponse('root-burst', held.rebuild)
  held.finish()
  await vi.waitFor(() => expect(held.rebuild).toHaveBeenCalledTimes(2))
  held.finish()
  await familyReadinessSettled('root-burst')
  expect(held.rebuild).toHaveBeenCalledTimes(2)
})

it('saves that land before the run starts join it', async () => {
  const rebuild = vi.fn(async () => undefined)
  for (let i = 0; i < 3; i++) rebuildAfterResponse('root-join', rebuild)
  await familyReadinessSettled('root-join')
  expect(rebuild).toHaveBeenCalledTimes(1)
})

it('a readiness read waits for the running rebuild of its family, and only of its family', async () => {
  const held = heldRebuild()
  rebuildAfterResponse('root-read', held.rebuild)
  let answered = false
  const read = familyReadinessSettled('root-read').then(() => { answered = true })
  await familyReadinessSettled('another-root') // nothing runs for it: answers at once
  await vi.waitFor(() => expect(held.rebuild).toHaveBeenCalledTimes(1))
  await tick()
  expect(answered).toBe(false)
  held.finish()
  await read
  expect(answered).toBe(true)
})

it('a read never waits longer than its bound', async () => {
  const held = heldRebuild()
  rebuildAfterResponse('root-slow', held.rebuild)
  const started = Date.now()
  await familyReadinessSettled('root-slow', 150)
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(familiesRebuildingAfterResponse()).toEqual(['root-slow'])
  held.finish()
})

it('a failed rebuild never throws into the save or the reader: it is logged and the marks stay for the drain', async () => {
  rebuildAfterResponse('root-fail', async () => { throw new Error('database went away') })
  await expect(familyReadinessSettled('root-fail')).resolves.toBeUndefined()
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('readiness-pending drain'), expect.objectContaining({ rootId: 'root-fail', error: 'database went away' }))
  expect(familiesRebuildingAfterResponse()).toEqual([])
})

it('runs in the business of the save that asked for it', async () => {
  let seen: string | undefined
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () =>
    rebuildAfterResponse('root-business', async () => { seen = workspaceContext()?.workspaceId }))
  await familyReadinessSettled('root-business')
  expect(seen).toBe(LEGACY_WORKSPACE_ID)
})
