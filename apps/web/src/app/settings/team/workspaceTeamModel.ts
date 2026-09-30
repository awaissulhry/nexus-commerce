/**
 * Who may change the team on Team & Access (business profiles on).
 *
 * The API shows the team to an owner and to a member whose roles here grant `users.manage` — the permission the
 * web asks before it opens this page — and keeps every change owner-only (apps/api/src/services/workspace.service.ts,
 * `listMembers`). Its answer says which: `canManage` is true for an owner only.
 */

/** The owner-only note a member who may see the team, but not change it, reads above the team. */
export const OWNER_ONLY_TEAM_NOTE = 'You can see this team. Only an owner of this business profile can invite members, change their access or edit roles.'

/**
 * Whether the page offers the owner-only changes. An answer without `canManage` comes from an API that served the
 * team to owners alone, so it means an owner; an explicit `false` is a member who may only read.
 */
export function canManageTeam(roster: { canManage?: unknown } | null | undefined): boolean {
  return !!roster && roster.canManage !== false
}
