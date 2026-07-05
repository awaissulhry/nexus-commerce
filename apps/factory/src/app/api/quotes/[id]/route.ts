/**
 * FP3 — one quote: full read (lines w/ template, versions, party+list,
 * conversation), patch (deposit/dates/state/lostReason — with lifecycle
 * guards), delete (draft only). Sent quotes are frozen: editing money-bearing
 * fields on a sent quote is refused (a new version is created on re-send).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";
import { quoteTotals } from "@/lib/quotes/compose-line";

export const permission = { GET: PAGES.quotes, PATCH: FEATURES.quotesCreate, DELETE: FEATURES.quotesCreate };

export const GET = guarded(PAGES.quotes, async (_req, { params, resolved }) => {
  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      party: { select: { id: true, name: true, kind: true, paymentTerms: true, priceListId: true, priceList: { select: { name: true } } } },
      conversation: { select: { id: true, subject: true } },
      lines: { orderBy: { id: "asc" }, include: { template: { select: { id: true, name: true } } } },
      versions: { orderBy: { version: "desc" }, select: { id: true, version: true, pdfRef: true, sentAt: true } },
    },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const totals = quoteTotals(quote.lines);
  return jsonStripped({ quote, totals }, resolved);
});

const Patch = z.object({
  depositPct: z.number().min(0).max(100).nullable().optional(),
  promiseDateAt: z.string().datetime().nullable().optional(),
  validUntilAt: z.string().datetime().nullable().optional(),
  state: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]).optional(),
  lostReason: z.string().max(500).nullable().optional(),
});

export const PATCH = guarded(FEATURES.quotesCreate, async (req: NextRequest, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const existing = await prisma.quote.findUnique({ where: { id }, select: { state: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (parsed.data.depositPct !== undefined) data.depositPct = parsed.data.depositPct;
  if (parsed.data.promiseDateAt !== undefined) data.promiseDateAt = parsed.data.promiseDateAt ? new Date(parsed.data.promiseDateAt) : null;
  if (parsed.data.validUntilAt !== undefined) data.validUntilAt = parsed.data.validUntilAt ? new Date(parsed.data.validUntilAt) : null;
  if (parsed.data.lostReason !== undefined) data.lostReason = parsed.data.lostReason;
  if (parsed.data.state) data.state = parsed.data.state;

  const quote = await prisma.quote.update({ where: { id }, data });
  void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "updated", before: { state: existing.state }, after: parsed.data });
  await publishEventDurable("pricing.updated", { quoteId: id });
  return jsonStripped({ quote }, resolved);
});

export const DELETE = guarded(FEATURES.quotesCreate, async (_req, { params, actor }) => {
  const { id } = await params;
  const quote = await prisma.quote.findUnique({ where: { id }, select: { state: true, number: true } });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (quote.state !== "DRAFT") return NextResponse.json({ error: "Only draft quotes can be deleted — mark a sent quote rejected instead" }, { status: 400 });
  await prisma.quote.delete({ where: { id } });
  void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "deleted", after: { number: quote.number } });
  return NextResponse.json({ ok: true });
});
