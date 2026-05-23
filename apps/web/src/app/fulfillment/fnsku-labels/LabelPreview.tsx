'use client'

import React from 'react'
import { Barcode128 } from '@/components/ui/Barcode128'
import type { LabelItem, TemplateConfig, TemplateRow } from './types'

interface Props {
  item: LabelItem
  template: TemplateConfig
}

/** Attribute aliases — primary English keys + Italian fallbacks.
 *  Xavia's product DB mixes both ('Color'/'Colore', 'Size'/'Taglia', 'Gender'/'Genere'). */
const ATTR_ALIASES: Record<'color' | 'size' | 'gender', string[]> = {
  color:  ['Color',  'color',  'Colore',  'colore'],
  size:   ['Size',   'size',   'Taglia',  'taglia'],
  gender: ['Gender', 'gender', 'Genere',  'genere'],
}

export function pickAttr(attrs: Record<string, string>, kind: 'color' | 'size' | 'gender'): string {
  for (const k of ATTR_ALIASES[kind]) {
    if (attrs[k]) return attrs[k]
  }
  return ''
}

export function getRowValue(row: TemplateRow, item: LabelItem): string {
  if (!row.show) return ''
  const attrs = item.variationAttributes ?? {}
  switch (row.valueSource) {
    case 'productName': return item.productName ?? ''
    case 'color':  return pickAttr(attrs, 'color')
    case 'size':   return pickAttr(attrs, 'size')
    case 'gender': return pickAttr(attrs, 'gender')
    case 'sku':    return item.sku
    case 'asin':   return item.asin ?? ''
    case 'custom': return row.customValue
    default: return ''
  }
}

// 1mm → px at 96 dpi
const MM_TO_PX = 3.7795

// Map template fontFamily to a CSS stack that uses the same family the PDF will render
function cssFontStack(family?: string): string {
  const f = (family ?? 'Helvetica').toLowerCase()
  if (f.includes('courier') || f.includes('mono')) return "'Courier New', Courier, monospace"
  if (f.includes('times') || f.includes('roman')) return "Georgia, 'Times New Roman', serif"
  return 'Helvetica, Arial, sans-serif'
}

// Singleton canvas for text measurement. The PDF renderer uses doc.widthOfString
// for the same purpose — this matches it in the browser so preview and PDF agree.
let measureCanvas: HTMLCanvasElement | null = null
function measureTextWidth(text: string, fontPx: number, fontFamily: string, weight: number | string = 400): number {
  if (typeof document === 'undefined') return text.length * fontPx * 0.6
  if (!measureCanvas) measureCanvas = document.createElement('canvas')
  const ctx = measureCanvas.getContext('2d')
  if (!ctx) return text.length * fontPx * 0.6
  ctx.font = `${weight} ${fontPx}px ${fontFamily}`
  return ctx.measureText(text).width
}

/** Shrink fontPx until text fits within maxWidth. Returns the new size. */
function fitFontSize(text: string, startPx: number, maxWidth: number, fontFamily: string, weight: number | string, minPx = 5): number {
  let fs = Math.max(minPx, startPx)
  while (fs > minPx && measureTextWidth(text, fs, fontFamily, weight) > maxWidth) {
    fs = Math.max(minPx, fs - 0.4)
  }
  return fs
}

/** Shrink font size until wrapped text fits within `maxLines` of `maxLineWidth`.
 *  Estimate: text-width / maxLineWidth ≤ maxLines. Conservative (word-wrap
 *  packs tighter), so we may shrink slightly more than strictly necessary,
 *  but never clips. Used to keep listing titles inside their line budget. */
function fitWrappedFontSize(text: string, startPx: number, maxLineWidth: number, fontFamily: string, weight: number | string, maxLines: number, minPx = 5): number {
  let fs = Math.max(minPx, startPx)
  while (fs > minPx) {
    const w = measureTextWidth(text, fs, fontFamily, weight)
    if (Math.ceil(w / maxLineWidth) <= maxLines) return fs
    fs = Math.max(minPx, fs - 0.4)
  }
  return fs
}

