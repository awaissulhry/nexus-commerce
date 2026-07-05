/** F1 — disconnect Google: mark the connection disconnected (tokens kept encrypted until re-connect overwrites them; revoke fully at myaccount.google.com/permissions). */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { publishEvent } from "@/lib/events";

export const permission = FEATURES.integrationsManage;

export const POST = guarded(FEATURES.integrationsManage, async (_req, { actor }) => {
  await prisma.googleConnection.updateMany({ data: { status: "disconnected" } });
  void audit({ actorId: actor!.id, entityType: "integration", entityId: "google", action: "disconnected" });
  publishEvent("integration.changed", { provider: "google" });
  return NextResponse.json({ ok: true });
});
