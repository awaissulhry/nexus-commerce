import { describe, expect, it } from 'vitest'
import { releaseHoldLine, releaseOutcomeLine, releasePreviewLines, scheduleHealth, STALE_AFTER_MS, type HealthInput, type ReleasePreview } from './scheduleHealth'

const NOW = Date.parse('2026-08-02T12:00:00Z')
const base: HealthInput = { enabled: true, lastEvaluatedAt: new Date(NOW - 60_000).toISOString(), failedWrites: 0, governedElsewhere: 0, membersTotal: 5 }
const h = (patch: Partial<HealthInput>) => scheduleHealth({ ...base, ...patch }, NOW)

describe('scheduleHealth', () => {
  it('reports OK for a schedule evaluated recently with no failures', () => {
    expect(h({})).toMatchObject({ tone: 'ok', label: 'OK' })
  })

  it('surfaces failed writes above everything else — including Paused', () => {
    expect(h({ failedWrites: 3 })).toMatchObject({ tone: 'bad', label: '3 writes failing' })
    // The exact defect A3 exists to close: a schedule paused because it was failing must not
    // hide the reason behind a neutral "Paused".
    expect(h({ failedWrites: 3, enabled: false })).toMatchObject({ tone: 'bad' })
  })

  it('singularises a single failed write', () => {
    expect(h({ failedWrites: 1 }).label).toBe('1 write failing')
  })

  it('never calls a paused schedule stale', () => {
    expect(h({ enabled: false, lastEvaluatedAt: new Date(NOW - 5 * 86_400_000).toISOString() })).toMatchObject({ tone: 'muted', label: 'Paused' })
  })

  // 2a — pausing gives back the bids it floored; the old copy said nothing is reverted.
  it('says a paused schedule gave its floored bids back, and that placements stay', () => {
    const d = h({ enabled: false }).detail
    expect(d).toContain('The bids it floored are given back when it is paused')
    expect(d).toContain('Placement percentages stay as last set.')
    expect(d).not.toContain('nothing is reverted')
  })

  it('flags a group that holds no campaigns', () => {
    expect(h({ membersTotal: 0 })).toMatchObject({ tone: 'warn', label: 'No campaigns' })
  })

  it('distinguishes partly- from fully-governed schedules', () => {
    expect(h({ governedElsewhere: 2, membersTotal: 5 })).toMatchObject({ tone: 'warn', label: '2 governed elsewhere' })
    expect(h({ governedElsewhere: 5, membersTotal: 5 })).toMatchObject({ tone: 'warn', label: 'Governed elsewhere' })
  })

  it('separates "never run" from "stale"', () => {
    expect(h({ lastEvaluatedAt: null })).toMatchObject({ tone: 'muted', label: 'Never run' })
    expect(h({ lastEvaluatedAt: new Date(NOW - STALE_AFTER_MS - 1000).toISOString() })).toMatchObject({ tone: 'warn', label: 'Stale' })
  })

  it('does not call a schedule stale just inside the threshold', () => {
    expect(h({ lastEvaluatedAt: new Date(NOW - STALE_AFTER_MS + 1000).toISOString() })).toMatchObject({ tone: 'ok' })
  })
})

/**
 * RD.P2 — `Cannot converge`, and the position that makes it useful.
 *
 * The ordering is the policy, so these tests pin the ORDER rather than the string: a config fault
 * that never self-heals must outrank a transient the next cron tick clears, and must not outrank a
 * campaign this schedule does not own.
 */
describe('Cannot converge', () => {
  const base = { enabled: true, lastEvaluatedAt: new Date().toISOString(), failedWrites: 0, governedElsewhere: 0, membersTotal: 11 }

  it('fires when every member is stuck, and carries the engine’s own reason', () => {
    const h = scheduleHealth({ ...base, cannotConverge: 11, cannotConvergeReason: 'The ceiling equals the floor (75%).' })
    expect(h.label).toBe('Cannot converge')
    expect(h.tone).toBe('warn')
    expect(h.detail).toContain('ceiling equals the floor')
  })

  it('counts the members when only some are stuck', () => {
    expect(scheduleHealth({ ...base, cannotConverge: 8, membersTotal: 10 }).label).toBe('8 cannot converge')
  })

  it('outranks Stale — a config fault does not heal on the next tick', () => {
    const stale = new Date(Date.now() - 90 * 60 * 1000).toISOString()
    expect(scheduleHealth({ ...base, lastEvaluatedAt: stale, cannotConverge: 3 }).label).toBe('3 cannot converge')
    expect(scheduleHealth({ ...base, lastEvaluatedAt: stale, cannotConverge: 0 }).label).toBe('Stale')
  })

  it('outranks Never run, which is transient for a freshly armed schedule', () => {
    expect(scheduleHealth({ ...base, lastEvaluatedAt: null, cannotConverge: 2 }).label).toBe('2 cannot converge')
  })

  it('does NOT outrank Governed elsewhere — that row is not this schedule’s to converge', () => {
    expect(scheduleHealth({ ...base, governedElsewhere: 11, cannotConverge: 11 }).label).toBe('Governed elsewhere')
  })

  it('does NOT outrank failing writes or Paused', () => {
    expect(scheduleHealth({ ...base, failedWrites: 2, cannotConverge: 11 }).tone).toBe('bad')
    expect(scheduleHealth({ ...base, enabled: false, cannotConverge: 11 }).label).toBe('Paused')
  })

  it('is absent when nothing is stuck, and the field is optional for existing callers', () => {
    expect(scheduleHealth(base).label).toBe('OK')
    expect(scheduleHealth({ ...base, cannotConverge: 0 }).label).toBe('OK')
  })
})

