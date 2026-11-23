import { afterEach, describe, expect, it } from 'vitest'
import { PARTY_WORK_GROUPS, type PartyWorkGroup } from '@nexus/factory-domain/parties/contracts'
import { ORDER_PHASES, type OrderPhase } from '@nexus/factory-domain/production-brand/stages'
import type { CommandCaller } from '../../core/command'
import { decodeKeyCursor, encodeCodeCursor, encodeKeyCursor } from './cursor'
import { arrangeParties, compareNeeds, compareRowKeys, inWorkGroup, needsKeyOf, PARTY_SORT_CAP, partyWorkOf, usePartyWork, workBandOf, type PartyWork, type PartyWorkFacts } from './work'

/**
 * B-CL-001 / B-CL-002 (customers list, 13-backend §1–§3, §7 units): the pure part of where each customer's work stands — the band's
 * groups, the needs order (most urgent first), the band's sums, the view's order with its cap, the key cursor, and the honest none
 * while no sales reader is registered. Made-up customers (SEED-A … SEED-E); no database.
 */

const ZERO: Record<OrderPhase, number> = { NOT_SENT: 0, NOT_STARTED: 0, IN_PRODUCTION: 0, READY: 0, SHIPPED: 0, DONE: 0, CANCELLED: 0 }

const work = (patch: { phases?: Partial<Record<OrderPhase, number>>; requests?: number; replies?: number; late?: number; waitsForYes?: number; waitsForDeposit?: number; best?: PartyWork['best']; firstRequestId?: string | null } = {}): PartyWork => ({
  phases: { ...ZERO, ...patch.phases },
  waiting: { requests: patch.requests ?? 0, replies: patch.replies ?? 0, late: patch.late ?? 0 },
  firstRequestId: patch.firstRequestId ?? null,
  waitsForYes: patch.waitsForYes ?? 0,
  waitsForDeposit: patch.waitsForDeposit ?? 0,
  best: patch.best ?? null,
})

const facts = (byParty: Record<string, PartyWork>, extra: Partial<Pick<PartyWorkFacts, 'repliesComplete' | 'limited'>> = {}): PartyWorkFacts => ({
  byParty: new Map(Object.entries(byParty)),
  repliesComplete: extra.repliesComplete ?? true,
  limited: extra.limited ?? false,
})

const party = (id: string, code: string, legalName: string, tradeName: string | null = null) => ({ id, code, legalName, tradeName })

afterEach(() => usePartyWork(undefined))

describe('the band\'s groups (B-CL-002)', () => {
  it('are NEEDS_US then the order phases without CANCELLED, in the orders\' own order', () => {
    expect(PARTY_WORK_GROUPS[0]).toBe('NEEDS_US')
    expect(PARTY_WORK_GROUPS.slice(1)).toEqual(ORDER_PHASES.filter((phase) => phase !== 'CANCELLED'))
  })

  it('inWorkGroup: NEEDS_US when a request, a reply or a late order waits on us; a phase when an order is in it; no facts: none', () => {
    expect(inWorkGroup(work({ requests: 1 }), 'NEEDS_US')).toBe(true)
    expect(inWorkGroup(work({ replies: 2 }), 'NEEDS_US')).toBe(true)
    expect(inWorkGroup(work({ late: 1 }), 'NEEDS_US')).toBe(true)
    // Waiting for a yes or for the deposit is not "needs us" (the Work strip's group "us" is requests, replies and late).
    expect(inWorkGroup(work({ waitsForYes: 3, waitsForDeposit: 1, phases: { NOT_SENT: 4 } }), 'NEEDS_US')).toBe(false)
    for (const group of PARTY_WORK_GROUPS.slice(1) as Exclude<PartyWorkGroup, 'NEEDS_US'>[]) {
      expect(inWorkGroup(work({ phases: { [group]: 1 } as Partial<Record<OrderPhase, number>> }), group), group).toBe(true)
      expect(inWorkGroup(work(), group), group).toBe(false)
      expect(inWorkGroup(undefined, group), group).toBe(false)
    }
    // A cancelled order puts the customer in no group.
    expect(PARTY_WORK_GROUPS.some((group) => inWorkGroup(work({ phases: { CANCELLED: 5 } }), group))).toBe(false)
    expect(inWorkGroup(undefined, 'NEEDS_US')).toBe(false)
  })
})

