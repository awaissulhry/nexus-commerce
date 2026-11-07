import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CodeInput } from './CodeInput'
import { CODE_INPUT_LABELS } from './CodeInputLabels'
import { codeCells, codeCompletes, codeFromText, codeGapAfter, resendReady } from './codeInputModel'

/** B-W2b-155 — CodeInput: whole-code paste, auto-submit on the last digit, tries left in words, held with its reason. */
describe('codeFromText', () => {
  it('keeps digits only, at most the length', () => {
    expect(codeFromText('12a3')).toBe('123')
    expect(codeFromText('1234567')).toBe('123456')
    expect(codeFromText('')).toBe('')
  })
  it('a pasted sentence gives its run of exactly six digits, spaces or a dash inside allowed', () => {
    expect(codeFromText('Your code is 123 456, valid for 10 minutes')).toBe('123456')
    expect(codeFromText('Codice: 123-456')).toBe('123456')
    expect(codeFromText('Valid 10 min. Code 654321')).toBe('654321')
  })
  it('without such a run, the digits in order', () => {
    expect(codeFromText('12 34 5')).toBe('12345')
  })
  it('another length', () => {
    expect(codeFromText('code 1234 5678', 8)).toBe('12345678')
    expect(codeFromText('12345', 4)).toBe('1234')
  })
})

describe('codeCompletes', () => {
  it('a new full code completes; the same one again does not; a partial one does not', () => {
    expect(codeCompletes('12345', '123456')).toBe(true)
    expect(codeCompletes('', '123456')).toBe(true)
    expect(codeCompletes('123456', '123456')).toBe(false)
    expect(codeCompletes('1234', '12345')).toBe(false)
  })
})

describe('the boxes', () => {
  it('one per digit, the next to fill marked (the last when full)', () => {
    expect(codeCells('12').map((c) => [c.digit, c.active])).toEqual([
      ['1', false],
      ['2', false],
      ['', true],
      ['', false],
      ['', false],
      ['', false],
    ])
    expect(codeCells('123456').at(-1)).toEqual({ digit: '6', active: true })
  })
  it('a gap in the middle of an even code of six or more', () => {
    expect(codeGapAfter(6)).toBe(3)
    expect(codeGapAfter(8)).toBe(4)
    expect(codeGapAfter(4)).toBeNull()
    expect(codeGapAfter(5)).toBeNull()
  })
})

describe('resendReady', () => {
  it('no time, or a time passed: ready', () => {
    expect(resendReady(null, 1000)).toBe(true)
    expect(resendReady(500, 1000)).toBe(true)
    expect(resendReady(1500, 1000)).toBe(false)
    expect(resendReady('2026-11-07T10:00:00Z', Date.parse('2026-11-07T10:00:30Z'))).toBe(true)
  })
})

describe('CodeInput markup', () => {
  const html = renderToStaticMarkup(
    createElement(CodeInput, {
      value: '12',
      onChange: () => {},
      label: "Codice dall'e-mail",
      error: 'Il codice non è giusto.',
      triesLeft: 2,
      labels: { hint: (n: number) => `${n} cifre`, triesLeft: (n: number) => `Restano ${n} tentativi` },
    }),
  )
  it('ONE real input: one-time-code, numeric, named by its label and described by hint, tries and error', () => {
    expect(html.match(/<input /g)).toHaveLength(1)
    expect(html).toContain('autoComplete="one-time-code"')
    expect(html).toContain('inputMode="numeric"')
    const id = /<label class="nds-code-label" for="([^"]+)">/.exec(html)?.[1]
    expect(html).toContain(`id="${id}"`)
    expect(html).toContain('aria-invalid="true"')
    expect(html).toMatch(/aria-describedby="[^"]+-hint [^"]+-tries [^"]+-error"/)
    expect(html).not.toMatch(/maxLength/i) // a pasted "123 456" must reach the part whole
  })
  it('the boxes are drawn from the value and hidden from a screen reader', () => {
    expect(html).toContain('<div class="nds-code-cells" aria-hidden="true">')
    expect(html).toContain('<span class="nds-code-cell" data-filled="true">1</span>')
    expect(html).toContain('<span class="nds-code-cell" data-active="true"></span>')
    expect((html.match(/class="nds-code-cell"/g) ?? []).length).toBe(6)
    expect(html).toContain('<span class="nds-code-gap"></span>')
  })
  it('error and tries left in the page\'s words', () => {
    expect(html).toContain('role="alert">Il codice non è giusto.</p>')
    expect(html).toContain('Restano 2 tentativi')
    expect(html).not.toContain('tries left')
  })
  it('held: read-only, aria-disabled, the reason on screen, no tries said', () => {
    const held = renderToStaticMarkup(createElement(CodeInput, { value: '', onChange: () => {}, triesLeft: 0, heldReason: 'Too many tries. Ask for a new code.' }))
    expect(held).toContain('readOnly=""')
    expect(held).toContain('aria-disabled="true"')
    expect(held).toContain('Too many tries. Ask for a new code.')
    expect(held).not.toContain('tries left')
  })
  it('busy: checking words in a status', () => {
    const busy = renderToStaticMarkup(createElement(CodeInput, { value: '123456', onChange: () => {}, busy: true }))
    expect(busy).toContain(`role="status"><span class="nds-spinner`)
    expect(busy).toContain(CODE_INPUT_LABELS.checking)
  })
  it('resend: with no time, the button; with a time ahead, a wait (no button)', () => {
    const now = renderToStaticMarkup(createElement(CodeInput, { value: '', onChange: () => {}, resend: { onResend: () => {} } }))
    expect(now).toContain('Send a new code')
    const later = renderToStaticMarkup(createElement(CodeInput, { value: '', onChange: () => {}, resend: { availableAt: Date.now() + 60_000, onResend: () => {} } }))
    expect(later).not.toContain('Send a new code')
    expect(later).toContain('nds-code-wait')
  })
})
