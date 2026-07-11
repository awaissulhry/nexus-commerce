/** FP2.3 — patch / delete a certificate (delete cascades its coverage rows). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = { PATCH: FEATURES.productsManage, DELETE: FEATURES.productsManage };

const Patch = z.object({
  class: z.string().trim().min(1).max(10).optional(),
  certNumber: z.string().trim().min(1).max(120).optional(),
  notifiedBody: z.string().trim().max(160).nullable().optional(),
  issuedAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  fileRef: z.string().trim().max(500).nullable().optional(),
});

export const PATCH = guarded(FEATURES.productsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const d = parsed.data;
  const certificate = await prisma.certificate.update({
    where: { id },
    data: {
      ...(d.class !== undefined ? { class: d.class } : {}),
      ...(d.certNumber !== undefined ? { certNumber: d.certNumber } : {}),
      ...(d.notifiedBody !== undefined ? { notifiedBody: d.notifiedBody } : {}),
      ...(d.issuedAt !== undefined ? { issuedAt: d.issuedAt ? new Date(d.issuedAt) : null } : {}),
      ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt ? new Date(d.expiresAt) : null } : {}),
      ...(d.fileRef !== undefined ? { fileRef: d.fileRef } : {}),
    },
  });
  void audit({ actorId: actor!.id, entityType: "certificate", entityId: id, action: "updated", after: d });
  await publishEventDurable("certificate.updated"); // FS2 — no silent mutations
  return NextResponse.json({ certificate });
});

export const DELETE = guarded(FEATURES.productsManage, async (_req, { params, actor }) => {
  const { id } = await params;
  await prisma.certificate.delete({ where: { id } });
  void audit({ actorId: actor!.id, entityType: "certificate", entityId: id, action: "deleted" });
  await publishEventDurable("certificate.updated"); // FS2 — no silent mutations
  return NextResponse.json({ ok: true });
});
