/**
 * FP3.3 — send a quote: recompose (refuse if any line blocks or margin is
 * below the floor without acknowledgement), render the PDF, send it as a Gmail
 * reply threaded into the linked conversation (or a new email to the party),
 * freeze a QuoteVersion, flip to SENT. Atomic in spirit: the email goes first —
 * if Gmail fails, nothing is recorded, so a quote is never SENT without a send.
 * NEVER exercised by automation (the Owner sends the real one).
 * EPQ.1 — supersede semantics: EVERY send mints a fresh accept token; the hash
 * lands on the QuoteVersion (which pins the version the token points at) AND
 * on Quote.acceptTokenHash (always the latest — older tokens resolve through
 * the version row to a superseded page). A below-floor send persists
 * marginFloorBreached + a floor.acknowledged audit (who/when/how far below).
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { google } from "googleapis";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { composeQuoteLine, quoteTotals } from "@/lib/quotes/compose-line";
import { buildQuoteSnapshot } from "@/lib/quotes/build-snapshot";
import { renderQuotePdf } from "@/lib/quotes/render-pdf";
import { buildReplyMime, replySubject } from "@/lib/google/mime";
import { getAuthedClient } from "@/lib/google/oauth";

export const permission = FEATURES.quotesSend;

const Body = z.object({ acknowledgeFloor: z.boolean().optional() });

export const POST = guarded(FEATURES.quotesSend, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const acknowledgeFloor = parsed.success ? parsed.data.acknowledgeFloor ?? false : false;

  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      party: { select: { name: true, priceListId: true, emails: { take: 1, select: { email: true } } } },
      conversation: { select: { id: true, subject: true, gmailThreadId: true } },
      lines: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { version: true } },
    },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!["DRAFT", "SENT"].includes(quote.state)) return NextResponse.json({ error: `A ${quote.state} quote cannot be sent` }, { status: 400 });
  if (quote.lines.length === 0) return NextResponse.json({ error: "Add at least one line first" }, { status: 400 });

  // recompose every line: refuse on any blocking violation
  for (const l of quote.lines) {
    if (!l.templateId) continue;
    const c = await composeQuoteLine({ templateId: l.templateId, selections: (l.selections as string[] | null) ?? [], adjustmentCents: l.adjustmentCents, priceListId: quote.party.priceListId });
    if (c?.hasBlockingViolation) return NextResponse.json({ error: "A line has a blocking constraint — resolve it before sending" }, { status: 400 });
  }

  // margin-floor gate (server-enforced even though the UI gates it)
  const floorRow = await prisma.appSetting.findUnique({ where: { key: "pricing.defaults" } });
  const floor = ((floorRow?.value as { marginFloorPct?: number })?.marginFloorPct) ?? 20;
  const totals = quoteTotals(quote.lines);
  const floorAckRequired = totals.netCents > 0 && totals.marginPct < floor; // EPQ.1 — persisted below
  if (floorAckRequired && !acknowledgeFloor) {
    return NextResponse.json({ error: `Net margin ${totals.marginPct.toFixed(1)}% is below your ${floor}% floor — acknowledge to send` }, { status: 422 });
  }

  // Gmail must be connected to send
  const authed = await getAuthedClient();
  if (!authed) return NextResponse.json({ error: "Connect Gmail in Settings › Integrations first" }, { status: 400 });

  // recipient
  const toEmail = quote.party.emails[0]?.email;
  if (!toEmail && !quote.conversation) return NextResponse.json({ error: "This contact has no email on file" }, { status: 400 });

  // EPQ.1 — accept token: EVERY send mints a fresh one (supersede semantics).
  // The customer always gets a live link; older links resolve to a superseded
  // page through the QuoteVersion row that owns their hash.
  const rawToken = randomBytes(24).toString("hex");
  const acceptTokenHash = createHash("sha256").update(rawToken).digest("hex");
  const publicBase = process.env.FACTORY_PUBLIC_URL || req.nextUrl.origin;
  const acceptUrl = `${publicBase}/q/${rawToken}`;

  const snapshot = await buildQuoteSnapshot(id, acceptUrl);
  if (!snapshot) return NextResponse.json({ error: "Could not build the quote" }, { status: 500 });

  const factoryNameRow = await prisma.appSetting.findUnique({ where: { key: "factory.name" } });
  const factoryName = (factoryNameRow?.value as { name?: string })?.name ?? "Nexus Factory";
  const pdf = await renderQuotePdf(snapshot, factoryName);

  const version = (quote.versions[0]?.version ?? 0) + 1;
  const dir = path.join(process.cwd(), "data", "quotes");
  fs.mkdirSync(dir, { recursive: true });
  const pdfPath = path.join(dir, `${id}-v${version}.pdf`);
  fs.writeFileSync(pdfPath, pdf);

  // send via Gmail (threaded reply if linked, else new email)
  const gmail = google.gmail({ version: "v1", auth: authed.client });
  let lastInboundRfc: string | null = null;
  let recipient = toEmail;
  if (quote.conversation?.id) {
    const lastInbound = await prisma.message.findFirst({ where: { conversationId: quote.conversation.id, direction: "INBOUND" }, orderBy: { sentAt: "desc" }, select: { fromAddress: true, rfcMessageId: true } });
    if (lastInbound) { lastInboundRfc = lastInbound.rfcMessageId; recipient = recipient ?? lastInbound.fromAddress; }
  }
  if (!recipient) return NextResponse.json({ error: "No recipient email" }, { status: 400 });

  const bodyText = `Buongiorno,\n\nin allegato il preventivo ${snapshot.number}.${acceptUrl ? `\n\nPuò accettarlo qui: ${acceptUrl}` : ""}\n\nCordiali saluti`;
  const raw = buildReplyMime({
    from: authed.email,
    to: [recipient],
    subject: quote.conversation?.subject ? replySubject(quote.conversation.subject) : `Preventivo ${snapshot.number}`,
    inReplyTo: lastInboundRfc,
    text: bodyText,
    attachments: [{ filename: `Preventivo-${snapshot.number}.pdf`, mimeType: "application/pdf", content: pdf }],
  });
  const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw, ...(quote.conversation?.gmailThreadId ? { threadId: quote.conversation.gmailThreadId } : {}) } });

  // record: version (owning this send's token) + state + optimistic OUTBOUND message
  const now = new Date();
  await prisma.quoteVersion.create({ data: { quoteId: id, version, sentSnapshot: snapshot as object, pdfRef: pdfPath, acceptTokenHash } });
  await prisma.quote.update({
    where: { id },
    data: {
      state: "SENT",
      sentAt: quote.sentAt ?? now,
      acceptTokenHash, // EPQ.1 — always the LATEST send's token; prior tokens now resolve as superseded
      ...(floorAckRequired ? { marginFloorBreached: true } : {}), // EPQ.1 — durable record a below-floor offer was knowingly made
    },
  });
  if (quote.conversation?.id) {
    await prisma.message.create({ data: { conversationId: quote.conversation.id, gmailMessageId: sent.data.id ?? null, direction: "OUTBOUND", fromAddress: authed.email.toLowerCase(), toAddresses: [recipient], snippet: `Preventivo ${snapshot.number} inviato`, sentAt: now, labels: [] } });
    await prisma.conversation.update({ where: { id: quote.conversation.id }, data: { lastMessageAt: now } });
  }
  if (floorAckRequired) {
    void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "floor.acknowledged", after: { ackBy: actor!.id, marginPct: totals.marginPct, floorPct: floor } });
  }
  void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "sent", after: { version, to: recipient, netCents: totals.netCents } });
  await publishEventDurable("conversation.updated", { id: quote.conversation?.id });
  await publishEventDurable("pricing.updated", { quoteId: id });

  return NextResponse.json({ ok: true, version });
});