describe('the needs order: most urgent first (B-CL-002, settle T3)', () => {
  const key = (patch: Parameters<typeof work>[0] | undefined, code = 'SEED-A', id = 'a') => needsKeyOf(patch === undefined ? undefined : work(patch), code, id)

  it('waiting on us first, then our level (Top before High), then our priority number (higher first), then the promise, then code and id', () => {
    const ordered = [
      key({ late: 1, best: { level: 'LOW', priority: 0, promise: null } }, 'SEED-Z', 'z'),
      key({ best: { level: 'URGENT', priority: 0, promise: '2026-12-20' } }),
      key({ best: { level: 'HIGH', priority: 9, promise: '2026-12-01' } }),
      key({ best: { level: 'HIGH', priority: 2, promise: '2026-12-01' } }),
      key({ best: { level: 'HIGH', priority: 2, promise: '2026-12-05' } }),
      key({ best: { level: 'HIGH', priority: 2, promise: null } }),
      key({ best: { level: 'NORMAL', priority: 0, promise: '2026-11-30' } }, 'SEED-B', 'b'),
      key({ best: { level: 'NORMAL', priority: 0, promise: '2026-11-30' } }, 'SEED-C', 'c'),
      key({ best: { level: 'LOW', priority: 0, promise: null } }),
      // With orders but none open (all done; T31: waiting for a yes neither): after every level.
      key({ phases: { DONE: 3 } }, 'SEED-D', 'd'),
      // No facts at all (no order the reader sees): last, by code.
      key(undefined, 'SEED-E', 'e'),
    ]
    const shuffled = [...ordered].reverse()
    expect([...shuffled].sort(compareNeeds)).toEqual(ordered)
  })

  it('a customer without facts is [1, 4, 0, "9999-12-31", code, id]; the customer\'s own urgency is not a key', () => {
    expect(needsKeyOf(undefined, 'SEED-E', 'e')).toEqual([1, 4, 0, '9999-12-31', 'SEED-E', 'e'])
    expect(needsKeyOf(work({ requests: 1 }), 'SEED-A', 'a')).toEqual([0, 4, 0, '9999-12-31', 'SEED-A', 'a'])
    expect(needsKeyOf(work({ best: { level: 'URGENT', priority: 3, promise: '2026-12-01' } }), 'SEED-A', 'a')).toEqual([1, 0, -3, '2026-12-01', 'SEED-A', 'a'])
    expect(Object.is(needsKeyOf(work({ best: { level: 'HIGH', priority: 0, promise: null } }), 'SEED-A', 'a')[2], 0)).toBe(true)
  })
})

