/**
 * The Owner (2026-10-11, on the Harvest term window): "the pop-up modal is supposed to be centered — also for the
 * negative and the bids". `size="detail"` no longer hangs from a fixed top: the backdrop centres it like every Modal, its
 * height follows its content up to min(880px, the viewport less 2 × 20px), and `DetailModal` keeps the tallest body seen
 * (`nextTallest`), so it only grows, evenly around the centre. A phone (≤ 760px) keeps the full-screen sheet.
 * apps/web vitest has no layout, so the rules are read from the stylesheets (web and Factory).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { nextTallest } from './detailModalModel'

const css = (app: 'web' | 'factory') =>
  readFileSync(new URL(app === 'web' ? '../styles/components.css' : '../../../../factory/src/design-system/styles/components.css', import.meta.url), 'utf8')
/** The stylesheet outside any @media block — the desktop rules. */
const desktop = (text: string) => text.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
const phone = (text: string) => (text.match(/@media \(max-width: 760px\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) ?? []).join('\n')

describe('DetailModal is centred on desktop (the Owner, 2026-10-11)', () => {
  for (const app of ['web', 'factory'] as const) {
    it(`${app}: no fixed-top hang; the base backdrop centres it; the max leaves the backdrop's margins`, () => {
      const d = desktop(css(app))
      expect(d).not.toMatch(/\.nds-backdrop\.detail\s*\{[^}]*align-items:\s*flex-start/)
      expect(d).not.toMatch(/\.nds-backdrop\.detail\s*\{[^}]*padding-top/)
      expect(d).toMatch(/\.nds-backdrop\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*padding:\s*20px;/)
      expect(d).toMatch(/\.nds-modal\.detail\s*\{\s*width:\s*1160px;\s*max-height:\s*min\(880px, calc\(100dvh - 40px\)\);\s*\}/)
    })
    it(`${app}: a phone keeps the full-screen sheet`, () => {
      const p = phone(css(app))
      expect(p).toMatch(/\.nds-backdrop\.detail\s*\{\s*padding:\s*0;\s*align-items:\s*stretch;\s*\}/)
      expect(p).toMatch(/\.nds-modal\.detail\s*\{[^}]*height:\s*100%;[^}]*max-height:\s*none;/)
    })
  }
  it('it only ever grows while open (so a centred dialog grows evenly, never jumps back)', () => {
    let floor = 0
    for (const content of [300, 520, 200, 410]) floor = nextTallest(floor, content, Infinity)
    expect(floor).toBe(520)
    expect(nextTallest(520, 900, 700)).toBe(700)
  })
})
