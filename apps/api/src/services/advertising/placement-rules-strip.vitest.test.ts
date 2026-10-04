/**
 * 4e (review 5.1) — the Placement strip counts a rule's lane writes under the actor rules write with today.
 *
 * Rules write as `automation:<ruleId>` (`RULE_ACTOR`) since part 06; the strip still counted only `automation:rule-…`,
 * so it said "no rule did any of it" whatever the rules did. It now matches the exact rule ids, and the old prefix.
 */
import { describe, expect, it, vi } from 'vitest'

const at = new Date()
vi.mock('../../db.js', () => ({
  default: {
    campaign: { findMany: vi.fn(async () => []) },
    adSchedule: { findMany: vi.fn(async () => []) },
    amazonAdsDailyPerformance: { groupBy: vi.fn(async () => []) },
    campaignBidHistory: {
      findMany: vi.fn(async () => [
        { campaignId: 'c1', changedBy: 'automation:cmrule1', changedAt: at }, // today's rule actor
        { campaignId: 'c1', changedBy: 'automation:rule-cmold', changedAt: at }, // the pre-part-06 actor
        { campaignId: 'c2', changedBy: 'automation:rank-defend-s1', changedAt: at }, // the rank loop
        { campaignId: 'c2', changedBy: 'automation:cmnotarule', changedAt: at }, // another engine, not a rule
      ]),
      count: vi.fn(async () => 0),
    },
    automationRule: { findMany: vi.fn(async () => [{ id: 'cmrule1' }]) },
  },
}))

import { getPlacementRulesStrip } from './placement-grid.service.js'

describe('getPlacementRulesStrip — which lane writes came from a rule', () => {
  it('🔴 counts `automation:<ruleId>` and the legacy `automation:rule-` prefix, never the rank loop or another engine', async () => {
    const s = await getPlacementRulesStrip()
    expect(s.engineWrites7d).toBe(4)
    expect(s.ruleWrites7d).toBe(2)
  })
})
