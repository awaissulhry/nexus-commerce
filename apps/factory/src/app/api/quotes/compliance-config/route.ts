/**
 * EPQ.5 — quote compliance config: the CGV reference {version, url, text} and
 * the bank-transfer instructions, both AppSetting rows edited from the Legal
 * gear on the Quotes page (home-page rule — the Settings PAGE belongs to
 * another session). CGV CONTENT is the Owner's input; rendering everywhere is
 * empty-safe until it lands.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { BANK_DETAILS_SETTING_KEY, CGV_SETTING_KEY, loadBankDetails, loadCgv } from "@/lib/quotes/compliance-settings";

export const permission = FEATURES.quotesSend;

export const GET = guarded(FEATURES.quotesSend, async () => {
  const [cgv, bankDetails] = await Promise.all([loadCgv(), loadBankDetails()]);
  return NextResponse.json({ cgv, bankDetails });
});

const Patch = z.object({
  cgv: z
    .object({
      version: z.string().trim().max(20),
      url: z.string().trim().max(300),
      text: z.string().max(20_000),
    })
    .optional(),
  bankDetails: z.string().max(2000).optional(),
});

export const PATCH = guarded(FEATURES.quotesSend, async (req, { actor }) => {
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid configuration" }, { status: 400 });

  if (parsed.data.cgv) {
    const before = await loadCgv(); // lazy-creates the row on first touch
    const value = parsed.data.cgv;
    await prisma.appSetting.update({ where: { key: CGV_SETTING_KEY }, data: { value } });
    void audit({
      actorId: actor!.id, entityType: "settings", entityId: CGV_SETTING_KEY, action: "updated",
      before: { version: before.version, url: before.url }, after: { version: value.version, url: value.url },
    });
  }
  if (parsed.data.bankDetails !== undefined) {
    const value = { text: parsed.data.bankDetails };
    await prisma.appSetting.upsert({
      where: { key: BANK_DETAILS_SETTING_KEY },
      create: { key: BANK_DETAILS_SETTING_KEY, value },
      update: { value },
    });
    void audit({ actorId: actor!.id, entityType: "settings", entityId: BANK_DETAILS_SETTING_KEY, action: "updated" });
  }
  await publishEventDurable("settings.updated", { key: CGV_SETTING_KEY });
  const [cgv, bankDetails] = await Promise.all([loadCgv(), loadBankDetails()]);
  return NextResponse.json({ cgv, bankDetails });
});
