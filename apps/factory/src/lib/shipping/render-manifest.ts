/**
 * FP8.4 — the day-sheet: a printable manifest of today's parcels for the driver
 * handover. Operational (no money) — order, customer, carrier, tracking. Server-
 * only (pdfkit), A4 portrait.
 */
import PDFDocument from "pdfkit";

export type ManifestRow = { orderNumber: string; partyName: string; service: string | null; trackingNumber: string | null };

export function renderManifestPdf(rows: ManifestRow[], factoryName: string, dateLabel: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 46 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).font("Helvetica-Bold").text(factoryName);
    doc.fontSize(13).fillColor("#1f6fde").text(`Day-sheet · ${dateLabel}`);
    doc.fillColor("#000").font("Helvetica").fontSize(10).text(`${rows.length} parcel${rows.length === 1 ? "" : "s"}`);
    doc.moveDown(0.6);

    const cols = [46, 120, 300, 420]; // x for #, order, customer→carrier, tracking
    doc.fontSize(9).font("Helvetica-Bold");
    doc.text("#", cols[0], doc.y, { continued: false });
    const headerY = doc.y - 11;
    doc.text("Order", cols[1], headerY);
    doc.text("Customer", cols[2], headerY);
    doc.text("Tracking", cols[3], headerY);
    doc.moveTo(46, doc.y + 2).lineTo(549, doc.y + 2).stroke();
    doc.moveDown(0.5);

    doc.font("Helvetica").fontSize(9);
    rows.forEach((r, i) => {
      const y = doc.y;
      doc.text(String(i + 1), cols[0], y);
      doc.text(r.orderNumber, cols[1], y, { width: 170 });
      doc.text(`${r.partyName}${r.service ? ` · ${r.service}` : ""}`, cols[2], y, { width: 115 });
      doc.text(r.trackingNumber ?? "—", cols[3], y, { width: 129 });
      doc.moveDown(0.7);
    });

    if (rows.length === 0) doc.fillColor("#888").text("No parcels shipped today.", 46);
    doc.end();
  });
}
