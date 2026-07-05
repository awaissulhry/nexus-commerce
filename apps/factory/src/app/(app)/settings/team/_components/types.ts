/** FP11 — team & roles workspace shapes. */
export type Member = { id: string; displayName: string; email: string; status: string; lastLoginAt: string | null; roleId: string | null; roleKey: string | null; roleName: string; isYou: boolean };
export type RoleLite = { id: string; key: string; name: string; isSystem: boolean };
export type MembersResponse = { members: Member[]; roles: RoleLite[] };
export type Invitation = { id: string; email: string; roleName: string; expiresAt: string; createdAt: string };
export type InvitationsResponse = { invitations: Invitation[] };

export type PermItem = { key: string; label: string };
export type PermGroup = { module: string; label: string; layer: "page" | "feature" | "field"; items: PermItem[] };
export type RoleFull = { id: string; key: string; name: string; description: string | null; isSystem: boolean; permissions: string[]; memberCount: number };
export type RolesResponse = { catalog: PermGroup[]; roles: RoleFull[] };
