'use client'

import { Barcode128 } from '@/components/ui/Barcode128'
import type { LabelItem, TemplateConfig, TemplateRow } from './types'

interface Props {
  item: LabelItem
  template: TemplateConfig
}

export function getRowValue(row: TemplateRow, item: LabelItem): string {
  if (!row.show) return ''
  const attrs = item.variationAttributes ?? {}
  switch (row.valueSource) {
    case 'productName': return item.productName ?? ''
    case 'color': return attrs['Color'] ?? attrs['color'] ?? ''
    case 'size':   return attrs['Size']  ?? attrs['size']  ?? ''
    case 'gender': return attrs['Gender'] ?? attrs['gender'] ?? ''
    case 'sku':    return item.sku
    case 'custom': return row.customValue
    default: return ''
  }
}

function getSizeValue(item: LabelItem): string {
  const attrs = item.variationAttributes ?? {}
  return attrs['Size'] ?? attrs['size'] ?? ''
}

// 1mm → px at 96dpi
const MM_TO_PX = 3.7795

export function LabelPreview({ item, template }: Props) {
  const { widthMm, heightMm } = template.labelSize
  const wPx = widthMm * MM_TO_PX
  const hPx = heightMm * MM_TO_PX

  // Right column is 38% of total width
  const rightColPx = Math.round(wPx * 0.38)
  const leftColPx = wPx - rightColPx

  const pad = Math.round(hPx * 0.04) // ~3px padding
  const sizeVal = getSizeValue(item)
  const activeRows = template.rows.filter(r => r.show)

  // Scale so preview fits nicely in the center pane (max 560px wide)
  const scale = Math.min(1, 560 / wPx)

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top center', marginBottom: `${(hPx * scale - hPx)}px` }}>
      {/* Label body */}
      <div
        style={{
          width: wPx,
          height: hPx,
          background: '#fff',
          border: '1px solid #999',
          display: 'flex',
          flexDirection: 'row',
          overflow: 'hidden',
          fontFamily: 'Arial, Helvetica, sans-serif',
          boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
        }}
      >
        {/* ── LEFT COLUMN ──────────────────────────────── */}
        <div
          style={{
            width: leftColPx,
            height: hPx,
            display: 'flex',
            flexDirection: 'column',
            padding: `${pad}px ${pad}px ${pad}px ${pad + 2}px`,
            borderRight: '1px solid #ddd',
          }}
        >
          {/* Logo */}
          {template.showLogo && (
            <div style={{ marginBottom: pad, flexShrink: 0 }}>
              {template.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={template.logoUrl}
                  alt="Logo"
                  style={{ maxHeight: hPx * 0.22, maxWidth: leftColPx - pad * 2, objectFit: 'contain' }}
                />
              ) : (
                <div style={{
                  height: hPx * 0.22,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                }}>
                  <span style={{
                    fontSize: hPx * 0.1,
                    fontWeight: 900,
                    letterSpacing: '-0.04em',
                    background: '#000',
                    color: '#fff',
                    padding: `${hPx * 0.01}px ${hPx * 0.025}px`,
                    borderRadius: 4,
                    textTransform: 'uppercase',
                    lineHeight: 1,
                  }}>
                    LOGO
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Field rows */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(hPx * 0.025) }}>
            {activeRows.map((row, i) => {
              const value = getRowValue(row, item)
              const isFirst = i === 0
              return (
                <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: Math.round(wPx * 0.015) }}>
                  {/* Badge */}
                  <div style={{
                    background: '#111',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: isFirst ? hPx * 0.07 : hPx * 0.07,
                    padding: `${hPx * 0.02}px ${hPx * 0.03}px`,
                    borderRadius: 3,
                    whiteSpace: 'nowrap',
                    letterSpacing: '0.03em',
                    textTransform: 'uppercase',
                    flexShrink: 0,
                    minWidth: hPx * 0.45,
                    textAlign: 'center',
                  }}>
                    {row.badgeText || '—'}
                  </div>
                  {/* Value */}
                  <div style={{
                    fontWeight: isFirst ? 900 : 700,
                    fontSize: isFirst ? hPx * 0.13 : hPx * 0.1,
                    color: '#000',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    letterSpacing: isFirst ? '-0.02em' : '0.02em',
                    textTransform: 'uppercase',
                    lineHeight: 1.1,
                  }}>
                    {value || <span style={{ color: '#aaa', fontStyle: 'italic', fontWeight: 400, fontSize: hPx * 0.07 }}>—</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── RIGHT COLUMN ─────────────────────────────── */}
        <div
          style={{
            width: rightColPx,
            height: hPx,
            display: 'flex',
            flexDirection: 'column',
            padding: `${pad}px ${pad}px ${pad}px ${pad}px`,
          }}
        >
          {/* Size box */}
          {template.showSizeBox && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              border: '2px solid #111',
              borderRadius: 4,
              padding: `${hPx * 0.01}px ${hPx * 0.015}px`,
              marginBottom: pad,
              flexShrink: 0,
            }}>
              <div style={{
                fontSize: hPx * 0.06,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                background: '#111',
                color: '#fff',
                width: '100%',
                textAlign: 'center',
                borderRadius: 2,
                padding: `${hPx * 0.005}px 0`,
              }}>
                SIZE
              </div>
              <div style={{
                fontSize: hPx * 0.19,
                fontWeight: 900,
                color: '#000',
                lineHeight: 1,
                marginTop: hPx * 0.01,
              }}>
                {sizeVal || '—'}
              </div>
            </div>
          )}

          {/* Barcode area */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
            {item.fnsku ? (
              <>
                <div style={{ width: '100%', overflow: 'hidden' }}>
                  <Barcode128
                    value={item.fnsku}
                    height={Math.round(hPx * 0.32)}
                    moduleWidthPx={Math.max(1, (rightColPx - pad * 2) / (item.fnsku.length * 11 + 35))}
                    showText={false}
                    className="w-full"
                  />
                </div>
                <div style={{
                  fontSize: hPx * 0.063,
                  fontFamily: 'monospace',
                  letterSpacing: '0.05em',
                  color: '#111',
                  marginTop: 2,
                  textAlign: 'center',
                }}>
                  {item.fnsku}
                </div>
                {template.showListingTitle && item.listingTitle && (
                  <div style={{
                    fontSize: hPx * 0.055,
                    color: '#333',
                    marginTop: 3,
                    textAlign: 'center',
                    lineHeight: 1.2,
                    maxWidth: rightColPx - pad * 2,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}>
                    {item.listingTitle}
                  </div>
                )}
                {template.showCondition && (
                  <div style={{
                    fontSize: hPx * 0.055,
                    color: '#333',
                    marginTop: 1,
                    textAlign: 'center',
                  }}>
                    {template.condition || 'New'}
                  </div>
                )}
              </>
            ) : (
              <div style={{
                width: '100%',
                height: hPx * 0.35,
                border: '1px dashed #ccc',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#bbb',
                fontSize: hPx * 0.06,
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
