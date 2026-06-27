# Design System — Consistency & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apps/web/src/design-system` internally consistent, self-truthful, and durable — without changing a single rendered pixel except the one deliberate component rebuild (TagInput).

**Architecture:** Introduce the platform-named semantic token layer as *value-preserving aliases* over the existing `--h10-*` Tier-2 roles; make `tokens/*.ts` the single source that *generates* `styles/tokens.css`; harmonize the public API (one `Tone` vocabulary, correct Badge naming, exported types) updating the 24 consumers; rebuild the one outlier component; lock it all down with extended lint + CI gates.

**Tech Stack:** TypeScript, React, Next.js, plain CSS custom properties (`var(--…)`), Node ESM scripts (`.mjs`), the existing `catalog/verify.mjs` @2x screenshot harness, `tools/token-guard.mjs`.

## Global Constraints

- **No color VALUE changes in Phases 0–2 and 4–5.** Every token edit is an alias or a rename; the catalog screenshot-diff MUST be a no-op. A visible diff is a bug to fix, never to accept. (Spec §2, §8.)
- **`.h10-*` / `.h10-ds-*` class prefix is RETAINED.** The `.h10-*`→`.nx-*` rename is the deferred Phase-9 codemod and is OUT OF SCOPE. (Spec §10, `docs/NAMING.md`.)
- **ZERO edits to `app/products/amazon-flat-file/**` and `app/products/ebay-flat-file/**`.** These are untouchable. Where their consumers (`EbayImportWizard.tsx` uses `Banner`+`Tag`) would otherwise need editing, the DS keeps a deprecated back-compat alias instead. (Spec §10; memory `feedback_flat_file_untouchable`.)
- **`/marketing/ads` must render pixel-identical** after every phase — it reads `--h10-*`, which we keep. (Spec §9.)
- **Inside the design-system, imports are RELATIVE** (portability); `lucide-react` is the icon set. (`docs/NAMING.md`.)
- **Commit with `git commit --only <paths>`** (concurrent sessions share `main`); end every commit message with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. (Memory `project_concurrent_sessions`, `feedback_always_commit_push`.)
- **Verify locally with `tsc` + `next build` + the token/catalog scripts; deploy verification is Vercel/Railway, not Docker.** (Memory `feedback_verify_on_prod_not_docker`.)
- **Canonical tone vocabulary:** `type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'`. (Spec §11 open-item 1, accepted default.)

Commands below assume CWD = repo root `/Users/awais/nexus-commerce`.

---

## Task 0.1: The Map — `docs/AUDIT.md`

The exhaustive inventory the engagement is judged against, and the authoritative source for the mapping tables later tasks consume. Read-only; no runtime risk.

**Files:**
- Create: `apps/web/src/design-system/docs/AUDIT.md`

**Interfaces:**
- Produces: the canonical `--h10-* → platform-semantic` mapping table (consumed verbatim by Tasks 1.2 and 2.2) and the per-value tone remap (consumed by Tasks 3.1–3.4).

- [ ] **Step 1: Generate the raw inventory data**

Run and keep the output:
```bash
cd apps/web/src/design-system
# every component + its barrel export
rg -n "^export (function|const|type)" primitives components patterns
# distinct --h10-* consumed by component CSS (the migration surface)
rg -oh 'var\(--h10-[a-z0-9-]+\)' styles/primitives.css styles/components.css styles/patterns.css | sed 's/var(//;s/)//' | sort -u
# the raw-ramp violations to fix
rg -n 'var\(--h10-(grey|blue|green|red|amber|purple|cyan)-[0-9]' styles/primitives.css styles/components.css styles/patterns.css
```

- [ ] **Step 2: Write `docs/AUDIT.md` with these required sections**

The doc MUST contain, with no "TBD":
1. **Token register** — every `--h10-*` in `styles/tokens.css`, its tier (ramp / semantic role / component token), and its platform-semantic target name (or "DS-only — stays `--h10-*`").
2. **The mapping table** (core color roles only), authoritative for Tasks 1.2 + 2.2:

| `--h10-*` (current) | Platform-semantic alias (new) |
|---|---|
| `--h10-text` | `--text-primary` |
| `--h10-text-2` | `--text-secondary` |
| `--h10-text-3` | `--text-tertiary` |
| `--h10-text-disabled` | `--text-disabled` |
| `--h10-text-link` | `--text-link` |
| `--h10-bg` | `--surface-canvas` |
| `--h10-surface` | `--surface-card` |
| `--h10-surface-sunken` | `--surface-sunken` |
| `--h10-border` | `--border-default` |
| `--h10-border-subtle` | `--border-subtle` |
| `--h10-border-strong` | `--border-strong` |
| `--h10-primary` | `--color-primary` |
| `--h10-primary-soft` | `--color-primary-soft` |
| `--h10-success-soft` | `--status-success-soft` |
| `--h10-success` | `--status-success-line` |
| `--h10-success-strong` | `--status-success-strong` |
| `--h10-warning-soft` | `--status-warning-soft` |
| `--h10-warning` | `--status-warning-line` |
| `--h10-warning-strong` | `--status-warning-strong` |
| `--h10-danger-soft` | `--status-danger-soft` |
| `--h10-danger` | `--status-danger-line` |
| `--h10-danger-strong` | `--status-danger-strong` |
| `--h10-info-soft` | `--status-info-soft` |
| `--h10-info` | `--status-info-line` |

   *DS-only (no alias, stay `--h10-*`):* all `--h10-*-NNN` ramps, `--h10-surface-raised/hover`, `--h10-wash-primary`, `--h10-text-strong/inverse`, `--h10-primary-hover/dark/ghost-border`, `--h10-live`, `--h10-rail-*`, `--h10-radius-*`, `--h10-shadow-*`, `--h10-focus-ring`, `--h10-pill-*`, `--h10-badge-*`, `--h10-targeting-*`, `--h10-row-nav`, `--h10-icon-zone`, `--h10-font-*`.
3. **Per-component register** — for each of the 47: props, tone/size axis, catalog coverage (yes/no), a11y notes, contract C1–C6 pass/fail.
4. **Tone remap table** (authoritative for Phase 3):

| Component | Old | New (`Tone`) |
|---|---|---|
| Pill | `ok` / `warn` / `arch` / `err` | `success` / `warning` / `neutral` / `danger` |
| Tag | `positive` | `success` (keep `positive` as deprecated alias) |
| Toast | `error` | `danger` |
| Banner | `error` | `danger` (keep `variant` prop as deprecated alias) |

5. **Inconsistency register** — the 5 findings from the spec + the 13 raw-ramp reaches, each with file:line and resolution-task number.

