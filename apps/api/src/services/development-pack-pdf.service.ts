/**
 * FP.6 — factory pack PDF for a development project.
 *
 * One document the factory can build from: cover (with confidential
 * watermark + revision) → brief/specs → size chart → materials/BOM →
 * colorways → embedded reference/sample images with captions → a QR file
 * index → merged PDF tech-pack pages appended at the end (pdf-lib).
 *
 * Reuses the factory-po-pdf approach (pdfkit + remote-image fetch). Labels
 * localise to EN/IT/ZH; the operator's typed content stays as entered.
 */

import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { PDFDocument as PdfLibDocument } from 'pdf-lib'
import { logger } from '../utils/logger.js'

export type PackLocale = 'en' | 'it' | 'zh'

export interface DevPackInput {
  locale: PackLocale
  company: { name: string; addressLines?: string[]; taxId?: string | null; email?: string | null }
  project: {
    code: string; name: string; productType: string | null; revision: number
    brief: string | null; specNotes: string | null; targetCostCents: number | null
    sizeChart: { columns: string[]; rows: Array<{ size: string; values: string[] }>; tolerance?: string } | null
    materials: Array<{ component: string; material: string; spec: string }> | null
    colorways: Array<{ name: string; pantone?: string; hex?: string }> | null
  }
  factoryName: string | null
  supplierName: string | null
  images: Array<{ url: string; caption: string | null }>
  pdfUrls: string[]
  otherFiles: Array<{ url: string; filename: string | null }>
}

const LABELS: Record<PackLocale, Record<string, string>> = {
  en: { pack: 'FACTORY PACK', project: 'Project', factoryName: 'Factory name', revision: 'Revision', date: 'Date', confidential: 'CONFIDENTIAL', brief: 'Brief', specs: 'Construction & special instructions', sizeChart: 'Size chart (cm)', size: 'Size', tolerance: 'Tolerance', materials: 'Materials / BOM', component: 'Component', material: 'Material', spec: 'Spec', colorways: 'Colorways', images: 'References & samples', files: 'File index', appendix: 'Appendix — tech packs', supplier: 'Supplier' },
  it: { pack: 'SCHEDA FABBRICA', project: 'Progetto', factoryName: 'Nome fabbrica', revision: 'Revisione', date: 'Data', confidential: 'RISERVATO', brief: 'Brief', specs: 'Costruzione e istruzioni speciali', sizeChart: 'Tabella taglie (cm)', size: 'Taglia', tolerance: 'Tolleranza', materials: 'Materiali / Distinta base', component: 'Componente', material: 'Materiale', spec: 'Specifica', colorways: 'Colorazioni', images: 'Riferimenti e campioni', files: 'Indice file', appendix: 'Appendice — schede tecniche', supplier: 'Fornitore' },
  zh: { pack: '工厂资料包', project: '项目', factoryName: '工厂名称', revision: '版本', date: '日期', confidential: '机密', brief: '简介', specs: '工艺与特别说明', sizeChart: '尺码表 (cm)', size: '尺码', tolerance: '公差', materials: '材料 / 物料清单', component: '部件', material: '材料', spec: '规格', colorways: '配色', images: '参考与样品', files: '文件索引', appendix: '附录 — 技术包', supplier: '供应商' },
}

const PAGE_MARGIN = 48
const HEADER_DARK = '#0f172a'
const TEXT_GREY = '#64748b'

