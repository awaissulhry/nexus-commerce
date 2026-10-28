/**
 * DetailModal round 2 (Bid lane re-measure, 2026-10-11): M12 — content that is ONLY an EmptyState is centred in the
 * kept-tall body (it sat 32 px under the tabs, 187–240 px empty below); S3 — on the phone sheet Prev / Next sit on the
 * title row (on their own row the header was 128–131 px of 844), 44 px to touch, the title truncating.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { onlyEmptyState, type EmptyCheckNode } from './detailModalModel'

const el = (cls: string, kids: EmptyCheckNode[] = [], text?: string): EmptyCheckNode => ({
  classList: { contains: (c: string) => cls.split(' ').includes(c) },
  children: kids,
  textContent: text ?? kids.map((k) => k.textContent ?? '').join(''),
})
const empty = () => el('nds-empty', [], 'No effect yet No bid changes to compare')

describe('onlyEmptyState (M12)', () => {
  it('an EmptyState alone, or inside wrappers that hold nothing else, is centred', () => {
    expect(onlyEmptyState(el('', [empty()]))).toBe(true)
    expect(onlyEmptyState(el('', [el('panelBody', [el('stack', [el('tabEmpty', [empty()])])])]))).toBe(true)
  })
  it('normal content is never moved: a sibling, a list beside it, or loose text', () => {
    expect(onlyEmptyState(el('', [el('h', [], 'Last 7 d'), empty()]))).toBe(false)
    expect(onlyEmptyState(el('', [el('stack', [el('table', [], 'rows'), empty()])]))).toBe(false)
    expect(onlyEmptyState(el('', [empty()], 'Changed · No effect yet No bid changes to compare'))).toBe(false)
    expect(onlyEmptyState(el('', []))).toBe(false)
    expect(onlyEmptyState(null)).toBe(false)
  })
  it('the stylesheet centres a marked body only', () => {
    const css = readFileSync(new URL('../styles/patterns.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.nds-detail-body\[data-only-empty\]\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;\s*justify-content:\s*center;\s*\}/)
  })
})

describe('phone sheet header (S3)', () => {
  const phone = (path: string) => (readFileSync(new URL(path, import.meta.url), 'utf8').match(/@media \(max-width: 760px\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) ?? []).join('\n')
  for (const [app, path] of [['web', '../styles/components.css']] as const) {
    it(`${app}: the header's controls flow into the title row; the title truncates; Close is 44 px`, () => {
      const p = phone(path)
      expect(p).toMatch(/\.nds-modal\.detail \.nds-modal-hl,\s*\.nds-modal\.detail \.nds-modal-h-actions\s*\{\s*display:\s*contents;\s*\}/)
      expect(p).toMatch(/\.nds-modal\.detail \.nds-modal-h \.sub\s*\{\s*order:\s*2;\s*flex-basis:\s*100%;/)
      expect(p).not.toMatch(/\.nds-modal\.detail \.nds-modal-h-actions\s*\{[^}]*flex-basis:\s*100%/)
      expect(p).toMatch(/\.nds-modal\.detail \.nds-modal-h \.t\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/)
      expect(p).toMatch(/\.nds-modal\.detail \.nds-modal-x\s*\{\s*width:\s*44px;\s*height:\s*44px;/)
    })
  }
  it('web: a detail\'s own actions keep a line of their own; Prev / Next are 44 px', () => {
    const p = phone('../styles/patterns.css')
    expect(p).toMatch(/\.nds-detail-actions\s*\{\s*order:\s*3;\s*flex-basis:\s*100%;\s*\}/)
    expect(p).toMatch(/\.nds-detail-nav \.nds-btn\s*\{\s*min-width:\s*44px;\s*min-height:\s*44px;/)
  })
})
