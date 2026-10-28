import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { cssDensityBlocks, cssVars, cssVarsDark } from './css-vars'
import {
  DENSITIES,
  DENSITY_TOKENS,
  DEFAULT_DENSITY,
  densityAttrs,
  densityCss,
  densityTokens,
  isDensityName,
  type DensityTokenKey,
} from './density'
import { GRID_DENSITIES } from './grid'

const keys = Object.keys(DENSITY_TOKENS) as DensityTokenKey[]
const rootValue = new Map(cssVars.map((v) => [v.name, v.value]))

/** Follow a `var(--x)` chain through the `:root` tokens to its literal. */
function resolveRoot(value: string, seen = 0): string {
  const m = /^var\((--nds-[a-z0-9-]+)\)$/.exec(value)
  if (!m) return value
  const next = rootValue.get(m[1])
  if (next === undefined) throw new Error(`${m[1]} is not a :root token`)
  if (seen > 10) throw new Error(`alias loop at ${m[1]}`)
  return resolveRoot(next, seen + 1)
}

describe('density tiers — the tokens', () => {
  it('has three tiers, standard first and the default, none of them a grid density name (both use data-density)', () => {
    expect(DENSITIES).toEqual(['standard', 'comfortable', 'floor'])
    expect(DEFAULT_DENSITY).toBe('standard')
    for (const d of DENSITIES) expect((GRID_DENSITIES as readonly string[]).includes(d)).toBe(false)
  })

  it('writes every value as an existing token that holds exactly its number, or as that number in px', () => {
    for (const d of DENSITIES) {
      for (const k of keys) {
        const css = densityCss[d][k]
        expect(resolveRoot(css), `${d}.${k} = ${css}`).toBe(`${densityTokens[d][k]}px`)
      }
    }
  })

  it('is dimensions only: an existing size scale or a px literal, never a colour', () => {
    const SIZE = /^(?:var\(--nds-(?:space|control-h|radius|font-size)-[a-z0-9-]+\)|\d+(?:\.\d+)?px)$/
    for (const b of cssDensityBlocks) for (const v of b.vars) expect(v.value, `${b.selector} ${v.name}`).toMatch(SIZE)
  })

  it('redefines ONLY its own --nds-density-* names, so a tier cannot change any existing token', () => {
    const existing = new Set([...cssVars, ...cssVarsDark].map((v) => v.name))
    const names = keys.map((k) => DENSITY_TOKENS[k].css)
    expect(new Set(names).size).toBe(names.length)
    for (const b of cssDensityBlocks) {
      expect(b.vars.map((v) => v.name)).toEqual(names)
      for (const v of b.vars) {
        expect(v.name).toMatch(/^--nds-density-[a-z0-9-]+$/)
        expect(existing.has(v.name), `${v.name} is an existing token`).toBe(false)
      }
    }
  })

  it('emits :root + standard, then comfortable, then floor — each block the table of its tier', () => {
    expect(cssDensityBlocks.map((b) => b.selector)).toEqual([":root, [data-density='standard']", "[data-density='comfortable']", "[data-density='floor']"])
    cssDensityBlocks.forEach((b, i) => {
      const d = DENSITIES[i]
      expect(Object.fromEntries(b.vars.map((v) => [v.name, v.value]))).toEqual(Object.fromEntries(keys.map((k) => [DENSITY_TOKENS[k].css, densityCss[d][k]])))
    })
  })

  it('the generated files carry the blocks AFTER .dark, so the existing blocks are untouched (npm run tokens:check holds the text)', () => {
    for (const file of ['tokens.css', 'tokens-global.css']) {
      const css = readFileSync(fileURLToPath(new URL(`../styles/${file}`, import.meta.url)), 'utf8')
      const dark = css.indexOf('\n.dark, ')
      expect(dark, file).toBeGreaterThan(0)
      let at = dark
      for (const b of cssDensityBlocks) {
        const next = css.indexOf(`\n${b.selector} {\n`, at)
        expect(next, `${file}: ${b.selector}`).toBeGreaterThan(at)
        at = next
      }
      // Nothing but density names after the .dark block closes.
      const tail = css.slice(css.indexOf('\n}\n', dark))
      for (const m of tail.matchAll(/(--[a-z0-9-]+)\s*:/g)) expect(m[1]).toMatch(/^--nds-density-/)
    }
  })
})

