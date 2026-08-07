/**
 * NAF.DT.1 — the event spine: one event per source table, with the right
 * actor, a sentence a beginner can read, honest outcomes, deterministic
 * paging, and totals that never hide a cap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentCharter: { findMany: vi.fn() },
    agentRun: { findMany: vi.fn() },
    agentFinding: { findMany: vi.fn() },
    agentPlan: { findMany: vi.fn() },
    agentApproval: { findMany: vi.fn() },
    agentFleetState: { findUnique: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { getFleetTimeline } from './fleet-timeline.service.js'

const db = vi.mocked(prisma, true)

const RUNS = [
  {
    id: 'run1',
    agentKey: 'amazon-negative-miner',
    mode: 'sweep',
    trigger: 'schedule',
    ok: true,
    status: 'done',
    findingCount: 5,
    costUSD: '0.0264',
    latencyMs: 16000,
    errorMessage: null,
    haltedReason: null,
    orchestrationId: 'orch1',
    createdAt: new Date('2026-08-06T04:50:00Z'),
  },
  {
    id: 'run2',
    agentKey: 'amazon-bid-tuner',
    mode: 'ask',
    trigger: 'manual',
    ok: false,
    status: 'failed',
    findingCount: 0,
    costUSD: '0',
    latencyMs: 900,
    errorMessage: 'fetch failed',
    haltedReason: null,
    orchestrationId: null,
    createdAt: new Date('2026-08-06T05:00:00Z'),
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  db.agentCharter.findMany.mockResolvedValue([
    { key: 'amazon-negative-miner', name: 'Negative miner' },
    { key: 'amazon-bid-tuner', name: 'Bid tuner' },
    { key: 'amazon-ads-director', name: 'Ads director' },
    { key: 'plan-critic', name: 'Plan critic' },
  ] as never)
  db.agentRun.findMany.mockImplementation((args: never) => {
    // episodeIndex() selects without a `take`; the event query uses one.
    const a = args as unknown as { take?: number }
    return Promise.resolve(
      (a?.take ? RUNS : RUNS.map((r) => ({ id: r.id, orchestrationId: r.orchestrationId, agentKey: r.agentKey }))) as never,
    )
  })
  db.agentFinding.findMany.mockResolvedValue([
    {
      id: 'f1',
      runId: 'run1',
      charterKey: 'amazon-negative-miner',
      kind: 'waste_term',
      severity: 'high',
      entityType: 'SEARCH_TERM',
      entityId: 'st1',
      entityName: 'giacca moto uomo',
      rationale: 'Spent €40 with no orders in 30 days.',
      status: 'open',
      createdAt: new Date('2026-08-06T04:52:00Z'),
    },
  ] as never)
  db.agentPlan.findMany.mockResolvedValue([
    {
      id: 'p1',
      runId: 'run1',
      charterKey: 'amazon-ads-director',
      headline: '15 actions: stop €280+ waste',
      items: new Array(15).fill({}),
      droppedItems: [{}, {}],
      criticVerdict: 'block',
      criticNotes: { summary: 'Two actions contradict a change made yesterday.' },
      status: 'critiqued',
      approvalIds: [],
      createdAt: new Date('2026-08-06T19:56:00Z'),
      decidedAt: new Date('2026-08-06T19:58:00Z'),
    },
  ] as never)
  db.agentApproval.findMany.mockResolvedValue([
    {
      id: 'a1',
      agentRunId: 'run1',
      toolName: 'create-negative-keyword',
      riskTier: 'medium',
      status: 'rejected',
      reason: 'too broad',
      requestedAt: new Date('2026-08-06T06:00:00Z'),
      decidedBy: null,
      decidedAt: new Date('2026-08-06T06:05:00Z'),
    },
  ] as never)
  db.agentFleetState.findUnique.mockResolvedValue({
    halted: false,
    haltedAt: null,
    haltReason: null,
    haltedBy: null,
  } as never)
})

describe('getFleetTimeline — one event per source', () => {
  it('turns a successful run into a sentence naming the worker and the count', async () => {
    const { events } = await getFleetTimeline()
    const e = events.find((x) => x.id === 'run.run1')!
    expect(e.kind).toBe('run.ok')
    expect(e.actor).toBe('Negative miner')
    expect(e.actorKey).toBe('amazon-negative-miner')
    expect(e.title).toBe('Negative miner ran and found 5 things')
    expect(e.source).toBe('the nightly sweep')
    expect(e.outcome).toBe('ok')
    expect(e.costUSD).toBeCloseTo(0.0264)
  })

  it('explains a failure in words and keeps the verbatim error', async () => {
    const { events } = await getFleetTimeline()
    const e = events.find((x) => x.id === 'run.run2')!
    expect(e.kind).toBe('run.failed')
    expect(e.outcome).toBe('bad')
    expect(e.title).toBe('Bid tuner tried to run, and failed')
    expect(e.detail).toContain('could not reach the model provider')
    expect(e.detail).toContain('fetch failed')
  })

  it('names the entity a finding is about instead of its id', async () => {
    const { events } = await getFleetTimeline()
    const e = events.find((x) => x.id === 'finding.f1')!
    expect(e.title).toBe('Negative miner found a search term wasting money — giacca moto uomo')
    expect(e.entity).toEqual({ type: 'SEARCH_TERM', id: 'st1', name: 'giacca moto uomo' })
    expect(e.outcome).toBe('attention')
  })

  it("splits a plan into the drafting and the critic's separate ruling", async () => {
    const { events } = await getFleetTimeline()
    const drafted = events.find((x) => x.id === 'plan.p1')!
    const ruled = events.find((x) => x.id === 'critic.p1')!
    expect(drafted.title).toBe('Ads director drew up a plan of 15 actions')
    expect(drafted.detail).toContain('set aside 2 more')
    expect(ruled.title).toBe('The critic blocked that plan')
    expect(ruled.actorKey).toBe('plan-critic')
    expect(ruled.outcome).toBe('bad')
    // The critic's moment is its own timestamp, not the plan's.
    expect(ruled.at).toBe('2026-08-06T19:58:00.000Z')
  })

  it('splits an approval into the worker asking and the human answering', async () => {
    const { events } = await getFleetTimeline()
    const asked = events.find((x) => x.id === 'approval.a1')!
    const decided = events.find((x) => x.id === 'decision.a1')!
    expect(asked.actorKind).toBe('worker')
    expect(asked.title).toBe('Negative miner asked permission to stop ads showing for a search term')
    expect(asked.riskTier).toBe('medium')
    expect(decided.actorKind).toBe('human')
    expect(decided.title).toBe('Someone said no to the request to stop ads showing for a search term')
    expect(decided.detail).toBe('Reason given: too broad')
  })

  it('admits when nobody recorded who decided, rather than inventing one', async () => {
    const { events } = await getFleetTimeline()
    expect(events.find((x) => x.id === 'decision.a1')!.actor).toBe('Someone (not recorded)')
  })

  it('groups a run and everything it produced into one episode', async () => {
    const { events } = await getFleetTimeline()
    const ids = ['run.run1', 'finding.f1', 'plan.p1', 'critic.p1', 'approval.a1']
    for (const id of ids) expect(events.find((x) => x.id === id)!.episodeId).toBe('orch1')
  })
})

describe('getFleetTimeline — ordering, paging and honesty', () => {
  it('returns newest first', async () => {
    const { events } = await getFleetTimeline()
    const times = events.map((e) => e.at)
    expect([...times].sort().reverse()).toEqual(times)
  })

  it('reports the true total even when a page is smaller', async () => {
    const { events, total, nextCursor } = await getFleetTimeline({}, { limit: 2 })
    expect(events).toHaveLength(2)
    expect(total).toBe(7) // 2 runs + 1 finding + 1 plan + 1 critic + 1 ask + 1 decision
    expect(nextCursor).not.toBeNull()
  })

  it('never repeats an event across pages', async () => {
    const first = await getFleetTimeline({}, { limit: 3 })
    const second = await getFleetTimeline({}, { limit: 3, cursor: first.nextCursor! })
    const overlap = first.events
      .map((e) => e.id)
      .filter((id) => second.events.some((e) => e.id === id))
    expect(overlap).toEqual([])
  })

  it('counts every kind so the filter chips can show real numbers', async () => {
    const { countsByKind } = await getFleetTimeline()
    expect(countsByKind).toMatchObject({
      'run.ok': 1,
      'run.failed': 1,
      'finding.raised': 1,
      'plan.drafted': 1,
      'plan.critiqued': 1,
      'approval.requested': 1,
      'approval.decided': 1,
    })
  })
})

describe('getFleetTimeline — filters', () => {
  it('filters to one worker, and drops the human decision with it', async () => {
    const { events } = await getFleetTimeline({ actors: ['amazon-negative-miner'] })
    expect(events.every((e) => e.actorKey === 'amazon-negative-miner')).toBe(true)
    expect(events.some((e) => e.kind === 'approval.decided')).toBe(false)
  })

  it("filters to what people did, keeping only humans' decisions", async () => {
    const { events } = await getFleetTimeline({ actors: ['human'] })
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('approval.decided')
  })

  /* ACT.3 — the actor filter is a LIST. These are the cases the single-value
     version could not express, and the ones most likely to be got wrong. */

  it('filters to SEVERAL workers at once', async () => {
    const { events, total } = await getFleetTimeline({
      actors: ['amazon-negative-miner', 'amazon-bid-tuner'],
    })
    const keys = new Set(events.map((e) => e.actorKey))
    expect(keys).toEqual(new Set(['amazon-negative-miner', 'amazon-bid-tuner']))
    // The counts are derived from the same predicate, so they must agree.
    expect(total).toBe(events.length)
  })

  it('mixes a worker with a person, and keeps both kinds of event', async () => {
    const { events } = await getFleetTimeline({ actors: ['amazon-negative-miner', 'human'] })
    expect(events.some((e) => e.actorKind === 'worker')).toBe(true)
    expect(events.some((e) => e.kind === 'approval.decided')).toBe(true)
    // …and still excludes everyone not named.
    expect(events.some((e) => e.actorKey === 'amazon-ads-director')).toBe(false)
  })

  it('returns nothing for an actor that does not exist, rather than everything', async () => {
    // The route does NOT validate actor keys against an allow-list — they are
    // data, and a W.8 instance can appear at any time. So an unknown key must
    // fail closed. Falling back to "no filter" would answer a question nobody
    // asked, which is how `kind`'s csv helper behaves and why this one differs.
    const { events, total } = await getFleetTimeline({ actors: ['no-such-worker'] })
    expect(events).toHaveLength(0)
    expect(total).toBe(0)
  })

  it('treats an empty list as no filter at all', async () => {
    const all = await getFleetTimeline()
    const empty = await getFleetTimeline({ actors: [] })
    expect(empty.total).toBe(all.total)
  })

  it('carries duration and finding count on runs, and on nothing else', async () => {
    const { events } = await getFleetTimeline()
    const run = events.find((e) => e.id === 'run.run1')!
    expect(run.durationMs).toBe(16000)
    expect(run.findingCount).toBe(5)
    for (const e of events.filter((x) => !x.kind.startsWith('run.'))) {
      expect(e.durationMs).toBeNull()
      expect(e.findingCount).toBeNull()
    }
  })

  it('filters by kind', async () => {
    const { events } = await getFleetTimeline({ kinds: ['run.failed'] })
    expect(events.map((e) => e.id)).toEqual(['run.run2'])
  })

  it('searches the sentence, not the raw row', async () => {
    const { events } = await getFleetTimeline({ q: 'giacca' })
    expect(events.map((e) => e.id)).toEqual(['finding.f1'])
  })
})

