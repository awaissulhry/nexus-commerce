/**
 * FP1.2 — save an attachment into Drive under the party's folder (created
 * lazily beneath the "Nexus Factory" root; folder ids cached in AppSetting
 * `drive.folders`). Stores driveFileId + webViewLink on the attachment.
 */
import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { google } from "googleapis";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { fetchAttachmentBytes } from "@/lib/google/gmail-body";
import { getAuthedClient } from "@/lib/google/oauth";

export const permission = PAGES.inbox;

const FOLDER_MAP_KEY = "drive.folders";

export const POST = guarded(PAGES.inbox, async (_req, { params, actor }) => {
  const { id, attId } = await params;
  const att = await prisma.attachment.findUnique({
    where: { id: attId },
    include: { message: { select: { conversationId: true, conversation: { select: { party: { select: { id: true, name: true } } } } } } },
  });
  if (!att || att.message?.conversationId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (att.driveFileId && att.webViewLink) {
    return NextResponse.json({ ok: true, webViewLink: att.webViewLink, existing: true });
  }

  const authed = await getAuthedClient();
  if (!authed) return NextResponse.json({ error: "Google not connected" }, { status: 400 });
  const connection = await prisma.googleConnection.findFirst({ where: { email: authed.email } });
  if (!connection?.driveRootFolderId) {
    return NextResponse.json({ error: "Create the Nexus Factory Drive folder first (Settings › Integrations)" }, { status: 400 });
  }
  const drive = google.drive({ version: "v3", auth: authed.client });

  const party = att.message.conversation?.party ?? null;
  const folderKey = party?.id ?? "unfiled";
  const folderName = party?.name ?? "Unfiled";
  const mapRow = await prisma.appSetting.findUnique({ where: { key: FOLDER_MAP_KEY } });
  const map = ((mapRow?.value as Record<string, string>) ?? {});
  let folderId = map[folderKey];
  if (!folderId) {
    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [connection.driveRootFolderId],
      },
      fields: "id",
    });
    folderId = folder.data.id!;
    await prisma.appSetting.upsert({
      where: { key: FOLDER_MAP_KEY },
      create: { key: FOLDER_MAP_KEY, value: { ...map, [folderKey]: folderId } },
      update: { value: { ...map, [folderKey]: folderId } },
    });
  }

  const fetched = await fetchAttachmentBytes(attId);
  if (!fetched) return NextResponse.json({ error: "Attachment unavailable from Gmail" }, { status: 502 });

  const uploaded = await drive.files.create({
    requestBody: { name: att.filename, parents: [folderId] },
    media: { mimeType: fetched.mimeType, body: Readable.from(fetched.content) },
    fields: "id, webViewLink",
  });

  await prisma.attachment.update({
    where: { id: attId },
    data: { driveFileId: uploaded.data.id, webViewLink: uploaded.data.webViewLink },
  });
  void audit({
    actorId: actor!.id, entityType: "conversation", entityId: id, action: "attachment.saved_to_drive",
    after: { filename: att.filename, folder: folderName },
  });

  return NextResponse.json({ ok: true, webViewLink: uploaded.data.webViewLink });
});
