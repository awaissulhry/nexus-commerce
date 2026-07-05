/** FP2.5 — options import template CSV. */
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { optionsTemplateCsv } from "@/lib/imports/options";

export const permission = FEATURES.productsManage;

export const GET = guarded(FEATURES.productsManage, async () =>
  new Response(optionsTemplateCsv(), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="options-template.csv"' } }),
);
