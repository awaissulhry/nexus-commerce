/**
 * NAF.SB.AS — the intersection law, asserted rather than intended.
 *
 * The single worst bug this feature can ship is a scope that resolves to
 * nothing and then falls through to account-wide: the assignment row would
 * say "one campaign" while the worker read all 220. `undefined` means
 * "everything" to getObservation, so every path that fails to resolve MUST
 * produce an error, never an empty-or-absent filter.
 *
 * The second worst is widening: an assignment must never let a worker see
 * more than the scope set on its Workers page.
 *
 * These tests exist because both failures are silent — no exception, no log,
 * just a worker quietly reading the whole account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

let campaignRows: Array<{ externalCampaignId: string; marketplace: string; name: string }> = []

vi.mock('../../db.js', () => ({
  default: {
    campaign: { findMany: vi.fn(async () => campaignRows) },
  },
}))

const { resolveAssignmentScope } = await import('./assignment-scope.js')
const { filterToCampaigns } = await import('./observations/scope-filter.js')

/** Charter shape the resolver actually reads. */
function charter(over: Partial<{ scopeMarketplaces: string[]; observationKeys: string[] }> = {}) {
  return {
    scopeMarketplaces: [],
    observationKeys: ['negative-candidates'],
    ...over,
  } as never
}

beforeEach(() => {
  campaignRows = [
    { externalCampaignId: '111', marketplace: 'IT', name: 'GALE | IT | Broad' },
    { externalCampaignId: '222', marketplace: 'DE', name: 'GALE | DE | Broad' },
  ]
})

describe('filterToCampaigns — fail closed', () => {
  const rows = [
    { externalCampaignId: '111', query: 'a' },
    { externalCampaignId: '222', query: 'b' },
    { externalCampaignId: undefined, query: 'orphan' },
  ]

  it('undefined means everything — the ONLY value that widens', () => {
    const r = filterToCampaigns(rows, undefined)
    expect(r.kept).toHaveLength(3)
    expect(r.droppedOutOfScope).toBe(0)
  })

  it('an EMPTY array means nothing, and must never mean everything', () => {
    const r = filterToCampaigns(rows, [])
    expect(r.kept).toHaveLength(0)
    expect(r.droppedOutOfScope).toBe(2)
    expect(r.unresolved).toBe(1)
  })

  it('keeps only named campaigns and counts every drop', () => {
    const r = filterToCampaigns(rows, ['111'])
    expect(r.kept.map((x) => x.query)).toEqual(['a'])
    expect(r.droppedOutOfScope).toBe(1)
    expect(r.unresolved).toBe(1) // the row with no campaign — never silently kept
  })

  it('a row that cannot prove its campaign is dropped, not kept', () => {
    const r = filterToCampaigns([{ externalCampaignId: undefined, query: 'x' }], ['111'])
    expect(r.kept).toHaveLength(0)
    expect(r.unresolved).toBe(1)
  })
})

describe('resolveAssignmentScope — campaign targets', () => {
  it('resolves a live campaign to a narrow, never to undefined', async () => {
    const r = await resolveAssignmentScope(charter(), { kind: 'CAMPAIGN', ids: ['111'] })
    expect(r.error).toBeUndefined()
    expect(r.narrow?.campaignExternalIds).toEqual(['111'])
    expect(r.narrow?.campaignLabels).toEqual(['GALE | IT | Broad'])
  })

  it('REFUSES an empty target rather than running account-wide', async () => {
    const r = await resolveAssignmentScope(charter(), { kind: 'CAMPAIGN', ids: [] })
    expect(r.error).toMatch(/target_unresolvable/)
    expect(r.narrow).toBeUndefined()
  })

  it('REFUSES when every named campaign has vanished — the archived-between-create-and-start case', async () => {
    campaignRows = []
    const r = await resolveAssignmentScope(charter(), { kind: 'CAMPAIGN', ids: ['999'] })
    expect(r.error).toMatch(/target_gone/)
    expect(r.narrow).toBeUndefined()
  })

  it('REFUSES a worker whose evidence cannot be narrowed, rather than scoping half of it', async () => {
    const r = await resolveAssignmentScope(
      charter({ observationKeys: ['negative-candidates', 'bid-proposals'] }),
      { kind: 'CAMPAIGN', ids: ['111'] },
    )
    expect(r.error).toMatch(/target_unsupported/)
    expect(r.error).toContain('bid-proposals')
  })

  it('INTERSECTS with the worker scope — never widens past it', async () => {
    const r = await resolveAssignmentScope(
      charter({ scopeMarketplaces: ['IT'] }),
      { kind: 'CAMPAIGN', ids: ['111', '222'] },
    )
    expect(r.error).toBeUndefined()
    // 222 is DE; the IT-scoped worker must not see it.
    expect(r.narrow?.campaignExternalIds).toEqual(['111'])
  })

  it('REFUSES when the intersection with the worker scope is empty', async () => {
    const r = await resolveAssignmentScope(
      charter({ scopeMarketplaces: ['IT'] }),
      { kind: 'CAMPAIGN', ids: ['222'] },
    )
    expect(r.error).toMatch(/target_outside_worker_scope/)
    expect(r.narrow).toBeUndefined()
  })
})

describe('resolveAssignmentScope — marketplace targets', () => {
  it('resolves one marketplace', async () => {
    const r = await resolveAssignmentScope(charter(), { kind: 'MARKETPLACE', ids: ['IT'] })
    expect(r.error).toBeUndefined()
    expect(r.marketplace).toBe('IT')
  })

  it('REFUSES more than one — the evidence layer honours exactly one', async () => {
    const r = await resolveAssignmentScope(charter(), { kind: 'MARKETPLACE', ids: ['IT', 'DE'] })
    expect(r.error).toMatch(/target_unresolvable/)
  })

  it('REFUSES a marketplace outside the worker scope', async () => {
    const r = await resolveAssignmentScope(
      charter({ scopeMarketplaces: ['IT'] }),
      { kind: 'MARKETPLACE', ids: ['DE'] },
    )
    expect(r.error).toMatch(/target_outside_worker_scope/)
    expect(r.marketplace).toBeUndefined()
  })

  it('no resolution ever returns a bare {} — that would read as account-wide', async () => {
    for (const t of [
      { kind: 'CAMPAIGN' as const, ids: [] },
      { kind: 'MARKETPLACE' as const, ids: [] },
      { kind: 'MARKETPLACE' as const, ids: ['IT', 'DE'] },
    ]) {
      const r = await resolveAssignmentScope(charter(), t)
      expect(r.error, `${t.kind} ${JSON.stringify(t.ids)} must refuse`).toBeTruthy()
    }
  })
})
