/**
 * apply.ts — the only thing in this layer that writes, and it had no test.
 *
 * The four defects pinned here all share one shape: a row's fate was recorded in
 * up to three places — the response, the ImportJobRow staging table, and the
 * strict-mode abort flag — and those places disagreed.
 *
 *   A failure that never reached staging. Several paths (an unmappable column, a
 *     bad State, the fail-closed default) pushed FAILED into the response and
 *     returned without touching the staging row. The annotated workbook is built
 *     from that column, so the operator's own file came back marked "unchanged"
 *     for a row that had just failed.
 *   `strict` that did not abort. Documented as "abort the whole set on the first
 *     failure"; those same paths ignored it.
 *   `no_changes` reported as APPLIED. Every update service returns
 *     `{ ok: true, error: 'no_changes' }` when the row already holds the value.
 *     Only the Product ad branch checked for it, so the other four claimed a
 *     write that never happened — reachable by re-uploading a file whose Archive
 *     rows already ran, since a new upload gets a new job id and the
 *     already-applied set starts empty.
 *   A create that reported no id. The result row echoed `row.targetId`, which is
 *     null on a create.
 *
 * The fake Prisma records what the code TRIED to write, because "what landed in
 * staging" is the assertion that matters.
 */
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { applyPlan, type ApplyOptions } from './apply.js'
import type { PreviewRow } from './preview.js'

type Rec = Record<string, unknown>
interface Staged { rowIndex: number; data: Rec }

/** Captures every ImportJobRow write so the staging record can be asserted. */
function fakePrisma(alreadySuccessful: number[] = []): { client: PrismaClient; staged: Staged[] } {
  const staged: Staged[] = []
  const client = {
    importJobRow: {
      findMany: async () => alreadySuccessful.map((rowIndex) => ({ rowIndex })),
      updateMany: async ({ where, data }: { where: Rec; data: Rec }) => {
        // Mirror the real guard: a SKIPPED write must not clobber a SUCCESS row.
        const guard = where.status as { not?: string } | undefined
        if (guard?.not === 'SUCCESS' && alreadySuccessful.includes(where.rowIndex as number)) return { count: 0 }
        staged.push({ rowIndex: where.rowIndex as number, data })
        return { count: 1 }
      },
    },
    campaign: { findUnique: async () => ({ externalCampaignId: '123' }) },
  } as unknown as PrismaClient
  return { client, staged }
}

const OPTS: ApplyOptions = { actor: 'user:u1', applyImmediately: false, strict: false, conflicts: 'skip' }

const row = (over: Partial<PreviewRow>): PreviewRow => ({
  rowIndex: 0, entity: 'Campaign', operation: 'Update', rowKey: '', targetId: 'c1', parentId: null,
  label: 'Alpha', status: 'UPDATE', diffs: [{ field: 'Daily budget', current: '10.00', next: '20.00' }],
  ...over,
})

/** Stub the mutation layer; each test decides what the write returns. */
const mockMutations = (res: { ok: boolean; error: string | null }) => {
  vi.doMock('../ads-mutation.service.js', () => ({
    updateCampaignWithSync: async () => res,
    updateAdGroupWithSync: async () => res,
    updateAdTargetWithSync: async () => res,
    updatePortfolioWithSync: async () => res,
    updateProductAdWithSync: async () => res,
    writeAdvertisingActionLog: async () => 'log1',
  }))
}

describe('no_changes is not an applied write', () => {
  it('reports SKIPPED, not APPLIED, when the row already holds the value', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: 'no_changes' })
    const { applyPlan: apply } = await import('./apply.js')
    const { client, staged } = fakePrisma()

    const out = await apply(client, 'job', [row({})], OPTS)

    expect(out.applied, 'a write that did not happen was counted as applied').toBe(0)
    expect(out.skipped).toBe(1)
    expect(out.results[0].message).toMatch(/already holds that value/)
    // And staging must not claim SUCCESS, or the annotated file comes back green.
    expect(staged[0].data.status).toBe('SKIPPED')
  })

  it('still reports a real write as APPLIED', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    const { applyPlan: apply } = await import('./apply.js')
    const { client, staged } = fakePrisma()

    const out = await apply(client, 'job', [row({})], OPTS)
    expect(out.applied).toBe(1)
    expect(staged[0].data.status).toBe('SUCCESS')
    expect(staged[0].data.beforeState).toEqual({ 'Daily budget': '10.00' })
    expect(staged[0].data.afterState).toEqual({ 'Daily budget': '20.00' })
  })
})

