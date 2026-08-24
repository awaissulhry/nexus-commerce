/**
 * DS drift guard — fails if shipped DS code reaches past the token/semantic tier.
 * Three checks, run together (all violations reported before exiting non-zero):
 *
 *   A — RAW HEX in primitives/components/patterns + the tokenized stylesheets.
 *       Every color must come from a token (`var(--h10-*)` in CSS, or an import
 *       from `tokens/` in TS). `styles/tokens.css` is the one place hex is
 *       allowed — it DEFINES the palette.
 *   B — RAW NUMBERED RAMP in component CSS (`var(--h10-{grey|blue|green|red|
 *       amber|purple|cyan}-NNN)`). Components must consume the semantic /
 *       platform tier (`--text-*`, `--surface-*`, `--status-*`, `--color-*`)
 *       or DS-only component tokens (`--h10-radius/shadow/focus/pill/badge/
 *       rail/surface-hover/surface-raised/text-strong/...`), NOT the numbered
 *       primitive ramps. Only the styles/{primitives,components,patterns}.css
 *       stylesheets are in scope; tokens.css (which DEFINES roles off the ramps)
 *       is not.
 *   C — RAW TAILWIND PALETTE classes in DS `.tsx` (`(bg|text|border|ring|from|
 *       to|fill|stroke)-(slate|gray|zinc|...)-NNN`). DS components style via
 *       `.h10-ds-*` classes + tokens, never raw Tailwind palette utilities.
 *
 * The `catalog/` (a demo surface) is intentionally out of scope throughout.
 *
 *   node apps/web/src/design-system/tools/token-guard.mjs
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = 'apps/web/src/design-system'

// A — raw hex literals
const HEX = /#[0-9a-fA-F]{3,8}\b/
const HEX_ALLOW = new Set(['styles/tokens.css'])
const HEX_SCOPE = /^(primitives|components|patterns|styles)\//

// B — raw NUMBERED primitive ramps reached from component stylesheets.
//     `-[0-9]` after the color word means a numbered ramp step (--h10-blue-700);
//     DS component tokens (--h10-radius-lg, --h10-surface-hover, --h10-text-strong,
//     --h10-pill-success-bg, …) never match because no digit follows the role word.
const RAMP = /var\(--h10-(grey|blue|green|red|amber|purple|cyan)-[0-9]/
const RAMP_FILES = new Set([
  'styles/primitives.css',
  'styles/components.css',
  'styles/patterns.css',
])

// C — raw Tailwind palette utility classes in DS .tsx
const TW =
  /\b(bg|text|border|ring|from|to|fill|stroke)-(slate|gray|zinc|blue|indigo|green|emerald|red|rose|amber|yellow|orange|purple|violet|cyan|sky)-[0-9]{2,3}\b/
const TW_SCOPE = /^(primitives|components|patterns)\//

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/**
 * Which lines of a file are comment. Block-aware, and it has to be: the old
 * per-line heuristic (`startsWith('//' | '*' | '/*')`) only recognised the FIRST
 * line of a `/* … *\/` block plus the `*`-led continuations that happen to be
 * indented that way. A continuation line quoting the very hex or Tailwind class
 * it is warning about read as code — so the guard pressured the author to DELETE
 * the explanation, which is the opposite of what it exists to encourage.
 */
function commentMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let inBlock = false
  lines.forEach((line, i) => {
    const t = line.trimStart()
    if (inBlock) {
      mask[i] = true
      if (line.includes('*/')) inBlock = false
      return
    }
    if (t.startsWith('//') || t.startsWith('*')) {
      mask[i] = true
      return
    }
    if (t.startsWith('/*')) {
      mask[i] = true
      const open = line.indexOf('/*')
      if (line.indexOf('*/', open + 2) === -1) inBlock = true
    }
  })
  return mask
}

const violations = []
for (const file of walk(ROOT)) {
  const rel = file.slice(ROOT.length + 1)
  const isCss = /\.css$/.test(file)
  const isTsx = /\.tsx$/.test(file)
  const isTsOrCss = /\.(tsx?|css)$/.test(file)
  if (!isTsOrCss) continue

  const lines = readFileSync(file, 'utf8').split('\n')
  const isComment = commentMask(lines)

  // A — raw hex
  if (HEX_SCOPE.test(rel) && !HEX_ALLOW.has(rel)) {
    lines.forEach((line, i) => {
      if (HEX.test(line) && !isComment[i]) {
        violations.push(`${rel}:${i + 1}  raw hex — use var(--h10-*) / tokens: ${line.trim().slice(0, 80)}`)
      }
    })
  }

  // B — raw numbered ramp in the three component stylesheets
  if (isCss && RAMP_FILES.has(rel)) {
    lines.forEach((line, i) => {
      if (RAMP.test(line) && !isComment[i]) {
        violations.push(`${rel}:${i + 1}  raw ramp — use a semantic/platform token: ${line.trim().slice(0, 80)}`)
      }
    })
  }

  // C — raw Tailwind palette class in DS .tsx
  //     Comments are skipped, as in A and B: prose EXPLAINING why an idiom is
  //     banned (Button.tsx's note about hand-rolled `!bg-red-600` overrides) is
  //     documentation, not a violation — and flagging it teaches the opposite
  //     lesson, that the safe move is to delete the explanation.
  if (isTsx && TW_SCOPE.test(rel)) {
    lines.forEach((line, i) => {
      if (TW.test(line) && !isComment[i]) {
        violations.push(`${rel}:${i + 1}  raw Tailwind palette — use .h10-ds-* + tokens: ${line.trim().slice(0, 80)}`)
      }
    })
  }
}

if (violations.length) {
  console.error(`✗ token-guard: ${violations.length} violation(s) (raw hex / ramp / Tailwind palette):`)
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log(
  '✓ token-guard: no raw hex, no numbered ramps in component CSS, no Tailwind palette in DS .tsx',
)
