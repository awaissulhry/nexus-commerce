/**
 * Phase 6 guardrail — one campaign lives in one rank schedule. Saving a group rebinds any campaign
 * that already belongs to ANOTHER group (the backend moves its execution row), which would silently
 * pull it out of that other schedule. This pure helper flags those campaigns so the builder can warn
 * before saving. No React/DB — unit-tested in scheduleConflicts.vitest.test.ts.
 */
export interface Membership { groupId: string; groupName: string }
export type MembershipMap = Record<string, Membership>
export interface ScheduleConflict { campaignId: string; groupId: string; groupName: string }

/**
 * Campaigns in the selection that are currently held by a DIFFERENT group than the one being edited.
 * A campaign already in THIS group (currentGroupId) is not a conflict — it's staying put.
 */
export function detectScheduleConflicts(
  selectedCampaignIds: string[],
  memberships: MembershipMap,
  currentGroupId?: string,
): ScheduleConflict[] {
  const out: ScheduleConflict[] = []
  const seen = new Set<string>()
  for (const id of selectedCampaignIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const m = memberships[id]
    if (m && m.groupId && m.groupId !== currentGroupId) {
      out.push({ campaignId: id, groupId: m.groupId, groupName: m.groupName })
    }
  }
  return out
}
