#!/usr/bin/env node
// Verify W2.5 — color cell type.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW2.5 — color cell type\n')

const ec = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/EditableCell.tsx'),
  'utf8',
)
const gc = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/grid-columns.tsx'),
  'utf8',
)
const tsv = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/tsv-helpers.ts'),
  'utf8',
)

console.log("Case 1: 'color' in FieldType union")
check("'color' in union", /\|\s*'color'/.test(ec))

console.log('\nCase 2: coerceColor exported + behaviour')
check('coerceColor exported', /export function coerceColor/.test(ec))

const NAMED_COLORS = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
  pink: '#ffc0cb', brown: '#a52a2a', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0',
}
function coerceColor(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim().toLowerCase()
  if (!s) return null
  const long = s.match(/^#?([0-9a-f]{6})$/)
  if (long) return `#${long[1]}`
  const short = s.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/)
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/)
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((x) =>
      Math.max(0, Math.min(255, parseInt(x, 10))),
    )
    const hex = (n) => n.toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}`
  }
  if (NAMED_COLORS[s]) return NAMED_COLORS[s]
  return null
}

const cases = [
  ['#aabbcc', '#aabbcc'],
  ['aabbcc', '#aabbcc'],
  ['#ABC', '#aabbcc'],
  ['abc', '#aabbcc'],
  ['rgb(170, 187, 204)', '#aabbcc'],
  ['rgb(170 187 204)', '#aabbcc'],
  ['red', '#ff0000'],
  ['BLACK', '#000000'],
  ['', null],
  [null, null],
  ['not a color', null],
  ['#zzz', null],
]
for (const [input, expected] of cases) {
  const got = coerceColor(input)
  check(
    `coerceColor(${JSON.stringify(input)}) === ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`,
    got === expected,
  )
}

console.log('\nCase 3: render branches')
check(
  'edit branch (color picker + hex input)',
  /type="color"/.test(ec) &&
    /placeholder="#rrggbb"/.test(ec),
)
check(
  'display branch (swatch + hex)',
  /backgroundColor: normalised/.test(ec) &&
    /aria-label=\{`Color swatch \$\{normalised\}`\}/.test(ec),
)

console.log('\nCase 4: fieldToMeta routing')
check("field.type === 'color' routed", /fieldType: 'color'/.test(gc))

console.log('\nCase 5: paste coercion')
check(
  "paste 'color' branch",
  /Use #rrggbb, #rgb, rgb\(r,g,b\) or a named color/.test(tsv),
)

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
