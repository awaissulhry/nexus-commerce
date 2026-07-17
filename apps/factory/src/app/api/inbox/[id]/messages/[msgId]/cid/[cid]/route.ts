/**
 * EPI2.1 — cid: inline-image resolver (closes the FP1 gap + backlog item,
 * migration-free). The stored sanitized HTML keeps `src="cid:…"`; the bubble
 * rewrites those to this route, which resolves the Content-ID against the
 * Gmail message's MIME parts live, caches the bytes under
 * data/attachments/cid/<msgId>/, and streams inline. Raster images only —
 * anything else 404s (same XSS posture as the ?inline=1 allowlist).
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { google, type gmail_v1 } from "googleapis";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { getAuthedClient } from "@/lib/google/oauth";
import { cidCacheName, matchesContentId, previewKind } from "@/lib/inbox/preview";

export const permission = PAGES.inbox;

type CidPart = { attachmentId: string; mimeType: string };

function findCidPart(payload: gmail_v1.Schema$MessagePart | undefined, cid: string): CidPart | null {
  if (!payload) return null;
  const header = payload.headers?.find((h) => h.name?.toLowerCase() === "content-id")?.value;
  if (matchesContentId(header, cid) && payload.body?.attachmentId) {
    return { attachmentId: payload.body.attachmentId, mimeType: payload.mimeType ?? "application/octet-stream" };
  }
  for (const child of payload.parts ?? []) {
    const hit = findCidPart(child, cid);
    if (hit) return hit;
  }
  return null;
}

export const GET = guarded(PAGES.inbox, async (_req, { params }) => {
  const { id, msgId, cid: rawCid } = await params;
  const cid = decodeURIComponent(rawCid);

  const message = await prisma.message.findUnique({
    where: { id: msgId },
    select: { conversationId: true, gmailMessageId: true },
  });
  if (!message || message.conversationId !== id || !message.gmailMessageId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const dir = path.join(process.cwd(), "data", "attachments", "cid", msgId);
  const base = path.join(dir, cidCacheName(cid));
  const metaPath = `${base}.meta.json`;

  let mimeType: string | null = null;
  if (fs.existsSync(base) && fs.existsSync(metaPath)) {
    try {
      mimeType = (JSON.parse(fs.readFileSync(metaPath, "utf8")) as { mimeType?: string }).mimeType ?? null;
    } catch {
      mimeType = null;
    }
  }

  if (!mimeType) {
    const authed = await getAuthedClient();
    if (!authed) return NextResponse.json({ error: "Google not connected" }, { status: 502 });
    const gmail = google.gmail({ version: "v1", auth: authed.client });
    const full = await gmail.users.messages.get({ userId: "me", id: message.gmailMessageId, format: "full" });
    const part = findCidPart(full.data.payload, cid);
    if (!part) return NextResponse.json({ error: "Inline image not found" }, { status: 404 });
    if (previewKind(part.mimeType) !== "image") {
      return NextResponse.json({ error: "Not an inline image" }, { status: 404 });
    }
    const attachment = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: message.gmailMessageId,
      id: part.attachmentId,
    });
    if (!attachment.data.data) return NextResponse.json({ error: "Inline image unavailable" }, { status: 502 });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(base, Buffer.from(attachment.data.data, "base64url"));
    fs.writeFileSync(metaPath, JSON.stringify({ mimeType: part.mimeType }));
    mimeType = part.mimeType;
  }

  if (previewKind(mimeType) !== "image") return NextResponse.json({ error: "Not an inline image" }, { status: 404 });
  const bytes = fs.readFileSync(base);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": "inline",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=86400",
    },
  });
});
