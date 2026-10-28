import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { PinPad } from './PinPad'
import { PIN_PAD_ROWS, pinDots, pinKeyFromKeyboard, pinPress, type PinKey } from './pinPadModel'

/** Presses keys in order; returns the digits left and every PIN submitted. */
function press(keys: PinKey[], length = 6) {
  let digits = ''
  const submitted: string[] = []
  for (const k of keys) {
    const r = pinPress(digits, k, length)
    digits = r.digits
    if (r.submit) submitted.push(r.submit)
  }
  return { digits, submitted }
}

const labels = {
  label: 'PIN',
  enteredLabel: (n: number, total: number) => `${n} di ${total}`,
  clearLabel: 'Cancella',
  backLabel: 'Indietro',
}

describe('PIN pad rules (G4)', () => {
  it('submits at the sixth digit and keeps nothing afterwards', () => {
    const r = press(['4', '0', '1', '9', '7'])
    expect(r).toEqual({ digits: '40197', submitted: [] })
    expect(press(['4', '0', '1', '9', '7', '3'])).toEqual({ digits: '', submitted: ['401973'] })
  })

  it('Back removes the last digit; Clear removes all', () => {
    expect(press(['1', '2', '3', 'back'])).toEqual({ digits: '12', submitted: [] })
    expect(press(['1', '2', '3', 'clear'])).toEqual({ digits: '', submitted: [] })
    expect(press(['back', 'back'])).toEqual({ digits: '', submitted: [] })
  })

  it('a corrected PIN submits the corrected digits once', () => {
    expect(press(['1', '2', '9', 'back', '3', '4', '5', '6'])).toEqual({ digits: '', submitted: ['123456'] })
  })

  it('honours another length (a 4-digit step-up)', () => {
    expect(press(['1', '2', '3', '4'], 4)).toEqual({ digits: '', submitted: ['1234'] })
  })

  it('reads a physical keyboard: digits, Backspace, Escape and Delete — nothing else', () => {
    expect(pinKeyFromKeyboard('7')).toBe('7')
    expect(pinKeyFromKeyboard('Backspace')).toBe('back')
    expect(pinKeyFromKeyboard('Escape')).toBe('clear')
    expect(pinKeyFromKeyboard('Delete')).toBe('clear')
    expect(pinKeyFromKeyboard('a')).toBeNull()
    expect(pinKeyFromKeyboard('Enter')).toBeNull()
    expect(pinKeyFromKeyboard('12')).toBeNull()
  })

  it('shows dots only, one per digit', () => {
    expect(pinDots(3, 6)).toEqual([true, true, true, false, false, false])
    expect(pinDots(0, 4)).toEqual([false, false, false, false])
  })

  it('one fixed 3 × 4 layout: 1–9, then Clear, 0, Back', () => {
    expect(PIN_PAD_ROWS.flat()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'])
  })
})

describe('PinPad (G4)', () => {
  const html = (extra: Record<string, unknown> = {}) => render(createElement(PinPad, { ...labels, onSubmit: vi.fn(), ...extra }))

  it('renders 12 keys, six empty dots and the count words — never a typed digit', () => {
    const out = html()
    expect(out.match(/<button/g)).toHaveLength(12)
    expect(out.match(/data-filled="false"/g)).toHaveLength(6)
    expect(out).toContain('0 di 6')
    // The dots region carries no digit at all.
    const dots = /<div[^>]*class="nds-floor-pin-dots"[^>]*>(.*?)<\/div>/.exec(out)?.[1] ?? ''
    expect(dots).not.toMatch(/\d/)
    // No input field that could echo or autofill the PIN.
    expect(out).not.toContain('<input')
  })

  it('names Clear and Back in words, and keeps them in their places', () => {
    const out = html()
    const keys = [...out.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1])
    expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'])
    expect(out).toContain('Cancella')
    expect(out).toContain('Indietro')
  })

  it('locked: every key is held (focusable, inert) and the message is an alert', () => {
    const out = html({ locked: true, message: 'Troppi tentativi. Riprova tra 5 minuti.', messageTone: 'danger' })
    expect(out.match(/aria-disabled="true"/g)).toHaveLength(12)
    expect(out).not.toMatch(/<button[^>]*\sdisabled=/)
    expect(out).toMatch(/role="alert"[^>]*>Troppi tentativi/)
  })

  it('the digits are only ever assigned or handed to pinPress — never read into the markup', () => {
    // A server render cannot type, so this holds the property at the source: every use of the digits ref.
    const src = readFileSync(new URL('./PinPad.tsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    const uses = [...src.matchAll(/digits\.current(\s*=(?!=)|,)?/g)]
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u[1], `a read of digits.current at ${u.index}`).toBeDefined()
    expect(src).toMatch(/pinPress\(digits\.current,/)
  })

  it('draws a 4-digit pad when asked', () => {
    expect(html({ length: 4 }).match(/data-filled="false"/g)).toHaveLength(4)
  })
})
