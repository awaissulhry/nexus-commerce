/**
 * FP3.3 — render a quote snapshot to a PDF (pdfkit, server-only). Customer-
 * facing → Italian labels (operator-language policy: app UI English, customer
 * content Italian). It is fed ONLY the QuoteSnapshot, which has no cost/margin,
 * so the PDF structurally cannot contain them.
 *
 * FS5 (S-14) — split into one drawing core and two delivery shapes:
 *   · renderQuotePdfStream — the HTTP route's shape: PDFDocument IS a Node
 *     Readable, bridged to a web ReadableStream (`Readable.toWeb`, real
 *     backpressure) so the response never holds the whole document.
 *   · renderQuotePdf (Buffer) — kept for the send route ONLY: a Gmail
 *     attachment is base64 of the complete bytes, so a full buffer is
 *     inherent to that consumer, not a leak.
 */
import { Readable } from "node:stream";
import PDFDocument from "pdfkit";
import type { QuoteSnapshot } from "./build-snapshot";

const eur = (cents: number) => "€ " + (cents / 100).toFixed(2).replace(".", ",");
const dmy = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("it-IT") : "—");

/** FS5 — streamed variant for HTTP responses (drawing is synchronous; bytes flow as consumed). */
export function renderQuotePdfStream(snapshot: QuoteSnapshot, factoryName: string): ReadableStream<Uint8Array> {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  drawQuotePdf(doc, snapshot, factoryName);
  doc.end();
  return Readable.toWeb(doc) as ReadableStream<Uint8Array>;
}

/** Full-buffer variant — the Gmail-attachment consumer (send route) needs complete bytes. */
export function renderQuotePdf(snapshot: QuoteSnapshot, factoryName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    drawQuotePdf(doc, snapshot, factoryName);
    doc.end();
  });
}

function drawQuotePdf(doc: PDFKit.PDFDocument, snapshot: QuoteSnapshot, factoryName: string): void {
  // header
  doc.fontSize(20).font("Helvetica-Bold").text(factoryName, { continued: false });
  doc.moveDown(0.2);
  doc.fontSize(14).font("Helvetica-Bold").fillColor("#1f6fde").text(`Preventivo ${snapshot.number}`);
  doc.fillColor("#000").font("Helvetica").fontSize(10);
  doc.text(`Data: ${dmy(snapshot.dateISO)}`);
  doc.text(`Valido fino al: ${dmy(snapshot.validUntilISO)}`);
  doc.moveDown(0.6);
  doc.fontSize(11).font("Helvetica-Bold").text("Cliente");
  doc.font("Helvetica").fontSize(11).text(snapshot.partyName);
  doc.moveDown(0.8);

  // table header
  const left = 50, colQty = 350, colUnit = 400, colTot = 480;
  doc.fontSize(9).font("Helvetica-Bold").fillColor("#5b6573");
  doc.text("Descrizione", left, doc.y, { continued: false });
  const headerY = doc.y - 11;
  doc.text("Q.tà", colQty, headerY);
  doc.text("Prezzo", colUnit, headerY);
  doc.text("Totale", colTot, headerY);
  doc.moveTo(left, doc.y + 2).lineTo(545, doc.y + 2).strokeColor("#d8dde4").stroke();
  doc.moveDown(0.5).fillColor("#000");

  for (const line of snapshot.lines) {
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(10).text(line.description, left, y, { width: 290 });
    doc.font("Helvetica").fontSize(10);
    doc.text(String(line.qty), colQty, y);
    doc.text(eur(line.unitNetCents), colUnit, y);
    doc.text(eur(line.lineTotalCents), colTot, y);
    if (line.options.length) {
      doc.fontSize(8.5).fillColor("#5b6573").text(line.options.join(" · "), left + 8, doc.y, { width: 300 });
      doc.fillColor("#000");
    }
    doc.moveDown(0.6);
  }

  doc.moveTo(left, doc.y).lineTo(545, doc.y).strokeColor("#d8dde4").stroke();
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(12).text(`Totale: ${eur(snapshot.totalCents)}`, { align: "right" });
  if (snapshot.depositPct) {
    doc.font("Helvetica").fontSize(10).fillColor("#5b6573").text(`Acconto (${snapshot.depositPct}%): ${eur(snapshot.depositCents)}`, { align: "right" });
    doc.fillColor("#000");
  }
  doc.moveDown(1);

  if (snapshot.acceptUrl) {
    doc.fontSize(10).font("Helvetica").text("Per accettare questo preventivo:", { continued: false });
    doc.fillColor("#1f6fde").text(snapshot.acceptUrl, { link: snapshot.acceptUrl, underline: true });
    doc.fillColor("#000");
  } else {
    doc.fontSize(10).fillColor("#5b6573").text("Per accettare, rispondi a questa email.");
    doc.fillColor("#000");
  }
  doc.moveDown(1);
  doc.fontSize(8).fillColor("#8a93a1").text("Prezzi IVA esclusa salvo diversa indicazione. Preventivo soggetto a conferma di disponibilità dei materiali.");
}
