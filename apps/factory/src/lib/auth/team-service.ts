/**
 * FP11 — the ONLY sanctioned path for team mutations. Every write consults the
 * F1 Owner-supremacy guardrails first, then bumps `permissionsVersion` so a live
 * session re-resolves its grants. Invitations use the session-token shape (raw
 * token in the link, sha256 stored). Not accounting, not auth theatre — just the
 * small set of moves an Owner needs to run the shop.
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db";
import { hashPassword } from "./password";
import { OWNER_ROLE_KEY } from "./permissions";
import { assertOwnerGrant, assertNotLastOwner, assertNotSystemRole, assertRoleUnused, assertKnownPermissions, GuardrailError } from "./guardrails";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function activeOwnerCount(): Promise<number> {
  return prisma.user.count({ where: { status: "active", roleAssignments: { some: { role: { key: OWNER_ROLE_KEY } } } } });
}

async function userIsActiveOwner(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { status: true, roleAssignments: { select: { role: { select: { key: true } } } } } });
  return !!u && u.status === "active" && u.roleAssignments.some((r) => r.role.key === OWNER_ROLE_KEY);
}

/** Set a user's single role (v1: one role per user). Guardrail-checked. */
export async function assignRole(actorIsOwner: boolean, targetUserId: string, roleId: string, grantedByUserId: string): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, key: true } });
  if (!role) throw new GuardrailError("unknown_permission", "Role not found");
  assertOwnerGrant(actorIsOwner, role.key);
  if (role.key !== OWNER_ROLE_KEY && (await userIsActiveOwner(targetUserId))) {
    assertNotLastOwner((await activeOwnerCount()) - 1); // this change demotes an owner
  }
  await prisma.$transaction([
    prisma.userRole.deleteMany({ where: { userId: targetUserId } }),
    prisma.userRole.create({ data: { userId: targetUserId, roleId, grantedByUserId } }),
    prisma.user.update({ where: { id: targetUserId }, data: { permissionsVersion: { increment: 1 } } }),
  ]);
}

export async function setStatus(targetUserId: string, status: "active" | "deactivated"): Promise<void> {
  if (status === "deactivated" && (await userIsActiveOwner(targetUserId))) {
    assertNotLastOwner((await activeOwnerCount()) - 1);
  }
  await prisma.user.update({ where: { id: targetUserId }, data: { status, permissionsVersion: { increment: 1 } } });
  if (status === "deactivated") await prisma.session.updateMany({ where: { userId: targetUserId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Create an invitation; returns the RAW token (shown once, for the join link). */
export async function invite(email: string, roleId: string, invitedByUserId: string): Promise<{ id: string; token: string }> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true } });
  if (!role) throw new GuardrailError("unknown_permission", "Role not found");
  if (await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } })) {
    throw new GuardrailError("role_in_use", "That email is already a member");
  }
  const token = randomBytes(24).toString("hex");
  const inv = await prisma.invitation.create({
    data: { email: email.toLowerCase(), roleId, tokenHash: sha256(token), invitedByUserId, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    select: { id: true },
  });
  return { id: inv.id, token };
}

export async function revokeInvite(id: string): Promise<void> {
  await prisma.invitation.updateMany({ where: { id, acceptedAt: null }, data: { revokedAt: new Date() } });
}

export type InviteView = { email: string; roleName: string } | null;

export async function validateInvite(token: string): Promise<InviteView> {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(token) }, select: { email: true, expiresAt: true, revokedAt: true, acceptedAt: true, role: { select: { name: true } } } });
  if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt.getTime() < Date.now()) return null;
  return { email: inv.email, roleName: inv.role.name };
}

/** Accept an invite: create the User + UserRole for the invited role. Returns the new user id. */
export async function acceptInvite(token: string, displayName: string, password: string): Promise<{ userId: string }> {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(token) }, select: { id: true, email: true, roleId: true, expiresAt: true, revokedAt: true, acceptedAt: true } });
  if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt.getTime() < Date.now()) throw new GuardrailError("role_in_use", "This invitation is no longer valid");
  if (password.length < 8) throw new GuardrailError("unknown_permission", "Password must be at least 8 characters");
  if (await prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } })) throw new GuardrailError("role_in_use", "That email is already a member");

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({ data: { email: inv.email, displayName: displayName.trim() || inv.email, passwordHash: hashPassword(password), status: "active" }, select: { id: true } });
    await tx.userRole.create({ data: { userId: u.id, roleId: inv.roleId, grantedByUserId: null } });
    await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
    return u;
  });
  return { userId: user.id };
}

// ── custom roles (FP11.2) ────────────────────────────────────────
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "role";

export async function createRole(name: string, permissions: string[]): Promise<{ id: string }> {
  assertKnownPermissions(permissions);
  const key = `${slug(name)}-${randomBytes(2).toString("hex")}`; // stable, unique, never a system key
  const role = await prisma.role.create({ data: { key, name: name.trim(), permissions, isSystem: false }, select: { id: true } });
  return role;
}

export async function editRole(roleId: string, patch: { name?: string; permissions?: string[] }): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { isSystem: true } });
  if (!role) throw new GuardrailError("unknown_permission", "Role not found");
  assertNotSystemRole(role.isSystem);
  if (patch.permissions) assertKnownPermissions(patch.permissions);
  await prisma.role.update({ where: { id: roleId }, data: { ...(patch.name ? { name: patch.name.trim() } : {}), ...(patch.permissions ? { permissions: patch.permissions } : {}) } });
  // members of this role must re-resolve their grants
  await prisma.user.updateMany({ where: { roleAssignments: { some: { roleId } } }, data: { permissionsVersion: { increment: 1 } } });
}

export async function deleteRole(roleId: string): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { isSystem: true, _count: { select: { assignments: true } } } });
  if (!role) throw new GuardrailError("unknown_permission", "Role not found");
  assertNotSystemRole(role.isSystem);
  assertRoleUnused(role._count.assignments);
  await prisma.role.delete({ where: { id: roleId } });
}
