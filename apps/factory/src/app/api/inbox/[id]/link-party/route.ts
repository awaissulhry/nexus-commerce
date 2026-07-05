/**
 * FP1.2 — the "unmatched sender → party in one click" flow: link an existing
 * party OR create one from the sender (optionally matching the whole domain),
 * then back-match every other unmatched conversation from that sender/domain.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { clearPartyEmailCache } from "@/lib/google/gmail-sync";
import { domainOf } from "@/lib/google/match";

export const permission = FEATURES.contactsManage;

const Body = z.union([
  z.object({ partyId: z.string().min(1) }),
  z.object({
    create: z.object({
      name: z.string().min(1).max(200),
      kind: z.enum(["CUSTOMER", "BRAND", "SUPPLIER"]),
      matchDomain: z.boolean().optional(),
    }),
  }),
]);

export const POST = guarded(FEATURES.contactsManage, async (req: NextRequest, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const lastInbound = await prisma.message.findFirst({
    where: { conversationId: id, direction: "INBOUND" },
    orderBy: { sentAt: "desc" },
    select: { fromAddress: true },
  });
  const senderEmail = lastInbound?.fromAddress?.toLowerCase() ?? null;

  let partyId: string;
  let matchDomain = false;
  if ("partyId" in parsed.data) {
    const party = await prisma.party.findUnique({ where: { id: parsed.data.partyId }, select: { id: true } });
    if (!party) return NextResponse.json({ error: "Party not found" }, { status: 404 });
    partyId = party.id;
    // linking an existing party also teaches it this sender's email
    if (senderEmail) {
      await prisma.partyEmail.upsert({
        where: { email: senderEmail },
        create: { partyId, email: senderEmail },
        update: {},
      });
    }
  } else {
    if (!senderEmail) return NextResponse.json({ error: "No sender to create a party from" }, { status: 400 });
    matchDomain = parsed.data.create.matchDomain ?? false;
    const party = await prisma.party.create({
      data: {
        kind: parsed.data.create.kind,
        name: parsed.data.create.name.trim(),
        emails: { create: { email: senderEmail, matchDomain } },
      },
    });
    partyId = party.id;
    void audit({
      actorId: actor!.id, entityType: "party", entityId: partyId, action: "created",
      after: { via: "inbox", email: senderEmail, matchDomain },
    });
  }

  await prisma.conversation.update({ where: { id }, data: { partyId } });
  void audit({
    actorId: actor!.id, entityType: "conversation", entityId: id, action: "party.linked",
    after: { partyId },
  });

  // Back-match other unmatched conversations from this sender (or domain)
  let linked = 1;
  if (senderEmail) {
    const domain = matchDomain ? domainOf(senderEmail) : null;
    const candidates = await prisma.conversation.findMany({
      where: { partyId: null, id: { not: id } },
      select: {
        id: true,
        messages: {
          where: { direction: "INBOUND" },
          orderBy: { sentAt: "desc" },
          take: 1,
          select: { fromAddress: true },
        },
      },
    });
    const matches = candidates.filter((c) => {
      const from = c.messages[0]?.fromAddress?.toLowerCase();
      if (!from) return false;
      return domain ? domainOf(from) === domain : from === senderEmail;
    });
    if (matches.length) {
      await prisma.conversation.updateMany({
        where: { id: { in: matches.map((m) => m.id) } },
        data: { partyId },
      });
      linked += matches.length;
    }
  }

  clearPartyEmailCache();
  await publishEventDurable("conversation.updated", { id });
  return NextResponse.json({ ok: true, partyId, linkedConversations: linked });
});
