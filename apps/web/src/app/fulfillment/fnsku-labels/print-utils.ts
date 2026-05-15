import type { LabelItem, TemplateConfig } from './types'
import { getRowValue } from './LabelPreview'

// CODE128B encoder — outputs a scaled SVG string.
// The barcode is rendered at exactly widthMm wide by applying a uniform
// scale factor to all bar x-positions and widths, preserving relative
// proportions so the barcode remains scannable.
const PATTERNS: readonly string[] = [
  '212222','222122','222221','121223','121322','131222','122213','122312',
  '132212','221213','221312','231212','112232','122132','122231','113222',
  '123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321',
  '232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321',
  '331121','312113','312311','332111','314111','221411','431111','111224',
  '111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112',
  '421211','212141','214121','412121','111143','111341','131141','114113',
  '114311','411113','411311','113141','114131','311141','411131','211412',
  '211214','211232','2331112',
]
const START_B = 104
const STOP = 106

function barcodeSvg(value: string, widthMm: number, heightMm: number): string {
  const safe = String(value ?? '').replace(/[^\x20-\x7E]/g, '?')
  const codes: number[] = []
  for (const ch of safe) {
    const v = ch.charCodeAt(0) - 32
    codes.push(v >= 0 && v <= 95 ? v : '?'.charCodeAt(0) - 32)
  }
  const checksum = (START_B + codes.reduce((acc, c, i) => acc + c * (i + 1), 0)) % 103
  const sequence = [START_B, ...codes, checksum, STOP]

  // Use module width of 1 unit, then scale uniformly to fit widthMm.
  // Uniform scaling preserves all bar-width ratios → barcode stays scannable.
  const bars: { x: number; w: number }[] = []
  let cursor = 0
  for (const sym of sequence) {
    const pat = PATTERNS[sym]
    if (!pat) continue
    let isBar = true
    for (const ch of pat) {
      const w = parseInt(ch, 10)
      if (isBar) bars.push({ x: cursor, w })
      cursor += w
      isBar = !isBar
    }
  }
  const totalUnits = cursor
  const scale = widthMm / totalUnits

  const rects = bars.map(b =>
    `<rect x="${(b.x * scale).toFixed(3)}" y="0" width="${(b.w * scale).toFixed(3)}" height="${heightMm}" fill="black"/>`,
  ).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}"><rect x="0" y="0" width="${widthMm}" height="${heightMm}" fill="white"/>${rects}</svg>`
}

