/**
 * EPQ.5 — on-demand VIES check for a contact's VAT number (contacts entity,
 * quote-triggered: the button lives in the quote editor's Tax & legal rail
 * for EU-B2B parties). checkVatApprox against ec.europa.eu WITH our own VAT
 * (env FACTORY_VAT_NUMBER) so VIES mints a `requestIdentifier` — the canonical
 * audit proof for art. 41 zero-rating. Valid → the proof (requestIdentifier +
 * timestamp + returned trader name) is stored on the Party; invalid → any
 * stale proof is CLEARED (a lapsed number must not keep the gate open).
 * Offline/fault → graceful 503, nothing changes.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { checkViesVat, splitVat } from "@/lib/vies";

export const permission = FEATURES.contactsManage;

const Body = z.object({ vatNumber: z.string().trim().max(20).optional() });

export const POST = guarded(FEATURES.contactsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const party = await prisma.party.findUnique({ where: { id }, select: { id: true, name: true, vatNumber: true } });
  if (!party) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const vatRaw = (parsed.success ? parsed.data.vatNumber : undefined) || party.vatNumber;
  const vat = splitVat(vatRaw);
  if (!vat) return NextResponse.json({ error: "Enter the VAT number with its country prefix (e.g. DE123456789)" }, { status: 400 });

  // `||` not `??`: an empty-string env value counts as unset (PLAYBOOK trap 5)
  const requester = splitVat(process.env.FACTORY_VAT_NUMBER || null);
  if (!requester) {
    return NextResponse.json({ error: "Set FACTORY_VAT_NUMBER in apps/factory/.env (your own VAT, e.g. IT01234567890) — VIES only issues a consultation number to an identified requester" }, { status: 400 });
  }

  let result;
  try {
    result = await checkViesVat({ country: vat.country, number: vat.number, requesterCountry: requester.country, requesterNumber: requester.number });
  } catch (err) {
    console.error("[vies] unreachable:", (err as Error).message);
    return NextResponse.json({ error: "VIES is unreachable right now — try again in a few minutes" }, { status: 503 });
  }
  if (result.fault) {
    return NextResponse.json({ error: `VIES refused the check: ${result.fault} — try again later` }, { status: 503 });
  }

  const normalizedVat = `${vat.country}${vat.number}`;
  const now = new Date();
  await prisma.party.update({
    where: { id },
    data: result.valid
      ? { vatNumber: normalizedVat, viesRequestId: result.requestIdentifier, viesCheckedAt: now }
      : { vatNumber: normalizedVat, viesRequestId: null, viesCheckedAt: null }, // stale proof must not keep the art. 41 gate open
  });
  void audit({
    actorId: actor!.id, entityType: "party", entityId: id, action: "vies-checked",
    after: { vatNumber: normalizedVat, valid: result.valid, requestIdentifier: result.requestIdentifier, traderName: result.traderName },
  });
  await publishEventDurable("party.updated");
  return NextResponse.json({
    valid: result.valid,
    requestIdentifier: result.requestIdentifier,
    traderName: result.traderName,
    checkedAt: result.valid ? now.toISOString() : null,
  });
});
