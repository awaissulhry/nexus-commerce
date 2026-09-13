/** PR.6 source-derived contrast. Grounds come from grid.css plus the menu panel/selected treatment. */
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import assert from 'node:assert/strict'
const root = new URL('../../../../', import.meta.url)
const read = p => readFileSync(new URL(p, root), 'utf8')
const tokenCss = read('apps/web/src/design-system/styles/tokens.css')
const grid = postcss.parse(read('apps/web/src/design-system/grid/theme/grid.css'))
const maps = { light: new Map(), dark: new Map() }
postcss.parse(tokenCss).walkRules(rule => {
  const target = rule.selectors.includes(':root') ? maps.light : rule.selectors.includes('.dark') ? maps.dark : null
  if (target) rule.walkDecls(d => target.set(d.prop, d.value))
})
assert.ok(maps.light.has('--nds-grid-bg') && maps.dark.has('--nds-grid-bg'), 'both declared grid grounds must exist')
const split = value => {
  let depth = 0, start = 0
  const out = []
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++
    if (value[i] === ')') depth--
    if (value[i] === ',' && !depth) { out.push(value.slice(start, i).trim()); start = i + 1 }
  }
  return [...out, value.slice(start).trim()]
}
const rgba = (value, theme, depth = 0) => {
  if (depth > 25) throw Error('token cycle ' + value)
  value = value.trim()
  if (value.startsWith('var(')) {
    const name = value.slice(4, -1)
    const raw = maps[theme].get(name) ?? maps.light.get(name)
    if (!raw) throw Error('unresolved ' + name)
    return rgba(raw, theme, depth + 1)
  }
  if (value === 'transparent') return [0, 0, 0, 0]
  if (value.startsWith('#')) {
    let hex = value.slice(1)
    if (hex.length === 3) hex = [...hex].map(x => x + x).join('')
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1)
  }
  if (value.startsWith('color-mix(')) {
    const [space, a, b] = split(value.slice(10, -1)); assert.equal(space, 'in srgb')
    const part = s => { const m = s.match(/^(.*?)\s+(\d+(?:\.\d+)?)%$/); return { color: rgba(m ? m[1] : s, theme, depth + 1), weight: m ? Number(m[2]) / 100 : null } }
    const x = part(a), y = part(b), wx = x.weight ?? (y.weight == null ? .5 : 1 - y.weight), wy = y.weight ?? 1 - wx
    const alpha = x.color[3] * wx + y.color[3] * wy
    return [0, 1, 2].map(i => alpha ? (x.color[i] * x.color[3] * wx + y.color[i] * y.color[3] * wy) / alpha : 0).concat(alpha)
  }
  const match = value.match(/^rgba?\((.*)\)$/)
  if (match) {
    let body = match[1].replace(/var\((--[^)]+)\)/g, (_, name) => maps[theme].get(name) ?? maps.light.get(name))
    const parts = body.split(/[\s,/]+/).filter(Boolean).map(Number)
    return parts.length === 3 ? [...parts, 1] : parts
  }
  throw Error('unsupported color ' + value)
}
const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3])).concat(1)
const lum = rgb => rgb.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0)
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05)
const hex = rgb => '#' + rgb.slice(0, 3).map(c => Math.round(c).toString(16).padStart(2, '0')).join('')
const rowTokens = ['--nds-grid-bg', '--nds-grid-child-bg', '--nds-grid-hover-bg', '--nds-grid-child-hover-bg', '--nds-grid-selected-bg']
const groundExpressions = new Map(rowTokens.map(n => [n, `var(${n})`]))
for (const n of ['--nds-surface', '--nds-surface-hover', '--nds-primary-soft', '--nds-danger-soft', '--nds-warning-soft']) groundExpressions.set(n, `var(${n})`)
const washes = new Map()
grid.walkDecls('background', d => {
  if (d.parent.type === 'rule' && d.parent.selector.includes('.ag-cell') && !d.parent.selector.includes('::')) {
    if (d.value.startsWith('var(') || d.value.startsWith('color-mix(')) washes.set(d.parent.selector, d.value)
  }
})
assert.ok(washes.size > 5, 'live cell state declarations must be measured')
// Captured pre-change source literals, not an assumed white-ground baseline.
const beforeValues = { light: { '--nds-danger-text': '#9c2f2a', '--nds-success-text': '#146034', '--nds-prov-formula-fg': '#0e7490', '--nds-warning-text': '#6d3f10' }, dark: { '--nds-danger-text': '#ef9c93', '--nds-warning-text': '#f0b46a', '--nds-prov-formula-fg': '#22d3ee' } }
const textNames = ['--nds-danger-text', '--nds-success-text', '--nds-warning-text', '--nds-prov-formula-fg', '--nds-text']
const results = []
for (const theme of ['light', 'dark']) {
  const grounds = [...groundExpressions].map(([name, expr]) => ({ name, rgb: rgba(expr, theme) }))
  for (const [name, expr] of washes) for (const base of rowTokens) grounds.push({ name: `${name} on ${base}`, rgb: over(rgba(expr, theme), rgba(`var(${base})`, theme)) })
  console.log(`\n${theme}: ${groundExpressions.size} named grounds plus ${washes.size * rowTokens.length} cell-state/row-ground combinations. Combined applicability must be witnessed per renderer; these conservative minima do not assert every combination is mounted.`)
  console.log('| ink | minimum before | minimum after | worst ground |')
  console.log('|---|---:|---:|---|')
  for (const name of textNames) {
    const after = rgba(`var(${name})`, theme), before = beforeValues[theme][name] ? rgba(beforeValues[theme][name], theme) : after
    const values = grounds.map(g => ({ ...g, before: ratio(before, g.rgb), after: ratio(after, g.rgb) })).sort((a, b) => a.after - b.after)
    const worst = values[0]
    const monotonic = values.every(v => v.after + .000001 >= v.before)
    console.log(`| ${name} (${hex(after)}) | ${Math.min(...values.map(v => v.before)).toFixed(2)} | ${worst.after.toFixed(2)} | ${worst.name} (${hex(worst.rgb)}); monotonic=${monotonic} |`)
    results.push({ theme, name, min: worst.after, monotonic })
    if (process.argv.includes('--suggest') && worst.after < 7) {
      for (let step = 1; step <= 255; step++) {
        const t = step / 255, candidate = after.slice(0, 3).map(c => Math.round(theme === 'light' ? c * (1 - t) : c + (255 - c) * t)).concat(1)
        const minimum = Math.min(...grounds.map(g => ratio(candidate, g.rgb)))
        if (minimum >= 7.05) { console.log(`Candidate only, NOT APPLIED: ${name} ${hex(candidate)}, minimum=${minimum.toFixed(2)} across every combination`); break }
      }
    }
  }
  for (const name of [...textNames, '--nds-primary']) {
    const foreground = rgba(`var(${name})`, theme)
    console.log(`${name}: ` + ['--nds-surface', '--nds-surface-hover', '--nds-grid-child-bg', '--nds-primary-soft', '--nds-danger-soft'].map(ground => `${ground}=${ratio(foreground, rgba(`var(${ground})`, theme)).toFixed(2)}`).join(' · '))
  }
  const svgMarks = { outdated: '--nds-warning-strong', inherited: '--nds-prov-inherited-fg', inheritedOverride: '--nds-prov-inherited-fg', pinned: '--nds-prov-inherited-fg', mapped: '--nds-grid-muted-fg', mappedShared: '--nds-grid-muted-fg', ai: '--nds-prov-ai-fg', aiStale: '--nds-warning-strong' }
  console.log('Eight SVG marks (3:1 bar), minimum across every ground: ' + Object.entries(svgMarks).map(([mark, ink]) => `${mark}=${Math.min(...grounds.map(g => ratio(rgba(`var(${ink})`, theme), g.rgb))).toFixed(2)}`).join(' · '))
  const outline = rgba('var(--nds-text)', theme)
  console.log('Text-token focus outline minimum across every outer ground: ' + Math.min(...grounds.map(g => ratio(outline, g.rgb))).toFixed(2))
  console.log('Observed app-shell primary pin (pre-correction outline): panel=' + ratio(rgba('#1f6fde', theme), rgba('var(--nds-surface)', theme)).toFixed(2) + ' selected=' + ratio(rgba('#1f6fde', theme), rgba('var(--nds-primary-soft)', theme)).toFixed(2))
  const base = rgba('var(--nds-grid-bg)', theme)
  console.log('focus glow: '+ ratio(over(rgba('rgb(var(--nds-focus-rgb) / 0.12)', theme), base), base).toFixed(2))
  for (const [state, tint, ring] of [['waiting','color-mix(in srgb, var(--nds-warning) 8%, transparent)','--nds-warning'],['unknown','color-mix(in srgb, var(--nds-warning) 8%, transparent)','--nds-warning'],['saving','var(--nds-grid-saving-bg)','--nds-primary']]) {
    const background = over(rgba(tint, theme), base)
    console.log(`${state}: wash=${ratio(background, base).toFixed(2)} glyph=${ratio(rgba('var(--nds-text)', theme), background).toFixed(2)} ring=${ratio(rgba(`var(${ring})`,theme),background).toFixed(2)}`)
  }
}
// The approved ModeNotches repair sits inside the existing light-pinned ads shell.
// Its inset outline follows currentColor, including the higher-specificity hover/above fills.
const modeCss = postcss.parse(read('apps/web/src/app/marketing/ads/rules-automation/rules-automation.css'))
const shellCss = postcss.parse(read('apps/web/src/app/_shared/shared-shell.css'))
const modeSelectors = [
  '.nds-btn.h10-au-notch', '.nds-btn.h10-au-notch:hover:not(:disabled):not(.above)',
  '.nds-btn.h10-au-notch.above', '.h10-au-notch.on.off', '.h10-au-notch.on.observe',
  '.h10-au-notch.on.propose', '.h10-au-notch.on.auto', '.nds-btn.h10-au-notch.earned',
]
for (const theme of ['light', 'dark']) {
  const scope = `${theme}-mode`
  maps[scope] = new Map([...maps.light, ...maps[theme]])
  shellCss.walkRules(rule => {
    if (!rule.selectors.includes('.h10-shell')) return
    rule.walkDecls(d => { if (d.prop.startsWith('--nds-')) maps[scope].set(d.prop, d.value) })
  })
  console.log(`ModeNotches ${theme}, inset currentColor on source-declared control fills (shell pins applied):`)
  for (const selector of modeSelectors) {
    const decls = new Map()
    modeCss.walkRules(rule => { if (rule.selector === selector) rule.walkDecls(d => decls.set(d.prop, d.value)) })
    assert.ok(decls.has('color') && decls.has('background'), `missing mode positive control ${selector}`)
    const ink = rgba(decls.get('color'), scope), ground = rgba(decls.get('background'), scope)
    const contrast = ratio(ink, ground)
    console.log(`${selector}: ${hex(ink)} on ${hex(ground)} = ${contrast.toFixed(2)}`)
    assert.ok(contrast >= 3, `mode inset outline below3:1: ${theme} ${selector}`)
  }
}
assert.equal(ratio(rgba('#000000','light'), rgba('#000000','light')), 1)
assert.equal(ratio(rgba('#000000','light'), rgba('#ffffff','light')), 21)
console.log('\nMath controls: identical=1.00, maximal=21.00; token scopes and live state declarations witnessed.')
if (process.argv.includes('--check')) {
  const failures = results.filter(r => r.min < 7 || !r.monotonic)
  for (const f of failures) console.error(`contrast below AAA: ${f.theme} ${f.name} minimum=${f.min.toFixed(2)} monotonic=${f.monotonic}`)
  process.exitCode = failures.length ? 1 : 0
}
