/**
 * Dark mode on the legacy (Tailwind) pages.
 *
 * `body` reads `--nds-text`, so text without a colour of its own is light in dark mode. Before, the value
 * was invalid and that text was black: unreadable on the dark page, readable only on the light boxes legacy
 * markup draws without a `dark:` partner. Those boxes, the browser's own form controls and the inverted
 * "slate-900 / dark:slate-100" buttons are what this holds:
 *  - `.dark` declares `color-scheme: dark`, and the light-pinned surfaces declare `light`;
 *  - a light box without `dark:bg-*` keeps dark ink, through a rule with zero specificity, using a colour
 *    `.dark` does not change;
 *  - plain-input placeholders follow their field's text colour (Tailwind's preflight grey-400 is 2.5:1);
 *  - no class string pairs `dark:bg-slate-100` with `text-white` and no `dark:text-*` (white on near-white).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import colors from 'tailwindcss/colors'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..')
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const read = (rel: string) => strip(readFileSync(join(SRC, rel), 'utf8'))
const globals = read('app/globals.css')

describe('color-scheme', () => {
  it('.dark asks the browser for dark form controls', () => {
    expect(globals).toMatch(/(^|\n)\.dark\s*\{\s*color-scheme:\s*dark;\s*\}/)
  })

  it.each([
    ['app/_shared/shared-shell.css', '.h10-shell'],
    ['app/fleet/fleet-pages.css', '.fleet-surface'],
    ['app/products/next/products-next-shell.css', '.productsNextLight'],
  ])('%s keeps its light-pinned surface light (%s)', (file, selector) => {
    const css = read(file)
    const block = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].includes(selector) && /color-scheme:\s*light/.test(m[2]))
    expect(block, `${selector} declares color-scheme: light`).toBeTruthy()
  })
})

describe('light boxes without a dark partner keep dark ink', () => {
  const rule = /:where\(\.dark :is\(([^)]*)\):not\(\[class\*="dark:bg-"\]\)\)\s*\{([^}]*)\}/.exec(globals)
  // Renamed v2 palettes are getters that warn when read; skip them before touching the value.
  const palettes = Object.keys(colors)
    .filter((k) => !['warmGray', 'trueGray', 'coolGray', 'blueGray', 'lightBlue'].includes(k))
    .filter((k) => { const v = (colors as unknown as Record<string, unknown>)[k]; return typeof v === 'object' && v !== null && '50' in v })

  it('is one rule with zero specificity — the whole selector inside :where()', () => {
    expect(rule).not.toBeNull()
    expect(rule![0].startsWith(':where(')).toBe(true)
  })

  it('covers bg-white and the 50/100/200 step of every Tailwind palette', () => {
    const covered = new Set(rule![1].split(',').map((s) => s.trim()))
    const want = ['.bg-white', ...palettes.flatMap((p) => [50, 100, 200].map((n) => `.bg-${p}-${n}`))]
    expect(palettes.length).toBeGreaterThanOrEqual(22)
    expect(want.filter((c) => !covered.has(c))).toEqual([])
  })

  it('sets a theme-stable dark ink and light controls', () => {
    expect(rule![2]).toMatch(/color:\s*var\(--nds-grey-900\)/)
    expect(rule![2]).toMatch(/color-scheme:\s*light/)
    const tokens = read('design-system/styles/tokens-global.css')
    expect(/:root\s*\{[^}]*--nds-grey-900:\s*#1c2530/.test(tokens)).toBe(true)
    const dark = /\.dark, \.dark body[^{]*\{([^}]*)\}/.exec(tokens)?.[1] ?? ''
    expect(dark.length).toBeGreaterThan(100)
    expect(dark).not.toMatch(/--nds-grey-900\s*:/)
  })
})

describe('plain-input placeholders', () => {
  it("follow the field's own text colour instead of preflight grey-400", () => {
    expect(globals).toMatch(/input::placeholder,\s*textarea::placeholder\s*\{\s*color:\s*color-mix\(in srgb, currentColor 75%, transparent\);\s*\}/)
  })
})

describe('inverted buttons (slate-900, dark:slate-100)', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (p.endsWith('.tsx')) out.push(p)
    }
    return out
  }
  // Scan class FRAGMENTS — runs between quotes, backticks and braces — not whole string literals: a
  // backtick literal holding `${active ? 'bg-slate-900 dark:bg-slate-100 text-white' : '… dark:text-…'}`
  // carries the other branch's dark:text- and hid the Returns "ALL" chip from a literal-level scan.
  const LIGHT_DARK_FILL = /\bdark:bg-(?:white|(?:slate|gray|zinc)-(?:50|100|200))\b/
  const offenders: string[] = []
  let seen = 0
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/[^'"`{}\n]+/g)) {
      if (!LIGHT_DARK_FILL.test(m[0])) continue
      seen++
      if (/(?<![:\w-])text-white\b/.test(m[0]) && !/dark:text-/.test(m[0])) offenders.push(`${file.slice(SRC.length + 1)}:${src.slice(0, m.index).split('\n').length}`)
    }
  }

  it('none paints white text on the near-white dark-mode fill (control: the pattern is found)', () => {
    expect(seen).toBeGreaterThan(40)
    expect(offenders).toEqual([])
  })
})
