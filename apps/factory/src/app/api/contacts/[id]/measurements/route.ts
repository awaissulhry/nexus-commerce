/**
 * FP5.2 — measurement profiles (the Tailornova ADOPT). GET lists a contact's
 * profiles; POST creates one — OR, with `supersedesId`, a NEW VERSION that
 * supersedes the prior (version + 1). Editing NEVER mutates a prior version:
 * a customer's size history is an immutable paper trail (docstatus discipline,
 * the same promise as sent quotes).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";

export const permission = { GET: PAGES.contacts, POST: FEATURES.contactsManage };

export const GET = guarded(PAGES.contacts, async (_req, { params }) => {
  const { id } = await params;
  const profiles = await prisma.measurementProfile.findMany({ where: { partyId: id }, orderBy: [{ garmentType: "asc" }, { version: "desc" }] }); // bounded: per-party measurement versions
  return NextResponse.json({ profiles });
});

const Body = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  garmentType: z.string().trim().min(1, "Garment type is required").max(80),
  fields: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  fitNotes: z.string().trim().max(2000).optional(),
  supersedesId: z.string().optional(),
});

export const POST = guarded(FEATURES.contactsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid profile" }, { status: 400 });
  const d = parsed.data;

  const party = await prisma.party.findUnique({ where: { id }, select: { id: true } });
  if (!party) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

  let version = 1;
  if (d.supersedesId) {
    const prior = await prisma.measurementProfile.findFirst({ where: { id: d.supersedesId, partyId: id }, select: { version: true } });
    if (!prior) return NextResponse.json({ error: "Prior version not found" }, { status: 404 });
    version = prior.version + 1;
  }

  const profile = await prisma.measurementProfile.create({
    data: {
      partyId: id,
      name: d.name,
      garmentType: d.garmentType,
      fields: (d.fields ?? {}) as Prisma.InputJsonValue,
      fitNotes: d.fitNotes ?? null,
      version,
      supersedesId: d.supersedesId ?? null,
    },
  });
  void audit({ actorId: actor!.id, entityType: "party", entityId: id, action: d.supersedesId ? "measurement-versioned" : "measurement-created", after: { profileId: profile.id, garmentType: profile.garmentType, version } });
  await publishEventDurable("party.updated"); // FS2 — no silent mutations
  return NextResponse.json({ profile }, { status: 201 });
});
