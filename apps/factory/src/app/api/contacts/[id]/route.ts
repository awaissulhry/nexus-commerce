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
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";

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
  return { contact: rest, counts: _count };
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
});

export const PATCH = guarded(FEATURES.contactsManage, async (req, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { archived, ...fields } = parsed.data;

  const exists = await prisma.party.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = { ...fields };
  if (archived !== undefined) data.archivedAt = archived ? new Date() : null;
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });

  await prisma.party.update({ where: { id }, data });
  void audit({ actorId: actor!.id, entityType: "party", entityId: id, action: archived === undefined ? "updated" : archived ? "archived" : "restored", after: Object.keys(data) });

  const payload = await detail(id);
  return jsonStripped(payload, resolved);
});

export const DELETE = guarded(FEATURES.contactsManage, async (_req, { params, actor }) => {
  const { id } = await params;
  const exists = await prisma.party.findUnique({ where: { id }, select: { id: true, archivedAt: true } });
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.party.update({ where: { id }, data: { archivedAt: new Date() } });
  void audit({ actorId: actor!.id, entityType: "party", entityId: id, action: "archived" });
  return NextResponse.json({ ok: true });
});
