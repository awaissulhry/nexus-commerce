/**
 * FP3.4 — PUBLIC: the customer requests changes / declines.
 * EPQ.5 — the rejection stores its own evidence bundle on the version the
 * token belongs to (same shape as acceptance: note, timestamp, hashed IP,
 * UA, pdf sha256, CGV version, view-event refs — typed name optional here;
 * a change request is not a contract signature).
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

export const permission = PUBLIC;

const Body = z.object({ note: z.string().max(1000).optional(), name: z.string().trim().max(200).optional() });

export const POST = guarded(PUBLIC, async (req, { params }) => {
  const { token } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const note = parsed.success ? parsed.data.note ?? null : null;
  const name = parsed.success ? parsed.data.name ?? null : null;
  const quote = await prisma.quote.findUnique({
    where: { acceptTokenHash: hashToken(token) },
    select: {
      id: true, number: true, state: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true, pdfRef: true, sentAt: true, sentSnapshot: true } },
    },
  });
  if (!quote) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (quote.state !== "SENT") return NextResponse.json({ error: "already_decided" }, { status: 409 });

  await prisma.quote.update({ where: { id: quote.id }, data: { state: "REJECTED", lostReason: note } });

  // EPQ.5 — rejection evidence (note + trail), same bundle shape as accept
  const version = quote.versions[0] ?? null;
  if (version) {
    const snapshot = (version.sentSnapshot ?? {}) as { cgv?: { version?: string } | null };
    const viewEvents = await prisma.quoteViewEvent.findMany({
      where: { quoteId: quote.id }, orderBy: { at: "asc" }, take: 500, select: { id: true },
    });
    const meta = viewerMeta(req);
    const evidence = buildEvidenceBundle({
      kind: "reject",
      typedName: name,
      note,
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

  void audit({ entityType: "quote", entityId: quote.id, action: "rejected", after: { via: "public link", note } });
  await notifyOwners({ title: `Quote ${quote.number}: customer requested changes`, body: note ?? undefined, entityId: quote.id, href: `/quotes?q=${quote.id}` });
  await publishEventDurable("pricing.updated", { quoteId: quote.id });
  return NextResponse.json({ ok: true });
});
