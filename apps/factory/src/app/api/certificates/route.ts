/**
 * FP2.3 — EN 17092 certificate registry (FD14 — no apparel vertical models EU
 * PPE; this is our differentiator). List + create. Coverage (which templates a
 * cert covers) is attached per-template. FP6's QC stage blocks PACKING when a
 * garment's cert is missing/expired.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";

export const permission = { GET: PAGES.products, POST: FEATURES.productsManage };

export const GET = guarded(PAGES.products, async () => {
  const certificates = await prisma.certificate.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { coverage: true } } },
  });
  return NextResponse.json({ certificates });
});

const Create = z.object({
  standard: z.string().trim().max(60).default("EN 17092"),
  class: z.string().trim().min(1).max(10), // AAA | AA | A | B | C
  certNumber: z.string().trim().min(1).max(120),
  notifiedBody: z.string().trim().max(160).nullable().optional(),
  issuedAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  fileRef: z.string().trim().max(500).nullable().optional(),
});

export const POST = guarded(FEATURES.productsManage, async (req, { actor }) => {
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "class and certificate number are required" }, { status: 400 });
  const d = parsed.data;
  const certificate = await prisma.certificate.create({
    data: {
      standard: d.standard,
      class: d.class,
      certNumber: d.certNumber,
      notifiedBody: d.notifiedBody ?? null,
      issuedAt: d.issuedAt ? new Date(d.issuedAt) : null,
      expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
      fileRef: d.fileRef ?? null,
    },
  });
  void audit({ actorId: actor!.id, entityType: "certificate", entityId: certificate.id, action: "created", after: { class: certificate.class, certNumber: certificate.certNumber } });
  return NextResponse.json({ certificate }, { status: 201 });
});
