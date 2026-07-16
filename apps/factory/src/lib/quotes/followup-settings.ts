/**
 * EPQ.2 — follow-up cadence + nudge templates, stored in ONE AppSetting
 * ("quotes.followup") and lazy-created with the defaults the first time
 * anything asks. Config is edited from the Quotes page (gear popover on the
 * queue card → PATCH /api/quotes/followup-config) — the home-page rule; the
 * Settings page belongs to another session.
 */
import { prisma } from "@/lib/db";
import {
  CADENCE_DEFAULTS,
  NUDGE_TEMPLATE_DEFAULTS,
  type CadenceConfig,
  type FollowUpRule,
} from "./followup";

export const FOLLOWUP_SETTING_KEY = "quotes.followup";

export type FollowUpSettings = CadenceConfig & { templates: Record<FollowUpRule, string> };

const clampDays = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(90, Math.max(1, n));
};

/** Defaults merged over whatever is stored — a partial row never breaks the tick. */
export function withDefaults(value: unknown): FollowUpSettings {
  const v = (value ?? {}) as Partial<FollowUpSettings> & { templates?: Partial<Record<FollowUpRule, string>> };
  return {
    unviewedDays: clampDays(v.unviewedDays, CADENCE_DEFAULTS.unviewedDays),
    viewedDays: clampDays(v.viewedDays, CADENCE_DEFAULTS.viewedDays),
    preExpiryDays: clampDays(v.preExpiryDays, CADENCE_DEFAULTS.preExpiryDays),
    templates: {
      unviewed: v.templates?.unviewed || NUDGE_TEMPLATE_DEFAULTS.unviewed,
      "viewed-silent": v.templates?.["viewed-silent"] || NUDGE_TEMPLATE_DEFAULTS["viewed-silent"],
      "pre-expiry": v.templates?.["pre-expiry"] || NUDGE_TEMPLATE_DEFAULTS["pre-expiry"],
    },
  };
}

export async function loadFollowUpSettings(): Promise<FollowUpSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: FOLLOWUP_SETTING_KEY } });
  if (!row) {
    const value: FollowUpSettings = { ...CADENCE_DEFAULTS, templates: { ...NUDGE_TEMPLATE_DEFAULTS } };
    // lazy-create so the row exists (and is editable) from the first tick on;
    // a concurrent create is harmless — both write the same defaults
    await prisma.appSetting
      .create({ data: { key: FOLLOWUP_SETTING_KEY, value } })
      .catch(() => {});
    return value;
  }
  return withDefaults(row.value);
}
