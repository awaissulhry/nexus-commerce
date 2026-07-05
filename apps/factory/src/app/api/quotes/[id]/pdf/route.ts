/**
 * FP3.3 — quote PDF for the Owner: a frozen version's stored PDF (?version=)
 * or a live preview of the current draft. Built from the customer-facing
 * snapshot only (no cost/margin can appear).
 */
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { buildQuoteSnapshot } from "@/lib/quotes/build-snapshot";
import { renderQuotePdf } from "@/lib/quotes/render-pdf";

export const permission = PAGES.quotes;

export const GET = guarded(PAGES.quotes, async (req: NextRequest, { params }) => {
  const { id } = await params;
  const versionParam = req.nextUrl.searchParams.get("version");

  if (versionParam) {
    const v = await prisma.quoteVersion.findFirst({ where: { quoteId: id, version: Number(versionParam) }, select: { pdfRef: true } });
    if (v?.pdfRef && fs.existsSync(v.pdfRef)) {
      return new Response(new Uint8Array(fs.readFileSync(v.pdfRef)), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="quote-v${versionParam}.pdf"` } });
    }
  }

  const snapshot = await buildQuoteSnapshot(id, null);
  if (!snapshot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const factoryNameRow = await prisma.appSetting.findUnique({ where: { key: "factory.name" } });
  const factoryName = (factoryNameRow?.value as { name?: string })?.name ?? "Nexus Factory";
  const pdf = await renderQuotePdf(snapshot, factoryName);
  return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${snapshot.number}.pdf"` } });
});
