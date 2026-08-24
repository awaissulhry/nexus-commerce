#!/usr/bin/env node
/**
 * Platform-alias FORM guard.
 *
 * `--text-*`, `--surface-*`, `--border-*`, `--status-*` and `--color-primary*` are defined in two
 * incompatible shapes in this app, and which one a file gets depends on the shell it renders under:
 *
 *   RGB CHANNELS  `--surface-card: 255 255 255`  → must be written `rgb(var(--surface-card))`
 *   WHOLE COLOUR  `--surface-card: #fff`         → must be written `var(--surface-card)`
 *
 * Written the wrong way round the value is invalid AT COMPUTED-VALUE TIME, so the browser does not
 * fall back to the previous rule — it applies the property's INITIAL value and discards yours,
 * with no error anywhere. `background` becomes transparent, `border` becomes 0px, and a colour
 * becomes `currentColor`. Measured on production 2026-08-25: 6 panels on /marketing/ads/trust
 * rendering with no surface and no border, and 6 elements on /settings/security with black borders.
 *
 * Verified on production, not inferred — every row of the table below was read out of a live
 * page's computed styles:
 *
 *   marketing/ads/**   `.h10-shell` alone           text/surface/border are CHANNELS
 *   products/next/**   `.h10-shell productsNextLight` on ONE element; the light pin wins → WHOLE
 *   fleet/**           `.fleet-surface` + `.fleet-portal`                                → WHOLE
 *   everything else    `:root` (tokens.css beats globals.css there)                      → WHOLE
 *   ANY scope          `--status-*` / `--color-primary*` are never re-pinned             → WHOLE
 *
 * KNOWN LIMIT — this is a static check keyed on file path. A component that PORTALS to <body>
 * escapes its route's shell at runtime, so its correct form is the one for `:root`, not the one
 * for the directory it lives in. This guard cannot see that. It is why the check reports a count
 * rather than claiming the app is proven correct.
 *
 *   node scripts/check-alias-form.mjs            # census
 *   node scripts/check-alias-form.mjs --check    # non-zero exit on any violation
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd(), 'apps/web/src');

/** Re-pinned to channels under `.h10-shell` (apps/web/src/app/_shared/shared-shell.css). */
const CHANNEL_TIER = new Set([
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-disabled', '--text-inverse',
  '--text-link', '--surface-canvas', '--surface-card', '--surface-raised', '--surface-sunken',
  '--surface-overlay', '--border-subtle', '--border-default', '--border-strong',
]);
/** Never re-pinned anywhere: whole colours in every scope, inside the ads shell as much as out. */
const WHOLE_TIER = new Set([
  '--color-primary', '--color-primary-soft',
  '--status-success-soft', '--status-success-line', '--status-success-strong',
  '--status-warning-soft', '--status-warning-line', '--status-warning-strong',
  '--status-danger-soft', '--status-danger-line', '--status-danger-strong',
  '--status-info-soft', '--status-info-line', '--status-info-strong',
]);

/** The only subtree where the channel tier is actually channels. */
const CHANNEL_SCOPE = 'app/marketing/ads/';
/** …minus the file that DEFINES the pin, which necessarily writes the raw triplets. */
const DEFINERS = ['app/_shared/shared-shell.css', 'app/globals.css',
                  'app/products/next/products-next-shell.css', 'app/fleet/fleet-pages.css',
                  'design-system/styles/'];

const BARE = /(?<!rgb\(\s*)var\((--[a-z0-9-]+)\)/g;
const WRAPPED = /rgb\(\s*var\((--[a-z0-9-]+)\)\s*\)/g;

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|tsx|ts)$/.test(p)) out.push(p);
  }
  return out;
};

const violations = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (DEFINERS.some((d) => rel.startsWith(d))) continue;
  const raw = readFileSync(file, 'utf8');
  // Comments are stripped, never checked: several of these files DOCUMENT the wrong form on
  // purpose, and a guard that flags the explanation of a trap teaches people to delete the
  // explanation.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const channelsHere = rel.startsWith(CHANNEL_SCOPE);
  const lineOf = (i) => src.slice(0, i).split('\n').length;

  for (const m of src.matchAll(BARE)) {
    const t = m[1];
    if (CHANNEL_TIER.has(t) && channelsHere)
      violations.push([rel, lineOf(m.index), `bare var(${t}) — under .h10-shell this token is CHANNELS; write rgb(var(${t}))`]);
  }
  for (const m of src.matchAll(WRAPPED)) {
    const t = m[1];
    if (WHOLE_TIER.has(t))
      violations.push([rel, lineOf(m.index), `rgb(var(${t})) — this token is a WHOLE COLOUR in every scope; write var(${t})`]);
    else if (CHANNEL_TIER.has(t) && !channelsHere)
      violations.push([rel, lineOf(m.index), `rgb(var(${t})) — outside .h10-shell this token is a WHOLE COLOUR; write var(${t})`]);
  }
}

if (violations.length === 0) {
  console.log('✓ alias-form: every platform alias matches the form its shell defines');
  process.exit(0);
}
console.error(`✗ alias-form: ${violations.length} declaration(s) will be silently discarded by the browser:`);
for (const [f, l, msg] of violations.slice(0, 40)) console.error(`  ${f}:${l}  ${msg}`);
if (violations.length > 40) console.error(`  … and ${violations.length - 40} more`);
process.exit(process.argv.includes('--check') ? 1 : 0);
