import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { SizeButtons } from '../SizeButtons/SizeButtons'
import { AqlCounter } from './AqlCounter'
import { QuantityPad } from './QuantityPad'

const words = {
  label: 'Buoni',
  decrementLabel: 'Meno',
  incrementLabel: 'Più',
  clearLabel: 'Cancella',
  backLabel: 'Indietro',
  emptyLabel: 'Scrivi una quantità',
  rangeLabel: (min?: number, max?: number) => `Da ${min} a ${max}`,
}

describe('QuantityPad markup (G6)', () => {
  it('the number is a spin button with its range and words; no text field, so no keyboard opens', () => {
    const out = render(h(QuantityPad, { ...words, value: 24, onChange: vi.fn(), min: 0, max: 24, unit: 'pezzi' }))
    expect(out).toMatch(/role="spinbutton"[^>]*aria-valuenow="24"[^>]*aria-valuemin="0"[^>]*aria-valuemax="24"[^>]*aria-valuetext="24 pezzi"/)
    expect(out).not.toContain('<input')
    // The default is fresh: the first digit replaces it.
    expect(out).toMatch(/data-fresh="true"/)
  })

  it('+ is held at max with the range in words, − is not; never the disabled attribute', () => {
    const out = render(h(QuantityPad, { ...words, value: 24, onChange: vi.fn(), min: 0, max: 24 }))
    expect(out).toMatch(/aria-label="Più"[^>]*aria-disabled="true"[^>]*aria-description="Da 0 a 24"|aria-disabled="true"[^>]*aria-description="Da 0 a 24"[^>]*aria-label="Più"|aria-label="Più"[^>]*aria-description="Da 0 a 24"/)
    expect(out).not.toMatch(/aria-label="Meno"[^>]*aria-disabled/)
    expect(out).not.toMatch(/\sdisabled=""/)
  })

  it('draws the PIN pad keys (twelve), and the separator key in Clear\'s place with decimals', () => {
    const whole = render(h(QuantityPad, { ...words, value: null, onChange: vi.fn() }))
    expect(whole.match(/class="nds-floor-pin-key"/g)).toHaveLength(12)
    expect(whole).toMatch(/data-key="clear"/)
    expect(whole).toMatch(/data-empty="true"/)
    expect(whole).toMatch(/aria-valuetext="Scrivi una quantità"/)
    const area = render(h(QuantityPad, { ...words, label: 'Area', value: 5.5, decimals: 2, decimalSeparator: ',', separatorLabel: 'Virgola', onChange: vi.fn() }))
    expect(area).toMatch(/data-key="sep"[^>]*aria-label="Virgola"/)
    expect(area).toContain('5,50')
    // Clear moved beside the quick values.
    expect(area).toMatch(/nds-floor-btn-label">Cancella</)
  })

  it('Confirm is held with nothing typed, and with a number under min', () => {
    const empty = render(h(QuantityPad, { ...words, value: null, onChange: vi.fn(), onConfirm: vi.fn(), confirmLabel: 'Conferma' }))
    expect(empty).toMatch(/aria-description="Scrivi una quantità"[^>]*>.*Conferma/)
    const low = render(h(QuantityPad, { ...words, value: 3, min: 10, max: 24, onChange: vi.fn(), onConfirm: vi.fn(), confirmLabel: 'Conferma' }))
    expect(low).toMatch(/aria-invalid="true"/)
    expect(low).toContain('nds-floor-qty-notice')
    const ok = render(h(QuantityPad, { ...words, value: 12, min: 10, max: 24, onChange: vi.fn(), onConfirm: vi.fn(), confirmLabel: 'Conferma' }))
    expect(ok).not.toMatch(/nds-floor-qty-confirm[^"]*"[^>]*aria-disabled/)
  })

  it('quick values are pressed when shown, held out of range', () => {
    const out = render(h(QuantityPad, { ...words, value: 24, max: 24, onChange: vi.fn(), quickValues: [{ value: 24, label: 'Tutti' }, 30] }))
    expect(out).toMatch(/aria-pressed="true"[^>]*>.*?Tutti/)
    expect(out).toMatch(/aria-pressed="false"[^>]*aria-disabled="true"[^>]*>.*?30/)
  })

  it('shows the expected number beside the name', () => {
    const out = render(h(QuantityPad, { ...words, value: 20, expected: 24, expectedLabel: (n: number) => `Attesi ${n}`, onChange: vi.fn() }))
    expect(out).toContain('Attesi 24')
  })
})

describe('SizeButtons markup (G6)', () => {
  const sizes = [
    { id: '48', label: '48', remaining: 4 },
    { id: '50', label: '50', remaining: 0 },
    { id: '52', label: '52', remaining: 6, heldReason: 'Non in questo ordine' },
  ]

  it('a radio group with one Tab stop on the picked size', () => {
    const out = render(h(SizeButtons, { label: 'Taglia', sizes, value: '50', onChange: vi.fn(), remainingLabel: (n: number) => `${n} da tagliare`, doneLabel: 'Fatto' }))
    expect(out).toMatch(/role="radiogroup"/)
    expect(out.match(/role="radio"/g)).toHaveLength(3)
    expect(out).toMatch(/data-size-id="50"[^>]*aria-checked="true"[^>]*tabindex="0"/i)
    expect(out).toMatch(/data-size-id="48"[^>]*aria-checked="false"[^>]*tabindex="-1"/i)
  })

  it('remaining as a number with words, done as a tick with its word, held announced', () => {
    const out = render(h(SizeButtons, { label: 'Taglia', sizes, value: null, onChange: vi.fn(), remainingLabel: (n: number) => `${n} da tagliare`, doneLabel: 'Fatto' }))
    expect(out).toContain('4 da tagliare')
    expect(out).toMatch(/data-state="done"[^]*?Fatto/)
    expect(out).toMatch(/data-size-id="52"[^>]*data-state="held"[^>]*aria-disabled="true"[^>]*aria-description="Non in questo ordine"/)
    expect(out).not.toMatch(/\sdisabled=""/)
  })
})

describe('AqlCounter markup (G6)', () => {
  const props = {
    label: 'AQL 2,5 · livello II',
    sampleSize: 50,
    inspected: 50,
    onInspectedChange: vi.fn(),
    classes: [
      { id: 'major', label: 'Maggiori', accept: 3, defects: 3 },
      { id: 'minor', label: 'Minori', accept: 5, defects: 0 },
    ],
    onDefectsChange: vi.fn(),
    inspectedLabel: 'Ispezionati',
    sampleLabel: (i: number, n: number) => `${i} di ${n}`,
    thresholdLabel: (ac: number, re: number) => `Ac ${ac} · Re ${re}`,
    verdictLabels: { open: 'In corso', accept: 'Accettato', reject: 'Rifiutato' },
    classStateLabels: { limit: 'Al limite' },
    addInspectedLabel: 'Pezzo controllato',
    removeInspectedLabel: 'Togli un pezzo',
    addDefectLabel: (c: string) => `Difetto ${c} in più`,
    removeDefectLabel: (c: string) => `Difetto ${c} in meno`,
    sampleDoneLabel: 'Campione completo',
    nothingToRemoveLabel: 'Già a zero',
  }

  it('the whole sample within Ac is accepted; a class at its limit says so', () => {
    const out = render(h(AqlCounter, props))
    expect(out).toMatch(/nds-floor-aql-verdict" data-verdict="accept" role="status">.*Accettato/)
    expect(out).toContain('Ac 3 · Re 4')
    expect(out).toMatch(/data-state="limit"[^]*?Al limite/)
    expect(out).toContain('50 di 50')
    // The main + is held at the sample size; − of an empty class is held at zero.
    expect(out).toMatch(/aria-description="Campione completo"/)
    expect(out).toMatch(/aria-label="Difetto Minori in meno"[^>]*aria-description="Già a zero"|aria-description="Già a zero"[^>]*aria-label="Difetto Minori in meno"/)
  })

  it('one class at Re rejects mid-sample', () => {
    const out = render(h(AqlCounter, { ...props, inspected: 10, classes: [{ id: 'major', label: 'Maggiori', accept: 3, defects: 4 }] }))
    expect(out).toMatch(/data-verdict="reject"/)
    expect(out).toContain('Rifiutato')
  })
})

describe('the count parts\' stylesheets read the density tokens (G1 → G6)', () => {
  const sheet = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (css: string, selector: string) => {
    const at = css.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }
  const qty = sheet('./quantityPad.css')
  const aql = sheet('./aqlCounter.css')
  const sizes = sheet('../SizeButtons/sizeButtons.css')

  it('every touch size comes from --nds-density-*', () => {
    for (const [css, selector] of [
      [qty, '.nds-floor-qty-step.nds-floor-btn'],
      [qty, '.nds-floor-qty-display'],
      [qty, '.nds-floor-qty-quick'],
      [sizes, '.nds-floor-size'],
      [sizes, '.nds-floor-sizes-grid'],
      [aql, '.nds-floor-aql-sample-actions'],
      [aql, '.nds-floor-aql-class-number'],
    ] as const) {
      expect(rule(css, selector), selector).toMatch(/var\(--nds-density-/)
    }
  })

  it('no raw colour: no hex, no numbered ramp; fill tokens never used as text', () => {
    for (const css of [qty, aql, sizes]) {
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(css).not.toMatch(/var\(--nds-(grey|blue|green|red|amber|purple|cyan)-[0-9]/)
      expect(css).not.toMatch(/(^|[;{\s])color:\s*var\(--nds-(success|warning|danger)\)/)
    }
  })
})
