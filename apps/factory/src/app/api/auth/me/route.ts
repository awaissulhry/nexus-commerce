/**
 * F1 — the one round-trip that powers all client gating (S3 /me contract):
 * { user, isOwner, permissions } — permissions is the expanded effective set,
 * or literally ["*"] for owners. Anonymous callers get { user: null }.
 */
import { NextResponse } from "next/server";
import { guarded, PUBLIC } from "@/lib/auth/guard";

export const permission = PUBLIC;

export const GET = guarded(PUBLIC, async (_req, { actor, resolved }) => {
  if (!actor || !resolved) return NextResponse.json({ user: null });
  return NextResponse.json({
    user: {
      id: actor.id,
      email: actor.email,
      displayName: actor.displayName,
      roleKeys: actor.roleKeys,
    },
    isOwner: resolved.isOwner,
    permissions: resolved.isOwner ? ["*"] : [...resolved.permissions],
  });
});
