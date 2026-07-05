/**
 * FP9.2 — render an Italian Fattura to PDF (pdfkit, server-only). Customer-
 * facing, so it is fed ONLY display fields (net prices) — no cost, no margin,
 * cost-free BY CONSTRUCTION like the quote PDF. VAT (IVA) is a display figure at
 * a single configurable rate, not a computed tax liability (FP9 is not accounting).
 */
import PDFDocument from "pdfkit";
import { vatDisplay } from "./rollup";

export type InvoiceLine = { description: string; qty: number; netUnitCents: number };
export type InvoiceSnapshot = {
  number: string;
  dateISO: string;
  orderNumber: string;
  partyName: string;
  lines: InvoiceLine[];
  netCents: number;
  vatRatePct: number;
};

const eur = (cents: number) => "€ " + (cents / 100).toFixed(2).replace(".", ",");
const dmy = (iso: string) => new Date(iso).toLocaleDateString("it-IT");

export function renderInvoicePdf(inv: InvoiceSnapshot, factoryName: string): Promise<Buffer> {
  const v = vatDisplay(inv.netCents, inv.vatRatePct);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).font("Helvetica-Bold").text(factoryName);
    doc.moveDown(0.2);
    doc.fontSize(14).fillColor("#1f6fde").text(`Fattura ${inv.number}`);
    doc.fillColor("#000").font("Helvetica").fontSize(10);
    doc.text(`Data: ${dmy(inv.dateISO)}`);
    doc.text(`Rif. ordine: ${inv.orderNumber}`);
    doc.moveDown(0.6);
    doc.fontSize(11).font("Helvetica-Bold").text("Cliente");
    doc.font("Helvetica").fontSize(11).text(inv.partyName);
    doc.moveDown(0.8);

    // line table
    const x = { desc: 50, qty: 330, price: 390, total: 470 };
    doc.fontSize(9).font("Helvetica-Bold").fillColor("#555");
    const head = doc.y;
    doc.text("Descrizione", x.desc, head);
    doc.text("Q.tà", x.qty, head);
    doc.text("Prezzo", x.price, head);
    doc.text("Imponibile", x.total, head);
    doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).stroke();
    doc.moveDown(0.5);
    doc.fillColor("#000").font("Helvetica").fontSize(10);
    for (const l of inv.lines) {
      const y = doc.y;
      doc.text(l.description, x.desc, y, { width: 270 });
      doc.text(String(l.qty), x.qty, y);
      doc.text(eur(l.netUnitCents), x.price, y);
      doc.text(eur(l.netUnitCents * l.qty), x.total, y);
      doc.moveDown(0.6);
    }

    doc.moveDown(0.4).moveTo(330, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.4);
    const totRow = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 12 : 10);
      doc.text(label, 330, y);
      doc.text(value, x.total, y);
      doc.moveDown(0.5);
    };
    totRow("Imponibile", eur(v.netCents));
    totRow(`IVA ${inv.vatRatePct}%`, eur(v.vatCents));
    totRow("Totale", eur(v.grossCents), true);

    doc.end();
  });
}
