/**
 * FP11.1 — invitations: pending list, create (returns the one-time join link),
 * revoke. The Owner shares the link (email lands later); the invitee accepts at
 * /join/[token]. Behind users.manage.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { invite, revokeInvite } from "@/lib/auth/team-service";
import { GuardrailError } from "@/lib/auth/guardrails";

export const permission = FEATURES.usersManage;

export const GET = guarded(FEATURES.usersManage, async () => {
  const invitations = await prisma.invitation.findMany({ // bounded: team-sized table
    where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, expiresAt: true, createdAt: true, role: { select: { name: true } } },
  });
  return NextResponse.json({ invitations: invitations.map((i) => ({ id: i.id, email: i.email, roleName: i.role.name, expiresAt: i.expiresAt, createdAt: i.createdAt })) });
});

const Body = z.object({ email: z.string().email(), roleId: z.string().min(1) });

export const POST = guarded(FEATURES.usersManage, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid email and a role are required" }, { status: 400 });
  try {
    const { id, token } = await invite(parsed.data.email, parsed.data.roleId, actor!.id);
    const base = process.env.FACTORY_PUBLIC_URL || req.nextUrl.origin;
    void audit({ actorId: actor!.id, entityType: "invitation", entityId: id, action: "invited", after: { email: parsed.data.email } });
    return NextResponse.json({ ok: true, id, joinUrl: `${base}/join/${token}` }, { status: 201 });
  } catch (e) {
    if (e instanceof GuardrailError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
});

export const DELETE = guarded(FEATURES.usersManage, async (req, { actor }) => {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await revokeInvite(id);
  void audit({ actorId: actor!.id, entityType: "invitation", entityId: id, action: "revoked" });
  return NextResponse.json({ ok: true });
});
