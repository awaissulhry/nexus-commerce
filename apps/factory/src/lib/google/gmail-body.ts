/**
 * FP1.1 — lazy full-body + attachment ingestion. F1 sync stores headers +
 * snippet; the FIRST open of a thread calls ensureBodies(), which fetches
 * `format=full`, walks the MIME tree (prefer text/html, fallback text/plain),
 * sanitizes AT WRITE TIME, stores the RFC Message-ID (reply threading), and
 * registers attachment metadata. Cached forever after (bodies are immutable).
 */
import { google, type gmail_v1 } from "googleapis";
import { prisma } from "@/lib/db";
import { sanitizeEmailHtml, textToHtml } from "@/lib/sanitize-email";
import { getAuthedClient } from "./oauth";

type Extracted = {
  html?: string;
  text?: string;
  attachments: { filename: string; mimeType: string; sizeBytes: number; gmailAttachmentId: string }[];
};

const decode = (data?: string | null) => (data ? Buffer.from(data, "base64url").toString("utf8") : undefined);

export function extractPayload(payload: gmail_v1.Schema$MessagePart | undefined): Extracted {
  const out: Extracted = { attachments: [] };
  const walk = (part?: gmail_v1.Schema$MessagePart) => {
    if (!part) return;
    const mime = part.mimeType ?? "";
    if (part.filename && part.body?.attachmentId) {
      out.attachments.push({
        filename: part.filename,
        mimeType: mime || "application/octet-stream",
        sizeBytes: part.body.size ?? 0,
        gmailAttachmentId: part.body.attachmentId,
      });
    } else if (mime === "text/html" && part.body?.data && out.html === undefined) {
      out.html = decode(part.body.data);
    } else if (mime === "text/plain" && part.body?.data && out.text === undefined) {
      out.text = decode(part.body.data);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

const headerOf = (msg: gmail_v1.Schema$Message, name: string): string | null =>
  msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;

/** Fetch + store bodies for every message in the conversation still missing one. Returns count fetched. */
export async function ensureBodies(conversationId: string): Promise<number> {
  const missing = await prisma.message.findMany({
    where: { conversationId, bodyHtml: null, bodyText: null, gmailMessageId: { not: null } },
    select: { id: true, gmailMessageId: true },
  });
  if (!missing.length) return 0;
  const authed = await getAuthedClient();
  if (!authed) return 0;
  const gmail = google.gmail({ version: "v1", auth: authed.client });

  let fetched = 0;
  for (const row of missing) {
    try {
      const full = await gmail.users.messages.get({ userId: "me", id: row.gmailMessageId!, format: "full" });
      const extracted = extractPayload(full.data.payload);
      const bodyHtml = extracted.html
        ? sanitizeEmailHtml(extracted.html)
        : extracted.text
          ? textToHtml(extracted.text)
          : null;
      await prisma.message.update({
        where: { id: row.id },
        data: {
          bodyHtml,
          bodyText: extracted.text ?? null,
          rfcMessageId: headerOf(full.data, "Message-ID"),
        },
      });
      for (const att of extracted.attachments) {
        const existing = await prisma.attachment.findFirst({
          where: { messageId: row.id, filename: att.filename, sizeBytes: att.sizeBytes },
          select: { id: true },
        });
        if (existing) {
          await prisma.attachment.update({
            where: { id: existing.id },
            data: { gmailAttachmentId: att.gmailAttachmentId },
          });
        } else {
          await prisma.attachment.create({ data: { messageId: row.id, ...att } });
        }
      }
      fetched++;
    } catch (err) {
      console.error("[gmail-body] fetch failed for", row.gmailMessageId, (err as Error).message);
    }
  }
  return fetched;
}

/**
 * Download an attachment's bytes. Gmail attachment ids are VOLATILE — on a
 * 400/404 we refetch the message, refresh the id, and retry once.
 */
export async function fetchAttachmentBytes(attachmentDbId: string): Promise<{ filename: string; mimeType: string; content: Buffer } | null> {
  const att = await prisma.attachment.findUnique({
    where: { id: attachmentDbId },
    include: { message: { select: { gmailMessageId: true } } },
  });
  if (!att?.message?.gmailMessageId) return null;
  const authed = await getAuthedClient();
  if (!authed) return null;
  const gmail = google.gmail({ version: "v1", auth: authed.client });

  const get = async (gmailAttachmentId: string) =>
    gmail.users.messages.attachments.get({
      userId: "me",
      messageId: att.message!.gmailMessageId!,
      id: gmailAttachmentId,
    });

  let dataB64: string | null | undefined;
  try {
    if (!att.gmailAttachmentId) throw Object.assign(new Error("no id"), { code: 404 });
    dataB64 = (await get(att.gmailAttachmentId)).data.data;
  } catch {
    // refresh the volatile id from the message and retry once
    const full = await gmail.users.messages.get({ userId: "me", id: att.message.gmailMessageId, format: "full" });
    const fresh = extractPayload(full.data.payload).attachments.find(
      (a) => a.filename === att.filename && a.sizeBytes === (att.sizeBytes ?? a.sizeBytes),
    );
    if (!fresh) return null;
    await prisma.attachment.update({ where: { id: att.id }, data: { gmailAttachmentId: fresh.gmailAttachmentId } });
    dataB64 = (await get(fresh.gmailAttachmentId)).data.data;
  }
  if (!dataB64) return null;
  return {
    filename: att.filename,
    mimeType: att.mimeType ?? "application/octet-stream",
    content: Buffer.from(dataB64, "base64url"),
  };
}
