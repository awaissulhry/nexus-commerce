/**
 * Tenant branding: the colour goes only where it passes, per theme, and a failed role keeps the design system's value.
 * The grounds the rule measures against are resolved from `css-vars.ts` (the source of the tokens CSS), so a token change
 * that this file's restated dark values miss fails here.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cssVars, cssVarsDark } from './css-vars'
import {
  BRAND_CONTRAST,
  BRAND_GROUNDS,
  BRAND_VARS,
  brandBlocks,
  brandHover,
  brandingAttrs,
  brandingRoles,
  brandingStyle,
  checkBranding,
  contrastRatio,
  normalizeHex,
  safeLogoUrl,
  type BrandTheme,
} from './branding'

/** A token's colour in a theme, every `var()` followed — dark falls back to light, as the cascade does. */
function resolve(name: string, theme: BrandTheme, depth = 0): string {
  if (depth > 20) throw new Error(`loop at ${name}`)
  const row = (theme === 'dark' ? cssVarsDark.find((r) => r.name === name) : undefined) ?? cssVars.find((r) => r.name === name)
  if (!row) throw new Error(`${name} is not defined`)
  const ref = row.value.match(/^var\((--[a-z0-9-]+)\)$/)
  return ref ? resolve(ref[1], theme, depth + 1) : row.value.toLowerCase()
}

describe('the grounds are the tokens the design system draws', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: every ground and the button label equal css-vars.ts`, () => {
      for (const [name, hex] of Object.entries(BRAND_GROUNDS[theme].grounds)) expect(hex.toLowerCase(), name).toBe(resolve(name, theme))
      expect(BRAND_GROUNDS[theme].inverse.toLowerCase()).toBe(resolve('--nds-text-inverse', theme))
    })
  }
  it('measures the same five grounds check-nds-contrast holds --nds-primary to', () => {
    expect(Object.keys(BRAND_GROUNDS.light.grounds).sort()).toEqual(['--nds-bg', '--nds-surface', '--nds-surface-hover', '--nds-surface-raised', '--nds-surface-sunken'])
  })
})

describe('the primary rule is the design system’s own bar', () => {
  it('the design system’s primary passes it in both themes (the rule is not stricter than the tokens)', () => {
    const check = checkBranding({ name: 'Nexus', accent: resolve('--nds-primary', 'light'), accentDark: resolve('--nds-primary', 'dark') })
    expect(check.light.primary).toBe(true)
    expect(check.dark.primary).toBe(true)
    expect(check.light.failures).toEqual([])
    expect(check.dark.failures).toEqual([])
  })
  it('measures seven primary pairs at 7:1 and five accent pairs at 3:1, weakest first', () => {
    const { light } = checkBranding({ name: 'Acme', accent: '#134da3' })
    expect(light.pairs.filter((p) => p.min === BRAND_CONTRAST.primary)).toHaveLength(7)
    expect(light.pairs.filter((p) => p.min === BRAND_CONTRAST.accent)).toHaveLength(5)
    const ratios = light.pairs.map((p) => p.ratio)
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b))
  })
  it('the hover fill moves the design system’s way and keeps the label readable', () => {
    expect(contrastRatio('#ffffff', brandHover('#134da3', 'light'))).toBeGreaterThan(contrastRatio('#ffffff', '#134da3'))
    expect(contrastRatio('#14223a', brandHover('#98bbf0', 'dark'))).toBeGreaterThan(contrastRatio('#14223a', '#98bbf0'))
  })
})

describe('a colour that fails is refused, role by role and theme by theme', () => {
  it('refuses a low-contrast accent in light (every role) and judges dark on its own', () => {
    const check = checkBranding({ name: 'Pale Co', accent: '#9ecbff' })
    expect(check.light).toMatchObject({ colour: '#9ecbff', primary: false, accent: false, hover: null })
    expect(check.light.failures[0].ratio).toBeLessThan(BRAND_CONTRAST.accent)
    expect(check.light.failures.some((f) => f.pair === '--nds-text-inverse on fill')).toBe(true)
    // The same pale blue is a good dark-theme accent: light text on the dark canvas, the dark label on the fill.
    expect(check.dark).toMatchObject({ primary: true, accent: true })
    const style = brandingStyle(check)
    expect(Object.keys(style).sort()).toEqual([BRAND_VARS.dark.accent, BRAND_VARS.dark.primary, BRAND_VARS.dark.hover].sort())
  })
  it('no colour fails the accent rule in both themes: a colour too light for light passes in dark, and back', () => {
    for (let l = 0; l <= 255; l += 5) {
      const hex = `#${l.toString(16).padStart(2, '0').repeat(3)}`
      const check = checkBranding({ name: 'Grey', accent: hex })
      expect(check.light.accent || check.dark.accent, hex).toBe(true)
    }
  })
  it('a mid red is decoration in light (3:1) but never the button fill (white on it is 5.4, under 7)', () => {
    const check = checkBranding({ name: 'Rosso', accent: '#c0392b' })
    expect(check.light).toMatchObject({ primary: false, accent: true })
    expect(check.dark).toMatchObject({ primary: false, accent: false }) // 2.8:1 on the dark surface
    expect(brandingStyle(check)).toEqual({ [BRAND_VARS.light.accent]: '#c0392b' })
  })
  it('a dark navy passes everything in light and nothing in dark; a light accentDark passes in dark', () => {
    const one = checkBranding({ name: 'Navy', accent: '#1d3557' })
    expect(one.light).toMatchObject({ primary: true, accent: true })
    expect(one.dark).toMatchObject({ primary: false, accent: false })
    const two = checkBranding({ name: 'Navy', accent: '#1d3557', accentDark: '#a8c5ff' })
    expect(two.dark).toMatchObject({ colour: '#a8c5ff', primary: true, accent: true })
    expect(brandingStyle(two)).toEqual({
      [BRAND_VARS.light.primary]: '#1d3557',
      [BRAND_VARS.light.hover]: brandHover('#1d3557', 'light'),
      [BRAND_VARS.light.accent]: '#1d3557',
      [BRAND_VARS.dark.primary]: '#a8c5ff',
      [BRAND_VARS.dark.hover]: brandHover('#a8c5ff', 'dark'),
      [BRAND_VARS.dark.accent]: '#a8c5ff',
    })
  })
  it('something that is not a colour is reported and ignored', () => {
    for (const accent of ['red', '#12345', 'rgb(0,0,0)', 'var(--nds-primary)']) {
      const check = checkBranding({ name: 'X', accent })
      expect(check.light).toMatchObject({ invalid: true, colour: null, primary: false, accent: false })
    }
    expect(checkBranding({ name: 'X' }).light).toMatchObject({ invalid: false, colour: null })
    expect(normalizeHex(' #ABC ')).toBe('#aabbcc')
  })
  it('brandingAttrs names the passed roles in data-brand and marks the subtree even when nothing passed', () => {
    expect(brandingAttrs({ name: 'No colour' })).toEqual({ 'data-brand': '', style: {} })
    expect(brandingAttrs({ name: 'Not a colour', accent: 'tomato' })).toEqual({ 'data-brand': '', style: {} })
    expect(brandingAttrs({ name: 'Rosso', accent: '#c0392b' })['data-brand']).toBe('accent-light')
    expect(brandingRoles({ name: 'Navy', accent: '#1d3557', accentDark: '#a8c5ff' })).toEqual(['primary-light', 'accent-light', 'primary-dark', 'accent-dark'])
    expect(brandingRoles({ name: 'Pale Co', accent: '#9ecbff' })).toEqual(['primary-dark', 'accent-dark'])
  })
  it('every role named has its custom properties set, and no property is set for a role not named', () => {
    for (const accent of ['#1d3557', '#c0392b', '#9ecbff', '#0f766e', '#ffffff', '#000000']) {
      const roles = brandingRoles({ name: 'X', accent })
      const style = brandingStyle({ name: 'X', accent })
      for (const theme of ['light', 'dark'] as const) {
        expect(BRAND_VARS[theme].primary in style, `${accent} ${theme} primary`).toBe(roles.includes(`primary-${theme}`))
        expect(BRAND_VARS[theme].hover in style).toBe(roles.includes(`primary-${theme}`))
        expect(BRAND_VARS[theme].accent in style, `${accent} ${theme} accent`).toBe(roles.includes(`accent-${theme}`))
      }
    }
  })
})

