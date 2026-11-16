import { describe, expect, it } from 'vitest'
import { DESIGN_WIDTHS, frameHref, frameOptions, widthOf, type DesignWidth } from './frame-options'

/**
 * B-TH-297 (PR-13): the design frames at the Owner's widths — Wide 1920 and Phone 375 beside 1440, 1024 and 390 — read
 * from the frame's and the gallery's address by key or by pixels, so every later step checks 375, 1440 and 1920.
 */
describe('the design frames at the Owner’s widths (B-TH-297)', () => {
  it('has the five widths, widest first, each with its label', () => {
    expect(Object.entries(DESIGN_WIDTHS).map(([key, size]) => [key, size.width, size.label])).toEqual([
      ['wide', 1920, 'Wide 1920'],
      ['desktop', 1440, 'Desktop 1440'],
      ['tablet', 1024, 'Tablet 1024'],
      ['phone', 390, 'Phone 390'],
      ['phone375', 375, 'Phone 375'],
    ])
    for (const size of Object.values(DESIGN_WIDTHS)) expect(size.height).toBeGreaterThan(600)
  })

  it('reads each width from the address by its key or its pixels; anything else is the desktop', () => {
    const cases: Array<[string | undefined, DesignWidth]> = [
      ['wide', 'wide'],
      ['1920', 'wide'],
      ['desktop', 'desktop'],
      ['1440', 'desktop'],
      ['tablet', 'tablet'],
      ['1024', 'tablet'],
      ['phone', 'phone'],
      ['390', 'phone'],
      ['phone375', 'phone375'],
      ['375', 'phone375'],
      [undefined, 'desktop'],
      ['', 'desktop'],
      ['1366', 'desktop'],
      ['huge', 'desktop'],
    ]
    for (const [asked, width] of cases) {
      expect(widthOf(asked)).toBe(width)
      expect(frameOptions(asked === undefined ? {} : { width: asked }).width).toBe(width)
    }
    expect(frameOptions({ width: ['375', '1920'] }).width).toBe('phone375')
  })

  it('keeps the theme and language, and every frame link names its width by key', () => {
    const options = frameOptions({ theme: 'dark', width: '1920', lang: 'it' })
    expect(options).toEqual({ theme: 'dark', width: 'wide', locale: 'it' })
    expect(frameHref('SCR-038', 'owner', options)).toBe('/design/SCR-038/owner?theme=dark&width=wide&lang=it')
    expect(frameHref('SCR-038', 'phone', frameOptions({ width: 'phone375' }))).toBe('/design/SCR-038/phone?theme=light&width=phone375&lang=en')
  })
})
