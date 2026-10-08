import { describe, it, expect } from 'vitest'
import { SHEET_TONES } from '@nexus/shared/sheet-groups'
import { GROUP_TONES, groupToneVars, groupToneVarsDark } from './groupTones'

describe('column-group tones', () => {
  it('names exactly the tones the sheet groups use', () => {
    expect(Object.keys(GROUP_TONES).sort()).toEqual([...SHEET_TONES].sort())
  })

  it('keeps the old flat file\'s band colours (Tailwind v3 colour-100 ground) with colour-900 text for AAA', () => {
    expect(GROUP_TONES.blue).toMatchObject({ bg: '#dbeafe', fg: '#1e3a8a' })
    expect(GROUP_TONES.purple).toMatchObject({ bg: '#f3e8ff', fg: '#581c87' })
    expect(GROUP_TONES.emerald).toMatchObject({ bg: '#d1fae5', fg: '#064e3b' })
    expect(GROUP_TONES.orange).toMatchObject({ bg: '#ffedd5', fg: '#7c2d12' })
    expect(GROUP_TONES.slate).toMatchObject({ bg: '#f1f5f9', fg: '#334155' })
  })

  /* Owner 2026-10-08: the Matrix and the Information page at "AAA quality" — every header name ≥ 7:1 on its tint, in
     light (its hover too: 82 % tint + 18 % edge, `grid.css`) and in dark (the tint at its alpha over the header ground). */
  it('every tone reads at 7:1 or more (WCAG AAA), light, light hover and dark', () => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
    const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
    const mix = (a: number[], b: number[], share: number) => a.map((v, i) => v * share + b[i] * (1 - share))
    const HEADER_DARK = rgb('#1f2c3d')
    for (const [name, t] of Object.entries(GROUP_TONES)) {
      expect(ratio(rgb(t.fg), rgb(t.bg)), `${name} light`).toBeGreaterThanOrEqual(7)
      expect(ratio(rgb(t.fg), mix(rgb(t.bg), rgb(t.rule), 0.82)), `${name} light hover`).toBeGreaterThanOrEqual(7)
      const m = /color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, transparent\)/.exec(t.darkBg)!
      expect(ratio(rgb(t.darkFg), mix(rgb(m[1]), HEADER_DARK, Number(m[2]) / 100)), `${name} dark`).toBeGreaterThanOrEqual(7)
    }
  })

  it('restates every colour in the dark block, so no tone keeps its light value in dark mode', () => {
    const light = groupToneVars.filter((v) => v.name.startsWith('--nds-grid-tone-')).map((v) => v.name)
    expect(groupToneVarsDark.map((v) => v.name)).toEqual(light)
    expect(light).toHaveLength(SHEET_TONES.length * 3)
  })
})
