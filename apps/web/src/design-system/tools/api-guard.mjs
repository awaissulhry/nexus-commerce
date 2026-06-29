/**
 * DS API-consistency guard — every public type a component declares must be
 * reachable from its area barrel.
 *
 * Fails if a `.tsx` under primitives/ · components/ · patterns/ exports a
 * `type X` / `interface X` that the sibling `index.ts` barrel does NOT
 * re-export. Each gap is printed as `area/File.tsx: TypeName not in barrel`.
 *
 * Barrel membership is matched on a word boundary (`\bTypeName\b`) so a name is
 * only considered re-exported when it appears as a whole token — a substring
 * (e.g. `Column` inside `ColumnCustomizer`) does not count as coverage.
 *
 *   node apps/web/src/design-system/tools/api-guard.mjs
 */
import { readdirSync, readFileSync } from 'fs'

const ROOT = 'apps/web/src/design-system'
const AREAS = ['primitives', 'components', 'patterns']

// Captures the identifier after `export type` / `export interface`
// (handles both `export type X = …` and `export interface X<…> {`).
const EXPORTED_TYPE = /export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g

const gaps = []
for (const area of AREAS) {
  const barrel = readFileSync(`${ROOT}/${area}/index.ts`, 'utf8')
  const files = readdirSync(`${ROOT}/${area}`).filter((f) => f.endsWith('.tsx'))
  for (const file of files) {
    const src = readFileSync(`${ROOT}/${area}/${file}`, 'utf8')
    for (const m of src.matchAll(EXPORTED_TYPE)) {
      const name = m[1]
      const inBarrel = new RegExp(`\\b${name}\\b`).test(barrel)
      if (!inBarrel) gaps.push(`${area}/${file}: ${name} not in barrel`)
    }
  }
}

if (gaps.length) {
  console.error(`✗ api-guard: ${gaps.length} exported type(s) not re-exported by the barrel:`)
  for (const g of gaps) console.error('  ' + g)
  process.exit(1)
}
console.log('✓ api-guard: every component type is re-exported by its barrel')
