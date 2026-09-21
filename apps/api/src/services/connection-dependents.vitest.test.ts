/**
 * What a `ChannelConnection` delete would take with it.
 *
 * ## The decision this exists to inform
 *
 * The Owner asked for 11 dead eBay rows to be deleted — *"they all say disconnected"*. Measured
 * on the live screen, that is true and it is not the question. Two other measurements are:
 *
 *   1. **Nothing in this API has ever deleted a `ChannelConnection`.** `grep channelConnection
 *      .delete` over `apps/api/src` returns nothing; every path revokes or deactivates.
 *   2. **The delete cascades.** `VariantChannelListing` and `EbayCampaign` carry
 *      `onDelete: Cascade`, so listing rows and ad campaigns are destroyed with the connection —
 *      and one of the eleven carries the SAME eBay user id as the live account and synced on
 *      2026-08-19.
 *
 * "Disconnected" is a fact about the token. It says nothing about what points at the row.
 *
 * ## 🔴 Why the relation list is derived and not written down
 *
 * A list of dependent tables is a **set claim**, and the failure mode is silent: add a relation
 * next month, and a report built on yesterday's list under-counts, calls the row safe, and the
 * delete destroys rows nobody counted. So the list comes from Prisma's DMMF — the same schema the
 * database enforces the cascade from.
 *
 * These tests therefore check the derivation against relations we can see in the schema today,
 * and — the part that matters — that the derivation is not merely returning a constant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ counts: {} as Record<string, unknown> }))

/** A prisma stub whose delegates are discovered from the model names, like the real client. */
vi.mock('../db.js', () => {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, prop: string) => ({
      count: async ({ where }: { where: Record<string, string> }) => {
        const entry = m.counts[prop]
        if (typeof entry === 'function') return (entry as (w: unknown) => number)(where)
        return typeof entry === 'number' ? entry : 0
      },
    }),
  }
  return { default: new Proxy({}, handler) }
})

const { dependentRelations, deriveDependentRelations, connectionDependents, isSafeToDelete } = await import('./connection-dependents.service.js')

beforeEach(() => { m.counts = {} })

describe('1. the relation list is DERIVED from the schema', () => {
  const relations = dependentRelations()
  const byModel = Object.fromEntries(relations.map((r) => [r.model, r]))

  it('🟢 POSITIVE CONTROL — it finds relations at all, and more than a couple', () => {
    // A derivation that silently returns [] would report every connection as safe to delete.
    expect(relations.length).toBeGreaterThan(5)
  })

  it('🔴 finds the two that DESTROY data, with the right verdict', () => {
    // These are the reason a delete is not a tidy-up.
    expect(byModel.VariantChannelListing).toMatchObject({ action: 'Cascade', destroys: true })
    expect(byModel.EbayCampaign).toMatchObject({ action: 'Cascade', destroys: true })
  })

  it('does NOT mark a SetNull relation as destructive', () => {
    // Orders and listings survive a delete with their link cleared. Counting them as destroyed
    // would make every row look unsafe and the report useless.
    expect(byModel.Order).toMatchObject({ action: 'SetNull', destroys: false })
    expect(byModel.ChannelListing).toMatchObject({ action: 'SetNull', destroys: false })
  })

  it('names the foreign key each table actually uses — they are not all the same', () => {
    // Half use `channelConnectionId` and half use `connectionId`. A single assumed name would
    // count zero for the other half, which reads as "nothing attached".
    expect(byModel.VariantChannelListing.field).toBe('channelConnectionId')
    expect(byModel.ConnectionScope.field).toBe('connectionId')
  })

  it('every relation carries a known action', () => {
    for (const relation of relations) {
      expect(relation.action, `${relation.model} has no onDelete`).not.toBe('Unknown')
    }
  })
})

