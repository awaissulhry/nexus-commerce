/**
 * F1 — the connect-a-courier wizard backend (Sendcloud own-contract shape:
 * one credential form → test call → live). GET lists connections (never the
 * credentials), POST validates + probes + stores encrypted, DELETE removes.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { publishEvent } from "@/lib/events";
import { encryptSecret } from "@/lib/vault";
import { CONNECTORS } from "@/lib/carriers/sendcloud";

export const permission = FEATURES.integrationsManage;

export const GET = guarded(FEATURES.integrationsManage, async () => {
  const accounts = await prisma.carrierAccount.findMany({ // bounded: carrier accounts: a handful of rows
    select: { id: true, adapterId: true, label: true, caps: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ accounts, available: Object.values(CONNECTORS).map((c) => ({ id: c.id, name: c.name })) });
});

const Body = z.object({
  adapterId: z.string().min(1),
  publicKey: z.string().min(4),
  secretKey: z.string().min(4),
});

export const POST = guarded(FEATURES.integrationsManage, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "adapterId, publicKey, secretKey required" }, { status: 400 });
  const connector = CONNECTORS[parsed.data.adapterId];
  if (!connector) return NextResponse.json({ error: `Unknown carrier adapter "${parsed.data.adapterId}"` }, { status: 400 });

  const probe = await connector.validateAndProbe({
    publicKey: parsed.data.publicKey,
    secretKey: parsed.data.secretKey,
  });
  if (!probe.ok) {
    return NextResponse.json({ error: "Validation failed", probe }, { status: 422 });
  }

  const account = await prisma.carrierAccount.create({
    data: {
      adapterId: connector.id,
      label: probe.accountLabel ?? connector.name,
      credentialsEncrypted: encryptSecret(JSON.stringify({
        publicKey: parsed.data.publicKey,
        secretKey: parsed.data.secretKey,
      })),
      caps: probe.caps as never,
      status: "connected",
    },
  });
  void audit({ actorId: actor!.id, entityType: "integration", entityId: account.id, action: "carrier.connected", after: { adapter: connector.id, label: account.label } });
  publishEvent("integration.changed", { provider: connector.id });
  return NextResponse.json({ ok: true, account: { id: account.id, label: account.label, caps: probe.caps }, probe }, { status: 201 });
});

export const DELETE = guarded(FEATURES.integrationsManage, async (req: NextRequest, { actor }) => {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.carrierAccount.delete({ where: { id } }).catch(() => {});
  void audit({ actorId: actor!.id, entityType: "integration", entityId: id, action: "carrier.disconnected" });
  publishEvent("integration.changed", { provider: "carrier" });
  return NextResponse.json({ ok: true });
});