/** 2a — what deleting, pausing or removing gives back, in the words the dialog, the builder and the list show. */
describe('release copy', () => {
  const item = (o: Partial<ReleasePreview['items'][number]>): ReleasePreview['items'][number] => ({
    campaignId: 'c', name: 'IT GALE', outcome: 'restore', bids: 3, floorCents: 2, floorBy: null, placements: { top: 0, rest: 0, product: 0 }, ...o,
  })
  const preview = (o: Partial<ReleasePreview>): ReleasePreview => ({ campaigns: 1, restore: 1, bids: 3, keptByOthers: 0, nothing: 0, waitWhy: null, items: [item({})], ...o })

  it('names the bids that come back at once, and the placements that stay', () => {
    expect(releasePreviewLines(preview({}))).toEqual([
      'Gives back at once the 3 bids it floored on 1 campaign.',
      'Placement percentages stay as they are (all at 0%).',
    ])
  })

  it('says why the give-back waits, and when it comes', () => {
    expect(releasePreviewLines(preview({ waitWhy: 'ads automation is stopped (halted: spend spike)' }))[0])
      .toBe('The 3 bids it floored on 1 campaign stay floored for now because ads automation is stopped (halted: spend spike). They come back on the first run after that changes.')
    expect(releasePreviewLines(preview({ bids: 1, waitWhy: 'Rank & Dayparting is switched off for this business' }))[0])
      .toBe('The 1 bid it floored on 1 campaign stays floored for now because Rank & Dayparting is switched off for this business. It comes back on the first run after that changes.')
  })

  it('names who holds a floor it did not set, and lists placements above 0%', () => {
    const lines = releasePreviewLines(preview({
      campaigns: 3, restore: 0, bids: 0, keptByOthers: 2, nothing: 1,
      items: [
        item({ campaignId: 'a', outcome: 'kept-by-others', bids: 0, floorBy: 'a person', placements: { top: 50, rest: 0, product: 10 } }),
        item({ campaignId: 'b', outcome: 'kept-by-others', bids: 0, floorBy: 'the out-of-stock check' }),
        item({ campaignId: 'c', outcome: 'nothing', bids: 0 }),
      ],
    }))
    expect(lines).toEqual([
      'No campaign here holds a bid floor this schedule set, so no bid changes.',
      '2 campaigns stay floored: the floor was set by a person, the out-of-stock check, not by this schedule.',
      'Placement percentages stay as they are: IT GALE Top 50% · Rest 0% · Product 10%.',
    ])
  })

  it('the builder note counts the campaigns held at a floor now', () => {
    expect(releaseHoldLine(preview({ campaigns: 11, restore: 4, bids: 40 }))).toBe('Right now this schedule holds a bid floor on 4 of its 11 campaigns (40 bids).')
    expect(releaseHoldLine(preview({ restore: 0, bids: 0 }))).toBe('Right now this schedule holds no bid floor.')
  })

  it('after a pause: what came back, what waits and why, what someone else holds', () => {
    const none = { restored: 0, keptByOthers: 0, failed: 0, deferred: 0, deferredWhy: null, writes: 0 }
    expect(releaseOutcomeLine(2, { ...none, restored: 3, writes: 9 })).toBe('Paused 2 schedules. Gave back the bids on 3 campaigns (9 bids).')
    expect(releaseOutcomeLine(1, { ...none, deferred: 1, deferredWhy: 'ads automation is stopped (halted: x)', keptByOthers: 1 }))
      .toBe('Paused 1 schedule. 1 campaign stays floored for now because ads automation is stopped (halted: x); the bids come back on the first run after that changes. 1 campaign stays floored by someone else.')
    expect(releaseOutcomeLine(1, none)).toBe('Paused 1 schedule. None of its campaigns held a bid floor, so no bid changed.')
    expect(releaseOutcomeLine(2, none)).toBe('Paused 2 schedules. None of their campaigns held a bid floor, so no bid changed.')
  })
})