async function fetchBuffer(url: string, timeoutMs = 6000): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return Buffer.from(new Uint8Array(await res.arrayBuffer()))
  } catch (err) {
    logger.warn('dev-pack: fetch failed', { url, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function renderDevelopmentPackPdf(input: DevPackInput): Promise<Buffer> {
  const L = LABELS[input.locale] ?? LABELS.en
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, autoFirstPage: true })
  // Note: pdfkit's default fonts don't render CJK glyphs; ZH labels may
  // fall back to boxes. Typed content + the structure still localise the
  // layout, which is the load-bearing part for the factory.
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

  const pageWidth = doc.page.width - PAGE_MARGIN * 2
  const watermark = () => {
    doc.save()
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
    doc.fontSize(64).fillColor('#000000').opacity(0.05)
      .text(L.confidential, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' })
    doc.opacity(1).restore()
  }
  const heading = (t: string) => {
    if (doc.y > doc.page.height - 120) doc.addPage()
    doc.moveDown(0.6).fontSize(13).font('Helvetica-Bold').fillColor(HEADER_DARK).text(t)
    doc.moveTo(PAGE_MARGIN, doc.y + 2).lineTo(doc.page.width - PAGE_MARGIN, doc.y + 2).strokeColor('#e2e8f0').stroke()
    doc.moveDown(0.5)
  }

  // ── Cover ──────────────────────────────────────────────────────────
  watermark()
  doc.fontSize(20).font('Helvetica-Bold').fillColor(HEADER_DARK).text(input.company.name, PAGE_MARGIN, PAGE_MARGIN)
  doc.fontSize(9).font('Helvetica').fillColor(TEXT_GREY)
  for (const line of input.company.addressLines ?? []) doc.text(line)
  if (input.company.taxId) doc.text(`Tax ID: ${input.company.taxId}`)
  doc.moveDown(2)
  doc.fontSize(28).font('Helvetica-Bold').fillColor('#1d4ed8').text(L.pack)
  doc.moveDown(0.4)
  doc.fontSize(18).fillColor(HEADER_DARK).text(input.factoryName || input.project.name)
  if (input.factoryName) doc.fontSize(11).fillColor(TEXT_GREY).text(`(${input.project.name})`)
  doc.moveDown(1)
  const meta: Array<[string, string]> = [
    [L.project, input.project.code],
    [L.revision, `Rev ${input.project.revision}`],
    [L.date, new Date().toISOString().slice(0, 10)],
  ]
  if (input.project.productType) meta.push(['Type', input.project.productType])
  if (input.supplierName) meta.push([L.supplier, input.supplierName])
  doc.fontSize(11).font('Helvetica')
  for (const [k, v] of meta) {
    doc.fillColor(TEXT_GREY).text(`${k}: `, { continued: true }).fillColor(HEADER_DARK).text(v)
  }

  // ── Brief ──────────────────────────────────────────────────────────
  if (input.project.brief?.trim()) {
    heading(L.brief)
    doc.fontSize(10).font('Helvetica').fillColor('#0f172a').text(input.project.brief.trim(), { width: pageWidth })
  }

  // ── Size chart ─────────────────────────────────────────────────────
  const sc = input.project.sizeChart
  if (sc && sc.rows.length > 0) {
    heading(L.sizeChart + (sc.tolerance ? `   (${L.tolerance}: ${sc.tolerance})` : ''))
    const cols = [L.size, ...sc.columns]
    const colW = pageWidth / cols.length
    let y = doc.y
    doc.fontSize(9).font('Helvetica-Bold').fillColor(HEADER_DARK)
    cols.forEach((c, i) => doc.text(c, PAGE_MARGIN + i * colW, y, { width: colW }))
    y = doc.y + 4
    doc.font('Helvetica').fillColor('#0f172a')
    for (const r of sc.rows) {
      if (y > doc.page.height - 80) { doc.addPage(); y = PAGE_MARGIN }
      const cells = [r.size, ...sc.columns.map((_, i) => r.values[i] ?? '')]
      cells.forEach((cell, i) => doc.text(cell, PAGE_MARGIN + i * colW, y, { width: colW }))
      y += 16
    }
    doc.y = y
  }

  // ── Materials / BOM ────────────────────────────────────────────────
  const mats = input.project.materials
  if (mats && mats.length > 0) {
    heading(L.materials)
    const cols = [L.component, L.material, L.spec]
    const colW = pageWidth / 3
    let y = doc.y
    doc.fontSize(9).font('Helvetica-Bold').fillColor(HEADER_DARK)
    cols.forEach((c, i) => doc.text(c, PAGE_MARGIN + i * colW, y, { width: colW }))
    y = doc.y + 4
    doc.font('Helvetica').fillColor('#0f172a')
    for (const m of mats) {
      if (y > doc.page.height - 80) { doc.addPage(); y = PAGE_MARGIN }
      ;[m.component, m.material, m.spec].forEach((cell, i) => doc.text(cell || '—', PAGE_MARGIN + i * colW, y, { width: colW - 6 }))
      y += 16
    }
    doc.y = y
  }

  // ── Colorways ──────────────────────────────────────────────────────
  const cw = input.project.colorways
  if (cw && cw.length > 0) {
    heading(L.colorways)
    let y = doc.y
    doc.fontSize(10).font('Helvetica')
    for (const c of cw) {
      if (y > doc.page.height - 70) { doc.addPage(); y = PAGE_MARGIN }
      if (c.hex && /^#[0-9a-f]{6}$/i.test(c.hex)) { doc.save(); doc.rect(PAGE_MARGIN, y, 16, 16).fill(c.hex); doc.restore() }
      doc.fillColor('#0f172a').text(`${c.name}${c.pantone ? `   ·   Pantone ${c.pantone}` : ''}${c.hex ? `   ·   ${c.hex}` : ''}`, PAGE_MARGIN + 24, y + 2)
      y += 24
    }
    doc.y = y
  }

  // ── Spec notes ─────────────────────────────────────────────────────
  if (input.project.specNotes?.trim()) {
    heading(L.specs)
    doc.fontSize(10).font('Helvetica').fillColor('#0f172a').text(input.project.specNotes.trim(), { width: pageWidth })
  }

  // ── Reference & sample images ──────────────────────────────────────
  if (input.images.length > 0) {
    heading(L.images)
    const cellW = (pageWidth - 16) / 2
    const imgH = 150
    let x = PAGE_MARGIN
    let y = doc.y
    for (const im of input.images) {
      if (y + imgH + 24 > doc.page.height - PAGE_MARGIN) { doc.addPage(); y = PAGE_MARGIN; x = PAGE_MARGIN }
      const buf = await fetchBuffer(im.url)
      try {
        if (buf) doc.image(buf, x, y, { fit: [cellW, imgH], align: 'center' })
        else doc.rect(x, y, cellW, imgH).strokeColor('#e2e8f0').stroke()
      } catch { doc.rect(x, y, cellW, imgH).strokeColor('#e2e8f0').stroke() }
      if (im.caption) doc.fontSize(8).fillColor(TEXT_GREY).text(im.caption, x, y + imgH + 2, { width: cellW })
      if (x === PAGE_MARGIN) { x = PAGE_MARGIN + cellW + 16 } else { x = PAGE_MARGIN; y += imgH + 24 }
    }
    doc.y = y + imgH + 24
  }

  // ── File index (QR links) ──────────────────────────────────────────
  const indexed = [...input.otherFiles, ...input.pdfUrls.map((u) => ({ url: u, filename: u.split('/').pop() ?? 'tech-pack.pdf' }))]
  if (indexed.length > 0) {
    heading(L.files)
    let y = doc.y
    for (const f of indexed) {
      if (y + 60 > doc.page.height - PAGE_MARGIN) { doc.addPage(); y = PAGE_MARGIN }
      try {
        const qrData = await QRCode.toBuffer(f.url, { margin: 0, width: 100 })
        doc.image(qrData, PAGE_MARGIN, y, { width: 48, height: 48 })
      } catch { /* skip QR on failure */ }
      doc.fontSize(9).fillColor('#0f172a').text(f.filename ?? 'file', PAGE_MARGIN + 56, y + 6, { width: pageWidth - 56, link: f.url, underline: true })
      y += 56
    }
    doc.y = y
  }

  doc.end()
  const bodyBuffer = await done

  // ── Merge PDF tech-packs as appendix pages (pdf-lib) ───────────────
  if (input.pdfUrls.length === 0) return bodyBuffer
  try {
    const merged = await PdfLibDocument.load(bodyBuffer)
    for (const url of input.pdfUrls) {
      const buf = await fetchBuffer(url, 10000)
      if (!buf) continue
      try {
        const src = await PdfLibDocument.load(buf, { ignoreEncryption: true })
        const pages = await merged.copyPages(src, src.getPageIndices())
        pages.forEach((pg) => merged.addPage(pg))
      } catch (err) {
        logger.warn('dev-pack: pdf merge skipped', { url, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return Buffer.from(await merged.save())
  } catch (err) {
    logger.warn('dev-pack: pdf-lib merge failed, returning body only', { error: err instanceof Error ? err.message : String(err) })
    return bodyBuffer
  }
}
