/** F1 — downloadable Party import template (start from the exact shape). */
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { partiesTemplateCsv } from "@/lib/imports/parties";

export const permission = FEATURES.importsRun;

export const GET = guarded(FEATURES.importsRun, async () => {
  return new Response(partiesTemplateCsv(), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="parties-template.csv"',
    },
  });
});
