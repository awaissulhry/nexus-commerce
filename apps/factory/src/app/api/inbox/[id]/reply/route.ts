/**
 * FP1.2 — reply into the SAME Gmail thread (the golden flow's outbound half).
 * multipart/form-data: `body` (plain text) + `files` (≤15MB total). Threading
 * = threadId param + In-Reply-To/References from the last inbound message's
 * RFC Message-ID + Re: subject — all three, or Gmail forks the thread.
 */
import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { textToHtml } from "@/lib/sanitize-email";
import { ensureBodies } from "@/lib/google/gmail-body";
import { buildReplyMime, replySubject, type MimeAttachment } from "@/lib/google/mime";
import { getAuthedClient } from "@/lib/google/oauth";

export const permission = FEATURES.inboxSend;

const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

export const POST = guarded(FEATURES.inboxSend, async (req: NextRequest, { params, actor }) => {
  const { id } = await params;
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart/form-data expected" }, { status: 400 });
  const body = String(form.get("body") ?? "").trim();
  if (!body) return NextResponse.json({ error: "Reply text is required" }, { status: 400 });

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  let total = 0;
  const attachments: MimeAttachment[] = [];
  for (const file of files) {
    total += file.size;
    if (total > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { error: "Attachments exceed 15 MB — share big files via Drive instead" },
        { status: 413 },
      );
    }
    attachments.push({
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      content: Buffer.from(await file.arrayBuffer()),
    });
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: { id: true, subject: true, gmailThreadId: true },
  });
  if (!conversation?.gmailThreadId) {
    return NextResponse.json({ error: "Not a Gmail conversation" }, { status: 400 });
  }

  await ensureBodies(id).catch(() => {}); // makes rfcMessageId available
  const lastInbound = await prisma.message.findFirst({
    where: { conversationId: id, direction: "INBOUND" },
    orderBy: { sentAt: "desc" },
    select: { fromAddress: true, rfcMessageId: true },
  });
  if (!lastInbound) {
    return NextResponse.json({ error: "Nothing to reply to in this thread yet" }, { status: 400 });
  }

  const authed = await getAuthedClient();
  if (!authed) return NextResponse.json({ error: "Google not connected" }, { status: 400 });
  const gmail = google.gmail({ version: "v1", auth: authed.client });

  const raw = buildReplyMime({
    from: authed.email,
    to: [lastInbound.fromAddress],
    subject: replySubject(conversation.subject ?? ""),
    inReplyTo: lastInbound.rfcMessageId,
    text: body,
    attachments,
  });

  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: conversation.gmailThreadId },
  });

  const now = new Date();
  const message = await prisma.message.create({
    data: {
      conversationId: id,
      gmailMessageId: sent.data.id ?? null,
      direction: "OUTBOUND",
      fromAddress: authed.email.toLowerCase(),
      toAddresses: [lastInbound.fromAddress],
      snippet: body.slice(0, 140),
      bodyText: body,
      bodyHtml: textToHtml(body),
      sentAt: now,
      labels: [],
    },
  });
  await prisma.conversation.update({ where: { id }, data: { lastMessageAt: now, lastMessageDirection: "OUTBOUND" } });

  void audit({
    actorId: actor!.id,
    entityType: "conversation",
    entityId: id,
    action: "replied",
    after: { to: lastInbound.fromAddress, attachments: attachments.map((a) => a.filename) },
  });
  await publishEventDurable("conversation.updated", { id });

  return NextResponse.json({ ok: true, messageId: message.id }, { status: 201 });
});
