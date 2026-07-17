/**
 * FP5 — one contact: GET returns identity + emails + measurement profiles +
 * relationship counts (the History arrays arrive in FP5.3). PATCH edits the
 * commercial identity (inline autosave) and archive state; DELETE soft-archives
 * (parties are referenced by quotes/orders — never hard-deleted). Grain strip
 * on the way out (terms/deposit by name).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";
import { quoteTotals } from "@/lib/quotes/compose-line";
import { orderTotals } from "@/lib/orders/money";

export const permission = { GET: PAGES.contacts, PATCH: FEATURES.contactsManage, DELETE: FEATURES.contactsManage };

async function detail(id: string) {
  const contact = await prisma.party.findUnique({
    where: { id },
    include: {
      emails: { orderBy: { email: "asc" } },
      priceList: { select: { id: true, name: true } },
      measurements: { orderBy: [{ garmentType: "asc" }, { version: "desc" }] },
      _count: { select: { quotes: true, orders: true, conversations: true, reviews: true } },
    },
  });
  if (!contact) return null;
  const { _count, ...rest } = contact;

  // FP5.3 — aggregated relationship history (money folds grain-stripped downstream)
  const [conversations, quotes, orders, reviews] = await Promise.all([
    prisma.conversation.findMany({ where: { partyId: id }, orderBy: { updatedAt: "desc" }, take: 25, select: { id: true, subject: true, state: true, updatedAt: true } }),
    prisma.quote.findMany({ where: { partyId: id }, orderBy: { updatedAt: "desc" }, take: 25, include: { lines: { select: { netPriceCents: true, costCents: true, qty: true } } } }),
    prisma.order.findMany({ where: { partyId: id }, orderBy: { updatedAt: "desc" }, take: 25, include: { lines: { select: { netPriceCents: true, costCents: true, qty: true } } } }),
    prisma.review.findMany({ where: { partyId: id }, orderBy: { createdAt: "desc" }, take: 25, select: { id: true, rating: true, notes: true, orderId: true, createdAt: true } }),
  ]);
  const history = {
    conversations: conversations.map((c) => ({ id: c.id, subject: c.subject, state: c.state, updatedAt: c.updatedAt })),
    quotes: quotes.map((q) => ({ id: q.id, number: q.number, state: q.state, netCents: quoteTotals(q.lines).netCents, updatedAt: q.updatedAt })),
    orders: orders.map((o) => ({ id: o.id, number: o.number, state: o.state, netCents: orderTotals(o.lines).netCents, promiseDateAt: o.promiseDateAt })),
    reviews: reviews.map((r) => ({ id: r.id, rating: r.rating, notes: r.notes, orderId: r.orderId, createdAt: r.createdAt })),
  };

  return { contact: rest, counts: _count, history };
}

export const GET = guarded(PAGES.contacts, async (_req, { params, resolved }) => {
  const { id } = await params;
  const payload = await detail(id);
  if (!payload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return jsonStripped(payload, resolved);
});

const Patch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  currency: z.string().trim().max(8).optional(),
  paymentTerms: z.string().trim().max(200).nullable().optional(),
  depositDefaultPct: z.number().min(0).max(100).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  priceListId: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  // EPQ.5 — tax posture + SDI routing (downstream invoicing is mechanical)
  taxMode: z.enum(["IT_B2C", "IT_B2B", "EU_B2B", "EXTRA_EU"]).nullable().optional(),
  vatNumber: z.string().trim().max(20).nullable().optional(),
  codiceFiscale: z.string().trim().max(20).nullable().optional(),
  sdiCodice: z.string().trim().max(10).nullable().optional(),
  sdiPec: z.string().trim().max(200).nullable().optional(),
});

export const PATCH = guarded(FEATURES.contactsManage, async (req, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { archived, ...fields } = parsed.data;

  const exists = await prisma.party.findUnique({ where: { id }, select: { id: true, vatNumber: true } });
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = { ...fields };
  if (archived !== undefined) data.archivedAt = archived ? new Date() : null;
  // EPQ.5 — a changed/removed VAT number invalidates the stored VIES proof
  // (the requestIdentifier certifies THAT number; re-check to re-open art. 41)
  if (fields.vatNumber !== undefined && fields.vatNumber !== exists.vatNumber) {
    data.viesRequestId = null;
    data.viesCheckedAt = null;
  }
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });

  await prisma.party.update({ where: { id }, data });
  void audit({ actorId: actor!.id, entityType: "party", entityId: id, action: archived === undefined ? "updated" : archived ? "archived" : "restored", after: Object.keys(data) });
  await publishEventDurable("party.updated"); // FS2 — no silent mutations

  const payload = await detail(id);
  return jsonStripped(payload, resolved);
});

export const DELETE = guarded(FEATURES.contactsManage, async (_req, { params, actor }) => {
  const { id } = await params;
  const exists = await prisma.party.findUnique({ where: { id }, select: { id: true, archivedAt: true } });
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.party.update({ where: { id }, data: { archivedAt: new Date() } });
  void audit({ actorId: actor!.id, entityType: "party", entityId: id, action: "archived" });
  await publishEventDurable("party.updated"); // FS2 — no silent mutations
  return NextResponse.json({ ok: true });
});