describe('the band: sums over the view\'s customers (B-CL-002)', () => {
  it('counts customers per group and the phase\'s orders, 0 as 0; Needs us and Not sent sum their parts; limited and partial travel', () => {
    const known = facts(
      {
        a: work({ phases: { NOT_SENT: 2, IN_PRODUCTION: 1 }, requests: 1, late: 1, waitsForYes: 1, waitsForDeposit: 1 }),
        b: work({ phases: { IN_PRODUCTION: 3, DONE: 7 }, replies: 2 }),
        c: work({ phases: { CANCELLED: 4 } }),
        outside: work({ phases: { READY: 9 }, requests: 5 }),
      },
      { repliesComplete: false, limited: true },
    )
    const band = workBandOf(['a', 'b', 'c', 'nofacts'], known)
    expect(band.groups).toEqual([
      { group: 'NEEDS_US', customers: 2, orders: null },
      { group: 'NOT_SENT', customers: 1, orders: 2 },
      { group: 'NOT_STARTED', customers: 0, orders: 0 },
      { group: 'IN_PRODUCTION', customers: 2, orders: 4 },
      { group: 'READY', customers: 0, orders: 0 },
      { group: 'SHIPPED', customers: 0, orders: 0 },
      { group: 'DONE', customers: 1, orders: 7 },
    ])
    expect(band.needsUs).toEqual({ requests: 1, replies: 2, late: 1, repliesComplete: false })
    expect(band.notSent).toEqual({ waitsForYes: 1, waitsForDeposit: 1 })
    expect(band.limited).toBe(true)
    // A customer outside the view's ids never counts (its READY 9 and its 5 requests are not in any number).
    expect(JSON.stringify(band)).not.toContain('9')
    // No customer: every group 0, never absent.
    expect(workBandOf([], known).groups.map((group) => group.customers)).toEqual(PARTY_WORK_GROUPS.map(() => 0))
  })

  it('band = filter: a group\'s customers are exactly the rows `work=<group>` keeps', () => {
    const known = facts({ a: work({ phases: { NOT_SENT: 1 }, late: 1 }), b: work({ phases: { SHIPPED: 2 } }), c: work({ replies: 1 }) })
    const candidates = [party('a', 'SEED-A', 'Seed A'), party('b', 'SEED-B', 'Seed B'), party('c', 'SEED-C', 'Seed C'), party('d', 'SEED-D', 'Seed D')]
    const band = workBandOf(candidates.map((row) => row.id), known)
    for (const group of PARTY_WORK_GROUPS) {
      const kept = arrangeParties(candidates, known, { work: group, sort: 'code', band: false }).rows
      expect(kept.length, group).toBe(band.groups.find((entry) => entry.group === group)!.customers)
    }
  })
})