function renderLabelHtml(item: LabelItem, template: TemplateConfig): string {
  const { widthMm, heightMm } = template.labelSize
  const rightPct   = Math.max(15, Math.min(55, template.columnSplitPct ?? 38)) / 100
  const rightColMm = widthMm * rightPct
  const leftColMm  = widthMm - rightColMm
  const padMm      = template.paddingMm ?? 2
  const innerMm    = rightColMm - padMm * 2
  const barW       = Math.max(5, innerMm * ((template.barcodeWidthPct ?? 100) / 100))
  const barH       = heightMm * ((template.barcodeHeightPct ?? 32) / 100)
  const fontFam    = template.fontFamily ?? 'Arial, Helvetica, sans-serif'
  const badgeScale = template.badgeFontScale ?? 1
  const valueScale = template.valueFontScale ?? 1
  const divider    = (template.showColumnDivider ?? true) ? '0.3mm solid #ddd' : 'none'
  const sizeLabel  = template.sizeBoxLabel || 'SIZE'
  const titleLines = template.listingTitleLines ?? 2

  const activeRows = template.rows.filter(r => r.show)
  const attrs = item.variationAttributes ?? {}
  const sizeVal = attrs['Size'] ?? attrs['size'] ?? ''

  const barcodeHtml = item.fnsku
    ? `<div style="width:${barW}mm;">${barcodeSvg(item.fnsku, barW, barH)}</div>
       <div style="font-size:${Math.min(heightMm * 0.063, barW / (item.fnsku.length * 0.55 + 2))}mm;font-family:${fontFam};letter-spacing:0.05em;text-align:center;margin-top:0.5mm;white-space:nowrap;">${item.fnsku}</div>
       ${template.showListingTitle && item.listingTitle ? `<div style="font-size:${heightMm * 0.052}mm;color:#333;text-align:center;line-height:1.2;margin-top:0.5mm;max-width:${barW}mm;overflow:hidden;display:-webkit-box;-webkit-line-clamp:${titleLines};-webkit-box-orient:vertical;">${item.listingTitle}</div>` : ''}
       ${template.showCondition ? `<div style="font-size:${heightMm * 0.052}mm;color:#333;text-align:center;margin-top:0.5mm;">${template.condition || 'New'}</div>` : ''}`
    : `<div style="width:${barW}mm;height:${barH}mm;border:0.3mm dashed #ccc;border-radius:1mm;display:flex;align-items:center;justify-content:center;color:#bbb;font-size:${heightMm * 0.07}mm;">No FNSKU</div>`

  const rowsHtml = activeRows.map((row, i) => {
    const value = getRowValue(row, item)
    const isFirst = i === 0
    const baseFsVm = isFirst ? 0.13 : 0.10
    const fs = heightMm * baseFsVm * valueScale * (row.fontScale ?? 1)
    const badgeFs = heightMm * 0.07 * badgeScale
    const tx = row.textTransform ?? 'uppercase'
    const fw = row.boldValue !== false ? (isFirst ? 900 : 700) : 400
    return `<div style="display:flex;align-items:center;gap:${widthMm * 0.015}mm;margin-bottom:${heightMm * 0.025}mm;">
      <div style="background:#111;color:#fff;font-weight:700;font-size:${badgeFs}mm;padding:${heightMm * 0.02}mm ${heightMm * 0.03}mm;border-radius:0.8mm;white-space:nowrap;letter-spacing:0.03em;text-transform:uppercase;flex-shrink:0;min-width:${heightMm * 0.45 * badgeScale}mm;text-align:center;">${row.badgeText || '—'}</div>
      <div style="font-weight:${fw};font-size:${fs}mm;color:#000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:${isFirst ? '-0.02em' : '0.02em'};text-transform:${tx};line-height:1.1;">${value || '—'}</div>
    </div>`
  }).join('')

  const sizeBoxHtml = template.showSizeBox ? `
    <div style="display:flex;flex-direction:column;align-items:center;border:0.5mm solid #111;border-radius:1mm;padding:${heightMm * 0.01}mm ${heightMm * 0.015}mm;margin-bottom:${padMm}mm;flex-shrink:0;">
      <div style="background:#111;color:#fff;font-weight:700;font-size:${heightMm * 0.06}mm;letter-spacing:0.1em;text-transform:uppercase;width:100%;text-align:center;border-radius:0.5mm;padding:${heightMm * 0.005}mm 0;">${sizeLabel}</div>
      <div style="font-size:${heightMm * 0.19}mm;font-weight:900;color:#000;line-height:1;margin-top:${heightMm * 0.01}mm;">${sizeVal || '—'}</div>
    </div>` : ''

  const logoHtml = template.showLogo ? (
    template.logoUrl
      ? `<div style="margin-bottom:${padMm}mm;flex-shrink:0;"><img src="${template.logoUrl}" style="max-height:${heightMm * 0.22}mm;max-width:${leftColMm - padMm * 2}mm;object-fit:contain;" /></div>`
      : `<div style="height:${heightMm * 0.22}mm;margin-bottom:${padMm}mm;flex-shrink:0;display:flex;align-items:center;"><span style="font-size:${heightMm * 0.1}mm;font-weight:900;letter-spacing:-0.04em;background:#000;color:#fff;padding:${heightMm * 0.01}mm ${heightMm * 0.025}mm;border-radius:1mm;text-transform:uppercase;line-height:1;">LOGO</span></div>`
  ) : ''

  return `
    <div class="label" style="width:${widthMm}mm;height:${heightMm}mm;display:flex;flex-direction:row;overflow:hidden;font-family:${fontFam};background:#fff;box-sizing:border-box;">
      <div style="width:${leftColMm}mm;height:${heightMm}mm;display:flex;flex-direction:column;padding:${padMm}mm ${padMm}mm ${padMm}mm ${padMm + 0.5}mm;border-right:${divider};box-sizing:border-box;">
        ${logoHtml}
        <div style="flex:1;display:flex;flex-direction:column;justify-content:center;">${rowsHtml}</div>
      </div>
      <div style="width:${rightColMm}mm;height:${heightMm}mm;display:flex;flex-direction:column;padding:${padMm}mm;box-sizing:border-box;">
        ${sizeBoxHtml}
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:0;">${barcodeHtml}</div>
      </div>
    </div>`
}

export function buildPrintHtml(items: LabelItem[], template: TemplateConfig): string {
  const { widthMm, heightMm } = template.labelSize
  const labelsHtml = items.map(item => renderLabelHtml(item, template)).join('\n')
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>FNSKU Labels</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
  body { background: white; }
  .label { page-break-after: always; break-after: page; }
  .label:last-child { page-break-after: auto; break-after: auto; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
${labelsHtml}
</body>
</html>`
}
