/**
 * FP3.3 — render a quote snapshot to a PDF (pdfkit, server-only). Customer-
 * facing → Italian labels (operator-language policy: app UI English, customer
 * content Italian). It is fed ONLY the QuoteSnapshot, which has no cost/margin,
 * so the PDF structurally cannot contain them.
 * EPQ.5 — per-tax-mode rendering: IT_B2C headlines the VAT-INCLUSIVE total
 * with gross line prices (the compliance fix); IT_B2B prints imponibile +
 * explicit IVA line + total; EU_B2B/EXTRA_EU print the non-imponibile note.
 * Deposit wording follows its legal character (acconto vs caparra — never
 * both labels on one sum), validity follows the revocable/irrevocable choice,
 * clauses (caparra symmetric wording, B2C bespoke withdrawal exclusion) and
 * the CGV reference print when present. A legacy snapshot (no `tax` block —
 * pre-EPQ.5 frozen versions) renders exactly as it always did.
 */
import PDFDocument from "pdfkit";
import type { QuoteSnapshot } from "./build-snapshot";
import { depositPdfLabel, normalizeDepositKind, normalizeValidityWording, validityLine } from "./legal";

const eur = (cents: number) => "€ " + (cents / 100).toFixed(2).replace(".", ",");
const dmy = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("it-IT") : "—");

