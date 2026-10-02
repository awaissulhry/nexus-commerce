/** P11 — revoke one Claude connection (OWNER only): its very next call is refused. */
import { NextResponse } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, OWNER_ROLE_KEY } from "@/lib/auth/permissions";
import { revokeAccessToken } from "@/lib/claude/tokens";

export const permission = FEATURES.integrationsManage;

export const DELETE = guarded(FEATURES.integrationsManage, async (_req, { actor, params }) => {
  if (!actor!.roleKeys.includes(OWNER_ROLE_KEY)) {
    return NextResponse.json({ error: "Only an owner can manage Claude connections.", code: "owner_required" }, { status: 403 });
  }
  const { id } = await params;
  const revoked = await revokeAccessToken(id, actor!.id);
  if (!revoked) return NextResponse.json({ error: "No such active connection." }, { status: 404 });
  return NextResponse.json({ ok: true });
});