- [ ] **Step 3: Commit**
```bash
git add apps/web/src/design-system/docs/AUDIT.md
git commit --only apps/web/src/design-system/docs/AUDIT.md -m "$(cat <<'EOF'
docs(design-system): AUDIT.md — full inventory + token mapping + tone remap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1.1: Token generator — make TS the single source

Build the generator BEFORE adding aliases, proving it reproduces today's `tokens.css` value-for-value.

**Files:**
- Create: `apps/web/src/design-system/tokens/css-vars.ts`
- Create: `apps/web/src/design-system/tools/generate-tokens-css.mjs`
- Modify: `apps/web/package.json` (add a script)
- Modify (regenerate, must stay value-identical): `apps/web/src/design-system/styles/tokens.css`

**Interfaces:**
- Produces: `cssVars: ReadonlyArray<{ section?: string; name: string; value: string }>` and `cssVarsDark: ReadonlyArray<{ name: string; value: string }>` from `css-vars.ts`; an npm script `tokens:gen` and `tokens:check`.

- [ ] **Step 1: Create `css-vars.ts` — the ordered manifest (names+order verbatim from current `tokens.css`, values referencing the structured token exports where they exist)**

Transcribe EVERY `:root` var from `styles/tokens.css` into the array, in file order, preserving the section-comment grouping. Values that already exist in `tokens/colors.ts` reference it (single source); literals (radius/shadow/structural/type) stay literal here. Worked pattern for the first sections (complete the rest the same way from `tokens.css`):

```ts
// apps/web/src/design-system/tokens/css-vars.ts
import { palette, color, pill, badge } from './colors'

/** The authoritative ordered list of CSS custom properties emitted to
 *  styles/tokens.css. ONE source of truth: tokens/* (TS) → tokens.css. */
export const cssVars: ReadonlyArray<{ section?: string; name: string; value: string }> = [
  { section: 'Tier 1: primitive ramps', name: '--h10-white', value: palette.white },
  { name: '--h10-blue-50', value: palette.blue[50] },
  { name: '--h10-blue-100', value: palette.blue[100] },
  { name: '--h10-blue-200', value: palette.blue[200] },
  { name: '--h10-blue-600', value: palette.blue[600] },
  { name: '--h10-blue-700', value: palette.blue[700] },
  { name: '--h10-blue-800', value: palette.blue[800] },
  { name: '--h10-blue-900', value: palette.blue[900] },
  // … grey/green/red/amber/purple/cyan/amazon ramps, then:
  { name: '--h10-shadow-rgb', value: '20 28 38' },
  { name: '--h10-focus-rgb', value: '31 111 222' },
  { section: 'Tier 2: semantic roles', name: '--h10-text', value: 'var(--h10-grey-900)' },
  { name: '--h10-text-2', value: 'var(--h10-grey-600)' },
  // … remaining Tier-2 roles, status pills, Tier-3 badges, radius, elevation,
  //    structural dims, type — each line copied from tokens.css :root in order.
]

export const cssVarsDark: ReadonlyArray<{ name: string; value: string }> = [
  { name: '--h10-text', value: '#e7ebf1' },
  { name: '--h10-text-2', value: '#aab6c2' },
  // … the rest of the current .dark block, in order.
]
```

- [ ] **Step 2: Create the generator**

```js
// apps/web/src/design-system/tools/generate-tokens-css.mjs
// Emits styles/tokens.css from tokens/css-vars.ts. Single source: TS.
//   node apps/web/src/design-system/tools/generate-tokens-css.mjs          (write)
//   node apps/web/src/design-system/tools/generate-tokens-css.mjs --check  (CI: diff only)
import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const DIR = 'apps/web/src/design-system'
const OUT = `${DIR}/styles/tokens.css`

// Load the manifest via a tiny tsx/esbuild transpile-free shim: import the
// compiled values by evaluating the TS through `tsx`. Run under the repo's tsx.
const { cssVars, cssVarsDark } = await import(`../tokens/css-vars.ts`)

const HEAD = `/**\n * GENERATED by tools/generate-tokens-css.mjs from tokens/css-vars.ts.\n * Do not edit by hand — edit the TS source and run \`pnpm tokens:gen\`.\n */\n`
const emit = (rows, indent = '  ') =>
  rows
    .map((r) => `${r.section ? `\n${indent}/* ── ${r.section} ── */\n` : ''}${indent}${r.name}: ${r.value};`)
    .join('\n')

const css = `${HEAD}\n:root {\n${emit(cssVars)}\n}\n\n.dark {\n${emit(cssVarsDark)}\n}\n`

if (process.argv.includes('--check')) {
  const cur = readFileSync(OUT, 'utf8')
  if (cur !== css) {
    console.error('✗ tokens.css is stale — run `pnpm tokens:gen` and commit.')
    process.exit(1)
  }
  console.log('✓ tokens.css matches tokens/css-vars.ts')
} else {
  writeFileSync(OUT, css)
  console.log(`✓ wrote ${OUT}`)
}
```

> Note: this script imports a `.ts` file — run it through the repo's `tsx` (already a dev dep). If `import` of `.ts` fails under plain node, invoke as `npx tsx apps/web/src/design-system/tools/generate-tokens-css.mjs`. Wire that exact invocation into the npm scripts below.

- [ ] **Step 3: Add npm scripts**

In `apps/web/package.json` `"scripts"`, add:
```json
"tokens:gen": "tsx src/design-system/tools/generate-tokens-css.mjs",
"tokens:check": "tsx src/design-system/tools/generate-tokens-css.mjs --check"
```

- [ ] **Step 4: Generate and verify VALUE-identity (the no-op gate)**

```bash
cd apps/web && pnpm tokens:gen
git diff --stat src/design-system/styles/tokens.css
```
Expected: the only diff is the new GENERATED header comment + reflowed whitespace/comments. **Confirm every `--var: value;` pair is unchanged** (no value moved):
```bash
# normalize both sides to "name:value" pairs and diff — MUST be empty
git show HEAD:apps/web/src/design-system/styles/tokens.css | rg -o -- '--[a-z0-9-]+:\s*[^;]+' | sort > /tmp/before.txt
rg -o -- '--[a-z0-9-]+:\s*[^;]+' src/design-system/styles/tokens.css | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "NO-OP ✓"
```
Expected: `NO-OP ✓`.

- [ ] **Step 5: Run the existing token-guard (tokens.css still the only hex home)**
```bash
node apps/web/src/design-system/tools/token-guard.mjs
```
Expected: `✓ token-guard: no raw hex…`.

- [ ] **Step 6: Commit**
```bash
git add apps/web/src/design-system/tokens/css-vars.ts apps/web/src/design-system/tools/generate-tokens-css.mjs apps/web/package.json apps/web/src/design-system/styles/tokens.css
git commit --only apps/web/src/design-system/tokens/css-vars.ts apps/web/src/design-system/tools/generate-tokens-css.mjs apps/web/package.json apps/web/src/design-system/styles/tokens.css -m "$(cat <<'EOF'
feat(design-system): generate tokens.css from TS (single source of truth)

