/**
 * NAF.SB.M-S9R — the map endpoint, against the states a healthy fleet cannot
 * show you.
 *
 * This file exists because Section 9 found that the only verification this
 * endpoint has ever had is `scripts/_sbm-map-check.mts` — thirteen assertions
 * written on the day it shipped, by the same person who wrote the bug Section 7
 * later found. It asserts what the service produces from real data, which means
 * it can only ever check the states production happens to be in.
 *
 * A degraded read is not one of those states. So it is forced here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentRun: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
    agentFinding: { findMany: vi.fn(async () => []) },
    agentPlan: { findMany: vi.fn(async () => []) },
    agentApproval: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock('./charter-registry.js', () => ({ listCharters: vi.fn(async () => []) }))
vi.mock('./fleet-labels.service.js', () => ({ resolveFleetLabels: vi.fn(async () => new Map()) }))
vi.mock('./fleet-schedule.service.js', () => ({ getFleetSchedule: vi.fn() }))
vi.mock('./fleet-state.service.js', () => ({ getFleetState: vi.fn() }))
vi.mock('./workflow-registry.service.js', () => ({ getEffectiveWiring: vi.fn(async () => []) }))

import { getFleetSchedule } from './fleet-schedule.service.js'
import { getFleetState } from './fleet-state.service.js'
import { getFleetMap } from './fleet-map.service.js'

const schedule = vi.mocked(getFleetSchedule)
const state = vi.mocked(getFleetState)

beforeEach(() => {
  vi.clearAllMocks()
  state.mockResolvedValue({
    halted: false,
    haltedAt: null,
    haltReason: null,
    haltedBy: null,
    dailyCeilingUSD: 2,
    updatedAt: new Date(),
  } as never)
  schedule.mockResolvedValue({ jobs: [] } as never)
})

describe('S9.a — a schedule that cannot be read says so', () => {
  it('still returns the rest of the map', async () => {
    schedule.mockRejectedValue(new Error('forced: schedule unreadable'))
    const m = await getFleetMap('7d')
    // Degrading is the right call: an unreadable schedule is no reason to deny
    // the operator the workers, the edges and the spend figure.
    expect(m.schedule).toEqual([])
    expect(m.state.dailyCeilingUSD).toBe(2)
  })

  it('pushes a warning, so absence and failure do not look alike', async () => {
    schedule.mockRejectedValue(new Error('forced: schedule unreadable'))
    const m = await getFleetMap('7d')
    expect(
      m.warnings.some((w) => w.includes('schedule could not be read')),
      'an unreadable schedule rendered identically to a fleet with nothing scheduled',
    ).toBe(true)
  })

  it('says nothing when the schedule is merely empty', async () => {
    schedule.mockResolvedValue({ jobs: [] } as never)
    const m = await getFleetMap('7d')
    expect(m.schedule).toEqual([])
    expect(m.warnings.some((w) => w.includes('schedule could not be read'))).toBe(false)
  })
})

/* ── S9.g — the two checks that make Section 9 durable ─────────────────────
 *
 * The only verification this endpoint had for a year was `_sbm-map-check.mts`,
 * which asserts what the service produces from whatever state production
 * happens to be in. It cannot see a field nobody reads, and it did not see the
 * `everCrossed` comment that asserted the opposite of its own branch.
 *
 * These two are greps, deliberately. The failure mode is "a field or a claim
 * outlived the thing it described", and a grep finds that. They read the real
 * files rather than a fixture, because a fixture is one more copy to drift.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVICE = join(HERE, 'fleet-map.service.ts')
const WEB = join(HERE, '../../../../web/src/app/fleet')

/** Source with comments stripped, so a claim cannot be satisfied by prose. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

function webReferences(name: string): number {
  try {
    const out = execSync(
      `grep -rl --include='*.ts' --include='*.tsx' -- '\\.${name}\\b' ${JSON.stringify(WEB)} || true`,
      { encoding: 'utf8' },
    )
    return out.split('\n').filter((f) => f && !f.includes('.vitest.test.')).length
  } catch {
    return 0
  }
}

describe('S9.g/1 — no payload field without a reader', () => {
  /*
   * Kept ON PURPOSE and unread, each for a stated reason in the service:
   * a cycle in the wiring is a state the operator must eventually see, and the
   * two running-run fields are unread only because the fleet is OFF. This set
   * is the marker — adding to it should require the same argument.
   */
  const AWAITING_A_READER = new Set([
    'unorderedReason',
    'runningRunId',
    'runningSince',
    /* Top-level payload stamp. The page shows an "as of" time, but it takes it
       from `useVisibilityPoll`'s own clock — the time of the last SUCCESSFUL
       read — not from this field. Kept because a payload that cannot say when
       it was computed is worse than one nobody has wired up yet. */
    'asOf',
    /* Charter provenance. Workers renders the model a run used; the map does
       not, and its card has three fixed fact slots with 18px of slack. */
    'modelProvider',
  ])

  const code = stripComments(readFileSync(SERVICE, 'utf8'))
  /*
   * BOUNDED to the exported interfaces. My first cut sliced from
   * `export interface MapNode` to end-of-file and reported `where`, `select`
   * and `tool` as unread payload fields — two Prisma query keys and a local
   * `PlanItem` member, none of which the browser ever sees. Section 8's key
   * parser had the identical bug. The guard below exists because of it.
   */
  const blocks = ['MapNode', 'MapEdge', 'FleetMapView'].map((n) => {
    const start = code.indexOf(`export interface ${n} {`)
    return start < 0 ? '' : code.slice(start, code.indexOf('\n}', start))
  })
  const fields = blocks.flatMap((b) => [...b.matchAll(/^\s{2,6}([a-z][A-Za-z]*)\??:/gm)].map((m) => m[1]))

  /* Structural names and container keys, not leaves the browser reads directly. */
  const skip = new Set(['currency', 'window', 'lifetime', 'runs', 'open', 'id', 'from', 'to', 'key', 'name'])

  /*
   * DELIBERATELY NOT RENDERED, and that is the point of them.
   *
   * `scopePortfolioIds` and `scopeCampaignIds` are stored, accepted at create,
   * merged onto the effective charter — and enforced by NO query, filter or
   * prompt. `observations/scope-filter.ts:6-7` is the fleet's own law:
   * "a control that is not enforced must not be rendered. This is the
   * enforcement." So a reader for these would be the defect. They ship in the
   * payload because the charter object does; nothing may draw them.
   */
  const MUST_NOT_BE_RENDERED = new Set(['scopePortfolioIds', 'scopeCampaignIds'])

  const checkable = [...new Set(fields)].filter((f) => !skip.has(f) && !MUST_NOT_BE_RENDERED.has(f))

  it('parses payload fields, and only those (guards the parser itself)', () => {
    expect(checkable.length).toBeGreaterThan(8)
    expect(checkable).toContain('everCrossed')
    /* Prisma query keys and local interfaces live outside the exported blocks.
       If these appear, the slice has escaped again. */
    expect(checkable).not.toContain('where')
    expect(checkable).not.toContain('select')
    expect(checkable).not.toContain('tool')
  })

  it.each(checkable)('`%s` is read by a fleet surface, or is a stated exception', (f) => {
    if (AWAITING_A_READER.has(f)) return
    expect(
      webReferences(f),
      `${f} is in the payload and no fleet surface reads it — give it a reader, delete it, or add it to AWAITING_A_READER with the reason`,
    ).toBeGreaterThan(0)
  })
})

describe('S9.g/2 — no comment names a renderer that does not render', () => {
  const src = readFileSync(SERVICE, 'utf8')

  it('does not claim the inspector rail renders a field it does not', () => {
    // The exact shape of the S9.c defect: a doc comment naming a surface, on a
    // field that surface never referenced. Guarded against reintroduction.
    const claims = [...src.matchAll(/(inspector rail|the rail|the list|the canvas|the band)\s+renders/gi)]
    for (const c of claims) {
      const after = src.slice(c.index ?? 0, (c.index ?? 0) + 400)
      const field = /\*\/\s*([a-z][A-Za-z]*)\??:/.exec(after)?.[1]
      if (!field) continue
      expect(
        webReferences(field),
        `a comment says "${c[0]}" of \`${field}\`, and no fleet surface references it`,
      ).toBeGreaterThan(0)
    }
  })
})
