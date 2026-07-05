/**
 * FP8 — a real one-page shipping-label PDF. The FakeCarrier renders it so the
 * whole buy→print→stream path is provable with a genuine PDF (no live account,
 * no spend); the real Sendcloud adapter returns the carrier's own label instead.
 * Also backs the FP8.4 day-sheet manifest. Server-only (pdfkit).
 */
import PDFDocument from "pdfkit";
import type { Address } from "../carriers/types";

export type LabelInput = {
  orderNumber: string;
  trackingNumber: string;
  carrier: string;
  service: string;
  to: Address;
  from?: Address | null;
};

export function renderLabelPdf(input: LabelInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // A6 landscape ≈ a 4×6 thermal label
    const doc = new PDFDocument({ size: [298, 420], margin: 18 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(9).font("Helvetica-Bold").fillColor("#000").text(input.carrier.toUpperCase(), { continued: true });
    doc.font("Helvetica").text(`   ${input.service}`);
    doc.moveTo(18, 40).lineTo(280, 40).stroke();

    if (input.from) {
      doc.moveDown(0.4).fontSize(7).font("Helvetica").fillColor("#555").text("FROM");
      doc.fillColor("#000").fontSize(8).text(addrLines(input.from).join("  ·  "));
    }

    doc.moveDown(0.6).fontSize(7).font("Helvetica").fillColor("#555").text("SHIP TO");
    doc.fillColor("#000").fontSize(12).font("Helvetica-Bold").text(input.to.name);
    doc.fontSize(10).font("Helvetica");
    for (const line of addrLines(input.to)) doc.text(line);

    doc.moveDown(0.8).moveTo(18, doc.y).lineTo(280, doc.y).stroke();
    doc.moveDown(0.4).fontSize(8).fillColor("#555").text(`Order ${input.orderNumber}`);
    doc.fillColor("#000").fontSize(13).font("Helvetica-Bold").text(input.trackingNumber);
    // a faux barcode band so the label reads like a label
    doc.moveDown(0.3);
    const y = doc.y;
    let x = 18;
    for (let i = 0; i < 90 && x < 278; i++) {
      const w = 1 + (i % 4);
      if (i % 2 === 0) doc.rect(x, y, w, 40).fill("#000");
      x += w + 1;
    }
    doc.fillColor("#000");
    doc.end();
  });
}

function addrLines(a: Address): string[] {
  const out: string[] = [];
  if (a.company) out.push(a.company);
  out.push(a.street + (a.street2 ? `, ${a.street2}` : ""));
  out.push(`${a.postalCode} ${a.city}`.trim());
  out.push(a.country);
  if (a.phone) out.push(a.phone);
  return out.filter((l) => l && l.trim().length > 0);
}
