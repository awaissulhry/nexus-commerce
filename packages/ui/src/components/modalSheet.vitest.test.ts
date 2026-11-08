import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * B-W2b-155 — Modal's phone sheet is opt-in: a dialog that does not pass `sheet` draws exactly as before. Modal renders
 * through a portal after hydration (nothing to render in Node), so this holds the two places the sheet can reach: every
 * rule of its stylesheet needs the `.sheet` class (or is the grab handle, which only a sheet draws, hidden by default), and
 * the Modal adds the class and the handle only when `sheet` is set and the size is not `detail` or `full`.
 */
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

/** The selectors of every style rule (keyframes and at-rule preludes left out). */
function selectors(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const noKeyframes = noComments.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  const out: string[] = []
  for (const m of noKeyframes.matchAll(/([^{}@;]+)\{[^{}]*\}/g)) {
    for (const sel of m[1].split(',')) if (sel.trim()) out.push(sel.trim())
  }
  return out
}

describe('the phone sheet is opt-in', () => {
  it('every rule of modalSheet.css needs .sheet, except the handle hidden by default', () => {
    const css = read('./modalSheet.css')
    const sels = selectors(css)
    expect(sels.length).toBeGreaterThan(5)
    for (const sel of sels) {
      if (sel === '.nds-modal-grab') continue
      expect(sel, sel).toMatch(/\.nds-backdrop\.sheet\b/)
    }
    expect(css).toMatch(/\.nds-modal-grab \{\s*display: none;\s*\}/)
    // The sheet applies under 720 px only (the BottomBar's breakpoint).
    expect(css).toContain('@media (max-width: 719px)')
  })

  it('Modal adds the class and the handle only for `sheet`, and never for detail or full', () => {
    const src = read('./Modal.tsx')
    expect(src).toContain("labels, sheet = false,")
    expect(src).toContain("const asSheet = sheet && size !== 'detail' && size !== 'full'")
    expect(src).toContain("className={['nds-backdrop', size === 'detail' ? 'detail' : '', asSheet ? 'sheet' : ''].filter(Boolean).join(' ')}")
    expect(src).toContain("{asSheet && <div className=\"nds-modal-grab\" aria-hidden {...grab} />}")
    // Without `sheet` the class lists come out as before: 'nds-backdrop' / 'nds-backdrop detail'.
    const backdrop = (size: string, sheet: boolean) => ['nds-backdrop', size === 'detail' ? 'detail' : '', sheet && size !== 'detail' && size !== 'full' ? 'sheet' : ''].filter(Boolean).join(' ')
    expect(backdrop('sm', false)).toBe('nds-backdrop')
    expect(backdrop('detail', false)).toBe('nds-backdrop detail')
    expect(backdrop('detail', true)).toBe('nds-backdrop detail')
    expect(backdrop('md', true)).toBe('nds-backdrop sheet')
  })

  it('a pulled handle closes only past the threshold and never through a held close', () => {
    const src = read('./Modal.tsx')
    expect(src).toMatch(/const SHEET_CLOSE_PX = \d+/)
    expect(src).toContain('if (d.by >= SHEET_CLOSE_PX && !closeHeldRef.current) closeRef.current()')
  })
})
