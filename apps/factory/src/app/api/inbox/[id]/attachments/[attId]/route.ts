/**
 * FP1.2 — attachment download: Gmail fetch → local cache
 * (data/attachments/<attId>/<filename>) → stream. Ownership is checked
 * against the conversation in the URL.
 * EPI2.1 — `?inline=1` streams previewable types (raster images + PDF, the
 * previewKind allowlist) with an inline disposition for the lightbox and
 * chip thumbnails; everything else keeps forced-download regardless.
 */
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { fetchAttachmentBytes } from "@/lib/google/gmail-body";
import { previewKind } from "@/lib/inbox/preview";

export const permission = PAGES.inbox;

export const GET = guarded(PAGES.inbox, async (req: NextRequest, { params }) => {
  const { id, attId } = await params;
  const att = await prisma.attachment.findUnique({
    where: { id: attId },
    include: { message: { select: { conversationId: true } } },
  });
  // EPI2.4 — ownership: via the carrying message, OR via a comment on this
  // conversation (comment attachments have no message).
  let owned = att?.message?.conversationId === id;
  if (att && !owned && att.entityType === "comment" && att.entityId) {
    const comment = await prisma.comment.findUnique({
      where: { id: att.entityId },
      select: { entityType: true, entityId: true },
    });
    owned = comment?.entityType === "conversation" && comment.entityId === id;
  }
  if (!att || !owned) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let filePath = att.localPath;
  if (!filePath || !fs.existsSync(filePath)) {
    const fetched = await fetchAttachmentBytes(attId);
    if (!fetched) return NextResponse.json({ error: "Attachment unavailable from Gmail" }, { status: 502 });
    const dir = path.join(process.cwd(), "data", "attachments", attId);
    fs.mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, att.filename.replace(/[/\\]/g, "_"));
    fs.writeFileSync(filePath, fetched.content);
    await prisma.attachment.update({ where: { id: attId }, data: { localPath: filePath } });
  }

  const bytes = fs.readFileSync(filePath);
  // EPI2.1 — inline only for the allowlist; the filename in the header is
  // encoded, and non-previewable types force download even with ?inline=1.
  const wantsInline = req.nextUrl.searchParams.get("inline") === "1";
  const inline = wantsInline && previewKind(att.mimeType) !== "none";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": inline ? att.mimeType! : (att.mimeType ?? "application/octet-stream"),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(att.filename)}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=3600",
    },
  });
});
