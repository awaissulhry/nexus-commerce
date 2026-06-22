/**
 * DS drift guard — fails if a raw hex color appears in shipped DS code. Every
 * color in primitives/components/patterns + the tokenized stylesheets must come
 * from a token (`var(--h10-*)` in CSS, or an import from `tokens/` in TS).
 * `styles/tokens.css` is the one place hex is allowed — it DEFINES the palette.
 * The `catalog/` (a demo surface) is intentionally out of scope.
 *
 *   node apps/web/src/design-system/tools/token-guard.mjs
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = 'apps/web/src/design-system'
const HEX = /#[0-9a-fA-F]{3,8}\b/
const ALLOW = new Set(['styles/tokens.css'])
const SCOPE = /^(primitives|components|patterns|styles)\//

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const violations = []
for (const file of walk(ROOT)) {
  const rel = file.slice(ROOT.length + 1)
  if (ALLOW.has(rel) || !SCOPE.test(rel) || !/\.(tsx?|css)$/.test(file)) continue
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const t = line.trimStart()
      if (HEX.test(line) && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) {
        violations.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`)
      }
    })
}

if (violations.length) {
  console.error(`✗ token-guard: ${violations.length} raw hex literal(s) in DS code — use var(--h10-*) / tokens:`)
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log('✓ token-guard: no raw hex in DS components/styles (tokens.css excepted)')
