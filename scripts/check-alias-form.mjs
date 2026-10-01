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
 *   everything else    `:root` (tokens.css; globals.css no longer defines them)          → WHOLE
 *   ANY scope          `--status-*` / `--color-primary*` are never re-pinned             → WHOLE
 *
 * KNOWN LIMIT — this is a static check keyed on file path. A component that PORTALS to <body>
 * escapes its route's shell at runtime, so its correct form is the one for `:root`, not the one
 * for the directory it lives in. This guard cannot see that. It is why the check reports a count
 * rather than claiming the app is proven correct.
 *
 * THE ELEVEN AT THE ROOT (2026-10-01). globals.css used to define `--text-{primary,secondary,
 * tertiary,disabled,link}`, `--surface-{canvas,card,sunken}` and `--border-{subtle,default,strong}`
 * at `:root`/`.dark` as channels for Tailwind, while tokens.css defines the same names at `:root` as
 * whole colours. tokens.css won on almost every route, so every Tailwind utility built on them
 * (`text-primary`, `bg-card`, `border-default`, …) was `rgb(#hex / 1)` — invalid: inherited black
 * text on the dark page (1.04:1), transparent cards, borders in the text colour. Those utilities
 * now read `--nds-*`. Two more checks hold it:
 *   - `apps/web/tailwind.config.ts` may not read one of the eleven, and may not wrap an `--nds-*`
 *     token (a whole colour) in `rgb()`;
 *   - `apps/web/src/app/globals.css` may not define or read one of the eleven at all.
 *
 *   node scripts/check-alias-form.mjs              # census
 *   node scripts/check-alias-form.mjs --check      # non-zero exit on any violation
 *   node scripts/check-alias-form.mjs --self-test  # the root checks, on planted bad and good input
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

/** Defined as channels by globals.css once, and as whole colours at `:root` by tokens.css. */
const ROOT_CONTESTED = [
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-disabled', '--text-link',
  '--surface-canvas', '--surface-card', '--surface-sunken',
  '--border-subtle', '--border-default', '--border-strong',
];
const TAILWIND_CONFIG = 'apps/web/tailwind.config.ts';
const GLOBALS_CSS = 'apps/web/src/app/globals.css';

const stripBlockComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
/** TS: block comments, then `//` comments that start a line or follow whitespace (keeps `https://`). */
const stripTsComments = (src) => stripBlockComments(src).replace(/(^|\s)\/\/.*$/gm, (m, lead) => lead + ' '.repeat(m.length - lead.length));
const lineAt = (src, i) => src.slice(0, i).split('\n').length;
const nameRe = (name) => new RegExp(`${name}(?![a-z0-9-])`, 'g');

/** Tailwind colours must read whole-colour `--nds-*` tokens, never the eleven, never `rgb(var(--nds-…))`. */
function tailwindViolations(raw, rel) {
  const src = stripTsComments(raw);
  const out = [];
  for (const name of ROOT_CONTESTED) {
    for (const m of src.matchAll(new RegExp(`var\\(\\s*${name}(?![a-z0-9-])`, 'g')))
      out.push([rel, lineAt(src, m.index), `var(${name}) — tokens.css defines it at :root as a WHOLE COLOUR, so a Tailwind colour built on it is invalid on most routes; read its --nds-* token`]);
  }
  for (const m of src.matchAll(/rgba?\(\s*var\(\s*(--nds-[a-z0-9-]+)/g))
    out.push([rel, lineAt(src, m.index), `rgb(var(${m[1]})) — --nds-* tokens are WHOLE COLOURS; use them through color-mix (tailwind.config.ts \`ds()\`)`]);
  return out;
}

/** globals.css loads on every route, before tokens.css: it may neither define nor read the eleven. */
function globalsViolations(raw, rel) {
  const src = stripBlockComments(raw);
  const out = [];
  for (const name of ROOT_CONTESTED) {
    for (const m of src.matchAll(nameRe(name)))
      out.push([rel, lineAt(src, m.index), `${name} — tokens.css owns this name at :root as a WHOLE COLOUR; globals.css may not define or read it (use the --nds-* token)`]);
  }
  return out;
}

if (process.argv.includes('--self-test')) {
  const cases = [
    ['tailwind: the old channel form', tailwindViolations("primary: 'rgb(var(--text-primary) / <alpha-value>)',", 't'), 1],
    ['tailwind: the injected border form', tailwindViolations("default: 'rgb(var(--border-default) / <alpha-value>)',", 't'), 1],
    ['tailwind: rgb() around --nds-*', tailwindViolations("primary: 'rgb(var(--nds-text) / <alpha-value>)',", 't'), 1],
    ['tailwind: ds() over --nds-*', tailwindViolations("const ds = (t) => `color-mix(in srgb, var(${t}) calc(<alpha-value> * 100%), transparent)`\nprimary: ds('--nds-text'),", 't'), 0],
    ['tailwind: an uncontested channel', tailwindViolations("inverse: 'rgb(var(--text-inverse) / <alpha-value>)',", 't'), 0],
    ['tailwind: a mention in a comment', tailwindViolations("// was rgb(var(--text-primary) / <alpha-value>)\n/* rgb(var(--nds-text)) */", 't'), 0],
    ['globals: a :root definition', globalsViolations(':root {\n  --text-primary: 15 23 42;\n}', 'g'), 1],
    ['globals: the old body rule', globalsViolations('body { background-color: rgb(var(--surface-canvas)); color: rgb(var(--text-primary)); }', 'g'), 2],
    ['globals: a prefix is not the name', globalsViolations('.x { --surface-card-hover: 1 2 3; color: rgb(var(--text-primary-ish)); }', 'g'), 0],
    ['globals: the new body rule', globalsViolations('body { background-color: var(--nds-bg); color: var(--nds-text); }', 'g'), 0],
    ['globals: a mention in a comment', globalsViolations('/* rgb(var(--text-primary)) */ body { color: var(--nds-text); }', 'g'), 0],
  ];
  let bad = 0;
  for (const [label, got, want] of cases) {
    const ok = got.length === want;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${label}: ${got.length} violation(s), expected ${want}`);
  }
  if (bad) { console.error(`✗ alias-form self-test: ${bad} case(s) wrong`); process.exit(1); }
  console.log('✓ alias-form self-test passed');
  process.exit(0);
}

const violations = [];
const REPO = process.cwd();
violations.push(...tailwindViolations(readFileSync(join(REPO, TAILWIND_CONFIG), 'utf8'), TAILWIND_CONFIG));
violations.push(...globalsViolations(readFileSync(join(REPO, GLOBALS_CSS), 'utf8'), GLOBALS_CSS));
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