describe('getFleetTimeline — the halt', () => {
  it('says nothing when the fleet is running', async () => {
    const { events } = await getFleetTimeline()
    expect(events.some((e) => e.kind === 'fleet.halted')).toBe(false)
  })

  it('contributes exactly one event when the fleet is halted', async () => {
    db.agentFleetState.findUnique.mockResolvedValue({
      halted: true,
      haltedAt: new Date('2026-08-06T07:00:00Z'),
      haltReason: 'daily ceiling reached',
      haltedBy: 'auto:budget-guard',
    } as never)
    const { events } = await getFleetTimeline()
    const halt = events.filter((e) => e.kind === 'fleet.halted')
    expect(halt).toHaveLength(1)
    expect(halt[0]!.title).toBe('The whole fleet was halted')
    expect(halt[0]!.detail).toBe('daily ceiling reached')
    expect(halt[0]!.source).toBe('a guard')
  })
})

describe('rollup keys', () => {
  it('gives identical failures one signature so repeats can collapse', async () => {
    const { events } = await getFleetTimeline()
    expect(events.find((e) => e.id === 'run.run2')!.rollupKey).toBe(
      'run:amazon-bid-tuner:unreachable',
    )
  })

  it('separates a success from a failure by the same worker', async () => {
    const { events } = await getFleetTimeline()
    const ok = events.find((e) => e.id === 'run.run1')!.rollupKey
    const bad = events.find((e) => e.id === 'run.run2')!.rollupKey
    expect(ok).not.toBe(bad)
  })
})

