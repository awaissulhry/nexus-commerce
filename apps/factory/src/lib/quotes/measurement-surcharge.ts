/**
 * EPQ.3 — measurement-surcharge rule, stored in ONE AppSetting
 * ("quotes.measurementSurcharge") and lazy-created with the defaults the first
 * time compose asks (same pattern as followup-settings). The rule only FIRES
 * when a line's selection includes a parseable size option ≥ the threshold —
 * the live catalog has no size groups yet, so it is dormant (zero-delta) until
 * sizes are modeled; value 0 disables it outright.
 */
import { prisma } from "@/lib/db";
import type { DeltaMode, SizeSurchargeRule } from "@/lib/pricing";

export const MEASUREMENT_SURCHARGE_KEY = "quotes.measurementSurcharge";

/** Spec defaults (EPQ-PROPOSAL §5 EPQ.3): size ≥ 58 ⇒ +8% of the resolved base. */
export const MEASUREMENT_SURCHARGE_DEFAULTS: SizeSurchargeRule = { sizeThreshold: 58, mode: "PERCENT", value: 800 };

/** Defaults merged over whatever is stored — a partial row never breaks compose. */
export function withSurchargeDefaults(value: unknown): SizeSurchargeRule {
  const v = (value ?? {}) as Partial<SizeSurchargeRule>;
  const threshold = typeof v.sizeThreshold === "number" && Number.isFinite(v.sizeThreshold)
    ? Math.round(v.sizeThreshold)
    : MEASUREMENT_SURCHARGE_DEFAULTS.sizeThreshold;
  const mode: DeltaMode = v.mode === "ABSOLUTE" || v.mode === "PERCENT" ? v.mode : MEASUREMENT_SURCHARGE_DEFAULTS.mode;
  const val = typeof v.value === "number" && Number.isFinite(v.value) ? Math.round(v.value) : MEASUREMENT_SURCHARGE_DEFAULTS.value;
  return { sizeThreshold: threshold, mode, value: val };
}

export async function loadMeasurementSurcharge(): Promise<SizeSurchargeRule> {
  const row = await prisma.appSetting.findUnique({ where: { key: MEASUREMENT_SURCHARGE_KEY } });
  if (!row) {
    // lazy-create so the row exists (and is editable) from first use; a
    // concurrent create is harmless — both write the same defaults
    await prisma.appSetting
      .create({ data: { key: MEASUREMENT_SURCHARGE_KEY, value: MEASUREMENT_SURCHARGE_DEFAULTS } })
      .catch(() => {});
    return { ...MEASUREMENT_SURCHARGE_DEFAULTS };
  }
  return withSurchargeDefaults(row.value);
}
