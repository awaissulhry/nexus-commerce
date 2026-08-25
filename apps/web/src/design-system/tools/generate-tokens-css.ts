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
const OUT_GLOBAL = resolve(__dirname, '../styles/tokens-global.css')

/**
 * The eleven names `globals.css` and `ads.css` ALSO define, as space-separated RGB channels
 * for Tailwind's `rgb(var(--x) / <alpha-value>)`. They are emitted into `tokens.css` (which
 * pages opt into) but NEVER into `tokens-global.css`, which the root layout loads on every
 * route: defining them app-wide as colours would make `rgb(var(--border-default))` resolve to
 * `rgb(#d8dde4)` — invalid, and every Tailwind utility built on them would die across 636
 * files. Phase 9.0b removed the design system's own dependence on these, which is the only
 * reason a global stylesheet is possible at all. See docs/PHASE-9-0B-TOKEN-FORM.md.
 */
const CONTESTED = new Set([
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-disabled', '--text-link',
  '--surface-canvas', '--surface-card', '--surface-sunken',
  '--border-default', '--border-subtle', '--border-strong',
])

const HEAD = `/**
 * GENERATED — do not edit by hand.
 * Source: tokens/css-vars.ts (+ tokens/colors.ts). Regenerate: \`npm run tokens:gen\`.
 *
 * \`--nds-\` namespaced so it never collides with the app's globals.css tokens.
 * The platform-semantic aliases (--text-, --surface-, --border-, --status-,
 * --color-primary) point AT these values; components consume the aliases.
 */`

const emit = (rows: ReadonlyArray<CssVar>, indent = '  '): string =>
  rows
    .map((r) => `${r.section ? `\n${indent}/* ── ${r.section} ── */\n` : ''}${indent}${r.name}: ${r.value};`)
    .join('\n')

const css = `${HEAD}\n\n:root {\n${emit(cssVars)}\n}\n\n.dark {\n${emit(cssVarsDark)}\n}\n`

const GLOBAL_HEAD = `/**
 * GENERATED — do not edit by hand.
 * Source: tokens/css-vars.ts. Regenerate: \`npm run tokens:gen\`.
 *
 * tokens.css minus the platform-alias names the app also defines as RGB channels.
 * This is the file the ROOT LAYOUT loads, so every route gets the --nds-* tiers and
 * the design system's components render styled without each page importing anything.
 * Anything needing the --text, --surface or --border aliases as COLOURS imports tokens.css.
 */`

const globalVars = cssVars.filter((r) => !CONTESTED.has(r.name))
const cssGlobal = `${GLOBAL_HEAD}\n\n:root {\n${emit(globalVars)}\n}\n\n.dark {\n${emit(cssVarsDark)}\n}\n`

if (process.argv.includes('--check')) {
  let stale = false
  for (const [file, want] of [[OUT, css], [OUT_GLOBAL, cssGlobal]] as const) {
    if (readFileSync(file, 'utf8') !== want) {
      console.error(`✗ ${file} is stale vs tokens/css-vars.ts — run \`npm run tokens:gen\` and commit.`)
      stale = true
    }
  }
  if (stale) process.exit(1)
  console.log('✓ tokens.css + tokens-global.css are in sync with tokens/css-vars.ts')
} else {
  writeFileSync(OUT, css)
  writeFileSync(OUT_GLOBAL, cssGlobal)
  console.log(`✓ wrote ${OUT} (${cssVars.length} vars + ${cssVarsDark.length} dark)`)
  console.log(`✓ wrote ${OUT_GLOBAL} (${globalVars.length} vars — ${cssVars.length - globalVars.length} contested aliases withheld)`)
}