describe('one view in memory: band before work, the order, the cap (B-CL-002)', () => {
  const candidates = [party('a', 'SEED-A', 'Zeta S.r.l.'), party('b', 'SEED-B', 'Alfa S.r.l.', 'Beta'), party('c', 'SEED-C', 'alfa s.r.l.'), party('d', 'SEED-D', 'Delta S.r.l.')]
  const known = facts({ c: work({ requests: 1, phases: { NOT_SENT: 1 } }), d: work({ phases: { IN_PRODUCTION: 1 }, best: { level: 'URGENT', priority: 0, promise: null } }) })

  it('the band counts every candidate before `work` keeps its group; count = the kept rows', () => {
    const view = arrangeParties(candidates, known, { work: 'NEEDS_US', sort: 'needs', band: true })
    expect(view.rows.map((row) => row.id)).toEqual(['c'])
    expect(view.band?.groups.find((group) => group.group === 'IN_PRODUCTION')?.customers).toBe(1)
    expect(view.sortedBy).toBe('needs')
  })

  it('needs: waiting first, then our level, then customers without work by code; name: trade name else legal name, then code; code: by code', () => {
    expect(arrangeParties(candidates, known, { work: undefined, sort: 'needs', band: false }).rows.map((row) => row.id)).toEqual(['c', 'd', 'a', 'b'])
    // SEED-B reads its trade name "Beta" (its legal name "Alfa S.r.l." would put it first); letter case aside, "alfa s.r.l." comes first.
    expect(arrangeParties(candidates, known, { work: undefined, sort: 'name', band: false }).rows.map((row) => row.id)).toEqual(['c', 'b', 'd', 'a'])
    expect(arrangeParties(candidates, known, { work: undefined, sort: 'code', band: false }).rows.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('needs and name over more than PARTY_SORT_CAP rows come back by code (sortedBy says so); work and band have no cap', () => {
    const many = Array.from({ length: PARTY_SORT_CAP + 1 }, (_, index) => party(`id-${String(index).padStart(5, '0')}`, `SEED-${String(PARTY_SORT_CAP - index).padStart(5, '0')}`, 'Seed'))
    const byNeeds = arrangeParties(many, facts({}), { work: undefined, sort: 'needs', band: true })
    expect(byNeeds.sortedBy).toBe('code')
    expect(byNeeds.rows[0]!.code).toBe('SEED-00000')
    expect(byNeeds.band).not.toBeNull()
    expect(arrangeParties(many, facts({}), { work: undefined, sort: 'name', band: false }).sortedBy).toBe('code')
    expect(arrangeParties(many.slice(0, PARTY_SORT_CAP), facts({}), { work: undefined, sort: 'name', band: false }).sortedBy).toBe('name')
  })

  it('a row\'s key is the cursor\'s: the rows strictly after a key are the next page, with no repeat and no gap', () => {
    const view = arrangeParties(candidates, known, { work: undefined, sort: 'needs', band: false })
    const pages: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const from = decodeKeyCursor(cursor, 'needs')
      const next = from ? view.rows.filter((row) => compareRowKeys('needs', view.keyOf(row), from) > 0) : view.rows
      if (next.length === 0) break
      pages.push(next[0]!.id)
      cursor = encodeKeyCursor('needs', view.keyOf(next[0]!))
    }
    expect(pages).toEqual(view.rows.map((row) => row.id))
  })
})

describe('the key cursor (B-CL-002)', () => {
  it('reads back its own key; refuses another order\'s cursor, a code cursor and a broken one (400 in words)', () => {
    const key = [0, 1, -2, '2026-12-01', 'SEED-A', 'a'] as const
    expect(decodeKeyCursor(encodeKeyCursor('needs', key), 'needs')).toEqual([...key])
    expect(decodeKeyCursor(encodeKeyCursor('name', ['Seed A', 'SEED-A', 'a']), 'name')).toEqual(['Seed A', 'SEED-A', 'a'])
    expect(decodeKeyCursor(undefined, 'name')).toBeNull()
    expect(() => decodeKeyCursor(encodeKeyCursor('needs', key), 'name')).toThrow('The cursor is not valid.')
    expect(() => decodeKeyCursor(encodeCodeCursor({ code: 'SEED-A', id: 'a' }), 'name')).toThrow('The cursor is not valid.')
    expect(() => decodeKeyCursor('not-a-cursor', 'needs')).toThrow('The cursor is not valid.')
  })
})

describe('no sales reader registered: an honest none (B-CL-001)', () => {
  const caller = { factoryContext: null, withClient: async () => { throw new Error('no database here') } } as unknown as CommandCaller

  it('partyWorkOf answers null; `work` keeps no row, the band is null, needs comes back by code', async () => {
    usePartyWork(undefined)
    expect(await partyWorkOf(caller, {} as never)).toBeNull()
    const candidates = [party('b', 'SEED-B', 'Seed B'), party('a', 'SEED-A', 'Seed A')]
    const view = arrangeParties(candidates, null, { work: 'NOT_SENT', sort: 'needs', band: true })
    expect(view).toMatchObject({ rows: [], band: null, sortedBy: 'code' })
    const plain = arrangeParties(candidates, null, { work: undefined, sort: 'needs', band: true })
    expect(plain.sortedBy).toBe('code')
    expect(plain.band).toBeNull()
    expect(plain.rows.map((row) => row.code)).toEqual(['SEED-A', 'SEED-B'])
  })

  it('a registered reader answers its facts; taken away again, none', async () => {
    const answer = facts({ a: work({ late: 1 }) })
    usePartyWork({ of: async () => answer })
    expect(await partyWorkOf(caller, {} as never)).toBe(answer)
    usePartyWork(undefined)
    expect(await partyWorkOf(caller, {} as never)).toBeNull()
  })
})
