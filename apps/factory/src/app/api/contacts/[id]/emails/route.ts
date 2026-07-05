/**
 * FP5 — add an email to a contact. `matchDomain` maps a whole B2B domain
 * (orders@ / sales@ / humans@brand.it) to this one party — the FP1 matching
 * key. Emails are globally unique (one address ⇒ one party).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.contactsManage;

const Body = z.object({ email: z.string().trim().email(), label: z.string().trim().max(80).optional(), matchDomain: z.boolean().optional() });

export const POST = guarded(FEATURES.contactsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid email is required" }, { status: 400 });

  const party = await prisma.party.findUnique({ where: { id }, select: { id: true } });
  if (!party) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const clash = await prisma.partyEmail.findUnique({ where: { email: parsed.data.email }, select: { partyId: true } });
  if (clash) return NextResponse.json({ error: clash.partyId === id ? "Already on this contact" : "That email belongs to another contact" }, { status: 409 });

  const email = await prisma.partyEmail.create({ data: { partyId: id, email: parsed.data.email, label: parsed.data.label ?? null, matchDomain: parsed.data.matchDomain ?? false } });
  void audit({ actorId: actor!.id, entityType: "party", entityId: id, action: "email-added", after: { email: email.email, matchDomain: email.matchDomain } });
  return NextResponse.json({ email }, { status: 201 });
});