describe('every outcome reaches the staging table', () => {
  it('records a FAILED validation in staging, not only in the response', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    const { applyPlan: apply } = await import('./apply.js')
    const { client, staged } = fakePrisma()

    // An unwritable State fails inside the field mapper, before any write.
    const out = await apply(client, 'job', [row({
      entity: 'Ad group', diffs: [{ field: 'State', current: 'enabled', next: 'nonsense' }],
    })], OPTS)

    expect(out.failed).toBe(1)
    expect(staged[0].data.status, 'staging stayed PENDING, so the annotated file said "unchanged"').toBe('FAILED')
    expect(String(staged[0].data.errorMessage)).toMatch(/State "nonsense"/)
  })

  it('records a SKIPPED row too, so it is not indistinguishable from untouched', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    const { applyPlan: apply } = await import('./apply.js')
    const { client, staged } = fakePrisma()

    await apply(client, 'job', [row({ status: 'UNRESOLVED', note: 'No campaign with that id' })], OPTS)
    expect(staged[0].data.status).toBe('SKIPPED')
  })

  it('never overwrites an earlier run’s SUCCESS back to SKIPPED', async () => {
    // Otherwise the idempotency record is destroyed and a third run re-applies.
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    const { applyPlan: apply } = await import('./apply.js')
    const { client, staged } = fakePrisma([0])

    const out = await apply(client, 'job', [row({})], OPTS)
    expect(out.skipped).toBe(1)
    expect(out.results[0].message).toMatch(/earlier run/)
    expect(staged, 'the SUCCESS row must be left alone').toHaveLength(0)
  })
})

describe('strict really is all-or-nothing', () => {
  it('aborts on a validation failure, not just on a refused write', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    const { applyPlan: apply } = await import('./apply.js')
    const { client } = fakePrisma()

    const out = await apply(client, 'job', [
      row({ rowIndex: 0, entity: 'Ad group', diffs: [{ field: 'State', current: 'enabled', next: 'nonsense' }] }),
      row({ rowIndex: 1 }),
    ], { ...OPTS, strict: true })

    expect(out.aborted, 'strict ignored a validation failure and carried on').toBe(true)
    expect(out.failed).toBe(1)
    expect(out.applied, 'the row after the failure must not have been written').toBe(0)
    expect(out.results).toHaveLength(1)
  })

  it('aborts on a refused write', async () => {
    vi.resetModules()
    mockMutations({ ok: false, error: 'gate refused' })
    const { applyPlan: apply } = await import('./apply.js')
    const { client } = fakePrisma()

    const out = await apply(client, 'job', [row({ rowIndex: 0 }), row({ rowIndex: 1 })], { ...OPTS, strict: true })
    expect(out.aborted).toBe(true)
    expect(out.results).toHaveLength(1)
  })

  it('without strict, one bad row does not stop the other four', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    const { applyPlan: apply } = await import('./apply.js')
    const { client } = fakePrisma()

    const out = await apply(client, 'job', [
      row({ rowIndex: 0 }),
      row({ rowIndex: 1, entity: 'Ad group', diffs: [{ field: 'State', current: 'enabled', next: 'nonsense' }] }),
      row({ rowIndex: 2 }), row({ rowIndex: 3 }), row({ rowIndex: 4 }),
    ], OPTS)

    expect(out.aborted).toBe(false)
    expect(out.applied).toBe(4)
    expect(out.failed).toBe(1)
  })
})

