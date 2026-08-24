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

// ── 3. one stylesheet. Order IS the cascade — this DS resolves conflicts by
// source order, not specificity, so a11y.css stays last as the override layer.
// tokens.css rides along here rather than in tokens/: cfg.tokensGlob only
// reaches a node_modules package, and this DS's tokens are a generated source
// file (tools/generate-tokens-css.ts), not a package.
//
// A generated Tailwind shim used to sit between patterns.css and a11y.css: the
// DS had two components styled with Tailwind utilities instead of .h10-ds-*,
// so they shipped unstyled to anything without the app's Tailwind build. The
// repo fixed that at source (.h10-ds-tbtn* / .h10-ds-tdivider / .h10-ds-cgm-*),
// which left the shim emitting only Tailwind's unconditional preamble. Removed.
const parts = [
  ['tokens.css', join(dsStyles, 'tokens.css')],
  ['base.css', join(here, 'base.css')],
  ...['primitives.css', 'components.css', 'patterns.css'].map((f) => [f, join(dsStyles, f)]),
  ['a11y.css', join(dsStyles, 'a11y.css')],
];
writeFileSync(
  join(dist, 'ds.css'),
  parts.map(([name, p]) => `/* ── ${name} ── */\n${readFileSync(p, 'utf8')}`).join('\n\n'),
);
console.error(`ds-pkg: wrote dist/index.d.ts and dist/ds.css (${parts.length} stylesheets)`);