css-vars.ts is now authoritative; tokens.css is generated + value-identical.
Closes the hand-sync drift gap (governance had claimed this already existed).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1.2: Add the platform-semantic alias layer

**Files:**
- Modify: `apps/web/src/design-system/tokens/css-vars.ts`
- Modify (regenerate): `apps/web/src/design-system/styles/tokens.css`

**Interfaces:**
- Produces: the platform-semantic vars (`--text-*`, `--surface-*`, `--border-*`, `--status-*`, `--color-primary*`) defined as `var(--h10-*)` aliases — consumed by Task 2.2.

- [ ] **Step 1: Append a "platform-semantic aliases" section to `cssVars`** (use the Task 0.1 mapping table, every row):
```ts
  { section: 'Platform-semantic aliases (consume THESE in components)', name: '--text-primary', value: 'var(--h10-text)' },
  { name: '--text-secondary', value: 'var(--h10-text-2)' },
  { name: '--text-tertiary', value: 'var(--h10-text-3)' },
  { name: '--text-disabled', value: 'var(--h10-text-disabled)' },
  { name: '--text-link', value: 'var(--h10-text-link)' },
  { name: '--surface-canvas', value: 'var(--h10-bg)' },
  { name: '--surface-card', value: 'var(--h10-surface)' },
  { name: '--surface-sunken', value: 'var(--h10-surface-sunken)' },
  { name: '--border-default', value: 'var(--h10-border)' },
  { name: '--border-subtle', value: 'var(--h10-border-subtle)' },
  { name: '--border-strong', value: 'var(--h10-border-strong)' },
  { name: '--color-primary', value: 'var(--h10-primary)' },
  { name: '--color-primary-soft', value: 'var(--h10-primary-soft)' },
  { name: '--status-success-soft', value: 'var(--h10-success-soft)' },
  { name: '--status-success-line', value: 'var(--h10-success)' },
  { name: '--status-success-strong', value: 'var(--h10-success-strong)' },
  { name: '--status-warning-soft', value: 'var(--h10-warning-soft)' },
  { name: '--status-warning-line', value: 'var(--h10-warning)' },
  { name: '--status-warning-strong', value: 'var(--h10-warning-strong)' },
  { name: '--status-danger-soft', value: 'var(--h10-danger-soft)' },
  { name: '--status-danger-line', value: 'var(--h10-danger)' },
  { name: '--status-danger-strong', value: 'var(--h10-danger-strong)' },
  { name: '--status-info-soft', value: 'var(--h10-info-soft)' },
  { name: '--status-info-line', value: 'var(--h10-info)' },
```

- [ ] **Step 2: Regenerate + verify no-op + token-guard**
```bash
cd apps/web && pnpm tokens:gen
node src/design-system/tools/token-guard.mjs
# the .dark block already flips the --h10-* these alias, so dark is covered transitively
```
Aliases are additive (new var names only) — existing pairs unchanged, so the catalog is visually unaffected.

- [ ] **Step 3: Screenshot-diff no-op gate** (the existing harness)
```bash
node apps/web/src/design-system/catalog/verify.mjs   # captures @2x
```
Expected: catalog renders identically (no value consumes the new aliases yet).

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/design-system/tokens/css-vars.ts apps/web/src/design-system/styles/tokens.css
git commit --only apps/web/src/design-system/tokens/css-vars.ts apps/web/src/design-system/styles/tokens.css -m "$(cat <<'EOF'
feat(design-system): platform-semantic token aliases over --h10-* (value-preserving)

Adds --text-*/--surface-*/--border-*/--status-*/--color-primary as aliases of the
existing --h10-* roles. No values move. Bridges to the ~290 platform pages' vocabulary.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1.3: CI gate — tokens.css can't drift from TS

