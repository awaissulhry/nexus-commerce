/**
 * F1 — health: DB answers, worker heartbeat age, RBAC mode. PUBLIC (no
 * secrets in the payload; used by the Settings › Health panel and smoke tests).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, PUBLIC, rbacMode } from "@/lib/auth/guard";

export const permission = PUBLIC;

export const GET = guarded(PUBLIC, async () => {
  let db = false;
  let workerBeatAgoMs: number | null = null;
  try {
    await prisma.$queryRawUnsafe("SELECT 1;");
    db = true;
    const beat = await prisma.appSetting.findUnique({ where: { key: "worker.heartbeat" } });
    if (beat) {
      const ts = (beat.value as { ts?: string })?.ts;
      if (ts) workerBeatAgoMs = Date.now() - new Date(ts).getTime();
    }
  } catch {
    db = false;
  }
  return NextResponse.json({ ok: db, db, workerBeatAgoMs, rbacMode: rbacMode() });
});
