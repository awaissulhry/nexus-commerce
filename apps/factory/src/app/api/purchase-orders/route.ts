/**
 * FP7 — purchase orders: list + create. A PO is a supplier + JSON lines
 * [{materialId, qty, unit, unitCostCents}]; born DRAFT, numbered PO-n. Totals
 * (money) are grain-stripped; the "+ Buy" prefill posts here too.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";
import { createDraftPurchaseOrder } from "@/lib/materials/purchase-order-draft";

export const permission = { GET: PAGES.materials, POST: FEATURES.materialsManage };

type Line = { materialId: string; qty: number; unit: string; unitCostCents: number };
const lineTotal = (lines: Line[]) => lines.reduce((s, l) => s + l.qty * (l.unitCostCents ?? 0), 0);

export const GET = guarded(PAGES.materials, async (req: NextRequest, { resolved }) => {
  const state = (req.nextUrl.searchParams.get("state") ?? "all").toUpperCase();
  const where = state !== "ALL" ? { state: state as never } : {};
  const [pos, counts] = await Promise.all([
    prisma.purchaseOrder.findMany({ where, orderBy: { createdAt: "desc" }, take: 300, include: { supplier: { select: { name: true } } } }),
    prisma.purchaseOrder.groupBy({ by: ["state"], _count: { _all: true } }),
  ]);
  const rows = pos.map((po) => ({ id: po.id, number: po.number, supplier: po.supplier.name, state: po.state, lineCount: (po.lines as Line[])?.length ?? 0, totalCents: lineTotal((po.lines as Line[]) ?? []), expectedAt: po.expectedAt, createdAt: po.createdAt }));
  return jsonStripped({ purchaseOrders: rows, counts: Object.fromEntries(counts.map((c) => [c.state, c._count._all])) }, resolved);
});

const Create = z.object({
  supplierId: z.string().min(1),
  expectedAt: z.string().nullable().optional(),
  lines: z.array(z.object({ materialId: z.string().min(1), qty: z.number().positive(), unit: z.string().min(1), unitCostCents: z.number().int().min(0) })).min(1, "At least one line"),
});

export const POST = guarded(FEATURES.materialsManage, async (req, { actor, resolved }) => {
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid PO" }, { status: 400 });
  // P12 — created by src/lib/materials/purchase-order-draft.ts (Claude's factory-draft-purchase-order too).
  const created = await createDraftPurchaseOrder({ ...parsed.data, actorId: actor!.id });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status });
  const po = created.purchaseOrder;
  return jsonStripped({ purchaseOrder: po }, resolved, { status: 201 });
});
