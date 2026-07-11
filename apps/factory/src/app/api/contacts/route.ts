/**
 * FP5 — the contacts workspace list: parties by kind (Customer / Supplier /
 * Brand) with per-kind counts, search, and quote/order tallies. Commercial
 * fields (paymentTerms, depositDefaultPct) are grain-stripped by name via
 * jsonStripped. Create promotes a party directly (not only from a thread).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";

export const permission = { GET: PAGES.contacts, POST: FEATURES.contactsManage };

const KIND_MAP: Record<string, "BRAND" | "CUSTOMER" | "SUPPLIER"> = { customer: "CUSTOMER", supplier: "SUPPLIER", brand: "BRAND" };

export const GET = guarded(PAGES.contacts, async (req: NextRequest, { resolved }) => {
  const p = req.nextUrl.searchParams;
  const kind = KIND_MAP[(p.get("kind") ?? "").toLowerCase()];
  const q = (p.get("q") ?? "").trim();
  const includeArchived = p.get("archived") === "1";
  const where = {
    ...(includeArchived ? {} : { archivedAt: null }),
    ...(kind ? { kind } : {}),
    ...(q ? { OR: [{ name: { contains: q } }, { emails: { some: { email: { contains: q } } } }] } : {}),
  };

  const [parties, counts] = await Promise.all([
    prisma.party.findMany({
      where,
      orderBy: { name: "asc" },
      take: 500,
      include: {
        emails: { select: { email: true, matchDomain: true } },
        priceList: { select: { id: true, name: true } },
        _count: { select: { quotes: true, orders: true, measurements: true } },
      },
    }),
    prisma.party.groupBy({ by: ["kind"], where: { archivedAt: null }, _count: { _all: true } }),
  ]);

  const rows = parties.map((party) => ({
    id: party.id,
    name: party.name,
    kind: party.kind,
    currency: party.currency,
    paymentTerms: party.paymentTerms,
    depositDefaultPct: party.depositDefaultPct,
    emailCount: party.emails.length,
    primaryEmail: party.emails[0]?.email ?? null,
    priceList: party.priceList,
    quoteCount: party._count.quotes,
    orderCount: party._count.orders,
    measurementCount: party._count.measurements,
    archivedAt: party.archivedAt,
    updatedAt: party.updatedAt,
  }));

  return jsonStripped({ contacts: rows, counts: Object.fromEntries(counts.map((c) => [c.kind, c._count._all])) }, resolved);
});

const Create = z.object({
  kind: z.enum(["BRAND", "CUSTOMER", "SUPPLIER"]),
  name: z.string().trim().min(1, "Name is required").max(200),
  currency: z.string().trim().max(8).optional(),
  paymentTerms: z.string().trim().max(200).optional(),
  depositDefaultPct: z.number().min(0).max(100).nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  email: z.string().trim().email().optional(),
});

export const POST = guarded(FEATURES.contactsManage, async (req, { actor, resolved }) => {
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid contact" }, { status: 400 });
  const d = parsed.data;

  if (d.email) {
    const clash = await prisma.partyEmail.findUnique({ where: { email: d.email }, select: { partyId: true } });
    if (clash) return NextResponse.json({ error: "That email already belongs to a contact" }, { status: 409 });
  }

  const party = await prisma.party.create({
    data: {
      kind: d.kind,
      name: d.name,
      currency: d.currency || "EUR",
      paymentTerms: d.paymentTerms ?? null,
      depositDefaultPct: d.depositDefaultPct ?? null,
      notes: d.notes ?? null,
      ...(d.email ? { emails: { create: { email: d.email } } } : {}),
    },
    select: { id: true, name: true, kind: true },
  });
  void audit({ actorId: actor!.id, entityType: "party", entityId: party.id, action: "created", after: { name: party.name, kind: party.kind } });
  await publishEventDurable("party.updated"); // FS2 — no silent mutations
  return jsonStripped({ contact: party }, resolved, { status: 201 });
});