describe('the logo address', () => {
  it('keeps https, a path on this site and an inline image; drops everything else', () => {
    expect(safeLogoUrl('https://cdn.example.com/logo.svg')).toBe('https://cdn.example.com/logo.svg')
    expect(safeLogoUrl('/files/logo.png')).toBe('/files/logo.png')
    expect(safeLogoUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=')
    for (const bad of ['javascript:alert(1)', 'http://example.com/logo.png', '//evil.example/logo.png', 'data:text/html;base64,PGI+', 'logo.png', '']) {
      expect(safeLogoUrl(bad), bad).toBeUndefined()
    }
  })
  it('the dark logo falls back to the light one; the name is trimmed', () => {
    const check = checkBranding({ name: '  Acme Leather  ', logoUrl: '/logo.png' })
    expect(check).toMatchObject({ name: 'Acme Leather', logoUrl: '/logo.png', logoDarkUrl: '/logo.png' })
  })
})

describe('the generated stylesheet (styles/branding.css)', () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(`../styles/${file}`, import.meta.url)), 'utf8')
  const brandCss = read('branding.css')
  it('the token files every page loads carry no branding at all', () => {
    for (const file of ['tokens.css', 'tokens-global.css']) expect(read(file)).not.toMatch(/data-brand|--nds-brand-/)
  })
  it('sets only the three brand roles, from --nds-brand-* properties, with no colour and no restated default', () => {
    const names = new Set([...brandCss.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]))
    expect(names).toEqual(new Set(['--nds-primary', '--nds-primary-hover', '--nds-brand-accent']))
    expect(brandCss).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    for (const [, value] of brandCss.matchAll(/^\s*--[a-z0-9-]+:\s*([^;]+);/gm)) expect(value).toMatch(/^var\(--nds-(brand-[a-z-]+|primary)\)$/)
  })
  it('each role fires only in its theme: light rules exclude anything under .dark, dark rules require it', () => {
    const blocks = brandBlocks()
    for (const b of blocks.filter((x) => x.selector.includes('-light'))) expect(b.selector).toMatch(/:not\(\.dark, \.dark \*\)$/)
    for (const b of blocks.filter((x) => x.selector.includes('-dark'))) expect(b.selector).toMatch(/^\.dark \[data-brand~='(primary|accent)-dark'\], \.dark\[data-brand~='(primary|accent)-dark'\]$/)
    // A role a colour failed is not in data-brand, so its rule never fires and the token keeps its inherited value.
    expect(blocks.map((b) => b.selector.match(/~='([a-z-]+)'/)?.[1]).filter(Boolean).sort()).toEqual(['accent-dark', 'accent-light', 'primary-dark', 'primary-light'])
  })
  it('the decoration falls back to the subtree\'s primary (the brand\'s where it passed, else the design system\'s)', () => {
    expect(brandBlocks()[0]).toMatchObject({ selector: '[data-brand]', vars: [{ name: '--nds-brand-accent', value: 'var(--nds-primary)' }] })
  })
})
