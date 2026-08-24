// Build for the design-sync import of the Nexus Design System.
//
// The DS lives in apps/web/src/design-system and has no standalone build —
// Next.js compiles it in-app. This emits the two things the converter needs:
//   1. a .d.ts tree (declaration-only) so component props become the API
//      contract the claude.ai/design agent codes against;
//   2. one concatenated stylesheet, since cfg.cssEntry takes a single file.
// It writes only into .design-sync/ds-pkg/dist (gitignored). apps/web is
// read-only to this script.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const dist = join(here, 'dist');
const dsStyles = join(repo, 'apps/web/src/design-system/styles');

// ── 1. declarations ──────────────────────────────────────────────────────
execFileSync('npx', ['tsc', '-p', join(here, 'tsconfig.json')], { stdio: 'inherit', cwd: repo });

// ── 2. the dist entry .d.ts — mirrors index.ts, which mirrors the DS barrels
mkdirSync(dist, { recursive: true });
writeFileSync(
  join(dist, 'index.d.ts'),
  ['primitives', 'components', 'patterns', 'tokens', 'lib']
    .map((d) => `export * from './${d}/index';`)
    .join('\n') + '\n',
);

mkdirSync(dist, { recursive: true });

// ── 2b. the Tailwind shim.
// Two components (ToolbarButton/ToolbarDivider, part of ColumnGroupModal) are
// styled with Tailwind utilities instead of the DS's `.h10-ds-*` convention, so
// they ship unstyled to anything without the app's Tailwind build. Regenerate
// exactly those utilities from apps/web's own config each build, so a class
// added to either component is picked up rather than silently unstyled.
const shim = join(dist, 'tailwind-shim.css');
execFileSync('npx', ['tailwindcss',
  '-c', join(here, 'tailwind-shim.config.ts'),
  '-i', join(here, 'tailwind-shim.in.css'),
  '-o', shim], { stdio: ['ignore', 'ignore', 'inherit'], cwd: repo });

// ── 3. one stylesheet. Order IS the cascade — this DS resolves conflicts by
// source order, not specificity, so a11y.css stays last as the override layer.
// tokens.css rides along here rather than in tokens/: cfg.tokensGlob only
// reaches a node_modules package, and this DS's tokens are a generated source
// file (tools/generate-tokens-css.ts), not a package.
const parts = [
  ['tokens.css', join(dsStyles, 'tokens.css')],
  ['base.css', join(here, 'base.css')],
  ...['primitives.css', 'components.css', 'patterns.css'].map((f) => [f, join(dsStyles, f)]),
  ['tailwind-shim.css (generated)', shim],
  ['a11y.css', join(dsStyles, 'a11y.css')],
];
writeFileSync(
  join(dist, 'ds.css'),
  parts.map(([name, p]) => `/* ── ${name} ── */\n${readFileSync(p, 'utf8')}`).join('\n\n'),
);
console.error(`ds-pkg: wrote dist/index.d.ts and dist/ds.css (${parts.length} stylesheets)`);
