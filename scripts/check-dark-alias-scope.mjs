#!/usr/bin/env node
/**
 * Dark-alias scope guard.
 *
 * A CSS custom property whose value is `var(X)` resolves in the scope where it is DECLARED, not
 * where it is used. So `:root { --a: var(--b) }` computes --a using :root's --b and then inherits
 * that LITERAL into `.dark` — redefining --b inside `.dark` never reaches --a.
 *
 * Found the hard way 2026-08-26: --nds-pill-warning-fg aliases --nds-warning-text, which .dark
 * overrides. The pill measured 1.50:1 in the browser while a static resolver that assumed lazy
 * resolution reported it passing. Same for the neutral (2.21) and danger (2.09) pills, and
 * --nds-stale-text.
 *
 * THE RULE: if a :root token's value is `var(X)` and `.dark` overrides X, then `.dark` must also
 * re-declare that token. Re-declaring it with the SAME `var(X)` is enough — inside `.dark` the
 * reference resolves against `.dark`'s X.
 *
 *   node scripts/check-dark-alias-scope.mjs           # report
 *   node scripts/check-dark-alias-scope.mjs --check   # exit 1 if any alias is unreachable
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const FILES = ['apps/web/src/design-system/styles/tokens.css']

let bad = []
for (const rel of FILES) {
  const css = readFileSync(join(ROOT, rel), 'utf8')
  const at = css.indexOf('\n.dark {')
  if (at < 0) continue
  const root = css.slice(0, at)
  const dark = css.slice(at)
  const darkNames = new Set([...dark.matchAll(/(--nds-[a-z0-9-]+):/g)].map((m) => m[1]))
  for (const m of root.matchAll(/(--nds-[a-z0-9-]+):\s*var\((--nds-[a-z0-9-]+)\)\s*;/g)) {
    const [, name, ref] = m
    if (darkNames.has(ref) && !darkNames.has(name)) bad.push({ rel, name, ref })
  }
}

if (bad.length) {
  console.error(`❌ dark-alias scope: ${bad.length} token(s) alias a dark-overridden token but are not re-declared in .dark:`)
  for (const b of bad) console.error(`   ${b.name}  →  var(${b.ref})   [${b.rel}]`)
  console.error(
    `\n   Each keeps its :root-computed LIGHT value inside .dark, because a var() alias resolves\n` +
      `   in the scope where it is DECLARED. Add the same entry to the dark section of\n` +
      `   tokens/css-vars.ts — re-declaring it with the same var(X) is enough.`,
  )
  if (process.argv[2] === '--check') process.exit(1)
} else {
  console.log('✓ dark-alias scope: every :root alias of a dark-overridden token is re-declared in .dark')
}
