/**
 * FP3.4 — PUBLIC: the customer accepts the quote. Token is the auth.
 * EPQ.5 — acceptance that stands up: the page requires a typed "Nome e
 * cognome" (SES practice) and the route freezes an evidence bundle on the
 * QuoteVersion the token belongs to (CAD art. 20 probative criteria): sha256
 * of the exact frozen PDF, the CGV version the snapshot referenced, the typed
 * name, server timestamp, hashed IP + UA, and the view-event trail refs.
 * The response carries the deposit-payment block (Stripe env-gated + bank
 * fallback) so the thank-you view can offer payment immediately.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { hashToken } from "@/lib/quotes/public";
import { notifyOwners } from "@/lib/quotes/notify-owners";
import { viewerMeta } from "@/lib/quotes/views";
import { buildEvidenceBundle, sha256FileOrNull } from "@/lib/quotes/evidence";
import { loadBankDetails } from "@/lib/quotes/compliance-settings";
import { stripeEnabled } from "@/lib/stripe";

export const permission = PUBLIC;

const Body = z.object({ name: z.string().trim().min(2).max(200) });

export const POST = guarded(PUBLIC, async (req, { params }) => {
  const { token } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "name_required" }, { status: 422 });
  const quote = await prisma.quote.findUnique({
    where: { acceptTokenHash: hashToken(token) },
    select: {
      id: true, number: true, state: true, validUntilAt: true, conversationId: true, depositPct: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true, pdfRef: true, sentAt: true, sentSnapshot: true } },
    },
  });
  if (!quote) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (quote.state !== "SENT") return NextResponse.json({ error: "already_decided" }, { status: 409 });
  if (quote.validUntilAt && quote.validUntilAt.getTime() < Date.now()) return NextResponse.json({ error: "expired" }, { status: 410 });

  await prisma.quote.update({ where: { id: quote.id }, data: { state: "ACCEPTED" } });

  // EPQ.5 — evidence bundle, frozen on the version this token belongs to
  const version = quote.versions[0] ?? null;
  const snapshot = (version?.sentSnapshot ?? {}) as { cgv?: { version?: string } | null; depositCents?: number };
  if (version) {
    const viewEvents = await prisma.quoteViewEvent.findMany({
      where: { quoteId: quote.id }, orderBy: { at: "asc" }, take: 500, select: { id: true },
    });
    const meta = viewerMeta(req);
    const evidence = buildEvidenceBundle({
      kind: "accept",
      typedName: parsed.data.name,
      note: null,
      atISO: new Date().toISOString(),
      ipHash: meta.ipHash,
      ua: meta.ua,
      pdfSha256: sha256FileOrNull(version.pdfRef),
      cgvVersion: snapshot.cgv?.version ?? null,
      tokenVersion: version.version,
      sentAtISO: version.sentAt.toISOString(),
      viewEventIds: viewEvents.map((v) => v.id),
    });
    await prisma.quoteVersion.update({ where: { id: version.id }, data: { evidenceJson: evidence as object } });
  }

  // a customer reply reopens a closed thread
  if (quote.conversationId) await prisma.conversation.updateMany({ where: { id: quote.conversationId, state: "CLOSED" }, data: { state: "OPEN" } });
  void audit({ entityType: "quote", entityId: quote.id, action: "accepted", after: { via: "public link", typedName: parsed.data.name } });
  await notifyOwners({ title: `Quote ${quote.number} accepted by the customer`, body: `Signed: ${parsed.data.name}`, entityId: quote.id, href: `/quotes?q=${quote.id}` });
  await publishEventDurable("pricing.updated", { quoteId: quote.id });

  // EPQ.5 — deposit payment block for the thank-you view (D-1, env-gated)
  const depositCents = snapshot.depositCents ?? 0;
  const bankDetails = (await loadBankDetails()).trim() || null;
  return NextResponse.json({
    ok: true,
    deposit: depositCents > 0 ? { depositCents, paid: false, stripePayable: stripeEnabled(), bankDetails } : null,
  });
});
