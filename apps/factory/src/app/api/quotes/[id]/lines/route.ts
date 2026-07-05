/** FP3 — add a line to a DRAFT quote. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.quotesCreate;

const Body = z.object({ templateId: z.string().nullable().optional(), description: z.string().max(300).optional() });

export const POST = guarded(FEATURES.quotesCreate, async (req, { params, actor }) => {
  const { id } = await params;
  const quote = await prisma.quote.findUnique({ where: { id }, select: { state: true } });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (quote.state !== "DRAFT") return NextResponse.json({ error: "Revise the quote to a draft before editing lines" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const line = await prisma.quoteLine.create({
    data: { quoteId: id, templateId: parsed.success ? parsed.data.templateId ?? null : null, description: parsed.success ? parsed.data.description : undefined, selections: [] },
  });
  void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "line.added", after: { lineId: line.id } });
  return NextResponse.json({ line }, { status: 201 });
});
