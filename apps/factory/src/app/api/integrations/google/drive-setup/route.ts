/**
 * F1 — Drive connect (FD4): create the "Nexus Factory" root folder (per-party
 * / per-order subfolders are created lazily by later cycles) and store its id.
 * drive.file scope: we only ever see files this app creates.
 */
import { NextResponse } from "next/server";
import { google } from "googleapis";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { getAuthedClient } from "@/lib/google/oauth";

export const permission = FEATURES.integrationsManage;

export const POST = guarded(FEATURES.integrationsManage, async (_req, { actor }) => {
  const authed = await getAuthedClient();
  if (!authed) return NextResponse.json({ error: "Google not connected" }, { status: 400 });
  const connection = await prisma.googleConnection.findFirst({ where: { email: authed.email } });
  if (connection?.driveRootFolderId) {
    return NextResponse.json({ ok: true, folderId: connection.driveRootFolderId, existing: true });
  }
  const drive = google.drive({ version: "v3", auth: authed.client });
  const folder = await drive.files.create({
    requestBody: { name: "Nexus Factory", mimeType: "application/vnd.google-apps.folder" },
    fields: "id, webViewLink",
  });
  await prisma.googleConnection.updateMany({
    where: { email: authed.email },
    data: { driveRootFolderId: folder.data.id! },
  });
  void audit({ actorId: actor!.id, entityType: "integration", entityId: "google", action: "drive.setup", after: { folderId: folder.data.id } });
  return NextResponse.json({ ok: true, folderId: folder.data.id, webViewLink: folder.data.webViewLink });
});