function smartTruncateTitle(title: string, firstN: number, lastN: number): string {
  const words = title.trim().split(/\s+/)
  if (words.length <= firstN + lastN) return title
  return words.slice(0, firstN).join(' ') + ' ...' + words.slice(-lastN).join(' ')
}

export function LabelPreview({ item, template }: Props) {
  const { widthMm, heightMm } = template.labelSize
  const wPx = widthMm * MM_TO_PX
  const hPx = heightMm * MM_TO_PX

  const rightPct  = Math.max(15, Math.min(55, template.columnSplitPct ?? 38)) / 100
  const rightColPx = Math.round(wPx * rightPct)
  const leftColPx  = wPx - rightColPx

  const padPx = (template.paddingMm ?? 2) * MM_TO_PX
  const innerW      = rightColPx - padPx * 2
  const fullInnerPx = wPx - 2 * padPx

  // Barcode width: allow > 100% to extend into left col; cap at full label inner width
  const barcodeW = Math.min(Math.max(20, innerW * ((template.barcodeWidthPct ?? 100) / 100)), fullInnerPx)

  // Size box height — natural, then shrunk if it exceeds 60% of right-col
  // (mirrors PDF service so preview matches output).
  const sizeBoxPadVNatural = hPx * 0.01
  const sizeHdrFsNatural   = hPx * 0.06 * (template.sizeHeaderScale ?? 1)
  const sizeHdrPadVNatural = hPx * 0.005
  const sizeValMtNatural   = hPx * 0.01
  const sizeValFsNatural   = hPx * 0.19 * (template.sizeValueScale ?? 1)
  const sizeHdrHNatural    = sizeHdrFsNatural + 2 * sizeHdrPadVNatural
  const sizeBoxNatural     = template.showSizeBox
    ? 2 * sizeBoxPadVNatural + sizeHdrHNatural + sizeValMtNatural + sizeValFsNatural
    : 0
  const sizeBoxCap = (hPx - 2 * padPx) * 0.6
  const sizeBoxShrink = template.showSizeBox && sizeBoxNatural > sizeBoxCap
    ? sizeBoxCap / sizeBoxNatural
    : 1
  const sizeBoxPadV   = sizeBoxPadVNatural * sizeBoxShrink
  const sizeHdrFs     = sizeHdrFsNatural   * sizeBoxShrink
  const sizeHdrPadV   = sizeHdrPadVNatural * sizeBoxShrink
  const sizeValMt     = sizeValMtNatural   * sizeBoxShrink
  const sizeValFs     = sizeValFsNatural   * sizeBoxShrink
  const sizeBoxTotalH = sizeBoxNatural     * sizeBoxShrink

  // Estimate info stack height to ensure FNSKU text never gets clipped
  const fnskuEstH = hPx * 0.063 * (template.fnskuTextScale ?? 1) * 1.4
  const titleEstH = (template.showListingTitle)
    ? hPx * 0.052 * (template.listingTitleScale ?? 1) * 1.25 * (template.listingTitleLines ?? 2) + 6
    : 0
  const condEstH  = template.showCondition ? hPx * 0.052 * (template.conditionScale ?? 1) * 1.4 + 4 : 0
  const rightAvailH = hPx - 2 * padPx - sizeBoxTotalH
  const maxBarcodeH = Math.max(20, rightAvailH - fnskuEstH - titleEstH - condEstH - 8)

  // Cap barcode height at 55% and also at computed max to prevent FNSKU text clipping
  const barcodeH = Math.min(
    Math.round(hPx * (Math.min(template.barcodeHeightPct ?? 32, 55) / 100)),
    maxBarcodeH,
  )

  // Fine-grained scale factors (size scales are applied earlier in the size-box
  // natural-height computation above)
  const fnskuTextScale    = template.fnskuTextScale    ?? 1
  const listingTitleScale = template.listingTitleScale ?? 1
  const conditionScale    = template.conditionScale    ?? 1
  const logoH             = hPx * ((template.logoHeightPct ?? 22) / 100)

  const sizeVal = pickAttr(item.variationAttributes ?? {}, 'size')
  const activeRows = template.rows.filter(r => r.show)

  const badgeFsBase = hPx * 0.07  * (template.badgeFontScale  ?? 1)
  const valueFs     = hPx * 0.1   * (template.valueFontScale  ?? 1)
  const valueFs1    = hPx * 0.13  * (template.valueFontScale  ?? 1) // first row
  const fontFam     = cssFontStack(template.fontFamily)
  const labelRadiusPx = ((template.labelRadiusMm ?? 5) * MM_TO_PX)

  // ── Field-row pre-computation (badge cap + value fit + overflow shrink) ─
  // Mirrors fnsku-label-pdf.service.ts so preview matches PDF exactly.
  const leftInnerWPx = leftColPx - 2 * padPx
  const badgePadHPx  = hPx * 0.03
  const badgePadVPx  = hPx * 0.02
  const badgeMinWPx  = hPx * 0.45 * (template.badgeFontScale ?? 1)
  const badgeMaxWPx  = leftInnerWPx * 0.45   // badge can never eat more than 45% of left col
  const colGapPx     = Math.round(wPx * 0.015)
  const rowGapPx     = Math.round(hPx * 0.025)
  const logoVerticalConsumed = template.showLogo ? (hPx * ((template.logoHeightPct ?? 22) / 100)) + padPx : 0
  const rowsAvailHPx = Math.max(0, hPx - 2 * padPx - logoVerticalConsumed)

  function applyTransform(s: string, tx?: string): string {
    if (!s) return s
    if (tx === 'uppercase')  return s.toUpperCase()
    if (tx === 'capitalize') return s.charAt(0).toUpperCase() + s.slice(1)
    return s
  }

  const computedRows = activeRows.map((row, i) => {
    const isFirst    = i === 0
    const tx         = row.textTransform ?? 'uppercase'
    const rawValue   = getRowValue(row, item)
    const valueText  = applyTransform(rawValue || '—', tx)
    const badgeText  = (row.badgeText || '—').toUpperCase()
    const valueWeight: number = row.boldValue !== false ? (isFirst ? 900 : 700) : 400

    // Badge: shrink badge font to fit inside badgeMaxW - 2*pad, then compute badgeW
    const badgeFsFit  = fitFontSize(badgeText, badgeFsBase, badgeMaxWPx - 2 * badgePadHPx, fontFam, 700)
    const measuredBW  = measureTextWidth(badgeText, badgeFsFit, fontFam, 700) + 2 * badgePadHPx
    const badgeW      = Math.min(badgeMaxWPx, Math.max(badgeMinWPx, measuredBW))
    const badgeH      = badgeFsFit + 2 * badgePadVPx

    // Value: shrink value font to fit in available value column
    const desiredValueFs = (isFirst ? valueFs1 : valueFs) * (row.fontScale ?? 1)
    const valueMaxW      = Math.max(8, leftInnerWPx - badgeW - colGapPx)
    const valueFsFit     = fitFontSize(valueText, desiredValueFs, valueMaxW, fontFam, valueWeight)

    const rowH = Math.max(badgeH, valueFsFit * 1.1)
    return { row, isFirst, tx, valueText, badgeText, badgeFsFit, badgeW, badgeH, valueFsFit, valueWeight, rowH }
  })

  const naturalGroupH = computedRows.reduce((s, r) => s + r.rowH, 0)
    + Math.max(0, computedRows.length - 1) * rowGapPx
  // Uniform shrink if rows would overflow vertical space (matches PDF behavior)
  const rowsOverflowScale = naturalGroupH > rowsAvailHPx && rowsAvailHPx > 0
    ? rowsAvailHPx / naturalGroupH
    : 1

  // Title display value (apply smart truncation if enabled)
  const rawTitle = item.listingTitle ?? null
  const displayTitle = (() => {
    if (!rawTitle) return null
    if ((template.titleTruncationMode ?? 'lines') === 'smart') {
      return smartTruncateTitle(rawTitle, template.titleFirstWords ?? 5, template.titleLastWords ?? 4)
    }
    return rawTitle
  })()

  // Scale preview to fit max 580px wide
  const scale = Math.min(1, 580 / wPx)

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top center', marginBottom: `${hPx * scale - hPx}px` }}>
      <div style={{
        width: wPx, height: hPx,
        background: '#fff',
        border: '1px solid #999',
        borderRadius: labelRadiusPx,
        display: 'flex',
        flexDirection: 'row',
        overflow: 'hidden',
        fontFamily: fontFam,
        boxShadow: '0 2px 16px rgba(0,0,0,0.18)',
      }}>

        {/* ── LEFT COLUMN ─────────────────────────────────── */}
        <div style={{
          width: leftColPx, height: hPx,
          display: 'flex', flexDirection: 'column',
          padding: `${padPx}px`,
          borderRight: (template.showColumnDivider ?? true) ? '1px solid #ddd' : 'none',
          flexShrink: 0,
        }}>
          {/* Logo */}
          {template.showLogo && (
            <div style={{ marginBottom: padPx, flexShrink: 0 }}>
              {template.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={template.logoUrl} alt="Logo"
                  style={{ maxHeight: logoH, maxWidth: leftColPx - padPx * 2, objectFit: 'contain' }} />
              ) : (
                <div style={{ height: logoH, display: 'flex', alignItems: 'center' }}>
                  <span style={{
                    fontSize: hPx * 0.1, fontWeight: 900, letterSpacing: '-0.04em',
                    background: '#000', color: '#fff',
                    padding: `${hPx * 0.01}px ${hPx * 0.025}px`,
                    borderRadius: 4, textTransform: 'uppercase', lineHeight: 1,
                  }}>LOGO</span>
                </div>
              )}
            </div>
          )}

          {/* Field rows — pre-computed: badge cap, value fit, uniform overflow shrink */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: rowGapPx * rowsOverflowScale }}>
            {computedRows.map((c) => {
              const rawValue = getRowValue(c.row, item)
              const showPlaceholder = !rawValue
              const finalBadgeFs = c.badgeFsFit * rowsOverflowScale
              const finalValueFs = c.valueFsFit * rowsOverflowScale
              const finalBadgeH  = c.badgeH    * rowsOverflowScale
              const finalBadgeW  = c.badgeW    * rowsOverflowScale
              return (
                <div key={c.row.id} style={{ display: 'flex', alignItems: 'center', gap: colGapPx }}>
                  <div style={{
                    background: '#111', color: '#fff',
                    fontWeight: 700,
                    fontSize: finalBadgeFs,
                    height: finalBadgeH,
                    width: finalBadgeW,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 3, whiteSpace: 'nowrap',
                    letterSpacing: '0.03em', textTransform: 'uppercase',
                    flexShrink: 0, overflow: 'hidden',
                  }}>
                    {c.badgeText}
                  </div>
                  <div style={{
                    fontWeight: c.valueWeight,
                    fontSize: finalValueFs,
                    color: '#000',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    letterSpacing: c.isFirst ? '-0.02em' : '0.02em',
                    textTransform: c.tx as React.CSSProperties['textTransform'],
                    lineHeight: 1.1,
                  }}>
                    {showPlaceholder
                      ? <span style={{ color: '#aaa', fontStyle: 'italic', fontWeight: 400, fontSize: finalBadgeFs }}>—</span>
                      : c.valueText}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── RIGHT COLUMN ─────────────────────────────────── */}
        <div style={{
          width: rightColPx, height: hPx,
          display: 'flex', flexDirection: 'column',
          padding: `${padPx}px ${padPx}px ${padPx}px ${padPx}px`,
        }}>
          {/* Size box — uses shrunk variables so preview matches PDF */}
          {template.showSizeBox && (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              border: '2px solid #111', borderRadius: 4,
              padding: `${sizeBoxPadV}px ${hPx * 0.015}px`,
              marginBottom: padPx, flexShrink: 0,
            }}>
              <div style={{
                fontSize: sizeHdrFs, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', background: '#111', color: '#fff',
                width: '100%', textAlign: 'center', borderRadius: 2,
                padding: `${sizeHdrPadV}px 0`,
              }}>
                {template.sizeBoxLabel || 'SIZE'}
              </div>
              <div style={{
                fontSize: Math.min(sizeValFs, innerW * 0.85),
                fontWeight: 900, color: '#000', lineHeight: 1, marginTop: sizeValMt,
              }}>
                {sizeVal || '—'}
              </div>
            </div>
          )}

          {/* Barcode area — when barcode wider than right col, shift all content left to
               centre in full label. marginLeft = (rightColPx - wPx) / 2 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
            {item.fnsku ? (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                marginLeft: barcodeW > innerW ? (rightColPx - wPx) / 2 : 0,
              }}>
                <Barcode128
                  value={item.fnsku}
                  height={barcodeH}
                  maxWidthPx={barcodeW}
                  showText={false}
                />
                {/* FNSKU text — width-fitted using font-aware char estimate */}
                <div style={{
                  width: barcodeW,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textAlign: 'center',
                  marginTop: 2,
                }}>
                  <span style={{
                    fontSize: Math.min(
                      hPx * 0.063,
                      barcodeW / (item.fnsku.length * (/mono|courier/i.test(fontFam) ? 0.62 : 0.58) + 2),
                    ) * fnskuTextScale,
                    fontFamily: fontFam,
                    letterSpacing: '0.03em',
                    color: '#111',
                  }}>
                    {item.fnsku}
                  </span>
                </div>
                {template.showListingTitle && displayTitle && (() => {
                  const titleFsRaw = hPx * 0.052 * listingTitleScale
                  const mode = template.titleTruncationMode ?? 'lines'
                  const maxLines = template.listingTitleLines ?? 2
                  // Smart mode: single line, shrink to fit barcode width.
                  // Lines mode: shrink so wrapped text fits within maxLines × barcodeW.
                  const titleFs = mode === 'smart'
                    ? fitFontSize(displayTitle, titleFsRaw, barcodeW, fontFam, 400)
                    : fitWrappedFontSize(displayTitle, titleFsRaw, barcodeW, fontFam, 400, maxLines)
                  return mode === 'smart' ? (
                    <div style={{
                      fontSize: titleFs,
                      color: '#333',
                      marginTop: 3,
                      textAlign: 'center',
                      lineHeight: 1.25,
                      maxWidth: barcodeW,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {displayTitle}
                    </div>
                  ) : (
                    <div style={{
                      fontSize: titleFs,
                      color: '#333',
                      marginTop: 3,
                      textAlign: 'center',
                      lineHeight: 1.25,
                      maxWidth: barcodeW,
                      overflow: 'hidden',
                      display: '-webkit-box',
                      WebkitLineClamp: maxLines,
                      WebkitBoxOrient: 'vertical',
                    } as React.CSSProperties}>
                      {displayTitle}
                    </div>
                  )
                })()}
                {template.showCondition && (
                  <div style={{ fontSize: hPx * 0.052 * conditionScale, color: '#333', marginTop: 2, textAlign: 'center' }}>
                    {template.condition || 'New'}
                  </div>
                )}
              </div>
            ) : (
              <div style={{
                width: barcodeW, height: barcodeH,
                border: '1px dashed #ccc', borderRadius: 4,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#bbb', fontSize: hPx * 0.06,
              }}>
                No FNSKU
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