/* ── NAF.SB.ACT.1 ──────────────────────────────────────────────────────── */

describe('ACT.1 — approvals belong to the fleet, or they do not appear', () => {
  it('drops an approval whose run is not a fleet run', async () => {
    // The real shape of every one of the 18 rows in production: attached to a
    // pre-fleet ACP run, so `mode` is null and the fleet-run index misses it.
    db.agentApproval.findMany.mockResolvedValue([
      {
        id: 'old1',
        agentRunId: 'acp-run-from-june',
        toolName: 'apply-content',
        riskTier: 'medium',
        status: 'executed',
        reason: 'acp3b-verify',
        requestedAt: new Date('2026-06-17T05:24:15Z'),
        decidedBy: null,
        decidedAt: new Date('2026-06-17T05:30:00Z'),
      },
    ] as never)
    const { events, total } = await getFleetTimeline()
    expect(events.some((e) => e.id.startsWith('approval.'))).toBe(false)
    expect(events.some((e) => e.id.startsWith('decision.'))).toBe(false)
    // And the headline number agrees with the rows — the whole point of
    // enforcing this in one place.
    expect(total).toBe(events.length)
  })

  it('never labels an actor "An agent" or invents one', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      {
        id: 'old1',
        agentRunId: 'acp-run-from-june',
        toolName: 'apply-content',
        riskTier: 'high',
        status: 'rejected',
        reason: null,
        requestedAt: new Date('2026-06-17T05:24:15Z'),
        decidedBy: null,
        decidedAt: new Date('2026-06-17T05:30:00Z'),
      },
    ] as never)
    const { events } = await getFleetTimeline()
    expect(events.map((e) => e.actor)).not.toContain('An agent')
  })

  it('keeps an approval that really does belong to a fleet run', async () => {
    const { events } = await getFleetTimeline()
    expect(events.some((e) => e.id === 'approval.a1')).toBe(true)
    expect(events.some((e) => e.id === 'decision.a1')).toBe(true)
  })
})