describe('2. counting, and what makes a row safe', () => {
  it('🟢 a row nothing points at is safe', async () => {
    const report = await connectionDependents('dead-row')
    expect(report.destroyedTotal).toBe(0)
    expect(report.unlinkedTotal).toBe(0)
    expect(isSafeToDelete(report)).toBe(true)
  })

  it('🔴 one cascading row makes it UNSAFE', async () => {
    m.counts.variantChannelListing = 3
    const report = await connectionDependents('has-listings')
    expect(report.destroyedTotal).toBe(3)
    expect(isSafeToDelete(report)).toBe(false)
  })

  it('🔴 an eBay campaign alone makes it unsafe', async () => {
    m.counts.ebayCampaign = 1
    expect(isSafeToDelete(await connectionDependents('has-campaign'))).toBe(false)
  })

  it('🟢 SetNull rows are counted but do NOT block — they survive', async () => {
    // 200 orders keep their history; only the link is cleared. Blocking on these would stop a
    // cleanup that destroys nothing.
    m.counts.order = 200
    const report = await connectionDependents('has-orders')
    expect(report.unlinkedTotal).toBe(200)
    expect(report.destroyedTotal).toBe(0)
    expect(isSafeToDelete(report)).toBe(true)
  })

  it('counts each table with ITS OWN foreign key', async () => {
    const seen: Record<string, string> = {}
    m.counts.variantChannelListing = (where: Record<string, string>) => {
      seen.variant = Object.keys(where)[0]!; return 0
    }
    m.counts.connectionScope = (where: Record<string, string>) => {
      seen.scope = Object.keys(where)[0]!; return 0
    }
    await connectionDependents('c1')
    expect(seen).toEqual({ variant: 'channelConnectionId', scope: 'connectionId' })
  })

  it('reports every relation, zeros included', async () => {
    // An absent line and a zero must not look alike to whoever reads this before deleting.
    const report = await connectionDependents('c1')
    expect(report.counts.length).toBe(dependentRelations().length)
  })
})

describe('3. 🔴 a count that could not be taken is not a zero', () => {
  it('a failed count sets incomplete and blocks the delete', async () => {
    // The banked rule: "could not measure" is not "measured empty". Without this, one unreadable
    // table turns into a confident "safe to delete".
    m.counts.variantChannelListing = () => { throw new Error('relation does not exist') }
    const report = await connectionDependents('c1')
    expect(report.incomplete).toBe(true)
    expect(report.destroyedTotal).toBe(0)
    expect(isSafeToDelete(report)).toBe(false)
  })

  it('names the table that failed, rather than a bare flag', async () => {
    m.counts.ebayCampaign = () => { throw new Error('boom') }
    const report = await connectionDependents('c1')
    const failed = report.counts.find((c) => c.error)
    expect(failed?.model).toBe('EbayCampaign')
    expect(failed?.error).toContain('boom')
  })

  it('🟢 CONTROL — with every count taken, the same row IS safe', async () => {
    // Proves the block above comes from the failure and not from the fixture.
    const report = await connectionDependents('c1')
    expect(report.incomplete).toBe(false)
    expect(isSafeToDelete(report)).toBe(true)
  })
})

describe('4. 🔴 the guard that a mutation SURVIVED', () => {
  /**
   * Removing `if (found.length === 0) throw` changed nothing any test could see, because the
   * real schema always has relations. The mutation applied — the script asserts the match count
   * — and 14 tests still passed. A derivation that quietly returns nothing would report every
   * connection as safe to delete, which is the worst possible failure for this module.
   *
   * These cases drive the derivation directly, so the guard has something to fire on.
   */
  it('🔴 THROWS when no relation is found, instead of reporting "nothing attached"', () => {
    expect(() => deriveDependentRelations([])).toThrow(/reader is broken/)
  })

  it('🔴 throws for a schema with models but no ChannelConnection relation', () => {
    // The realistic shape of the bug: the relation is renamed and the matcher stops matching.
    expect(() => deriveDependentRelations([
      { name: 'Product', fields: [{ kind: 'object', type: 'Workspace', relationFromFields: ['workspaceId'] }] },
    ])).toThrow(/reader is broken/)
  })

  it('🟢 CONTROL — one real-shaped relation is enough to satisfy it', () => {
    // Proves the throw comes from emptiness, not from the fixture being synthetic.
    const got = deriveDependentRelations([
      { name: 'Thing', fields: [{ kind: 'object', type: 'ChannelConnection', relationFromFields: ['connectionId'], relationOnDelete: 'Cascade' }] },
    ])
    expect(got).toEqual([{ model: 'Thing', field: 'connectionId', action: 'Cascade', destroys: true }])
  })

  it('ignores a relation with no foreign key on this side', () => {
    // The back-reference (ChannelConnection -> many) has no relationFromFields and must not be
    // counted as a dependent table.
    expect(() => deriveDependentRelations([
      { name: 'Thing', fields: [{ kind: 'object', type: 'ChannelConnection', relationFromFields: [] }] },
    ])).toThrow(/reader is broken/)
  })

  it('the live schema still satisfies it', () => {
    expect(dependentRelations().length).toBeGreaterThan(5)
  })
})
