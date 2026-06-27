/**
 * Generates styles/tokens.css from tokens/css-vars.ts — the single source of truth.
 * Do NOT hand-edit tokens.css; edit css-vars.ts (or the colors it imports) and run:
 *
 *   npm run tokens:gen      # write tokens.css
 *   npm run tokens:check    # CI: fail if tokens.css is stale (no write)
 *
 * Runs via the root `tsx` (CJS) so paths resolve off __dirname; CWD doesn't matter.
 */
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { cssVars, cssVarsDark } from '../tokens/css-vars'
import type { CssVar } from '../tokens/css-vars'

const OUT = resolve(__dirname, '../styles/tokens.css')

const HEAD = `/**
 * GENERATED — do not edit by hand.
 * Source: tokens/css-vars.ts (+ tokens/colors.ts). Regenerate: \`npm run tokens:gen\`.
 *
 * \`--h10-\` namespaced so it never collides with the app's globals.css tokens.
 * The platform-semantic aliases (--text-, --surface-, --border-, --status-,
 * --color-primary) point AT these values; components consume the aliases.
 */`

const emit = (rows: ReadonlyArray<CssVar>, indent = '  '): string =>
  rows
    .map((r) => `${r.section ? `\n${indent}/* ── ${r.section} ── */\n` : ''}${indent}${r.name}: ${r.value};`)
    .join('\n')

const css = `${HEAD}\n\n:root {\n${emit(cssVars)}\n}\n\n.dark {\n${emit(cssVarsDark)}\n}\n`

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8')
  if (current !== css) {
    console.error('✗ tokens.css is stale vs tokens/css-vars.ts — run `npm run tokens:gen` and commit.')
    process.exit(1)
  }
  console.log('✓ tokens.css is in sync with tokens/css-vars.ts')
} else {
  writeFileSync(OUT, css)
  console.log(`✓ wrote ${OUT} (${cssVars.length} vars + ${cssVarsDark.length} dark)`)
}