**Files:**
- Modify: `.githooks/pre-push` (or the repo's existing pre-push script)

- [ ] **Step 1: Add the check to pre-push**, alongside the existing token-guard:
```bash
( cd apps/web && pnpm tokens:check ) || exit 1
node apps/web/src/design-system/tools/token-guard.mjs || exit 1
```
- [ ] **Step 2: Verify it fails on a deliberate drift**
```bash
# temporarily hand-edit tokens.css, then:
cd apps/web && pnpm tokens:check   # expect: ✗ stale → exit 1
git checkout src/design-system/styles/tokens.css
```
- [ ] **Step 3: Commit** (`.githooks/pre-push` only).

---

## Task 2.1: Fix the 13 raw-ramp reaches

**Files:**
- Modify: `apps/web/src/design-system/styles/primitives.css` (lines incl. 147–151, 307, 414, 433, 458)
- Modify: `apps/web/src/design-system/styles/components.css` (lines incl. 378, 850, 868, 928)
- Modify: `apps/web/src/design-system/styles/patterns.css` (line incl. 108)

- [ ] **Step 1: Repoint each raw ramp to its semantic/platform token.** Use this mapping (a ramp's nearest semantic role; values are identical so it's a no-op):

| Raw ramp in component CSS | Replace with |
|---|---|
| `var(--h10-grey-900)` (text/tooltip bg contexts) | `var(--text-primary)` |
| `var(--h10-grey-700)` (`.h10-ds-tag.neutral` fg) | `var(--text-strong-…)` → use `var(--h10-text-strong)` (DS-only role; already semantic) |
| `var(--h10-grey-300)` | `var(--border-strong)` |
| `var(--h10-grey-150)` | `var(--border-subtle)` |
| `var(--h10-grey-100)` | `var(--surface-sunken)` |
| `var(--h10-grey-25)` | `var(--h10-surface-raised)` (DS-only role) |
| `var(--h10-blue-700)` (`.h10-ds-tag.info` fg) | `var(--status-info-strong)` *(add this alias if absent: `--status-info-strong: var(--h10-blue-700)`)* |
| `var(--h10-blue-100)` (`.h10-ds-tag.info` bg) | `var(--status-info-soft)` |
| `var(--h10-green-700)` (`.h10-ds-tag.positive` fg) | `var(--status-success-strong)` |
| `var(--h10-green-soft)` | `var(--status-success-soft)` |
| `var(--h10-red-700)` (`.h10-ds-tag.danger` fg) | `var(--status-danger-strong)` |
| `var(--h10-red-soft)` | `var(--status-danger-soft)` |

   For `.h10-ds-tag.warning` confirm it already uses `--h10-warning*`/`--status-warning-*`; if it reaches a ramp, map analogously. Where a needed `--status-*-strong` info alias is missing, add it to `css-vars.ts` (Task 1.2 section) and regenerate.

- [ ] **Step 2: Re-run the raw-ramp grep — expect ZERO hits**
```bash
rg -n 'var\(--h10-(grey|blue|green|red|amber|purple|cyan)-[0-9]' apps/web/src/design-system/styles/primitives.css apps/web/src/design-system/styles/components.css apps/web/src/design-system/styles/patterns.css
```
Expected: no matches.

- [ ] **Step 3: Regenerate (if aliases added) + screenshot-diff no-op**
```bash
cd apps/web && pnpm tokens:gen && node src/design-system/catalog/verify.mjs
```
Expected: catalog identical (values unchanged).

- [ ] **Step 4: Commit** (the 3 CSS files + any css-vars.ts/tokens.css alias additions).

---

## Task 2.2: Repoint component CSS onto platform-semantic names

**Files:**
- Modify: `apps/web/src/design-system/styles/primitives.css`
- Modify: `apps/web/src/design-system/styles/components.css`
- Modify: `apps/web/src/design-system/styles/patterns.css`

- [ ] **Step 1: Apply the Task 0.1 mapping as a scripted replace** (core color roles only — NOT the DS-only `--h10-*`). Run from repo root:
```bash
cd apps/web/src/design-system/styles
# one sed per mapping row; \b-guard so --h10-text doesn't also match --h10-text-2 etc.
perl -pi -e 's/var\(--h10-text\)/var(--text-primary)/g;            s/var\(--h10-text-2\)/var(--text-secondary)/g;
             s/var\(--h10-text-3\)/var(--text-tertiary)/g;          s/var\(--h10-text-disabled\)/var(--text-disabled)/g;
             s/var\(--h10-text-link\)/var(--text-link)/g;
             s/var\(--h10-bg\)/var(--surface-canvas)/g;             s/var\(--h10-surface\)(?![-a-z])/var(--surface-card)/g;
             s/var\(--h10-surface-sunken\)/var(--surface-sunken)/g;
             s/var\(--h10-border\)(?![-a-z])/var(--border-default)/g; s/var\(--h10-border-subtle\)/var(--border-subtle)/g;
             s/var\(--h10-border-strong\)/var(--border-strong)/g;
             s/var\(--h10-primary\)(?![-a-z])/var(--color-primary)/g; s/var\(--h10-primary-soft\)/var(--color-primary-soft)/g;
             s/var\(--h10-success-soft\)/var(--status-success-soft)/g; s/var\(--h10-success-strong\)/var(--status-success-strong)/g;
             s/var\(--h10-success\)(?![-a-z])/var(--status-success-line)/g;
             s/var\(--h10-warning-soft\)/var(--status-warning-soft)/g; s/var\(--h10-warning-strong\)/var(--status-warning-strong)/g;
             s/var\(--h10-warning\)(?![-a-z])/var(--status-warning-line)/g;
             s/var\(--h10-danger-soft\)/var(--status-danger-soft)/g;   s/var\(--h10-danger-strong\)/var(--status-danger-strong)/g;
             s/var\(--h10-danger\)(?![-a-z])/var(--status-danger-line)/g;
             s/var\(--h10-info-soft\)/var(--status-info-soft)/g;       s/var\(--h10-info\)(?![-a-z])/var(--status-info-line)/g;' \
             primitives.css components.css patterns.css
```

- [ ] **Step 2: Verify only DS-only `--h10-*` remain in components**
```bash
rg -oh 'var\(--h10-[a-z0-9-]+\)' apps/web/src/design-system/styles/{primitives,components,patterns}.css | sort -u
```
Expected: only DS-only names (radius/shadow/focus/pill/badge/targeting/rail/surface-raised/surface-hover/wash-primary/text-strong/text-inverse/primary-hover/primary-dark/primary-ghost-border/live + ramps used by `--h10-pill-*` definitions). NO core role (`--h10-text`, `--h10-bg`, `--h10-border`, `--h10-primary`, `--h10-status*`).

- [ ] **Step 3: Screenshot-diff no-op + build**
```bash
cd apps/web && node src/design-system/catalog/verify.mjs && pnpm build
```
Expected: catalog identical; build clean.

- [ ] **Step 4: Commit** the 3 CSS files.

---

## Task 3.1: Canonical `Tone` + Pill harmonization

**Files:**
- Create: `apps/web/src/design-system/primitives/tone.ts`
- Modify: `apps/web/src/design-system/primitives/Pill.tsx`
- Modify: `apps/web/src/design-system/primitives/index.ts`
- Modify: `apps/web/src/design-system/styles/primitives.css` (`.h10-ds-pill.*` rules + `--h10-pill-*` token class names)
- Modify: `apps/web/src/design-system/styles/tokens.css` via `css-vars.ts` (rename `--h10-pill-{ok,warn,arch,err}-*` → `--h10-pill-{success,warning,neutral,danger}-*`)
- Modify (consumers): `app/fulfillment/stock/import/ImportClient.tsx`, `app/fulfillment/stock/locations/LocationsClient.tsx`, `app/pricing/volume-pricing/VolumePricingClient.tsx`

**Interfaces:**
- Produces: `export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'` from `primitives/tone.ts`, re-exported by the barrel. Consumed by Tasks 3.2–3.4.

- [ ] **Step 1: Create the canonical type**
```ts
// apps/web/src/design-system/primitives/tone.ts
/** The one semantic colour-role vocabulary for status chips/callouts. */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
export const TONES: readonly Tone[] = ['neutral', 'info', 'success', 'warning', 'danger']
```

- [ ] **Step 2: Refactor `Pill.tsx`** (status→tone; forward className per contract C4)
```tsx
import type { ReactNode } from 'react'
import type { Tone } from './tone'

export interface PillProps {
  /** Active→success · Paused→warning · Archived→neutral · Error→danger */
  tone: Tone
  className?: string
  children: ReactNode
}

/** Status pill — matches the H10 `.h10-pill`. */
export function Pill({ tone, className, children }: PillProps) {
  return <span className={`h10-ds-pill ${tone}${className ? ` ${className}` : ''}`}>{children}</span>
}
```

- [ ] **Step 3: Rename the Pill CSS classes + tokens.** In `primitives.css` rename selectors `.h10-ds-pill.ok|.warn|.arch|.err` → `.success|.warning|.neutral|.danger`; in `css-vars.ts` rename `--h10-pill-ok-*`→`--h10-pill-success-*`, `warn`→`warning`, `arch`→`neutral`, `err`→`danger` (values unchanged), regenerate.

- [ ] **Step 4: Update the barrel**
```ts
export { Pill, type PillProps } from './Pill'
export { type Tone, TONES } from './tone'
```
(Remove the old `type PillStatus` export.)

- [ ] **Step 5: Update Pill consumers** (verbatim remap `ok→success, warn→warning, arch→neutral, err→danger`, `status=`→`tone=`):
  - `ImportClient.tsx:945,947,948,949` and the `:1119` ternary (`'ok'|'warn'|'err'|'arch'` → new) + import drops `PillStatus`.
  - `LocationsClient.tsx:287` `status={row.isActive ? 'ok' : 'arch'}` → `tone={row.isActive ? 'success' : 'neutral'}`.
  - `VolumePricingClient.tsx:315` `status={statusPill(r.status)}` → `tone={…}`; update the local `statusPill()` return type from `PillStatus`→`Tone` and its returned literals; import `type Tone` (drop `PillStatus`).

- [ ] **Step 6: tsc + build + screenshot-diff**
```bash
cd apps/web && pnpm tsc --noEmit && node src/design-system/catalog/verify.mjs
rg -n "PillStatus|status=\"(ok|warn|arch|err)\"" src app   # expect: no matches
```
- [ ] **Step 7: Commit** (DS files + 3 consumers).

---

## Task 3.2: Tag harmonization (`positive`→`success`, keep `positive` deprecated)

**Files:**
- Modify: `apps/web/src/design-system/primitives/Tag.tsx`
- Modify: `apps/web/src/design-system/primitives/index.ts`
- Modify: `apps/web/src/design-system/styles/primitives.css` (`.h10-ds-tag.positive` → add `.success`, keep `.positive` as alias)
- Modify (consumers, NON-untouchable only): `ImportClient.tsx`, `LocationsClient.tsx`, `SuggestionsClient.tsx`, `VolumePricingClient.tsx`

**Interfaces:**
- Consumes: `Tone` from `./tone`.

- [ ] **Step 1: Refactor `Tag.tsx`** — accept `Tone`, plus legacy `'positive'` (deprecated) so the untouchable `EbayImportWizard.tsx` keeps compiling:
```tsx
import type { ReactNode } from 'react'
import type { Tone } from './tone'

/** @deprecated use 'success' */
export type LegacyTagTone = 'positive'
export type TagTone = Tone | LegacyTagTone   // 'positive' retained for the untouchable flat-file consumer

export interface TagProps {
  tone?: TagTone
  className?: string
  children: ReactNode
}

export function Tag({ tone = 'neutral', className, children }: TagProps) {
  const t = tone === 'positive' ? 'success' : tone   // normalize legacy
  return <span className={`h10-ds-tag ${t}${className ? ` ${className}` : ''}`}>{children}</span>
}
```

- [ ] **Step 2: CSS** — rename `.h10-ds-tag.positive` rule to `.h10-ds-tag.success` (Task 2.1 already repointed its colors to `--status-success-*`). The component normalizes `positive→success`, so a `.positive` selector is no longer rendered; no `.positive` CSS needed.

- [ ] **Step 3: Barrel** — keep `export { Tag, type TagProps, type TagTone } from './Tag'`.

- [ ] **Step 4: Update NON-untouchable consumers** that pass `'positive'` literally. Grep first:
```bash
rg -n "tone=\"positive\"|=> 'positive'|: 'positive'" app | rg -v 'products/(amazon|ebay)-flat-file'
```
Update those literals to `'success'`. (Dynamic `tone={…}` exprs that may yield `'positive'` keep working via the normalize shim — leave them.)

- [ ] **Step 5: tsc + build + screenshot-diff**, then **Step 6: Commit**.

---

## Task 3.3: Toast harmonization (`variant`→`tone`, `error`→`danger`)

**Files:**
- Modify: `apps/web/src/design-system/components/Toast.tsx`
- Modify: `apps/web/src/design-system/components/index.ts`
- Modify: `apps/web/src/design-system/styles/components.css` (`.h10-ds-toast.error` → `.danger`; add `.warning`/`.neutral` if absent — values from `--status-*`)
- Modify (consumers): `ImportClient.tsx`, `LocationsClient.tsx`, `SuggestionsClient.tsx`, `VolumePricingClient.tsx`

**Interfaces:**
- Consumes: `Tone`. Produces: `toast(message, tone?: Tone)` (signature change: 2nd arg type widened to `Tone`, default `'info'`).

- [ ] **Step 1: Refactor `Toast.tsx`** — replace `ToastVariant` with `Tone`, rename the field, keep the function arg name generic:
```tsx
import type { Tone } from '../primitives/tone'
// type ToastVariant removed — use Tone
interface ToastItem { id: number; message: ReactNode; tone: Tone }
interface ToastApi { toast: (message: ReactNode, tone?: Tone) => void }
// …
const toast = useCallback((message: ReactNode, tone: Tone = 'info') => {
  const id = nextId++
  setItems((xs) => [...xs, { id, message, tone }])
  setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), duration)
}, [duration])
// render: className={`h10-ds-toast ${t.tone}`}
```

- [ ] **Step 2: Barrel** — `export { ToastProvider, useToast, type ToastApi } from './Toast'` (drop `ToastVariant`; export `ToastApi` for typed consumers).

- [ ] **Step 3: CSS** — in `components.css` rename `.h10-ds-toast.error`→`.h10-ds-toast.danger`.

- [ ] **Step 4: Update consumers** — every `toast(msg, 'error')`→`toast(msg, 'danger')`; `'success'` stays. Grep:
```bash
rg -n "toast\([^)]*,\s*'error'\)" app   # update each to 'danger'
```
(ImportClient has 5 `'error'` + 2 `'success'`; LocationsClient/SuggestionsClient/VolumePricingClient per the audit.)

- [ ] **Step 5: tsc + build**, **Step 6: Commit**.

---

## Task 3.4: Banner harmonization (`tone` canonical, `variant` kept deprecated)

`Banner` is used by the untouchable `EbayImportWizard.tsx` (`variant="error"/"info"/"warning"`), so `variant` MUST keep working. Add `tone` as canonical; accept `variant` as a deprecated alias.

**Files:**
- Modify: `apps/web/src/design-system/components/Banner.tsx`
- Modify: `apps/web/src/design-system/components/index.ts`
- Modify: `apps/web/src/design-system/styles/components.css` (`.h10-ds-banner.error`→ add `.danger`, keep `.error` alias rule)
- Modify (NON-untouchable consumers): `VolumePricingClient.tsx`

**Interfaces:**
- Consumes: `Tone`. Produces: `BannerProps` with `tone?: Tone` (canonical) and `/** @deprecated */ variant?: Tone | 'error'`.

- [ ] **Step 1: Refactor `Banner.tsx`**
```tsx
import type { Tone } from '../primitives/tone'
export interface BannerProps {
  tone?: Tone
  /** @deprecated use `tone`. Retained for the untouchable flat-file consumer. */
  variant?: Tone | 'error'
  title?: ReactNode
  children?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  onDismiss?: () => void
}
const DEFAULT_ICON: Record<Tone, ReactNode> = {
  neutral: <Info size={18} aria-hidden />,
  info: <Info size={18} aria-hidden />,
  warning: <AlertTriangle size={18} aria-hidden />,
  danger: <AlertCircle size={18} aria-hidden />,
  success: <CheckCircle2 size={18} aria-hidden />,
}
export function Banner({ tone, variant, title, children, icon, action, onDismiss }: BannerProps) {
  const t: Tone = (variant === 'error' ? 'danger' : (tone ?? variant ?? 'info')) as Tone
  return (
    <div className={`h10-ds-banner ${t}`} role={t === 'danger' ? 'alert' : 'status'}>
      <span className="h10-ds-banner-icon">{icon ?? DEFAULT_ICON[t]}</span>
      {/* …body/action/dismiss unchanged… */}
    </div>
  )
}
```

- [ ] **Step 2: CSS** — rename `.h10-ds-banner.error`→`.h10-ds-banner.danger`; the component maps both old (`error`) and new (`danger`) to the `.danger` class, so no `.error` selector is rendered. Add `.neutral` if the Tone needs it.

- [ ] **Step 3: Barrel** — `export { Banner, type BannerProps } from './Banner'` (drop `BannerVariant`).

- [ ] **Step 4: Update NON-untouchable consumer** `VolumePricingClient.tsx:913,922,1082` `variant="error"/"warning"`→`tone="danger"/"warning"`. **Do NOT touch `EbayImportWizard.tsx`** — its `variant="error"` keeps working via the deprecated alias.

- [ ] **Step 5: tsc + build**; confirm untouchable file untouched:
```bash
git status --porcelain app/products/ebay-flat-file app/products/amazon-flat-file   # expect: empty
```
- [ ] **Step 6: Commit**.

---

## Task 3.5: Badge rename (ad-program, not "tone")

**Files:**
- Modify: `apps/web/src/design-system/primitives/Badge.tsx`
- Modify: `apps/web/src/design-system/primitives/index.ts`

(0 consumers — the audit found no `<Badge tone=>` in the app, so this is internal-only.)

- [ ] **Step 1: Refactor `Badge.tsx`**
```tsx
import type { ReactNode } from 'react'

/** Ad program (Sponsored Products/Display/Brands) + targeting (Auto/Manual). */
export type AdProgram = 'sp' | 'sd' | 'sb' | 'auto' | 'manual'

export interface BadgeProps {
  program: AdProgram
  className?: string
  children: ReactNode
}

export function Badge({ program, className, children }: BadgeProps) {
  return <span className={`h10-ds-badge ${program}${className ? ` ${className}` : ''}`}>{children}</span>
}
```
(CSS class names `.h10-ds-badge.sp|.sd|.sb|.auto|.manual` are unchanged.)

- [ ] **Step 2: Barrel** — `export { Badge, type BadgeProps, type AdProgram } from './Badge'` (drop `BadgeTone`).
- [ ] **Step 3: tsc + build**; `rg -n "BadgeTone" src app` → no matches. **Step 4: Commit**.

---

## Task 3.6: Kbd — export its type

**Files:**
- Modify: `apps/web/src/design-system/primitives/Kbd.tsx`
- Modify: `apps/web/src/design-system/primitives/index.ts`

- [ ] **Step 1: Refactor `Kbd.tsx`**
```tsx
import type { ReactNode } from 'react'
export interface KbdProps { className?: string; children: ReactNode }
/** Keyboard key chip (e.g. ⌘, K). */
export function Kbd({ className, children }: KbdProps) {
  return <kbd className={`h10-ds-kbd${className ? ` ${className}` : ''}`}>{children}</kbd>
}
```
- [ ] **Step 2: Barrel** — `export { Kbd, type KbdProps } from './Kbd'`.
- [ ] **Step 3: tsc** (SuggestionsClient already uses `<Kbd>` children-only — no change needed). **Step 4: Commit**.

---

## Task 3.7: Standardize the `size` scale (documentation + types)

`size` only appears on `Modal` (`sm|md|lg|xl`) and `SegmentedControl` (`sm|md`) today. No renames needed — standardize the TYPE and document the scale so future components conform.

**Files:**
- Modify: `apps/web/src/design-system/primitives/tone.ts` → rename file purpose? NO — create `apps/web/src/design-system/primitives/size.ts`
- Modify: `Modal.tsx`, `SegmentedControl.tsx` to consume the shared types
- Modify: `apps/web/src/design-system/docs/NAMING.md` (add the canonical size scale)

- [ ] **Step 1: Create the shared scale**
```ts
// apps/web/src/design-system/primitives/size.ts
/** Canonical control size scale. Components pick the contiguous subset they support. */
export type Size = 'sm' | 'md' | 'lg' | 'xl'
```
- [ ] **Step 2:** In `Modal.tsx` use `size?: Extract<Size, 'sm'|'md'|'lg'|'xl'>` (i.e. `Size`); in `SegmentedControl.tsx` use `size?: Extract<Size, 'sm'|'md'>`. Re-export `type Size` from the components/primitives barrels as appropriate.
- [ ] **Step 3:** Document in `docs/NAMING.md`: "Control sizes use `Size = sm|md|lg|xl`; a component exposes the contiguous subset it implements; default is `md`."
- [ ] **Step 4: tsc + build** (consumers pass `sm|md|lg|xl` already — unchanged). **Step 5: Commit**.

---

## Task 3.8: Rebuild TagInput onto the DS system

The one outlier. This is the ONLY task that may change pixels — verify it looks right (not a no-op). Props are unchanged, so consumers (`AmazonFlatFileClient`, `AddListingPopover` — both untouchable) need NO edits.

**Files:**
- Modify: `apps/web/src/design-system/primitives/TagInput.tsx`
- Modify: `apps/web/src/design-system/styles/primitives.css` (add `.h10-ds-taginput*` rules)

- [ ] **Step 1: Add CSS** (mirror `.h10-ds-field` + a chip, all semantic tokens) to `primitives.css`:
```css
.h10-ds-taginput { position: relative; }
.h10-ds-taginput-field {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  min-height: 36px; padding: 6px 8px; cursor: text;
  background: var(--surface-card); border: 1px solid var(--border-strong);
  border-radius: var(--h10-radius-lg);
}
.h10-ds-taginput-field:focus-within { border-color: var(--color-primary); box-shadow: var(--h10-focus-ring); }
.h10-ds-taginput.disabled .h10-ds-taginput-field { opacity: .6; pointer-events: none; }
.h10-ds-taginput-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px;
  font-size: 12px; font-weight: 550; border-radius: var(--h10-radius-md);
  color: var(--text-link); background: var(--color-primary-soft);
}
.h10-ds-taginput-chip button { color: var(--text-link); display: inline-flex; }
.h10-ds-taginput-chip button:hover { color: var(--h10-primary-hover); }
.h10-ds-taginput input {
  flex: 1; min-width: 80px; border: 0; outline: none; background: transparent;
  font-size: 12px; color: var(--text-primary);
}
.h10-ds-taginput input::placeholder { color: var(--text-tertiary); }
.h10-ds-taginput-menu {
  position: absolute; z-index: 50; left: 0; right: 0; top: 100%; margin-top: 4px;
  max-height: 160px; overflow-y: auto; padding: 4px 0;
  background: var(--surface-card); border: 1px solid var(--border-default);
  border-radius: var(--h10-radius-lg); box-shadow: var(--h10-shadow-menu);
}
.h10-ds-taginput-menu button {
  display: block; width: 100%; text-align: left; padding: 6px 12px;
  font-size: 12px; color: var(--text-secondary); background: transparent;
}
.h10-ds-taginput-menu button:hover { background: var(--surface-sunken); }
```

- [ ] **Step 2: Rewrite `TagInput.tsx`** — drop `@/lib/utils` and ALL Tailwind/`dark:` classes; keep the exact same props + behavior:
```tsx
'use client'
import { useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'

export interface TagInputProps {
  value: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  suggestions?: string[]
  disabled?: boolean
  className?: string
  maxTags?: number
  'aria-label'?: string
}

export function TagInput({
  value, onChange, placeholder = 'Add value…', suggestions = [],
  disabled = false, className, maxTags, 'aria-label': ariaLabel,
}: TagInputProps) {
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const atMax = maxTags != null && value.length >= maxTags

  const addTag = (raw: string) => {
    const tag = raw.trim()
    if (!tag || value.includes(tag) || atMax) return
    onChange([...value, tag])
  }
  const commit = () => { if (input.trim()) { addTag(input); setInput(''); setOpen(false) } }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
    else if (e.key === 'Tab') commit()
    else if (e.key === 'Backspace' && !input && value.length) onChange(value.slice(0, -1))
    else if (e.key === 'Escape') setOpen(false)
  }
  const filtered = suggestions.filter((s) => s.toLowerCase().includes(input.toLowerCase()) && !value.includes(s))

  return (
    <div className={`h10-ds-taginput${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`}>
      <div className="h10-ds-taginput-field" onClick={() => inputRef.current?.focus()}>
        {value.map((tag, i) => (
          <span key={tag} className="h10-ds-taginput-chip">
            {tag}
            <button type="button" aria-label={`Remove ${tag}`}
              onClick={(e) => { e.stopPropagation(); onChange(value.filter((_, j) => j !== i)) }}>
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        {!atMax && (
          <input ref={inputRef} type="text" value={input} aria-label={ariaLabel}
            placeholder={value.length === 0 ? placeholder : ''}
            onChange={(e) => { setInput(e.target.value); setOpen(true) }}
            onKeyDown={onKey}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onFocus={() => { if (input || filtered.length) setOpen(true) }} />
        )}
      </div>
      {open && filtered.length > 0 && (
        <ul className="h10-ds-taginput-menu">
          {filtered.map((s) => (
            <li key={s}>
              <button type="button" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { addTag(s); setInput(''); setOpen(false); inputRef.current?.focus() }}>{s}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Verify it's clean of the old approach**
```bash
rg -n '(bg|text|border|ring)-(blue|slate)-[0-9]|dark:|@/lib/utils' apps/web/src/design-system/primitives/TagInput.tsx
```
Expected: no matches.

- [ ] **Step 4: tsc + build + visual check.** Render the flat-file Add-Listing popover (or a catalog story) and confirm the rebuilt control looks correct (chips, focus ring, dropdown). This is a deliberate rebuild — judge by eye against the field/chip spec, then **Step 5: Commit** (`TagInput.tsx` + `primitives.css`).

---

## Task 3.9: ref + className forwarding sweep (contract C4)

**Files:**
- Modify: any primitive still missing `className` passthrough (Pill/Tag/Badge/Kbd already added in 3.1/3.2/3.5/3.6). Audit the rest:

- [ ] **Step 1: Find primitives that don't accept `className`**
```bash
cd apps/web/src/design-system/primitives
for f in *.tsx; do rg -q 'className' "$f" || echo "NO className: $f"; done
```
- [ ] **Step 2:** For each gap, add `className?: string` to its props and merge into the root element's class (same pattern as Pill in Task 3.2). Keep behavior identical.
- [ ] **Step 3: tsc + build + screenshot-diff no-op.** **Step 4: Commit**.

---

## Task 4.1: Extend token-guard (raw-ramp + raw-Tailwind guards)

**Files:**
- Modify: `apps/web/src/design-system/tools/token-guard.mjs`

- [ ] **Step 1: Add two checks** after the existing hex scan, before the final exit:
```js
// D1 — raw RAMP reaches in component CSS (numbered ramps only; semantic/DS-token OK)
const RAMP = /var\(--h10-(grey|blue|green|red|amber|purple|cyan)-[0-9]/
// D2 — raw Tailwind palette classes in DS .tsx
const TW = /\b(bg|text|border|ring|from|to|fill|stroke)-(slate|gray|zinc|blue|indigo|green|emerald|red|rose|amber|yellow|orange|purple|violet|cyan|sky)-[0-9]{2,3}\b/

const extra = []
for (const file of walk(ROOT)) {
  const rel = file.slice(ROOT.length + 1)
  if (ALLOW.has(rel) || !SCOPE.test(rel)) continue
  const text = readFileSync(file, 'utf8')
  if (/\.css$/.test(file)) text.split('\n').forEach((l, i) => { if (RAMP.test(l)) extra.push(`${rel}:${i + 1}  raw ramp — use a semantic token`) })
  if (/\.tsx$/.test(file)) text.split('\n').forEach((l, i) => { if (TW.test(l)) extra.push(`${rel}:${i + 1}  raw Tailwind palette — use .h10-ds-* + tokens`) })
}
if (extra.length) { console.error(`✗ token-guard: ${extra.length} ramp/palette violation(s):`); extra.forEach((v) => console.error('  ' + v)); process.exit(1) }
```
- [ ] **Step 2: Run — expect clean** (Tasks 2.1 + 3.8 already removed the violations):
```bash
node apps/web/src/design-system/tools/token-guard.mjs
```
Expected: `✓`.
- [ ] **Step 3: Verify it CATCHES a planted violation** (add a `bg-blue-500` to a scratch line, run, see it fail, revert). **Step 4: Commit**.

---

## Task 4.2: API-consistency check

**Files:**
- Create: `apps/web/src/design-system/tools/api-guard.mjs`

- [ ] **Step 1: Write the guard** — assert each component file's exported types are re-exported by its barrel, and that any `Tone`/`Size`-shaped union matches the canonical set:
```js
// Fails if a primitives/components/patterns .tsx exports a `type X` that the
// sibling index.ts does not re-export, or a tone union diverges from canonical.
import { readdirSync, readFileSync } from 'fs'
const AREAS = ['primitives', 'components', 'patterns']
const ROOT = 'apps/web/src/design-system'
const CANON = "'neutral' | 'info' | 'success' | 'warning' | 'danger'"
const bad = []
for (const area of AREAS) {
  const idx = readFileSync(`${ROOT}/${area}/index.ts`, 'utf8')
  for (const f of readdirSync(`${ROOT}/${area}`).filter((f) => /\.tsx$/.test(f))) {
    const src = readFileSync(`${ROOT}/${area}/${f}`, 'utf8')
    for (const m of src.matchAll(/export (?:type|interface) (\w+)/g)) {
      if (!idx.includes(m[1])) bad.push(`${area}/${f}: exported ${m[1]} not in barrel`)
    }
  }
}
if (bad.length) { console.error('✗ api-guard:'); bad.forEach((b) => console.error('  ' + b)); process.exit(1) }
console.log('✓ api-guard: every component type is re-exported by its barrel')
```
- [ ] **Step 2: Run — fix any gaps it finds** (it may surface DataGrid/Menu/etc. types missing from barrels; add them). **Step 3: Commit**.

---

## Task 4.3: Wire all guards into pre-push/CI

**Files:**
- Modify: `.githooks/pre-push`

- [ ] **Step 1:** Ensure pre-push runs, in order: `pnpm tokens:check`, `token-guard.mjs`, `api-guard.mjs`. (`catalog/verify.mjs` baseline diff stays a manual gate unless the harness supports headless CI.)
- [ ] **Step 2:** Push a no-op commit to confirm the hook runs green. **Step 3: Commit** the hook.

---

## Task 4.4: Reconcile the docs with reality

**Files:**
- Modify: `apps/web/src/design-system/README.md`, `docs/GOVERNANCE.md`, `CHANGELOG.md`
- (Optional) Create: `apps/web/src/design-system/index.ts` (root barrel)

- [ ] **Step 1:** In `README.md` replace the `> Status: Phase 0 — … No runtime code yet` block with the real status (P0–P8 shipped; 47 components live; this hardening pass), and change the "Built in" column from future tense to "Shipped".
- [ ] **Step 2:** In `GOVERNANCE.md`, the "Token values: `tokens/` (TS) → generates … `tokens.css`" line is now TRUE — update the wording from aspirational to "generated by `tools/generate-tokens-css.mjs`; CI-checked." In `NAMING.md`, note the platform-semantic layer is live and is what components consume.
- [ ] **Step 3:** Add a `CHANGELOG.md` entry for this engagement.
- [ ] **Step 4 (optional root barrel):** create `index.ts` re-exporting `./primitives`, `./components`, `./patterns`, `./tokens`, `./lib`.
- [ ] **Step 5: Commit**.

---

## Task 5.1: Catalog completeness

**Files:**
- Modify: `apps/web/src/design-system/catalog/TokenCatalog.tsx` (or the catalog page) + any missing stories

- [ ] **Step 1: Diff catalog coverage vs the barrels**
```bash
cd apps/web/src/design-system
comm -23 <(rg -oh 'export \{ (\w+)' {primitives,components,patterns}/index.ts | sed 's/export { //' | sort -u) \
         <(rg -oh '\b(Pill|Tag|Badge|Button|…)\b' catalog/TokenCatalog.tsx | sort -u)
```
(Adjust the grep to the catalog's actual structure.) List components/states absent from the catalog.
- [ ] **Step 2:** Add a story for each missing component, rendering EVERY state (each `Tone`, each `size`, disabled/loading where relevant). Use the new canonical props.
- [ ] **Step 3: Build + visual review** the catalog page; **Step 4: Commit**.

---

## Task 5.2: A11y completeness sweep

**Files:**
- Modify: interactive primitives/components missing a11y affordances (per the Task 0.1 register)

- [ ] **Step 1:** For each interactive component, verify: visible focus (`:focus-visible`), correct ARIA role/label, keyboard operability, and `prefers-reduced-motion` on any transition. Fix gaps (CSS in `a11y.css`/component CSS; ARIA in the `.tsx`).
- [ ] **Step 2: Contrast lint** per the existing `studies/02-contrast-audit.md` method — body text ≥ 4.5:1, UI ≥ 3:1.
- [ ] **Step 3: Screenshot-diff** (focus states may add outlines — verify intentional), **build**, **Step 4: Commit**.

---

## Self-Review

**Spec coverage:** Workstream A → Tasks 1.1–1.3, 2.1–2.2. Workstream B → Tasks 3.1–3.9. Workstream C → Tasks 0.1, 4.4. Workstream D → Tasks 4.1–4.3. Contract C1–C6 → enforced across 2.x (C1), 3.x (C2/C3/C4), 5.1 (C5), 5.2 (C6). Every spec §4–§7 item maps to a task. ✓

**Constraint coverage:** Untouchable flat-files → Tasks 3.2/3.4 keep `positive`/`variant` deprecated aliases; Task 3.4 Step 5 asserts `git status` clean on those dirs. No-op gate → every Phase-0/1/2/4/5 task ends in a screenshot-diff or value-pair diff. ✓

**Type consistency:** `Tone` defined in `primitives/tone.ts` (Task 3.1) and consumed identically by Pill/Tag/Toast/Banner (3.1–3.4); `Size` in `primitives/size.ts` (3.7); `AdProgram` in Badge (3.5). Barrel exports updated in the same task as each type. ✓

**Placeholder scan:** mechanical sweeps (1.1 manifest, 2.2 repoint, 5.x) specify exact commands + acceptance greps rather than inline-listing every line — each has a verifiable "expect zero/no-op" gate, not a "do the rest somehow." Generator manifest shows the worked pattern + a diff test that fails until complete. ✓
