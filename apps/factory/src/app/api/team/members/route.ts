/**
 * FP11.1 — team members: list who's on the platform (role, last login), and
 * reassign a role or deactivate — every write through the guardrail-checked team
 * service (the last owner can't be demoted or switched off).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { assignRole, setStatus } from "@/lib/auth/team-service";
import { GuardrailError } from "@/lib/auth/guardrails";

export const permission = FEATURES.usersManage;

export const GET = guarded(FEATURES.usersManage, async (_req, { actor }) => {
  const [users, roles] = await Promise.all([
    prisma.user.findMany({ // bounded: team-sized table
      orderBy: { createdAt: "asc" },
      select: { id: true, displayName: true, email: true, status: true, lastLoginAt: true, roleAssignments: { select: { role: { select: { id: true, key: true, name: true } } } } },
    }),
    prisma.role.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }], select: { id: true, key: true, name: true, isSystem: true } }), // bounded: team-sized table
  ]);
  const members = users.map((u) => ({
    id: u.id, displayName: u.displayName, email: u.email, status: u.status, lastLoginAt: u.lastLoginAt,
    roleId: u.roleAssignments[0]?.role.id ?? null, roleKey: u.roleAssignments[0]?.role.key ?? null, roleName: u.roleAssignments[0]?.role.name ?? "—",
    isYou: u.id === actor!.id,
  }));
  return NextResponse.json({ members, roles });
});

const Patch = z.object({ userId: z.string().min(1), roleId: z.string().optional(), status: z.enum(["active", "deactivated"]).optional() });

export const PATCH = guarded(FEATURES.usersManage, async (req, { actor, resolved }) => {
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "userId + roleId or status required" }, { status: 400 });
  const { userId, roleId, status } = parsed.data;
  try {
    if (roleId) {
      await assignRole(!!resolved?.isOwner, userId, roleId, actor!.id);
      void audit({ actorId: actor!.id, entityType: "user", entityId: userId, action: "role-assigned", after: { roleId } });
      await publishEventDurable("team.updated"); // FS2 — no silent mutations
    }
    if (status) {
      await setStatus(userId, status);
      void audit({ actorId: actor!.id, entityType: "user", entityId: userId, action: `user-${status}` });
      await publishEventDurable("team.updated"); // FS2 — no silent mutations
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof GuardrailError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
});
