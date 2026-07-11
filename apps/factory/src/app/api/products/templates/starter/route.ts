/**
 * FP2.2 — one-click starter structure: a real, ZERO-PRICED "Custom Cowhide
 * Suit" with the canonical option groups pre-created, ready to edit. No fake
 * prices (all deltas 0) — scaffolding, not demo data. The Owner fills in the
 * real numbers; this just saves the typing of the tree.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.productsManage;

const STRUCTURE: { name: string; minSelect: number; maxSelect: number; options: string[] }[] = [
  { name: "Leather type", minSelect: 1, maxSelect: 1, options: ["Cowhide", "Kangaroo"] },
  { name: "Lining", minSelect: 0, maxSelect: 1, options: ["Standard lining", "Waterproof liner", "Thermal liner"] },
  { name: "Armor level", minSelect: 1, maxSelect: 1, options: ["CE Level 1", "CE Level 2"] },
  { name: "Perforation", minSelect: 0, maxSelect: 1, options: ["Perforated panels"] },
  { name: "Custom fit", minSelect: 0, maxSelect: 1, options: ["Made-to-measure"] },
  { name: "Branding", minSelect: 0, maxSelect: 2, options: ["Embroidered name", "Sponsor logos"] },
];

export const POST = guarded(FEATURES.productsManage, async (_req, { actor }) => {
  const template = await prisma.productTemplate.create({
    data: {
      name: "Custom Cowhide Suit",
      description: "Starter structure — set your real base cost/price and per-option deltas. All values start at 0 (no fake prices).",
      optionGroups: {
        create: STRUCTURE.map((g, gi) => ({
          name: g.name,
          minSelect: g.minSelect,
          maxSelect: g.maxSelect,
          sort: gi,
          options: { create: g.options.map((name, oi) => ({ name, sort: oi })) },
        })),
      },
    },
    select: { id: true, name: true },
  });
  void audit({ actorId: actor!.id, entityType: "template", entityId: template.id, action: "created", after: { via: "starter", name: template.name } });
  await publishEventDurable("pricing.updated", { templateId: template.id }); // FS2 — no silent mutations
  return NextResponse.json({ template }, { status: 201 });
});
