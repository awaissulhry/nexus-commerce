/**
 * FP7 — the materials workspace list: every material with the four-column math
 * (In stock / Committed / Expected / Available) from the append-only ledger +
 * open POs. `pages.materials` (the Workers' page too) — stock counts are NOT
 * financial (the floor needs them); supplier cost is grain-stripped by name. P11: the fold lives in
 * src/lib/materials/stock-list.ts (Claude's factory-materials reads it too).
 */
import { NextRequest } from "next/server";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { loadMaterialStock } from "@/lib/materials/stock-list";

export const permission = PAGES.materials;

export const GET = guarded(PAGES.materials, async (req: NextRequest, { resolved }) => {
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  return jsonStripped({ materials: await loadMaterialStock({ includeArchived }) }, resolved);
});
