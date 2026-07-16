/**
 * EPQ.2 — follow-up queue row actions (Owner task queue, not auto-send):
 *   snooze  — hide the row for 3 days (followUpFlaggedAt pushed into the
 *             future; the worker treats a future flag as "snoozed until")
 *   dismiss — take it out of the queue now; the fresh followUpFlaggedAt
 *             suppresses a re-flag for the rule's own cadence window
 * Both audited; pricing.updated refreshes the pipeline live.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.quotesSend;

const SNOOZE_DAYS = 3;

const Body = z.object({ action: z.enum(["snooze", "dismiss"]) });

export const POST = guarded(FEATURES.quotesSend, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const quote = await prisma.quote.findUnique({ where: { id }, select: { id: true, number: true, followUpRule: true } });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!quote.followUpRule) return NextResponse.json({ error: "This quote isn't in the follow-up queue" }, { status: 400 });

  const now = new Date();
  if (parsed.data.action === "snooze") {
    const until = new Date(now.getTime() + SNOOZE_DAYS * 86_400_000);
    await prisma.quote.update({ where: { id }, data: { followUpFlaggedAt: until } });
    void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "followup.snoozed", after: { rule: quote.followUpRule, until } });
  } else {
    await prisma.quote.update({ where: { id }, data: { followUpRule: null, followUpFlaggedAt: now } });
    void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "followup.dismissed", after: { rule: quote.followUpRule } });
  }
  await publishEventDurable("pricing.updated", { quoteId: id });
  return NextResponse.json({ ok: true });
});
