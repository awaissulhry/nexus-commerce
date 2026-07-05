/**
 * FP8 — parcel presets: the Owner ships a handful of shapes (a folded jacket, a
 * suit in a box), so the buy panel offers presets instead of typing weight+dims
 * every time. Defaults live here (like FP4's DEFAULT_STAGES); the Owner overrides
 * them via the `shipping.parcelPresets` AppSetting. Pure — no Prisma.
 */

export type Parcel = { weightGrams: number; lengthCm: number; widthCm: number; heightCm: number };
export type ParcelPreset = { key: string; label: string } & Parcel;

/** Sensible starting shapes for leather apparel (heavy). The Owner edits these in Settings. */
export const DEFAULT_PRESETS: ParcelPreset[] = [
  { key: "S", label: "Small — accessory / gloves", weightGrams: 500, lengthCm: 30, widthCm: 20, heightCm: 5 },
  { key: "M", label: "Medium — folded jacket", weightGrams: 1500, lengthCm: 40, widthCm: 30, heightCm: 15 },
  { key: "L", label: "Large — suit / boxed", weightGrams: 3000, lengthCm: 50, widthCm: 40, heightCm: 25 },
];

/** Read presets from a raw AppSetting value, falling back to the defaults; drops malformed rows. */
export function resolvePresets(settingValue: unknown): ParcelPreset[] {
  const rows = (settingValue as { presets?: unknown } | null)?.presets;
  if (!Array.isArray(rows)) return DEFAULT_PRESETS;
  const clean = rows.filter(isPreset);
  return clean.length ? clean : DEFAULT_PRESETS;
}

export function parcelFromPreset(key: string, presets: ParcelPreset[] = DEFAULT_PRESETS): Parcel | null {
  const p = presets.find((x) => x.key === key);
  return p ? { weightGrams: p.weightGrams, lengthCm: p.lengthCm, widthCm: p.widthCm, heightCm: p.heightCm } : null;
}

/** A parcel is buyable only with a positive weight and three positive dimensions. */
export function isValidParcel(p: Partial<Parcel> | null | undefined): p is Parcel {
  return (
    !!p &&
    Number.isFinite(p.weightGrams) && (p.weightGrams as number) > 0 &&
    Number.isFinite(p.lengthCm) && (p.lengthCm as number) > 0 &&
    Number.isFinite(p.widthCm) && (p.widthCm as number) > 0 &&
    Number.isFinite(p.heightCm) && (p.heightCm as number) > 0
  );
}

function isPreset(x: unknown): x is ParcelPreset {
  const p = x as Record<string, unknown>;
  return (
    !!p && typeof p.key === "string" && p.key.length > 0 && typeof p.label === "string" &&
    typeof p.weightGrams === "number" && typeof p.lengthCm === "number" && typeof p.widthCm === "number" && typeof p.heightCm === "number"
  );
}
