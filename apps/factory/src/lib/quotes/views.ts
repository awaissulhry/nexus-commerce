/**
 * EPQ.2 — view tracking for the public quote page. One QuoteViewEvent row per
 * open (latest OR superseded token — `version` says which send was viewed) +
 * the Quote counters in a single update. Called fire-and-forget (`void …`)
 * from the public GET so the customer's page NEVER blocks on bookkeeping.
 * Privacy: sha256(ip) only — the raw address is never stored.
 */
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { publishEventDurable } from "@/lib/events";
import { notifyOwners } from "./notify-owners";

export function viewerMeta(req: NextRequest): { ipHash: string | null; ua: string | null } {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const ua = req.headers.get("user-agent")?.slice(0, 300) || null;
  return { ipHash: ip ? createHash("sha256").update(ip).digest("hex") : null, ua };
}

export async function recordQuoteView(input: {
  quoteId: string;
  number: string;
  version: number;
  state: string;
  /** counters as read by the public GET — first-view detection (0 → 1) */
  viewCount: number;
  firstViewedAt: Date | null;
  ipHash: string | null;
  ua: string | null;
}): Promise<void> {
  try {
    const now = new Date();
    await prisma.quoteViewEvent.create({
      data: { quoteId: input.quoteId, version: input.version, ipHash: input.ipHash, ua: input.ua },
    });
    // counters in ONE update; firstViewedAt only lands once
    await prisma.quote.update({
      where: { id: input.quoteId },
      data: {
        viewCount: { increment: 1 },
        lastViewedAt: now,
        ...(input.firstViewedAt ? {} : { firstViewedAt: now }),
      },
    });
    // first view of a live offer — the moment the Owner has waited for
    if (input.state === "SENT" && input.viewCount === 0) {
      await notifyOwners({
        title: `Preventivo ${input.number} visto dal cliente`,
        entityId: input.quoteId,
        href: `/quotes?q=${input.quoteId}`,
      });
    }
    await publishEventDurable("pricing.updated", { quoteId: input.quoteId });
  } catch (err) {
    // fire-and-forget by contract: log loudly, never surface to the customer
    console.error("[quotes] view record failed:", (err as Error).message);
  }
}
