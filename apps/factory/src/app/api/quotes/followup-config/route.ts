/**
 * EPQ.2 — follow-up cadence config (AppSetting quotes.followup), edited from
 * the gear popover on the pipeline's Needs-follow-up card (home-page rule —
 * the Settings PAGE belongs to another session). GET returns the effective
 * settings (defaults merged); PATCH updates the three cadence numbers.
 * Templates stay in the same row at their defaults — the Owner edits each
 * nudge's text in the preview modal before it goes out.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { FOLLOWUP_SETTING_KEY, loadFollowUpSettings } from "@/lib/quotes/followup-settings";

export const permission = FEATURES.quotesSend;

export const GET = guarded(FEATURES.quotesSend, async () => {
  const settings = await loadFollowUpSettings();
  return NextResponse.json(settings);
});

const Patch = z.object({
  unviewedDays: z.number().int().min(1).max(90).optional(),
  viewedDays: z.number().int().min(1).max(90).optional(),
  preExpiryDays: z.number().int().min(1).max(90).optional(),
});

export const PATCH = guarded(FEATURES.quotesSend, async (req, { actor }) => {
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Cadence values must be whole days between 1 and 90" }, { status: 400 });
  const before = await loadFollowUpSettings(); // lazy-creates the row on first touch
  const next = { ...before, ...parsed.data };
  await prisma.appSetting.update({ where: { key: FOLLOWUP_SETTING_KEY }, data: { value: next } });
  void audit({
    actorId: actor!.id, entityType: "settings", entityId: FOLLOWUP_SETTING_KEY, action: "updated",
    before: { unviewedDays: before.unviewedDays, viewedDays: before.viewedDays, preExpiryDays: before.preExpiryDays },
    after: { unviewedDays: next.unviewedDays, viewedDays: next.viewedDays, preExpiryDays: next.preExpiryDays },
  });
  await publishEventDurable("settings.updated", { key: FOLLOWUP_SETTING_KEY });
  return NextResponse.json(next);
});