describe('the entity dispatch', () => {
  it('refuses an entity with no apply path instead of writing it to AdTarget', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    const { applyPlan: apply } = await import('./apply.js')
    const { client, staged } = fakePrisma()

    const out = await apply(client, 'job', [row({ entity: 'Bidding adjustment' })], OPTS)
    expect(out.failed).toBe(1)
    expect(out.results[0].message).toMatch(/has no apply path/)
    expect(staged[0].data.status).toBe('FAILED')
  })

  it('says archiving a portfolio is not a thing, rather than "no writable field"', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    const { applyPlan: apply } = await import('./apply.js')
    const { client } = fakePrisma()

    const out = await apply(client, 'job', [row({
      entity: 'Portfolio', status: 'ARCHIVE', diffs: [{ field: 'State', current: 'enabled', next: 'archived' }],
    })], OPTS)
    expect(out.skipped).toBe(1)
    expect(out.results[0].message).toMatch(/cannot be archived from a bulksheet/)
  })

  it('honours conflicts: skip, and conflicts: mine', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    const { applyPlan: apply } = await import('./apply.js')

    const skipped = await apply(fakePrisma().client, 'job', [row({ status: 'CONFLICT', note: 'budget moved' })], OPTS)
    expect(skipped.skipped).toBe(1)
    expect(skipped.results[0].message).toMatch(/budget moved/)

    const forced = await apply(fakePrisma().client, 'job', [row({ status: 'CONFLICT', note: 'budget moved' })], { ...OPTS, conflicts: 'mine' })
    expect(forced.applied, 'conflicts: mine must write the row anyway').toBe(1)
  })
})

describe('creates report what they made', () => {
  it('names the created id, not the null targetId of the row that asked for it', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    vi.doMock('../ads-create.service.js', () => ({
      createKeywordLocal: async () => ({ id: 'new_kw_1', externalTargetId: '55512345' }),
    }))
    const { applyPlan: apply } = await import('./apply.js')
    const { client, staged } = fakePrisma()

    const out = await apply(client, 'job', [row({
      entity: 'Keyword', status: 'CREATE', targetId: null, parentId: 'ag1', label: 'giacca moto',
      diffs: [
        { field: 'Keyword text', current: '', next: 'giacca moto' },
        { field: 'Match type', current: '', next: 'Exact' },
        { field: 'Bid', current: '', next: '0,85' },
      ],
    })], OPTS)

    expect(out.applied).toBe(1)
    expect(out.results[0].targetId, 'the result named nothing at all').toBe('new_kw_1')
    expect(out.results[0].message).toMatch(/Created on Amazon \(55512345\)/)
    expect(staged[0].data.targetId).toBe('new_kw_1')
  })

  it('says a create landed only locally when the gate declined it', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    vi.doMock('../ads-create.service.js', () => ({
      createKeywordLocal: async () => ({ id: 'new_kw_2', externalTargetId: null }),
    }))
    const { applyPlan: apply } = await import('./apply.js')

    const out = await apply(fakePrisma().client, 'job', [row({
      entity: 'Keyword', status: 'CREATE', targetId: null, parentId: 'ag1',
      diffs: [
        { field: 'Keyword text', current: '', next: 'x' },
        { field: 'Match type', current: '', next: 'Exact' },
        { field: 'Bid', current: '', next: '1,00' },
      ],
    })], OPTS)

    expect(out.results[0].message).toMatch(/not yet on Amazon/)
  })

  it('fails a create missing a required field instead of inventing a default', async () => {
    vi.resetModules()
    mockMutations({ ok: true, error: null })
    vi.doMock('../ads-create.service.js', () => ({ createKeywordLocal: async () => ({ id: 'x', externalTargetId: null }) }))
    const { applyPlan: apply } = await import('./apply.js')

    const out = await apply(fakePrisma().client, 'job', [row({
      entity: 'Keyword', status: 'CREATE', targetId: null, parentId: 'ag1',
      diffs: [{ field: 'Keyword text', current: '', next: 'x' }, { field: 'Match type', current: '', next: 'Exact' }],
    })], OPTS)

    expect(out.failed).toBe(1)
    expect(out.results[0].message).toMatch(/Bid is required/)
  })
})

// Referenced so the direct import is not flagged unused; the tests above all use
// the re-imported module so vi.doMock applies.
void applyPlan
