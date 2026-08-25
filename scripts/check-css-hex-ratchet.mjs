#!/usr/bin/env node
/**
 * Raw-hex ratchet over app CSS — the demand side of the token system.
 *
 * Measured 2026-08-25: the design system SUPPLIES 206 `--nds-*` tokens and its own stylesheets are
 * 100% tokenized (components.css 389 references / 0 literals, primitives 177/0, patterns 99/0),
 * enforced by design-system/tools/token-guard.mjs. The app CONSUMES almost none of it — 10,523 raw
 * hex against 1,170 token references, about 10%. The two heaviest files are the two the operator
 * asked about: rules-automation.css (3,674) and ads.css (2,144).
 *
 * token-guard covers DS stylesheets ONLY, so every one of those 10,523 could grow while a
 * conversion was in progress — converting into a bucket that is still filling. This freezes each
 * file at today's count: existing literals are asked nothing, the number may only go DOWN.
 *
 * Deliberately per-FILE, not per-section like ds-conformance-guard. Tokenization happens one
 * stylesheet at a time, and a per-file number says exactly which one moved.
 *
 * A file with NO baseline entry is held at ZERO. That is the point rather than an oversight: new
 * CSS has no legacy to inherit, the tokens are already there, and `var(--nds-*)` costs the same to
 * type as `#1f6fde`.
 *
 *   node scripts/check-css-hex-ratchet.mjs            # census
 *   node scripts/check-css-hex-ratchet.mjs --baseline # write scripts/css-hex-baseline.json
 *   node scripts/check-css-hex-ratchet.mjs --check    # non-zero exit if any file rose
 *
 * KNOWN LIMIT, stated rather than hidden: counts `#rgb` literals only. `rgba(16, 24, 40, 0.08)`
 * shadows are untokenized too and are NOT counted — `--nds-shadow-*` exists for them, and folding
 * them in would inflate every baseline without a conversion path being ready. A later pass can add
 * them as a second metric; pretending they are covered would be worse than saying they are not.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd(), 'apps/web/src');
const BASELINE = join(process.cwd(), 'scripts/css-hex-baseline.json');

/** The palette SOURCE. Literals belong here and nowhere else — this is what the tokens are. */
const TOKEN_SOURCES = ['design-system/styles/tokens.css', 'design-system/styles/tokens-global.css'];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

// Untracked files are another session's work in a shared tree, not part of this push — counting
// them can fail a push that has nothing to do with them. Same rule as ds-conformance-guard.
let tracked = null;
const isTracked = (p) => {
  if (tracked === null) {
    try {
      tracked = new Set(execSync('git ls-files -z', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean));
    } catch { tracked = new Set(); }
  }
  return tracked.size === 0 || tracked.has(relative(process.cwd(), p));
};

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules') continue;
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.css') && isTracked(p)) yield p;
  }
}

const counts = {};
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (TOKEN_SOURCES.includes(rel)) continue;
  // Comments are not code. Several of these files DOCUMENT a literal on purpose ("#b87503 lives in
  // the shell half"), and counting the explanation would push people to delete the explanation.
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const n = (src.match(HEX) ?? []).length;
  if (n) counts[rel] = n;
}

const mode = process.argv[2] ?? '--census';
const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (mode === '--census') {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log(`${rows.length} stylesheet(s) carry ${total} raw hex literal(s)\n`);
  for (const [f, n] of rows.slice(0, 20)) console.log(`  ${String(n).padStart(5)}  ${f}`);
  if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);
}

if (mode === '--baseline') {
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Raw-hex ratchet over app CSS. Conversions LOWER these; a push may never raise one. A file absent here is held at zero.',
    updatedAt: new Date().toISOString().slice(0, 10), total, files: counts,
  }, null, 2) + '\n');
  console.log(`baseline written: ${Object.keys(counts).length} files, ${total} literals`);
}

if (mode === '--check') {
  if (!existsSync(BASELINE)) { console.log('no baseline — run --baseline once'); process.exit(0); }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')).files;
  const risen = [];
  for (const [f, n] of Object.entries(counts)) {
    const was = base[f] ?? 0;
    if (n > was) risen.push([f, was, n]);
  }
  if (risen.length) {
    console.error(`❌ raw-hex ratchet: ${risen.length} stylesheet(s) gained colour literals:`);
    for (const [f, was, now] of risen) {
      console.error(`   ${f}: ${was} → ${now}`);
      console.error(was === 0
        ? '     New stylesheet — start it on tokens. 206 --nds-* tokens exist; see /DESIGN.md.'
        : '     Replace the literal with a --nds-* token; this file is mid-conversion, not a free-for-all.');
    }
    process.exit(1);
  }
  const dropped = Object.entries(base).filter(([f, was]) => (counts[f] ?? 0) < was);
  console.log(`✓ raw-hex ratchet: ${total} literal(s), none risen${dropped.length ? ` — ${dropped.length} file(s) improved` : ''}`);
}
