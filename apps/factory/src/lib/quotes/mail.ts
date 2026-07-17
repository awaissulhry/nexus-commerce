/**
 * EPQ.2 — the ONE Gmail plumbing for quote email (extracted verbatim from the
 * FP3.3 send route so nudges thread identically to sends): resolve the authed
 * client, pick the recipient (party email, else the thread's last inbound
 * sender), build the threaded reply MIME (In-Reply-To/References + Re: subject
 * + threadId — all three, F0-ARCHITECTURE §Gmail), send, then record the
 * OUTBOUND Message and bump the conversation. Errors return {ok:false} with
 * the exact user-facing strings the send route always used — the caller
 * decides what (if anything) to persist, so a failed send never records state.
 */
import { google } from "googleapis";
import { prisma } from "@/lib/db";
import { buildReplyMime, replySubject, type MimeAttachment } from "@/lib/google/mime";
import { getAuthedClient } from "@/lib/google/oauth";

export type QuoteMailResult =
  | { ok: true; recipient: string; gmailMessageId: string | null; sentAt: Date }
  | { ok: false; status: number; error: string };

export async function sendQuoteMail(input: {
  conversation: { id: string; subject: string | null; gmailThreadId: string | null } | null;
  /** the party's email on file (may be null when a linked thread can supply one) */
  partyEmail: string | null;
  /** subject when there is no linked thread (threaded sends use `Re: <subject>`) */
  fallbackSubject: string;
  text: string;
  /** snippet for the optimistic OUTBOUND Message row */
  snippet: string;
  attachments?: MimeAttachment[];
}): Promise<QuoteMailResult> {
  // Gmail must be connected to send
  const authed = await getAuthedClient();
  if (!authed) return { ok: false, status: 400, error: "Connect Gmail in Settings › Integrations first" };

  // recipient: party email first, else the thread's last inbound sender
  if (!input.partyEmail && !input.conversation) {
    return { ok: false, status: 400, error: "This contact has no email on file" };
  }
  const gmail = google.gmail({ version: "v1", auth: authed.client });
  let lastInboundRfc: string | null = null;
  let recipient: string | null = input.partyEmail;
  if (input.conversation?.id) {
    const lastInbound = await prisma.message.findFirst({
      where: { conversationId: input.conversation.id, direction: "INBOUND" },
      orderBy: { sentAt: "desc" },
      select: { fromAddress: true, rfcMessageId: true },
    });
    if (lastInbound) {
      lastInboundRfc = lastInbound.rfcMessageId;
      recipient = recipient ?? lastInbound.fromAddress;
    }
  }
  if (!recipient) return { ok: false, status: 400, error: "No recipient email" };

  const raw = buildReplyMime({
    from: authed.email,
    to: [recipient],
    subject: input.conversation?.subject ? replySubject(input.conversation.subject) : input.fallbackSubject,
    inReplyTo: lastInboundRfc,
    text: input.text,
    attachments: input.attachments,
  });
  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, ...(input.conversation?.gmailThreadId ? { threadId: input.conversation.gmailThreadId } : {}) },
  });

  const now = new Date();
  if (input.conversation?.id) {
    // FS4 (C-3) — the OUTBOUND record and the conversation bump commit
    // together: the thread can no longer show a send its list row denies
    const conversationId = input.conversation.id;
    await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          gmailMessageId: sent.data.id ?? null,
          direction: "OUTBOUND",
          fromAddress: authed.email.toLowerCase(),
          toAddresses: [recipient],
          snippet: input.snippet,
          sentAt: now,
          labels: [],
        },
      }),
      // lastMessageDirection is maintained at every message write point (FS1) —
      // the original send route missed it; the shared helper closes that too
      prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: now, lastMessageDirection: "OUTBOUND" },
      }),
    ]);
  }
  return { ok: true, recipient, gmailMessageId: sent.data.id ?? null, sentAt: now };
}
