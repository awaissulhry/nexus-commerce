/** FP3.4 — PUBLIC: the customer requests changes / declines. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { hashToken } from "@/lib/quotes/public";
import { notifyOwners } from "@/lib/quotes/notify-owners";

export const permission = PUBLIC;

const Body = z.object({ note: z.string().max(1000).optional() });

export const POST = guarded(PUBLIC, async (req, { params }) => {
  const { token } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const note = parsed.success ? parsed.data.note ?? null : null;
  const quote = await prisma.quote.findUnique({ where: { acceptTokenHash: hashToken(token) }, select: { id: true, number: true, state: true } });
  if (!quote) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (quote.state !== "SENT") return NextResponse.json({ error: "already_decided" }, { status: 409 });

  await prisma.quote.update({ where: { id: quote.id }, data: { state: "REJECTED", lostReason: note } });
  void audit({ entityType: "quote", entityId: quote.id, action: "rejected", after: { via: "public link", note } });
  await notifyOwners({ title: `Quote ${quote.number}: customer requested changes`, body: note ?? undefined, entityId: quote.id, href: `/quotes?q=${quote.id}` });
  await publishEventDurable("pricing.updated", { quoteId: quote.id });
  return NextResponse.json({ ok: true });
});
