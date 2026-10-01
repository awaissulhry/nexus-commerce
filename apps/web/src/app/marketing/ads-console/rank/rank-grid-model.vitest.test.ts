/**
 * `textOn` picks the swatch ink by WCAG contrast, not by a perceived-brightness cut-off.
 * The cut-off put white on mid greens: 2.99:1 on the default "Defend Top" #3aa873.
 */
import { describe, expect, it } from 'vitest'
import { targetColor, textOn } from './rank-grid-model'

const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) }
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const expand = (ink: string) => (ink === '#fff' ? '#ffffff' : ink)

describe('textOn', () => {
  it('puts the dark ink on the default Defend Top green (white was 2.99:1)', () => {
    expect(textOn('#3aa873')).toBe('#1e293b')
    expect(ratio('#3aa873', '#1e293b')).toBeGreaterThan(4.5)
  })

  it('keeps white on the dark greens', () => {
    expect(textOn('#065f46')).toBe('#fff')
    expect(textOn('#0a7d48')).toBe('#fff')
  })

  it('always picks the higher-contrast ink, and every fallback swatch clears 4.3:1', () => {
    for (const key of ['own-top-allout', 'own-top', 'defend-top', 'rest-of-search', 'pause', 'unknown']) {
      const bg = targetColor({ key })
      const ink = expand(textOn(bg))
      const other = ink === '#ffffff' ? '#1e293b' : '#ffffff'
      expect(ratio(bg, ink), `${key} ${bg}`).toBeGreaterThanOrEqual(ratio(bg, other))
      expect(ratio(bg, ink), `${key} ${bg}`).toBeGreaterThan(4.3)
    }
  })

  it('falls back to white for a value that is not a 6-digit hex', () => {
    expect(textOn('red')).toBe('#fff')
  })
})
