import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { Code128 } from './Code128'
import { LABEL_PRINT_TONE, LABEL_TEXT_MM, labelBlocks, labelCanRetry, labelInvalidCodes, type LabelLayout } from './labelLayout'
import { LabelPreview } from './LabelPreview'

// Made-up bundle ticket.
const ticket: LabelLayout = {
  name: 'Cartellino fascio',
  widthMm: 100,
  heightMm: 50,
  blocks: [
    { kind: 'title', text: 'Giacca Aria · Nero' },
    {
      kind: 'row',
      blocks: [
        { kind: 'fields', columns: 2, fields: [{ label: 'Taglia', value: '52', size: 'xl' }, { label: 'Pezzi', value: '24' }] },
        { kind: 'qr', value: 'B-000123-04' },
      ],
    },
    { kind: 'fill' },
    { kind: 'barcode', value: 'B-000123-04' },
  ],
}

describe('label layout (G11)', () => {
  it('opens rows in reading order and finds barcode values Code 128 cannot carry', () => {
    expect(labelBlocks(ticket.blocks).map((b) => b.kind)).toEqual(['title', 'row', 'fields', 'qr', 'fill', 'barcode'])
    expect(labelInvalidCodes(ticket)).toEqual([])
    expect(labelInvalidCodes({ blocks: [{ kind: 'row', blocks: [{ kind: 'barcode', value: 'Città' }] }] })).toEqual(['Città'])
  })

  it('offers retry for a failed job only; every state has a tone', () => {
    expect(labelCanRetry({ status: 'failed', label: 'Non stampata' })).toBe(true)
    expect(labelCanRetry({ status: 'printed', label: 'Stampata' })).toBe(false)
    expect(labelCanRetry(undefined)).toBe(false)
    expect(LABEL_PRINT_TONE).toEqual({ queued: 'neutral', sent: 'info', printed: 'success', failed: 'danger' })
  })
})

describe('LabelPreview markup (G11)', () => {
  it('a named figure at its size in mm, real text inside, the barcode one named image', () => {
    const out = render(h(LabelPreview, { layout: ticket, codeLabel: (v: string, k: string) => `${k} ${v}` }))
    expect(out).toMatch(/<figure class="nds-label-figure" aria-label="Cartellino fascio">/)
    expect(out).toMatch(/--nds-label-w:100;--nds-label-h:50;--nds-label-scale:4;--nds-label-pad:2/)
    expect(out).toContain('<dt>Taglia</dt><dd data-size="xl">52</dd>')
    expect(out).toMatch(/class="nds-code128 nds-label-barcode" style="--nds-label-bar-h:10" role="img" aria-label="barcode B-000123-04"/)
    expect(out).toMatch(/<path d="M10 0h2v1h-2z/)
    // No renderQr: an outlined square, still named.
    expect(out).toMatch(/role="img" aria-label="qr B-000123-04"><span class="nds-label-square-empty"/)
  })

  it('draws the app\'s QR and marks in their squares', () => {
    const out = render(
      h(LabelPreview, {
        layout: { ...ticket, blocks: [{ kind: 'qr', value: 'X', sizeMm: 20 }, { kind: 'mark', id: 'ce', label: 'Marcatura CE' }] },
        renderQr: (v: string, mm: number) => h('svg', { 'data-qr': v, 'data-mm': mm }),
        renderMark: (id: string) => h('svg', { 'data-mark': id }),
      }),
    )
    expect(out).toMatch(/--nds-label-square:20[^>]*role="img" aria-label="X"><svg data-qr="X" data-mm="20">/)
    expect(out).toMatch(/aria-label="Marcatura CE"><svg data-mark="ce">/)
  })

  it('print state: icon + word + detail, announced; Retry only when failed', () => {
    const failed = render(h(LabelPreview, { layout: ticket, print: { status: 'failed', label: 'Non stampata', detail: 'Carta finita' }, onRetry: vi.fn(), retryLabel: 'Riprova' }))
    expect(failed).toMatch(/nds-label-print-state" data-status="failed" role="status">/)
    expect(failed).toContain('Non stampata')
    expect(failed).toContain('Carta finita')
    expect(failed).toContain('Riprova')
    const printed = render(h(LabelPreview, { layout: ticket, print: { status: 'printed', label: 'Stampata' }, onRetry: vi.fn(), retryLabel: 'Riprova' }))
    expect(printed).not.toContain('Riprova')
  })

  it('a value Code 128 cannot carry draws no bars, only its words', () => {
    const out = render(h(Code128, { value: 'Città', invalidLabel: 'Codice non stampabile' }))
    expect(out).toMatch(/class="nds-code128 is-invalid" role="img" aria-label="Codice non stampabile"/)
    expect(out).not.toContain('<svg')
  })
})

describe('labelPreview.css (G11)', () => {
  const css = readFileSync(new URL('./labelPreview.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('text heights are the mm in LABEL_TEXT_MM', () => {
    for (const [size, mm] of Object.entries(LABEL_TEXT_MM)) {
      expect(css, size).toContain(`.nds-label [data-size='${size}'] {\n  font-size: calc(var(--nds-label-mm) * ${mm});`)
    }
  })

  it('paper and ink are the theme-invariant pair in both the label and the barcode; no raw colour', () => {
    for (const sel of ['.nds-code128 {', '.nds-label {']) {
      const body = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)))
      expect(body, sel).toContain('--nds-label-paper: var(--nds-tooltip-light-bg);')
      expect(body, sel).toContain('--nds-label-ink: var(--nds-tooltip-light-fg);')
    }
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/var\(--nds-(grey|blue|green|red|amber|purple|cyan)-[0-9]/)
  })

  it('the print state and its buttons read the density', () => {
    const body = css.slice(css.indexOf('.nds-label-print-state {'), css.indexOf('}', css.indexOf('.nds-label-print-state {')))
    expect(body).toMatch(/var\(--nds-density-control-h\)/)
  })
})
