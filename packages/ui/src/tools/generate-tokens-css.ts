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
import { cssVars, cssVarsDark, cssDensityBlocks } from '../tokens/css-vars'
import type { CssVar } from '../tokens/css-vars'
import { brandBlocks } from '../tokens/branding'

const OUT = resolve(__dirname, '../styles/tokens.css')
const OUT_GLOBAL = resolve(__dirname, '../styles/tokens-global.css')
const OUT_BRAND = resolve(__dirname, '../styles/branding.css')

/**
 * The eleven platform-alias names the app also defined as space-separated RGB channels. They are
 * emitted into `tokens.css` (which pages opt into) but NEVER into `tokens-global.css`, which the
 * root layout loads on every route. The reason was Tailwind: `globals.css` defined them as channels
 * for `rgb(var(--x) / <alpha-value>)`, and a global colour definition would have made every
 * utility built on them `rgb(#d8dde4)` — invalid. Since 2026-10-01 `globals.css` no longer defines
 * them and Tailwind reads `--nds-*` (apps/web/tailwind.config.ts), so that reason is gone; only the
 * ads shell (`app/_shared/shared-shell.css`) still pins them as channels, and nothing reads them
 * there. Publishing them globally is an open follow-up, not done here. Phase 9.0b removed the
 * design system's own dependence on these, which is what made a global stylesheet possible at all.
 * See docs/PHASE-9-0B-TOKEN-FORM.md.
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

/**
 * The density tiers (tokens/density.ts), after `.dark`: one `[data-density='…']` block per tier. Same specificity as
 * `:root`, so on an `<html data-density>` the later block wins. Appended at the END of both files, so the generated diff
 * only adds lines, and holding only `--nds-density-*` names, so no existing declaration can change.
 */
const densityCss = cssDensityBlocks.map((b) => `\n${b.selector} {\n${emit(b.vars)}\n}\n`).join('')

const css = `${HEAD}\n\n:root {\n${emit(cssVars)}\n}\n\n.dark, .dark body:has(.nds-theme-responsive), .dark body .nds-theme-responsive {\n${emit(cssVarsDark)}\n}\n${densityCss}`

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
const cssGlobal = `${GLOBAL_HEAD}\n\n:root {\n${emit(globalVars)}\n}\n\n.dark, .dark body:has(.nds-theme-responsive), .dark body .nds-theme-responsive {\n${emit(cssVarsDark)}\n}\n${densityCss}`

const BRAND_HEAD = `/**
 * GENERATED — do not edit by hand.
 * Source: tokens/branding.ts (\`brandBlocks\`). Regenerate: \`npm run tokens:gen\`.
 *
 * Tenant branding on a \`[data-brand]\` subtree (\`brandingAttrs\`): maps the subtree's --nds-brand-* properties onto
 * --nds-primary, --nds-primary-hover and --nds-brand-accent, per theme, only for the roles \`data-brand\` names (the roles
 * the tenant's colour passed). Loaded by the app that shows branded pages; the token files every page loads are not
 * touched, so an app without branded pages carries none of this.
 */`

/** tokens/branding.ts's rules, in a file of their own (an app loads it), not in the token files every page loads. */
const cssBrand = `${BRAND_HEAD}\n${brandBlocks().map((b) => `\n${b.selector} {\n${emit(b.vars)}\n}\n`).join('')}`

if (process.argv.includes('--check')) {
  let stale = false
  for (const [file, want] of [[OUT, css], [OUT_GLOBAL, cssGlobal], [OUT_BRAND, cssBrand]] as const) {
    if (readFileSync(file, 'utf8') !== want) {
      console.error(`✗ ${file} is stale vs tokens/css-vars.ts — run \`npm run tokens:gen\` and commit.`)
      stale = true
    }
  }
  if (stale) process.exit(1)
  console.log('✓ tokens.css + tokens-global.css + branding.css are in sync with tokens/css-vars.ts and tokens/branding.ts')
} else {
  writeFileSync(OUT, css)
  writeFileSync(OUT_GLOBAL, cssGlobal)
  writeFileSync(OUT_BRAND, cssBrand)
  console.log(`✓ wrote ${OUT} (${cssVars.length} vars + ${cssVarsDark.length} dark + ${cssDensityBlocks.length} density tiers)`)
  console.log(`✓ wrote ${OUT_GLOBAL} (${globalVars.length} vars — ${cssVars.length - globalVars.length} contested aliases withheld)`)
  console.log(`✓ wrote ${OUT_BRAND} (${brandBlocks().length} branding rules)`)
}