describe('ACT.1 — diagnostic workers are excluded, never concealed', () => {
  const SELFTEST_RUN = {
    id: 'run3',
    agentKey: 'fleet-selftest',
    mode: 'ask',
    trigger: 'manual',
    ok: false,
    status: 'failed',
    findingCount: 0,
    costUSD: '0',
    latencyMs: 400,
    errorMessage: 'fetch failed',
    haltedReason: null,
    orchestrationId: null,
    createdAt: new Date('2026-08-06T08:44:00Z'),
    workflowKey: null,
  }

  beforeEach(() => {
    const all = [...RUNS, SELFTEST_RUN]
    db.agentRun.findMany.mockImplementation((args: never) => {
      const a = args as unknown as { take?: number }
      return Promise.resolve(
        (a?.take
          ? all
          : all.map((r) => ({ id: r.id, orchestrationId: r.orchestrationId, agentKey: r.agentKey }))) as never,
      )
    })
  })

  it('marks the self-test diagnostic and the business workers not', async () => {
    const { events } = await getFleetTimeline()
    expect(events.find((e) => e.id === 'run.run3')!.diagnostic).toBe(true)
    expect(events.find((e) => e.id === 'run.run1')!.diagnostic).toBe(false)
  })

  it('includes them by default, so no existing caller changes behaviour', async () => {
    const { events } = await getFleetTimeline()
    expect(events.some((e) => e.id === 'run.run3')).toBe(true)
  })

  it('drops them when asked, and the totals agree with the rows', async () => {
    const withThem = await getFleetTimeline()
    const without = await getFleetTimeline({ includeDiagnostic: false })
    expect(without.events.some((e) => e.id === 'run.run3')).toBe(false)
    expect(without.total).toBe(withThem.total - 1)
    // The invariant that has broken twice in this subtree: a headline count
    // above a table must be the SAME derivation, not a parallel one.
    expect(without.total).toBe(without.events.length)
    expect(Object.values(without.countsByKind).reduce((a, b) => a + b, 0)).toBe(without.total)
  })

  it('drops them from the actor list too, so a filter cannot offer an empty result', async () => {
    const { actors } = await getFleetTimeline({ includeDiagnostic: false })
    expect(actors.map((a) => a.key)).not.toContain('fleet-selftest')
  })
})

