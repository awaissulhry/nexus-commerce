/**
 * FP8.3 — share the tracking into the customer's Gmail thread. OWNER-INITIATED
 * (a click, never a background auto-send — the send-guard), threaded as a reply
 * via the FP1 pipeline. The body is composed by the cost-free trackingEmail().
 * In the sandbox verify build (FACTORY_FORCE_FAKE_CARRIER) it composes and
 * returns without sending, so automation never sends a real email (platform rule).
 */
import { NextResponse } from "next/server";
import { google } from "googleapis";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { buildReplyMime, replySubject } from "@/lib/google/mime";
import { getAuthedClient } from "@/lib/google/oauth";
import { trackingEmail } from "@/lib/shipping/tracking-email";

export const permission = FEATURES.labelsPurchase;

export const POST = guarded(FEATURES.labelsPurchase, async (_req, { params, actor }) => {
  const { id } = await params;
  const s = await prisma.shipment.findUnique({
    where: { id },
    select: { trackingNumber: true, trackingUrl: true, service: true, order: { select: { id: true, number: true, conversationId: true, party: { select: { name: true, emails: { take: 1, select: { email: true } } } } } } },
  });
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!s.order.conversationId) return NextResponse.json({ error: "This order has no linked email thread — copy the tracking to the customer manually." }, { status: 400 });

  const email = trackingEmail({ orderNumber: s.order.number, partyName: s.order.party.name, carrier: s.service, trackingNumber: s.trackingNumber, trackingUrl: s.trackingUrl }, "it");

  // sandbox verify build: prove composition without sending a real email
  if (process.env.FACTORY_FORCE_FAKE_CARRIER === "1") {
    void audit({ actorId: actor!.id, entityType: "shipment", entityId: id, action: "tracking.shared", after: { dryRun: true } });
    return NextResponse.json({ ok: true, dryRun: true, subject: email.subject, body: email.body });
  }

  const authed = await getAuthedClient();
  if (!authed) return NextResponse.json({ error: "Connect Gmail in Settings › Integrations first" }, { status: 400 });

  const conv = await prisma.conversation.findUnique({ where: { id: s.order.conversationId }, select: { id: true, subject: true, gmailThreadId: true } });
  const lastInbound = await prisma.message.findFirst({ where: { conversationId: s.order.conversationId, direction: "INBOUND" }, orderBy: { sentAt: "desc" }, select: { fromAddress: true, rfcMessageId: true } });
  const recipient = s.order.party.emails[0]?.email ?? lastInbound?.fromAddress;
  if (!recipient) return NextResponse.json({ error: "No recipient email on file" }, { status: 400 });

  const raw = buildReplyMime({
    from: authed.email,
    to: [recipient],
    subject: conv?.subject ? replySubject(conv.subject) : email.subject,
    inReplyTo: lastInbound?.rfcMessageId ?? null,
    text: email.body,
  });
  const gmail = google.gmail({ version: "v1", auth: authed.client });
  const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw, ...(conv?.gmailThreadId ? { threadId: conv.gmailThreadId } : {}) } });

  const now = new Date();
  await prisma.message.create({ data: { conversationId: s.order.conversationId, gmailMessageId: sent.data.id ?? null, direction: "OUTBOUND", fromAddress: authed.email.toLowerCase(), toAddresses: [recipient], snippet: `Tracciamento ordine ${s.order.number} inviato`, sentAt: now, labels: [] } });
  await prisma.conversation.update({ where: { id: s.order.conversationId }, data: { lastMessageAt: now } });
  void audit({ actorId: actor!.id, entityType: "shipment", entityId: id, action: "tracking.shared", after: { to: recipient } });
  await publishEventDurable("conversation.updated", { id: s.order.conversationId });

  return NextResponse.json({ ok: true, sentTo: recipient });
});
