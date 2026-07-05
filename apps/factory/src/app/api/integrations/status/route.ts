/**
 * F1 — one round-trip for the Settings › Integrations page: Google connection
 * (+ Drive quota when connected), carrier accounts, sync freshness. Secrets
 * never leave the server; only presence/metadata.
 */
import { NextResponse } from "next/server";
import { google } from "googleapis";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { getAuthedClient, getOauthClientConfig } from "@/lib/google/oauth";

export const permission = FEATURES.integrationsManage;

export const GET = guarded(FEATURES.integrationsManage, async () => {
  const config = await getOauthClientConfig();
  const connection = await prisma.googleConnection.findFirst({ orderBy: { updatedAt: "desc" } });

  let drive: { usedBytes: number; limitBytes: number | null } | null = null;
  if (connection?.status === "connected") {
    try {
      const authed = await getAuthedClient();
      if (authed) {
        const about = await google.drive({ version: "v3", auth: authed.client }).about.get({ fields: "storageQuota" });
        const q = about.data.storageQuota;
        drive = { usedBytes: Number(q?.usage ?? 0), limitBytes: q?.limit ? Number(q.limit) : null };
      }
    } catch {
      drive = null;
    }
  }

  const [conversations, messages, carriers, recent] = await Promise.all([
    prisma.conversation.count(),
    prisma.message.count(),
    prisma.carrierAccount.findMany({
      select: { id: true, adapterId: true, label: true, caps: true, status: true },
    }),
    prisma.conversation.findMany({
      orderBy: { lastMessageAt: "desc" },
      take: 8,
      select: {
        id: true,
        subject: true,
        lastMessageAt: true,
        party: { select: { name: true, kind: true } },
      },
    }),
  ]);

  return NextResponse.json({
    google: {
      configSaved: !!config,
      clientId: config?.clientId ?? null, // public identifier by definition; shown so a wrong paste is visible + replaceable
      status: connection?.status ?? "not_connected",
      email: connection?.email ?? null,
      labelName: connection?.labelName ?? null,
      lastSyncAt: connection?.lastSyncAt ?? null,
      lastError: connection?.lastError ?? null,
      driveRootFolderId: connection?.driveRootFolderId ?? null,
      drive,
    },
    sync: { conversations, messages, recent },
    carriers,
  });
});