export function renderQuotePdf(snapshot: QuoteSnapshot, factoryName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const tax = snapshot.tax ?? null; // EPQ.5 — legacy snapshots have none
    const grossFirst = tax?.grossFirst ?? false;

    // header
    doc.fontSize(20).font("Helvetica-Bold").text(factoryName, { continued: false });
    doc.moveDown(0.2);
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#1f6fde").text(`Preventivo ${snapshot.number}`);
    doc.fillColor("#000").font("Helvetica").fontSize(10);
    doc.text(`Data: ${dmy(snapshot.dateISO)}`);
    if (tax) {
      // EPQ.5 — validity as a deliberate wording choice (art. 1329 c.c.)
      doc.text(validityLine(normalizeValidityWording(snapshot.validityWording), dmy(snapshot.validUntilISO)));
    } else {
      doc.text(`Valido fino al: ${dmy(snapshot.validUntilISO)}`);
    }
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
    // EPQ.5 — a consumer table shows VAT-inclusive prices and says so
    doc.text(grossFirst ? "Prezzo (IVA incl.)" : "Prezzo", colUnit, headerY);
    doc.text("Totale", colTot, headerY);
    doc.moveTo(left, doc.y + 2).lineTo(545, doc.y + 2).strokeColor("#d8dde4").stroke();
    doc.moveDown(0.5).fillColor("#000");

    for (const line of snapshot.lines) {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(10).text(line.description, left, y, { width: 290 });
      doc.font("Helvetica").fontSize(10);
      doc.text(String(line.qty), colQty, y);
      doc.text(eur(grossFirst ? line.unitGrossCents ?? line.unitNetCents : line.unitNetCents), colUnit, y);
      doc.text(eur(grossFirst ? line.lineGrossCents ?? line.lineTotalCents : line.lineTotalCents), colTot, y);
      if (line.options.length) {
        doc.fontSize(8.5).fillColor("#5b6573").text(line.options.join(" · "), left + 8, doc.y, { width: 300 });
        doc.fillColor("#000");
      }
      doc.moveDown(0.6);
    }

    doc.moveTo(left, doc.y).lineTo(545, doc.y).strokeColor("#d8dde4").stroke();
    doc.moveDown(0.4);

    // right-aligned totals anchored at the left margin so the full width is
    // available (pdfkit otherwise continues from the last column's x and wraps)
    const totalRow = (str: string) => doc.text(str, left, doc.y, { width: 495, align: "right" });

    // ── totals, per tax mode (EPQ.5) ─────────────────────────────
    if (!tax) {
      // legacy frozen snapshot: exactly the historic net-only rendering
      doc.font("Helvetica-Bold").fontSize(12);
      totalRow(`Totale: ${eur(snapshot.totalCents)}`);
    } else if (tax.grossFirst) {
      // IT_B2C — GROSS-FIRST: the headline total includes IVA; net is secondary
      doc.font("Helvetica-Bold").fontSize(12);
      totalRow(`Totale (IVA ${tax.vatRatePct}% inclusa): ${eur(tax.totaleCents)}`);
      doc.font("Helvetica").fontSize(9).fillColor("#5b6573");
      totalRow(`Imponibile: ${eur(tax.imponibileCents)} · IVA ${tax.vatRatePct}%: ${eur(tax.ivaCents)}`);
      doc.fillColor("#000");
    } else if (tax.note) {
      // EU_B2B (VIES-proven) / EXTRA_EU — non-imponibile
      doc.font("Helvetica-Bold").fontSize(12);
      totalRow(`Totale: ${eur(tax.totaleCents)}`);
      doc.font("Helvetica").fontSize(9).fillColor("#5b6573");
      totalRow(tax.note);
      doc.fillColor("#000");
    } else {
      // IT_B2B — net + explicit IVA line + total
      doc.font("Helvetica").fontSize(10);
      totalRow(`Imponibile: ${eur(tax.imponibileCents)}`);
      totalRow(`IVA ${tax.vatRatePct}%: ${eur(tax.ivaCents)}`);
      doc.font("Helvetica-Bold").fontSize(12);
      totalRow(`Totale: ${eur(tax.totaleCents)}`);
    }

    if (snapshot.depositPct) {
      // EPQ.5 — ONE legal label per sum: acconto or caparra, never both
      const label = tax
        ? depositPdfLabel(normalizeDepositKind(snapshot.depositKind), snapshot.depositPct)
        : `Acconto (${snapshot.depositPct}%)`;
      doc.font("Helvetica").fontSize(10).fillColor("#5b6573");
      totalRow(`${label}: ${eur(snapshot.depositCents)}`);
      doc.fillColor("#000");
    }
    doc.moveDown(1);

    // EPQ.5 — legal clauses (caparra symmetric wording, B2C bespoke exclusion)
    const clauses = snapshot.clauses ?? [];
    if (clauses.length) {
      doc.font("Helvetica").fontSize(8.5).fillColor("#3a4452");
      for (const clause of clauses) {
        doc.text(clause, left, doc.y, { width: 495 });
        doc.moveDown(0.3);
      }
      doc.fillColor("#000");
      doc.moveDown(0.4);
    }

    if (snapshot.acceptUrl) {
      doc.fontSize(10).font("Helvetica").text("Per accettare questo preventivo:", left, doc.y, { continued: false });
      doc.fillColor("#1f6fde").text(snapshot.acceptUrl, { link: snapshot.acceptUrl, underline: true });
      doc.fillColor("#000");
    } else {
      doc.fontSize(10).fillColor("#5b6573").text("Per accettare, rispondi a questa email.", left, doc.y);
      doc.fillColor("#000");
    }
    doc.moveDown(1);

    // EPQ.5 — CGV reference (empty-safe: the builder omits the block until set)
    if (snapshot.cgv) {
      doc.fontSize(8).fillColor("#8a93a1");
      if (snapshot.cgv.url) {
        doc.text(`Condizioni generali di vendita v${snapshot.cgv.version}: `, left, doc.y, { continued: true });
        doc.fillColor("#1f6fde").text(snapshot.cgv.url, { link: snapshot.cgv.url, underline: true });
      } else {
        doc.text(`Si applicano le Condizioni generali di vendita v${snapshot.cgv.version}.`, left, doc.y);
      }
      doc.fillColor("#000");
      doc.moveDown(0.4);
    }

    doc.fontSize(8).fillColor("#8a93a1");
    if (!tax) {
      // legacy footer, unchanged
      doc.text("Prezzi IVA esclusa salvo diversa indicazione. Preventivo soggetto a conferma di disponibilità dei materiali.", left, doc.y);
    } else if (tax.grossFirst) {
      doc.text("Prezzi IVA inclusa. Preventivo soggetto a conferma di disponibilità dei materiali.", left, doc.y);
    } else {
      doc.text("Preventivo soggetto a conferma di disponibilità dei materiali.", left, doc.y);
    }

    doc.end();
  });
}
