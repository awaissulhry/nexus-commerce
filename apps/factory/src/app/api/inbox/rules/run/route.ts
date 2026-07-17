/**
 * EPI3.4 — Run-now: retroactive rule sweep with the dry-run idiom. dryRun
 * returns the per-conversation from/to diff (only rows the action would
 * actually change); apply takes the chosen subset. Capped at 200 like bulk.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { runRuleNow } from "@/lib/inbox/rules-service";

export const permission = FEATURES.inboxViewsManage;

const Body = z.object({
  ruleId: z.string().min(1),
  dryRun: z.boolean().default(true),
  ids: z.array(z.string().min(1)).max(200).optional(),
});

export const POST = guarded(FEATURES.inboxViewsManage, async (req: NextRequest, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    const result = await runRuleNow(parsed.data.ruleId, {
      dryRun: parsed.data.dryRun,
      ids: parsed.data.ids,
      actorId: actor!.id,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
});
