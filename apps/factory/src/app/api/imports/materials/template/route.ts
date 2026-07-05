/** FP2.5 — materials import template CSV. */
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { materialsTemplateCsv } from "@/lib/imports/materials";

export const permission = FEATURES.materialsManage;

export const GET = guarded(FEATURES.materialsManage, async () =>
  new Response(materialsTemplateCsv(), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="materials-template.csv"' } }),
);