describe('ACT.1 — the fields a row needs to explain itself', () => {
  it('carries the routine that ran it, when one did', async () => {
    db.agentRun.findMany.mockImplementation((args: never) => {
      const a = args as unknown as { take?: number }
      const rows = [{ ...RUNS[0]!, workflowKey: 'fleet-sweep' }, RUNS[1]!]
      return Promise.resolve(
        (a?.take
          ? rows
          : rows.map((r) => ({ id: r.id, orchestrationId: r.orchestrationId, agentKey: r.agentKey }))) as never,
      )
    })
    const { events } = await getFleetTimeline()
    expect(events.find((e) => e.id === 'run.run1')!.workflowKey).toBe('fleet-sweep')
    expect(events.find((e) => e.id === 'run.run2')!.workflowKey).toBeNull()
  })

  it('says how fresh a finding really is, because findings are upserted', async () => {
    db.agentFinding.findMany.mockResolvedValue([
      {
        id: 'f1',
        runId: 'run1',
        charterKey: 'amazon-negative-miner',
        kind: 'waste_term',
        severity: 'high',
        entityType: 'SEARCH_TERM',
        entityId: 'st1',
        entityName: 'giacca moto uomo',
        rationale: 'Spent €40 with no orders in 30 days.',
        status: 'open',
        createdAt: new Date('2026-08-06T04:52:00Z'),
        dataVintage: new Date('2026-08-07T03:00:00Z'),
      },
    ] as never)
    const { events } = await getFleetTimeline()
    const f = events.find((e) => e.id === 'finding.f1')!
    // First sighting on the 6th; the evidence behind it is from the 7th.
    expect(f.at.slice(0, 10)).toBe('2026-08-06')
    expect(f.dataVintage!.slice(0, 10)).toBe('2026-08-07')
  })

  it('links into the fleet, not the old ads-console route', async () => {
    const { events } = await getFleetTimeline()
    const hrefs = events.map((e) => e.href).filter((h): h is string => h != null)
    expect(hrefs.length).toBeGreaterThan(0)
    expect(hrefs.every((h) => h.startsWith('/fleet'))).toBe(true)
    expect(hrefs.some((h) => h.includes('rules-automation'))).toBe(false)
    expect(events.find((e) => e.id === 'run.run1')!.href).toBe('/fleet/workers/amazon-negative-miner')
  })
})
