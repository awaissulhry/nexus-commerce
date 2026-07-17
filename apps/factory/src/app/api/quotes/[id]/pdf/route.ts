/**
 * FP3.3 — quote PDF for the Owner: a frozen version's stored PDF (?version=)
 * or a live preview of the current draft. Built from the customer-facing
 * snapshot only (no cost/margin can appear).
 * FS5 (S-14) — both shapes now STREAM: the frozen file goes out as an fs
 * read stream (Content-Length from stat, no readFileSync buffer), the live
 * preview bridges pdfkit's Readable straight into the response. Invoice PDFs
 * keep their buffered read for now — EPF territory (recorded handoff).
 */
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { buildQuoteSnapshot } from "@/lib/quotes/build-snapshot";
import { renderQuotePdfStream } from "@/lib/quotes/render-pdf";

export const permission = PAGES.quotes;

export const GET = guarded(PAGES.quotes, async (req: NextRequest, { params }) => {
  const { id } = await params;
  const versionParam = req.nextUrl.searchParams.get("version");

  if (versionParam) {
    const v = await prisma.quoteVersion.findFirst({ where: { quoteId: id, version: Number(versionParam) }, select: { pdfRef: true } });
    if (v?.pdfRef && fs.existsSync(v.pdfRef)) {
      const size = fs.statSync(v.pdfRef).size;
      const file = Readable.toWeb(fs.createReadStream(v.pdfRef)) as ReadableStream<Uint8Array>;
      return new Response(file, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(size),
          "Content-Disposition": `inline; filename="quote-v${versionParam}.pdf"`,
        },
      });
    }
  }

  const snapshot = await buildQuoteSnapshot(id, null);
  if (!snapshot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const factoryNameRow = await prisma.appSetting.findUnique({ where: { key: "factory.name" } });
  const factoryName = (factoryNameRow?.value as { name?: string })?.name ?? "Nexus Factory";
  return new Response(renderQuotePdfStream(snapshot, factoryName), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${snapshot.number}.pdf"` },
  });
});
