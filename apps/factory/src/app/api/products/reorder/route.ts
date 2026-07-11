/**
 * FP2.2 — persist drag-sort for groups or options: sets sort = array index for
 * each id in order. One route covers both entity kinds.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.productsManage;

const Body = z.object({ kind: z.enum(["group", "option"]), ids: z.array(z.string()).min(1) });

export const POST = guarded(FEATURES.productsManage, async (req) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { kind, ids } = parsed.data;
  await prisma.$transaction(
    ids.map((id, i) =>
      kind === "group"
        ? prisma.optionGroup.update({ where: { id }, data: { sort: i } })
        : prisma.option.update({ where: { id }, data: { sort: i } }),
    ),
  );
  const templateId =
    kind === "group"
      ? (await prisma.optionGroup.findUnique({ where: { id: ids[0] }, select: { templateId: true } }))?.templateId
      : (await prisma.option.findUnique({ where: { id: ids[0] }, select: { group: { select: { templateId: true } } } }))?.group.templateId;
  await publishEventDurable("pricing.updated", { templateId }); // FS2 — no silent mutations
  return NextResponse.json({ ok: true });
});
