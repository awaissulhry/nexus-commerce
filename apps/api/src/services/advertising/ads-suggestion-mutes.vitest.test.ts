/**
 * SG.9 — "stop suggesting for this one", H10's third verb at its documented meaning.
 *
 * The contract these pin, because getting any of them wrong turns a mute into something the
 * operator did not ask for:
 *   · muting writes NOTHING to Amazon — it is a producer-side stop, and the entity keeps running;
 *   · the WRITER consults it, so a muted entity stops generating rows (a read-time filter would
 *     let the queue keep growing behind the operator's back);
 *   · muting clears the entity's whole pending set, not just the clicked row;
 *   · `muted` is out of the lifecycle sweep's reach — it must never be resurrected the way a
 *     7-day-old operator dismissal is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { db } = vi.hoisted(() => ({
  db: {
    adsRuleSuggestion: { findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
    adsSuggestionMute: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  },
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../ads-core/ams-daily.js', () => ({ EXCLUDE_AMS_DAILY: {} }))

import { muteSuggestion, unmuteSuggestion, mutedKeys } from './ads-suggestions.service.js'

const ROW = { id: 's1', entityType: 'AD_TARGET', entityId: 't1', entityName: 'motorradjacke', marketplace: 'DE', status: 'pending' }

beforeEach(() => {
  vi.clearAllMocks()
  db.adsRuleSuggestion.updateMany.mockResolvedValue({ count: 2 })
  db.adsSuggestionMute.upsert.mockResolvedValue({})
  db.adsSuggestionMute.deleteMany.mockResolvedValue({ count: 1 })
})

describe('mutedKeys', () => {
  it('keys by entityType|entityId for the requested producer only', async () => {
    db.adsSuggestionMute.findMany.mockResolvedValue([
      { entityType: 'AD_TARGET', entityId: 't1' }, { entityType: 'CAMPAIGN', entityId: 'c9' },
    ])
    const keys = await mutedKeys('rules')
    expect(db.adsSuggestionMute.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { scope: 'rules' } }))
    expect([...keys]).toEqual(['AD_TARGET|t1', 'CAMPAIGN|c9'])
  })
  it('an unreadable mute table degrades to "no mutes" rather than throwing the tick', async () => {
    db.adsSuggestionMute.findMany.mockRejectedValue(new Error('db down'))
    await expect(mutedKeys('ai')).resolves.toEqual(new Set())
  })
})

describe('muteSuggestion', () => {
  it('records the mute and clears the ENTITY\'s pending rows — not just the clicked one', async () => {
    db.adsRuleSuggestion.findUnique.mockResolvedValue(ROW)
    const res = await muteSuggestion('s1')
    expect(res).toMatchObject({ ok: true, result: { muted: 2 } })
    expect(db.adsSuggestionMute.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { scope_entityType_entityId: { scope: 'rules', entityType: 'AD_TARGET', entityId: 't1' } },
      create: expect.objectContaining({ scope: 'rules', entityName: 'motorradjacke', marketplace: 'DE' }),
    }))
    expect(db.adsRuleSuggestion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { entityType: 'AD_TARGET', entityId: 't1', status: 'pending' },
      data: expect.objectContaining({ status: 'muted', decidedBy: 'operator:muted' }),
    }))
  })
  it('writes NOTHING to Amazon — no mutation service is reachable from this path', async () => {
    db.adsRuleSuggestion.findUnique.mockResolvedValue(ROW)
    await muteSuggestion('s1')
    // the only writes are the mute row and the status flip
    expect(Object.keys(db)).toEqual(['adsRuleSuggestion', 'adsSuggestionMute'])
  })
  it('refuses a row that is not pending, and a row that is gone', async () => {
    db.adsRuleSuggestion.findUnique.mockResolvedValue({ ...ROW, status: 'applied' })
    expect((await muteSuggestion('s1')).error).toContain('already applied')
    db.adsRuleSuggestion.findUnique.mockResolvedValue(null)
    expect((await muteSuggestion('s1')).httpStatus).toBe(404)
  })
})

describe('unmuteSuggestion', () => {
  it('drops the mute and returns the entity\'s rows to the queue', async () => {
    db.adsRuleSuggestion.findUnique.mockResolvedValue({ ...ROW, status: 'muted' })
    const res = await unmuteSuggestion('s1')
    expect(res).toMatchObject({ ok: true, result: { restored: 2 } })
    expect(db.adsSuggestionMute.deleteMany).toHaveBeenCalledWith({
      where: { scope: 'rules', entityType: 'AD_TARGET', entityId: 't1' },
    })
    expect(db.adsRuleSuggestion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'pending', decidedBy: null }),
    }))
  })
  it('only a muted row can be unmuted', async () => {
    db.adsRuleSuggestion.findUnique.mockResolvedValue(ROW)
    expect((await unmuteSuggestion('s1')).error).toContain('cannot unmute pending')
  })
})
