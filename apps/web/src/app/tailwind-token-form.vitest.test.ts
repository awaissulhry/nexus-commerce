/**
 * Tailwind's semantic colour utilities read design-system tokens, in a form the browser accepts.
 *
 * `text-primary`, `bg-card`, `border-default` and their siblings were built as `rgb(var(--text-primary) / <alpha-value>)`
 * over RGB numbers in globals.css. The design system's tokens.css (imported by ~195 files, the top bar among them)
 * defines the same eleven names at `:root` as whole colours, and on almost every route it won: `rgb(#1c2530 / 1)` is
 * invalid, so text inherited black (1.04:1 on the dark page), cards went transparent and borders took the text
 * colour. The utilities now read `--nds-*` tokens, which have one form, are defined on every route
 * (tokens-global.css, loaded by the root layout) and flip under `.dark`.
 *
 * Held here: no colour in the Tailwind config reads one of the eleven names, none wraps a `--nds-*` token in `rgb()`,
 * and every `--nds-*` token it reads is defined in tokens-global.css for light AND dark. The checker is proven on
 * injected bad values first, and the real build output is read back so the opacity modifiers are known to work.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import { describe, expect, it } from 'vitest'
import config from '../../tailwind.config'

const HERE = import.meta.dirname
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const tokensGlobal = stripComments(readFileSync(join(HERE, '..', 'design-system', 'styles', 'tokens-global.css'), 'utf8'))

/** The names globals.css once defined as RGB numbers and tokens.css defines as whole colours. */
const CONTESTED = [
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-disabled', '--text-link',
  '--surface-canvas', '--surface-card', '--surface-sunken',
  '--border-subtle', '--border-default', '--border-strong',
]

