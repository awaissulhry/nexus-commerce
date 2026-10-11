import { describe, expect, it } from 'vitest'
import { BODY_PINNED_BY, LIGHT_PINNED, opensDark } from './opens-dark'

/** An element with (or without) a `.dark` ancestor and a light-pinned ancestor. */
const el = (inDark: boolean, inLightPin: boolean) =>
  ({ closest: (sel: string) => ((sel === '.dark' && inDark) || (sel === LIGHT_PINNED && inLightPin) ? ({} as Element) : null) }) as unknown as Element

describe('opensDark — a portalled surface follows the colours of the place it was opened from', () => {
  it('is light with no .dark ancestor', () => {
    expect(opensDark(el(false, false))).toBe(false)
    expect(opensDark(el(false, true))).toBe(false)
    expect(opensDark(null)).toBe(false)
  })
  it('is light inside a light-pinned section under a dark theme (the ads pages on a dark OS)', () => {
    expect(opensDark(el(true, true))).toBe(false)
  })
  it('is dark under a dark theme where nothing pins light', () => {
    expect(opensDark(el(true, false))).toBe(true)
  })
  it('names the same light-pinned sections as the shared shell token pin', () => {
    for (const sel of ['.h10-shell', '.fleet-surface', '.fleet-portal']) expect(LIGHT_PINNED).toContain(sel)
  })
})

describe('opensDark — opened with the focus on <body> (a deep link, a reload)', () => {
  /** <body> (or <html>) under a dark theme, with or without a light-pinned shell in the page. */
  const bodyOf = (shell: boolean, which: 'body' | 'html' = 'body') => {
    const doc = {} as { body: unknown; documentElement: unknown }
    const body = { ownerDocument: doc, closest: (sel: string) => (sel === '.dark' ? ({} as Element) : null), querySelector: (sel: string) => (shell && sel === BODY_PINNED_BY ? ({} as Element) : null) }
    const html = { ownerDocument: doc, closest: (sel: string) => (sel === '.dark' ? ({} as Element) : null) }
    doc.body = body
    doc.documentElement = html
    return (which === 'body' ? body : html) as unknown as Element
  }
  it('follows the body\'s pin: light when the page is a light-pinned shell', () => {
    expect(opensDark(bodyOf(true))).toBe(false)
    expect(opensDark(bodyOf(true, 'html'))).toBe(false)
  })
  it('dark when nothing in the page pins light', () => {
    expect(opensDark(bodyOf(false))).toBe(true)
  })
})
