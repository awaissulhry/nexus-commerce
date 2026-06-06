/**
 * Compliant Amazon review-insert cards (PDF).
 *
 * One printable A6 card per product: brand + product name + an HONEST-review
 * request + a QR code that opens the Amazon "write a review" page for that ASIN
 * on the buyer's marketplace. The customer scans, lands logged-in on Amazon's
 * review form, and submits.
 *
 * Amazon ToS guardrails baked into the copy: we ask for an *honest* review only
 * — never "positive", never an incentive, and never "contact us instead of a bad
 * review" (review gating is prohibited). A QR to Amazon's own review page is
 * allowed. Customer-facing copy localises per marketplace (it/de/fr/es/en); the
 * operator-facing app stays English.
 *
 * Reuses pdfkit + qrcode (see development-pack-pdf.service.ts).
 */

import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { logger } from '../../utils/logger.js'

export interface InsertProduct {
  name: string
  asin: string
  marketplace?: string | null
}

export interface ReviewInsertInput {
  brand: string
  marketplace: string
  products: InsertProduct[]
}

// marketplace short-code → Amazon TLD (mirrors MARKETPLACE_TZ in review-timing.service)
const MARKETPLACE_TLD: Record<string, string> = {
  IT: 'it', DE: 'de', FR: 'fr', ES: 'es', NL: 'nl', BE: 'com.be',
  PL: 'pl', SE: 'se', UK: 'co.uk', GB: 'co.uk', IE: 'ie', TR: 'com.tr',
}

function tldFor(code: string): string {
  return MARKETPLACE_TLD[(code || '').toUpperCase()] || 'it'
}

/** Amazon "write a review" deep link for an ASIN on the buyer's marketplace. */
function reviewUrl(asin: string, marketplace: string): string {
  return `https://www.amazon.${tldFor(marketplace)}/review/create-review?asin=${encodeURIComponent(asin)}`
}

type Lang = 'it' | 'de' | 'fr' | 'es' | 'en'

const MARKETPLACE_LANG: Record<string, Lang> = {
  IT: 'it', DE: 'de', FR: 'fr', ES: 'es', UK: 'en', GB: 'en', IE: 'en',
}

function langFor(code: string): Lang {
  return MARKETPLACE_LANG[(code || '').toUpperCase()] || 'en'
}

// All copy is honest-review only: no incentive, no "positive", no diversion.
const COPY: Record<Lang, { headline: string; body: (brand: string) => string; cta: string }> = {
  it: {
    headline: 'La tua opinione conta',
    body: (b) =>
      `Grazie per aver scelto ${b}. Se hai un momento, lascia una recensione onesta sul tuo acquisto: ci aiuti a migliorare e aiuti altri motociclisti a scegliere bene.`,
    cta: 'Inquadra il QR per lasciare una recensione su Amazon',
  },
  de: {
    headline: 'Deine Meinung zählt',
    body: (b) =>
      `Danke, dass du dich für ${b} entschieden hast. Wenn du einen Moment Zeit hast, hinterlasse eine ehrliche Bewertung zu deinem Kauf – du hilfst uns, besser zu werden, und anderen Bikern bei der Wahl.`,
    cta: 'Scanne den QR-Code, um auf Amazon zu bewerten',
  },
  fr: {
    headline: 'Votre avis compte',
    body: (b) =>
      `Merci d'avoir choisi ${b}. Si vous avez un instant, laissez un avis honnête sur votre achat : vous nous aidez à nous améliorer et aidez d'autres motards à bien choisir.`,
    cta: 'Scannez le QR pour laisser un avis sur Amazon',
  },
  es: {
    headline: 'Tu opinión cuenta',
    body: (b) =>
      `Gracias por elegir ${b}. Si tienes un momento, deja una reseña honesta sobre tu compra: nos ayudas a mejorar y ayudas a otros moteros a elegir bien.`,
    cta: 'Escanea el QR para dejar una reseña en Amazon',
  },
  en: {
    headline: 'Your opinion counts',
    body: (b) =>
      `Thanks for choosing ${b}. If you have a moment, please leave an honest review of your purchase — you help us improve and help other riders choose well.`,
    cta: 'Scan the QR to leave a review on Amazon',
  },
}

const INK = '#111111'
const ACCENT = '#dc2626'
const MUTED = '#555555'
const FAINT = '#999999'

function drawCard(doc: PDFKit.PDFDocument, brand: string, p: InsertProduct, qr: Buffer, marketplace: string) {
  const W = doc.page.width
  const M = doc.page.margins.left
  const cx = W / 2
  const innerW = W - 2 * M
  const lang = langFor(marketplace)
  const copy = COPY[lang]
  const name = p.name.length > 64 ? `${p.name.slice(0, 61)}…` : p.name

  // Every text() below is absolutely positioned and single-line except the
  // body, so we pass lineBreak:false to stop pdfkit from auto-appending a page
  // if a glyph nudges past the bottom margin (which would print a blank back).

  // brand wordmark
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(22)
  doc.text(brand.toUpperCase(), M, 32, { width: innerW, align: 'center', characterSpacing: 2, lineBreak: false })

  // accent rule
  doc.moveTo(cx - 26, 64).lineTo(cx + 26, 64).lineWidth(2).strokeColor(ACCENT).stroke()

  // headline
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
  doc.text(copy.headline, M, 78, { width: innerW, align: 'center', lineBreak: false })

  // body (the only wrapping block — sits high so it can never reach the margin)
  doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
  doc.text(copy.body(brand), M, 100, { width: innerW, align: 'center', lineGap: 1.5 })

  // QR centred
  const qrSize = 132
  const qrY = 154
  doc.image(qr, cx - qrSize / 2, qrY, { width: qrSize, height: qrSize })

  // CTA under the QR
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
  doc.text(copy.cta, M, qrY + qrSize + 8, { width: innerW, align: 'center', lineBreak: false })

  // footer: product name + the marketplace site (kept above the bottom margin)
  const footerY = doc.page.height - 56
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
  doc.text(name, M, footerY, { width: innerW, align: 'center', lineBreak: false, ellipsis: true })
  doc.fillColor(FAINT).fontSize(7)
  doc.text(`amazon.${tldFor(marketplace)}`, M, footerY + 14, { width: innerW, align: 'center', lineBreak: false })
}

export async function buildReviewInsertPdf(input: ReviewInsertInput): Promise<Buffer> {
  const brand = input.brand?.trim() || 'Xavia'
  const products = input.products.filter((p) => p.asin && p.asin.trim())

  const doc = new PDFDocument({ size: 'A6', margin: 28, autoFirstPage: false })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  if (products.length === 0) {
    doc.addPage()
    doc.fillColor(INK).font('Helvetica').fontSize(11)
    doc.text('No products with an Amazon ASIN to print.', 28, 120, {
      width: doc.page.width - 56,
      align: 'center',
    })
    doc.end()
    return done
  }

  for (const p of products) {
    const mk = (p.marketplace || input.marketplace || 'IT').toString()
    const url = reviewUrl(p.asin, mk)
    const qr = await QRCode.toBuffer(url, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
    doc.addPage()
    try {
      drawCard(doc, brand, p, qr, mk)
    } catch (err: any) {
      logger.warn('review-insert card draw failed', { asin: p.asin, error: err?.message })
    }
  }

  doc.end()
  return done
}
