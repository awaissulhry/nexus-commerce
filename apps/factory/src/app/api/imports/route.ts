/** F1 — import job history for the Settings › Import/Export grid. */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.importsRun;

export const GET = guarded(FEATURES.importsRun, async () => {
  const items = await prisma.importJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      entity: true,
      mode: true,
      rowsTotal: true,
      rowsOk: true,
      rowsError: true,
      createdAt: true,
      actor: { select: { displayName: true } },
    },
  });
  return NextResponse.json({ items });
});