const blockOf = (selector: RegExp) => selector.exec(tokensGlobal)?.[1] ?? ''
const namesIn = (block: string) => new Set([...block.matchAll(/(--nds-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
const LIGHT = namesIn(blockOf(/:root\s*\{([^}]*)\}/))
const DARK = namesIn(blockOf(/\.dark, \.dark body[^{]*\{([^}]*)\}/))

/** Every string in the theme, with its path (`extend.textColor.primary`). Functions are theme callbacks, not colours. */
function strings(node: unknown, path: string[] = []): Array<[string, string]> {
  if (typeof node === 'string') return [[path.join('.'), node]]
  if (Array.isArray(node)) return node.flatMap((v, i) => strings(v, [...path, String(i)]))
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => strings(v, [...path, k]))
  return []
}

/** What would break in the browser, one line per problem. */
function problems(theme: unknown): string[] {
  const out: string[] = []
  for (const [path, value] of strings(theme)) {
    for (const name of CONTESTED) {
      if (new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(value)) out.push(`${path}: reads ${name}, which tokens.css defines as a whole colour — use --nds-*`)
    }
    if (/rgba?\(\s*var\(\s*--nds-/.test(value)) out.push(`${path}: rgb() around an --nds-* token, which is a whole colour`)
    for (const m of value.matchAll(/var\(\s*(--nds-[a-z0-9-]+)/g)) {
      if (!LIGHT.has(m[1])) out.push(`${path}: ${m[1]} is not defined in tokens-global.css :root`)
      if (!DARK.has(m[1])) out.push(`${path}: ${m[1]} has no .dark value in tokens-global.css, so it would not flip`)
    }
  }
  return out
}

describe('the checker (controls)', () => {
  it('reads both theme blocks of tokens-global.css', () => {
    expect(LIGHT.size).toBeGreaterThan(100)
    expect(DARK.size).toBeGreaterThan(50)
    for (const t of ['--nds-text', '--nds-surface', '--nds-border']) {
      expect(LIGHT.has(t), t).toBe(true)
      expect(DARK.has(t), t).toBe(true)
    }
  })

  it('refuses the old form, an rgb()-wrapped --nds-* token and an unknown token', () => {
    expect(problems({ borderColor: { default: 'rgb(var(--border-default) / <alpha-value>)' } })).toEqual([
      'borderColor.default: reads --border-default, which tokens.css defines as a whole colour — use --nds-*',
    ])
    expect(problems({ textColor: { primary: 'rgb(var(--nds-text) / <alpha-value>)' } })).toEqual([
      'textColor.primary: rgb() around an --nds-* token, which is a whole colour',
    ])
    expect(problems({ textColor: { x: 'color-mix(in srgb, var(--nds-no-such-token) 100%, transparent)' } })).toHaveLength(2)
  })

  it('accepts a whole-colour --nds-* token that flips, and the channel names nothing else defines', () => {
    expect(problems({ textColor: { primary: 'color-mix(in srgb, var(--nds-text) calc(<alpha-value> * 100%), transparent)' } })).toEqual([])
    expect(problems({ textColor: { inverse: 'rgb(var(--text-inverse) / <alpha-value>)' } })).toEqual([])
  })
})

describe('tailwind.config.ts', () => {
  it('has no colour that reads a contested name, wraps --nds-* in rgb(), or reads a token without a light and a dark value', () => {
    const values = strings(config.theme)
    expect(values.some(([path]) => path === 'extend.textColor.primary')).toBe(true)
    expect(problems(config.theme)).toEqual([])
  })

  it('reads the design-system token each semantic utility stands for', () => {
    const extend = (config.theme?.extend ?? {}) as Record<string, Record<string, unknown>>
    const token = (value: unknown) => /var\((--nds-[a-z0-9-]+)\)/.exec(String(value))?.[1]
    expect(Object.fromEntries(Object.entries(extend.textColor).map(([k, v]) => [k, token(v) ?? v]))).toMatchObject({
      primary: '--nds-text', secondary: '--nds-text-2', tertiary: '--nds-text-3', disabled: '--nds-text-disabled', link: '--nds-text-link',
    })
    expect(Object.fromEntries(Object.entries(extend.backgroundColor).map(([k, v]) => [k, token(v) ?? v]))).toMatchObject({
      canvas: '--nds-bg', card: '--nds-surface', sunken: '--nds-surface-sunken',
    })
    expect(Object.fromEntries(Object.entries(extend.borderColor).map(([k, v]) => [k, token(v) ?? v]))).toEqual({
      subtle: '--nds-border-subtle', default: '--nds-border', strong: '--nds-border-strong',
    })
    const surface = (extend.colors as Record<string, Record<string, unknown>>).surface
    expect(Object.fromEntries(['background', 'card', 'border', 'border-strong'].map((k) => [k, token(surface[k])]))).toEqual({
      background: '--nds-surface', card: '--nds-surface', border: '--nds-border-subtle', 'border-strong': '--nds-border',
    })
  })
})

describe('the CSS Tailwind builds from it', () => {
  const build = async (classes: string) => {
    const result = await postcss([
      tailwind({ ...config, content: [{ raw: `<div class="${classes}"></div>`, extension: 'html' }], corePlugins: { preflight: false } }),
    ]).process('@tailwind utilities;', { from: undefined })
    return result.css
  }
  const rule = (css: string, selector: string) => {
    const at = css.indexOf(`${selector} {`)
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at) + 1)
  }

  it('keeps opacity working: the default, a /NN modifier, an opacity utility and a variant', async () => {
    const css = await build('text-tertiary border-default/50 text-primary/60 bg-card bg-opacity-50 placeholder:text-tertiary')
    expect(rule(css, '.text-tertiary')).toContain('color: color-mix(in srgb, var(--nds-text-3) calc(var(--tw-text-opacity, 1) * 100%), transparent)')
    expect(rule(css, '.text-tertiary')).toContain('--tw-text-opacity: 1')
    expect(rule(css, '.border-default\\/50')).toContain('border-color: color-mix(in srgb, var(--nds-border) calc(0.5 * 100%), transparent)')
    expect(rule(css, '.text-primary\\/60')).toContain('color: color-mix(in srgb, var(--nds-text) calc(0.6 * 100%), transparent)')
    expect(rule(css, '.bg-card')).toContain('background-color: color-mix(in srgb, var(--nds-surface) calc(var(--tw-bg-opacity, 1) * 100%), transparent)')
    expect(rule(css, '.bg-opacity-50')).toContain('--tw-bg-opacity: 0.5')
    expect(rule(css, '.placeholder\\:text-tertiary::placeholder')).toContain('var(--nds-text-3)')
    expect(css).not.toContain('<alpha-value>')
    for (const name of CONTESTED) expect(css).not.toContain(`var(${name})`)
  })
})
