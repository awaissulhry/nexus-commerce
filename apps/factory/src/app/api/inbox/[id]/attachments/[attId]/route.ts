/**
 * FP1.2 — attachment download: Gmail fetch → local cache
 * (data/attachments/<attId>/<filename>) → stream. Ownership is checked
 * against the conversation in the URL.
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { fetchAttachmentBytes } from "@/lib/google/gmail-body";

export const permission = PAGES.inbox;

export const GET = guarded(PAGES.inbox, async (_req, { params }) => {
  const { id, attId } = await params;
  const att = await prisma.attachment.findUnique({
    where: { id: attId },
    include: { message: { select: { conversationId: true } } },
  });
  if (!att || att.message?.conversationId !== id) {
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
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": att.mimeType ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(att.filename)}"`,
      "Content-Length": String(bytes.byteLength),
    },
  });
});
