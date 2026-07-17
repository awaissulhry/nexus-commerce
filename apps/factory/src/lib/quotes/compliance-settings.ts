/**
 * EPQ.5 — quote compliance settings, two AppSetting rows edited from the
 * Legal gear on the Quotes page (home-page rule; the Settings PAGE belongs to
 * another session):
 *   · quotes.cgv         {version, url, text} — the CGV reference the PDF +
 *     accept page print and the acceptance evidence records. Content is the
 *     Owner's input; rendering is empty-safe (line omitted until set).
 *   · quotes.bankDetails {text} — bank-transfer instructions, the always-on
 *     deposit fallback on the acceptance page (Stripe or not).
 */
import { prisma } from "@/lib/db";
import { CGV_DEFAULTS, withCgvDefaults, type CgvSetting } from "./legal";

export const CGV_SETTING_KEY = "quotes.cgv";
export const BANK_DETAILS_SETTING_KEY = "quotes.bankDetails";

export async function loadCgv(): Promise<CgvSetting> {
  const row = await prisma.appSetting.findUnique({ where: { key: CGV_SETTING_KEY } });
  if (!row) {
    // lazy-create so the gear edits an existing row; concurrent create is harmless
    await prisma.appSetting.create({ data: { key: CGV_SETTING_KEY, value: CGV_DEFAULTS } }).catch(() => {});
    return { ...CGV_DEFAULTS };
  }
  return withCgvDefaults(row.value);
}

export async function loadBankDetails(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: BANK_DETAILS_SETTING_KEY } });
  const v = (row?.value ?? {}) as { text?: string };
  return typeof v.text === "string" ? v.text : "";
}