describe('density tiers — the sizes', () => {
  const { standard, comfortable, floor } = densityTokens

  it('standard is the console as it is: its control heights, field label, body, metric figure and 2 px focus outline', () => {
    expect(resolveRoot('var(--nds-control-h-sm)')).toBe(`${standard.controlHSm}px`)
    expect(resolveRoot('var(--nds-control-h-md)')).toBe(`${standard.controlH}px`)
    expect(standard).toMatchObject({ fontBody: 13, fontLabel: 12.5, fontNumeral: 22, radius: 8, focusW: 2, focusOffset: 1, targetMin: 24 })
  })

  it('comfortable (portal, links): controls 40–44 px, targets at least 44 px, body 15–16 px', () => {
    expect(comfortable.controlHSm).toBeGreaterThanOrEqual(40)
    expect(comfortable.controlH).toBeGreaterThanOrEqual(40)
    expect(comfortable.controlH).toBeLessThanOrEqual(44)
    expect(comfortable.targetMin).toBeGreaterThanOrEqual(44)
    expect(comfortable.fontBody).toBeGreaterThanOrEqual(15)
    expect(comfortable.fontBody).toBeLessThanOrEqual(16)
  })

  it('floor (gloved hands): nothing under 48 px, primary 56–64 px, body at least 18 px, numerals 32–48 px, 8 mm between targets', () => {
    for (const k of ['targetMin', 'controlHSm', 'controlH', 'controlHPrimary'] as const) expect(floor[k], k).toBeGreaterThanOrEqual(48)
    expect(floor.controlHPrimary).toBeGreaterThanOrEqual(56)
    expect(floor.controlHPrimary).toBeLessThanOrEqual(64)
    expect(floor.fontBody).toBeGreaterThanOrEqual(18)
    expect(floor.fontNumeral).toBeGreaterThanOrEqual(32)
    expect(floor.fontNumeral).toBeLessThanOrEqual(48)
    // 1280 × 800 CSS px on a 10-inch screen is 150.9 px per inch, 5.94 px per mm.
    expect(floor.targetGap / (Math.hypot(1280, 800) / 10 / 25.4)).toBeGreaterThanOrEqual(8)
  })

  it('never shrinks from one tier to the next', () => {
    for (const k of keys) {
      expect(comfortable[k], k).toBeGreaterThanOrEqual(standard[k])
      expect(floor[k], k).toBeGreaterThanOrEqual(comfortable[k])
    }
  })

  it('every tier keeps its own order: small ≤ control ≤ primary, target ≤ small control, label ≤ body ≤ numeral', () => {
    for (const d of DENSITIES) {
      const t = densityTokens[d]
      expect(t.controlHSm, d).toBeLessThanOrEqual(t.controlH)
      expect(t.controlH, d).toBeLessThanOrEqual(t.controlHPrimary)
      expect(t.fontLabel, d).toBeLessThanOrEqual(t.fontBody)
      expect(t.fontBody, d).toBeLessThan(t.fontNumeral)
    }
    expect(floor.targetMin).toBeLessThanOrEqual(floor.controlHSm)
  })
})

describe('density helpers', () => {
  it('isDensityName accepts the three tiers only', () => {
    for (const d of DENSITIES) expect(isDensityName(d)).toBe(true)
    for (const v of ['compact', 'spacious', 'Floor', '', null, 3, undefined]) expect(isDensityName(v)).toBe(false)
  })

  it('densityAttrs is the attribute the CSS selects on', () => {
    expect(densityAttrs('floor')).toEqual({ 'data-density': 'floor' })
    for (const d of DENSITIES) expect(cssDensityBlocks.some((b) => b.selector.split(', ').includes(`[data-density='${densityAttrs(d)['data-density']}']`))).toBe(true)
  })
})
