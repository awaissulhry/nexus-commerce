/**
 * Every custom BullMQ job id this API builds must pass BullMQ's OWN rule (bullmq Job.validateOptions): not a bare
 * integer, and no ":" unless the id splits into exactly three parts (BullMQ keeps that shape for old repeatable jobs).
 * An id it refuses makes every `add` throw — `addJobSafely` logs it and the job never runs.
 *
 * Found in the MCP full control local end-to-end run (2026-10-02, queue workers on): the change-plan job id
 * "agent-plan:<approvalId>" was refused on every enqueue ("Custom Id cannot contain :"), so an approved plan never ran.
 *
 *   1  the plan worker's id, as enqueuePlan builds it, passes BullMQ's validator (and the old one is refused: control)
 *   2  every `jobId: \`…\`` template in apps/api/src, with each `${…}` filled, passes it — except the ones listed in
 *      PRE_EXISTING (ids already on main before this work, reported, owned elsewhere): a ratchet, the list only shrinks
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Job } from 'bullmq'

const enqueued = vi.hoisted(() => ({ calls: [] as Array<{ name: string; opts: { jobId?: string } }> }))
vi.mock('./queue.js', () => ({
  agentPlanQueue: { name: 'agent-plan' },
  addJobSafely: vi.fn(async (_queue: unknown, name: string, _data: unknown, opts: { jobId?: string }) => {
    enqueued.calls.push({ name, opts })
    return { enqueued: true }
  }),
}))

import { enqueuePlan } from '../services/agents/change-plan.service.js'

/** BullMQ's own check, offline: a Job on a stand-in queue, validated exactly as `add` validates it. */
function bullmqRefusal(jobId: string): string | null {
  const queue = { opts: {}, keys: {}, toKey: (key: string) => key, qualifiedName: 'bull:check', client: Promise.resolve({}) }
  try {
    const job = new Job(queue as never, 'check', {}, { jobId })
    ;(job as unknown as { validateOptions(data: unknown): void }).validateOptions(job.asJSON())
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const SRC = join(import.meta.dirname, '..')
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.ts$/.test(name) && !/\.(vitest\.)?test\.ts$/.test(name)) out.push(path)
  }
  return out
}

/** Ids on main before this work that BullMQ refuses: reported (their owners fix them), never added to. */
const PRE_EXISTING = new Set([
  'routes/outbound-queue.routes.ts:`${row.channelListingId}:${row.syncType}:retry:${Date.now()}`',
  'routes/outbound-queue.routes.ts:`${r.channelListingId}:${r.syncType}:retry:${Date.now()}`',
  'services/pim/readiness-index.service.ts:`readiness:${rootId}`',
  'services/pim/matrix-write.service.ts:`${failed.channelListingId}:${failed.syncType}:retry:${Date.now()}`',
])

describe('BullMQ job ids', () => {
  it('the validator refuses what BullMQ refuses (control) and passes a plain id', () => {
    expect(bullmqRefusal('agent-plan:abc')).toBe('Custom Id cannot contain :')
    expect(bullmqRefusal('12345')).toBe('Custom Id cannot be integers')
    expect(bullmqRefusal('cache:refresh:abc')).toBeNull()
    expect(bullmqRefusal('agent-plan-abc')).toBeNull()
  })

  it('the change-plan job id passes BullMQ, as enqueuePlan builds it (with the business prefix too)', async () => {
    await enqueuePlan('cmuq0qwvo0033n7s4gs9klmj5')
    const jobId = enqueued.calls.at(-1)?.opts.jobId ?? ''
    expect(jobId).toMatch(/cmuq0qwvo0033n7s4gs9klmj5/)
    expect(bullmqRefusal(jobId)).toBeNull()
    // WorkspaceQueue prefixes "w_<business>_" (lib/workspace-jobs.ts): still valid.
    expect(bullmqRefusal(`w_nexus_legacy_workspace_${jobId}`)).toBeNull()
  })

  it('every jobId template in the API passes BullMQ, the pre-existing list excepted (and it only shrinks)', () => {
    const refused: string[] = []
    const stillThere = new Set<string>()
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const [, template] of text.matchAll(/jobId:\s*(`[^`]*`)/g)) {
        const key = `${relative(SRC, file)}:${template}`
        const sample = template.slice(1, -1).replace(/\$\{[^}]*\}/g, 'x1')
        if (bullmqRefusal(sample) === null) continue
        if (PRE_EXISTING.has(key)) stillThere.add(key)
        else refused.push(`${key} → ${bullmqRefusal(sample)}`)
      }
    }
    expect(refused).toEqual([])
    // An entry fixed by its owner leaves the list.
    expect([...PRE_EXISTING].filter((key) => !stillThere.has(key))).toEqual([])
  })
})
