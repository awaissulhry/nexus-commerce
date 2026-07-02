/**
 * Phase 6 — unit tests for the schedule-conflict guardrail. Pure function, no DB/network.
 * Run via `npx vitest run scheduleConflicts`.
 */
import { describe, it, expect } from 'vitest'
import { detectScheduleConflicts, type MembershipMap } from './scheduleConflicts'

const memberships: MembershipMap = {
  c1: { groupId: 'gA', groupName: 'GALE Performance' },
  c2: { groupId: 'gA', groupName: 'GALE Performance' },
  c3: { groupId: 'gB', groupName: 'Misano schedule' },
  // c4, c5 are ungrouped (absent from the map)
}

describe('detectScheduleConflicts', () => {
  it('flags campaigns held by a DIFFERENT group', () => {
    const out = detectScheduleConflicts(['c1', 'c3', 'c4'], memberships, undefined)
    expect(out).toEqual([
      { campaignId: 'c1', groupId: 'gA', groupName: 'GALE Performance' },
      { campaignId: 'c3', groupId: 'gB', groupName: 'Misano schedule' },
    ])
  })

  it('does NOT flag campaigns already in the group being edited', () => {
    // Editing gA: c1/c2 are staying put, only c3 (in gB) is a conflict.
    const out = detectScheduleConflicts(['c1', 'c2', 'c3'], memberships, 'gA')
    expect(out).toEqual([{ campaignId: 'c3', groupId: 'gB', groupName: 'Misano schedule' }])
  })

  it('returns nothing for wholly ungrouped selections', () => {
    expect(detectScheduleConflicts(['c4', 'c5'], memberships, undefined)).toEqual([])
  })

  it('returns nothing for an empty selection', () => {
    expect(detectScheduleConflicts([], memberships, 'gA')).toEqual([])
  })

  it('de-dupes a campaign id that appears twice', () => {
    const out = detectScheduleConflicts(['c1', 'c1'], memberships, undefined)
    expect(out).toEqual([{ campaignId: 'c1', groupId: 'gA', groupName: 'GALE Performance' }])
  })

  it('treats a campaign in the edited group as safe even if listed twice', () => {
    expect(detectScheduleConflicts(['c1', 'c1'], memberships, 'gA')).toEqual([])
  })
})
