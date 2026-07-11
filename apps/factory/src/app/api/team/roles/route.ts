/**
 * FP11.2 — roles: the permission catalog + every role (system + custom) with its
 * grants and member count; create / edit / delete custom roles through the
 * guardrail-checked team service (system roles immutable; a role with members
 * can't be deleted; unknown permissions rejected).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, permissionCatalog } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { createRole, editRole, deleteRole } from "@/lib/auth/team-service";
import { GuardrailError } from "@/lib/auth/guardrails";

export const permission = FEATURES.rolesManage;

export const GET = guarded(FEATURES.rolesManage, async () => {
  const roles = await prisma.role.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }], select: { id: true, key: true, name: true, description: true, isSystem: true, permissions: true, _count: { select: { assignments: true } } } }); // bounded: role registry is config-sized
  return NextResponse.json({
    catalog: permissionCatalog(),
    roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem, permissions: (r.permissions as string[]) ?? [], memberCount: r._count.assignments })),
  });
});

const Create = z.object({ name: z.string().trim().min(1).max(40), permissions: z.array(z.string()) });
const Patch = z.object({ roleId: z.string().min(1), name: z.string().trim().min(1).max(40).optional(), permissions: z.array(z.string()).optional() });

export const POST = guarded(FEATURES.rolesManage, async (req, { actor }) => {
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A name and permissions are required" }, { status: 400 });
  try {
    const role = await createRole(parsed.data.name, parsed.data.permissions);
    void audit({ actorId: actor!.id, entityType: "role", entityId: role.id, action: "role-created", after: { name: parsed.data.name, count: parsed.data.permissions.length } });
    await publishEventDurable("team.updated"); // FS2 — no silent mutations
    return NextResponse.json({ ok: true, id: role.id }, { status: 201 });
  } catch (e) { return e instanceof GuardrailError ? NextResponse.json({ error: e.message }, { status: 400 }) : Promise.reject(e); }
});

export const PATCH = guarded(FEATURES.rolesManage, async (req, { actor }) => {
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "roleId required" }, { status: 400 });
  try {
    await editRole(parsed.data.roleId, { name: parsed.data.name, permissions: parsed.data.permissions });
    void audit({ actorId: actor!.id, entityType: "role", entityId: parsed.data.roleId, action: "role-edited" });
    await publishEventDurable("team.updated"); // FS2 — no silent mutations
    return NextResponse.json({ ok: true });
  } catch (e) { return e instanceof GuardrailError ? NextResponse.json({ error: e.message }, { status: 400 }) : Promise.reject(e); }
});

export const DELETE = guarded(FEATURES.rolesManage, async (req, { actor }) => {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    await deleteRole(id);
    void audit({ actorId: actor!.id, entityType: "role", entityId: id, action: "role-deleted" });
    await publishEventDurable("team.updated"); // FS2 — no silent mutations
    return NextResponse.json({ ok: true });
  } catch (e) { return e instanceof GuardrailError ? NextResponse.json({ error: e.message }, { status: 400 }) : Promise.reject(e); }
});
