/**
 * DS drift guard — fails if shipped DS code reaches past the token/semantic tier.
 * Three checks, run together (all violations reported before exiting non-zero):
 *
 *   A — RAW HEX in primitives/components/patterns + the tokenized stylesheets.
 *       Every color must come from a token (`var(--nds-*)` in CSS, or an import
 *       from `tokens/` in TS). `styles/tokens.css` is the one place hex is
 *       allowed — it DEFINES the palette.
 *   B — RAW NUMBERED RAMP in component CSS (`var(--nds-{grey|blue|green|red|
 *       amber|purple|cyan}-NNN)`). Components must consume the semantic /
 *       platform tier (`--text-*`, `--surface-*`, `--status-*`, `--color-*`)
 *       or DS-only component tokens (`--nds-radius/shadow/focus/pill/badge/
 *       rail/surface-hover/surface-raised/text-strong/...`), NOT the numbered
 *       primitive ramps. Only the styles/{primitives,components,patterns}.css
 *       stylesheets are in scope; tokens.css (which DEFINES roles off the ramps)
 *       is not.
 *   C — RAW TAILWIND PALETTE classes in DS `.tsx` (`(bg|text|border|ring|from|
 *       to|fill|stroke)-(slate|gray|zinc|...)-NNN`). DS components style via
 *       `.nds-*` classes + tokens, never raw Tailwind palette utilities.
 *
 * The `catalog/` (a demo surface) is intentionally out of scope throughout.
 *
 *   node apps/web/src/design-system/tools/token-guard.mjs
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { execSync } from 'child_process'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'

/**
 * ROOT and REPO are derived from THIS FILE's own location, never hardcoded — and that is the
 * whole of hub P14's first half.
 *
 * `apps/factory` keeps a copy of this tool, and BOTH copies said
 * `const ROOT = 'apps/web/src/design-system'`. So the factory copy scanned WEB. It was not merely
 * stale (an Aug-25 snapshot, 4,358 B): it pointed at the wrong application, which means
 * **factory's design system has never been checked by this guard in any version** — and wiring
 * the copy up as it stood would have produced a confident green about a tree it never opened.
 * A scanner aimed one app away is the vacuous pass that looks most like coverage.
 *
 * Deriving it also makes the two copies BYTE-IDENTICAL, which is what lets
 * `check-ds-fork-drift` hold them identical from here on (P14's second half widened its EXT to
 * `.mjs`). The only thing that had ever differed between them was this hardcoded path.
 *
 * REPO is used for the `git ls-files` tracking check. It must NOT come from `process.cwd()`:
 * with an absolute ROOT the walk would succeed from any directory while the tracked-set lookup
 * silently matched nothing, and every file would be skipped as untracked — a guard printing ✓
 * over a tree it never read. Both are anchored to this file instead, so the invocation's cwd
 * cannot change the answer.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '')
const APP = relative(REPO, ROOT).split('/')[1] ?? 'unknown'

// A — raw hex literals
const HEX = /#[0-9a-fA-F]{3,8}\b/
// Both generated token files DEFINE the palette, so hex is their whole job.
// `tokens-global.css` is `tokens.css` minus the contested platform aliases — it is what
// the root layout loads app-wide (Phase 9.3). Adding a third token file? Allow it here.
const HEX_ALLOW = new Set(['styles/tokens.css', 'styles/tokens-global.css'])
const HEX_SCOPE = /^(primitives|components|patterns|styles)\//

// B — raw NUMBERED primitive ramps reached from component stylesheets.
//     `-[0-9]` after the color word means a numbered ramp step (--nds-blue-700);
//     DS component tokens (--nds-radius-lg, --nds-surface-hover, --nds-text-strong,
//     --nds-pill-success-bg, …) never match because no digit follows the role word.
const RAMP = /var\(--nds-(grey|blue|green|red|amber|purple|cyan)-[0-9]/
const RAMP_FILES = new Set([
  'styles/primitives.css',
  'styles/components.css',
  'styles/patterns.css',
])

// D — PLATFORM-ALIAS tokens reached from DS stylesheets (9.0b).
//     `--text-*`, `--surface-*` and `--border-*` are ALSO defined by globals.css and
//     ads.css as space-separated RGB CHANNELS, for Tailwind's `rgb(var(--x) / <alpha>)`.
//     Custom properties resolve from the nearest defining ancestor, so inside
//     `.h10-shell` those definitions shadow the DS's — and `background: var(--surface-card)`
//     becomes `background: 255 255 255`, invalid at computed-value time, silently dropped.
//     285 declarations were dead this way until 9.0b. `--color-primary` / `--status-*` are
//     NOT contested (nothing else defines them) and stay published for app CSS — but DS
//     stylesheets consume the DS-owned `--nds-*` tier only, so the whole alias tier is
//     banned here and one rule covers both cases.
// Global: a single declaration can reach several aliases, and reporting only the first
// understates the work — someone fixes one, re-runs, and meets the same line again.
const ALIAS =
  /var\(\s*--(text-(?:primary|secondary|tertiary|disabled|link)|surface-(?:canvas|card|sunken|raised)|border-(?:default|subtle|strong)|color-primary(?:-soft)?|status-[a-z]+-[a-z]+)\s*\)/g
const ALIAS_FILES = new Set([
  'styles/primitives.css',
  'styles/components.css',
  'styles/patterns.css',
  'styles/a11y.css',
])

// C — raw Tailwind palette utility classes in DS .tsx
const TW =
  /\b(bg|text|border|ring|from|to|fill|stroke)-(slate|gray|zinc|blue|indigo|green|emerald|red|rose|amber|yellow|orange|purple|violet|cyan|sky)-[0-9]{2,3}\b/
const TW_SCOPE = /^(primitives|components|patterns)\//

// Files git does not track are, by definition, not in the commit being pushed —
// another session's work-in-progress in this shared tree. Failing a push over one
// blocks work that has nothing to do with it: measured four times on 2026-08-24,
// on pushes whose commit was a single markdown file. Tracked-but-dirty files ARE
// still checked; those can legitimately be part of what you are about to push.
let trackedSet = null
function isTracked(p) {
  if (trackedSet === null) {
    try {
      trackedSet = new Set(
        execSync('git ls-files -z', { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
          .split('\0')
          .filter(Boolean),
      )
    } catch {
      trackedSet = new Set() // not a git checkout — check everything
    }
  }
  return trackedSet.size === 0 || trackedSet.has(relative(REPO, p))
}

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (isTracked(p)) out.push(p)
  }
  return out
}

/**
 * Comment-STRIPPED source: one entry per line, every comment span blanked to spaces so line
 * numbers, column positions and line count all survive. Every check below scans THIS, never the
 * raw line.
 *
 * History, because each step here was paid for:
 *
 *  1. The original per-line heuristic (`startsWith('//' | '*' | '/*')`) saw only the FIRST line
 *     of a block plus the `*`-led continuations. A continuation line quoting the very hex it was
 *     warning about read as code — so the guard pressured the author to DELETE the explanation,
 *     the opposite of what it exists to encourage.
 *  2. The block-aware MASK that replaced it classified a whole line as comment or code. That is
 *     still too coarse for a comment that OPENS MID-LINE after a declaration:
 *         font-size: 14.5px; /* no token: … hub #617 left it literal *\/
 *     The line starts with code, so the whole line read as code and `#617` — the RULING NUMBER —
 *     matched as a raw hex. Three stylesheets failed on the prose saying why their literal is
 *     deliberate and which ruling blessed it. Same failure as (1), one step in.
 *
 * Spans also close a false NEGATIVE the mask carried: a block comment that CLOSES mid-line
 * (`… *\/ color: #ff0000;`) marked the whole line as comment and hid real code after it.
 *
 * Strings stay CODE on purpose — `color: '#ff0000'` in a .tsx IS a raw hex and must fail. They
 * are tracked only so that a `//` inside one (the `//` of an https URL) does not blank the rest
 * of the line, which would trade this false positive for a false negative.
 *
 * `lineComments` is false for CSS, where `//` is not a comment and a hex after one must still be
 * caught. Known limit, stated rather than hidden: a template literal spanning lines is treated as
 * ending at EOL, so a `//` on its continuation line would blank that line's tail. That errs toward
 * flagging, not hiding, everywhere except that one case.
 */
function codeOnly(lines, lineComments) {
  const out = new Array(lines.length)
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let buf = ''
    let quote = null
    let j = 0
    while (j < line.length) {
      const two = line.slice(j, j + 2)
      if (inBlock) {
        if (two === '*/') { inBlock = false; buf += '  '; j += 2 } else { buf += ' '; j += 1 }
        continue
      }
      if (quote) {
        if (line[j] === '\\' && j + 1 < line.length) { buf += line[j] + line[j + 1]; j += 2; continue }
        buf += line[j]
        if (line[j] === quote) quote = null
        j += 1
        continue
      }
      if (two === '/*') { inBlock = true; buf += '  '; j += 2; continue }
      if (lineComments && two === '//') { buf += ' '.repeat(line.length - j); j = line.length; continue }
      if (line[j] === '"' || line[j] === "'" || line[j] === '`') { quote = line[j]; buf += line[j]; j += 1; continue }
      buf += line[j]
      j += 1
    }
    out[i] = buf
  }
  return out
}

/**
 * `--self-test` — the guard proving it can still FAIL, in BOTH directions.
 *
 * Asked for by DS.1-b when reporting the `#617` false positive, and the right instinct: a fix
 * that stops a comment being scanned can trade a false POSITIVE for a false NEGATIVE, and the
 * negative is the one nobody notices. So every case below fixes the EXACT lines expected to be
 * flagged — an empty expectation and a wrong-line expectation both fail.
 *
 * A guard that cannot fail is not a guard: cases 2, 3, 5, 7 and 8 must go RED if `codeOnly` ever
 * over-strips. Run it against the old per-line mask and case 1 fails (that was the bug) and case 5
 * fails (the false negative the mask carried) — which is what makes this a test rather than a
 * restatement.
 */
const SELF_TEST_CASES = [
  { name: 'trailing comment carrying a ruling number is NOT a hex',
    ts: false, expect: [], lines: ['  font-size: 14.5px; /* no token — hub #617 left it literal */'] },
  { name: 'a real hex in code still FAILS',
    ts: false, expect: [0], lines: ['  color: #ff0000;'] },
  { name: 'a real hex in code FAILS even with a comment on the same line',
    ts: false, expect: [0], lines: ['  color: #ff0000; /* see hub #617 */'] },
  { name: 'a hex inside a multi-line block comment is NOT flagged',
    ts: false, expect: [], lines: ['/* a note', ' * about #abcdef and why', ' */'] },
  { name: 'code AFTER a block comment closes mid-line still FAILS (the mask hid this)',
    ts: false, expect: [0], lines: ['/* note */ color: #123456;'] },
  { name: 'a // line comment in TS is NOT scanned',
    ts: true, expect: [], lines: ['// see #abcdef for why'] },
  { name: 'a URL in a TS string does not blank the line — a hex after it still FAILS',
    ts: true, expect: [0], lines: ["const u = 'https://x.example'; const c = '#ff0000'"] },
  { name: 'in CSS, // is NOT a comment — a hex after one still FAILS',
    ts: false, expect: [0], lines: ['  color: #ff0000; // not a css comment'] },
]

if (process.argv.includes('--self-test')) {
  let failed = 0
  for (const c of SELF_TEST_CASES) {
    const code = codeOnly(c.lines, c.ts)
    const got = code.map((l, i) => (HEX.test(l) ? i : -1)).filter((i) => i >= 0)
    const ok = got.length === c.expect.length && got.every((v, k) => v === c.expect[k])
    if (!ok) failed++
    console.log(`${ok ? '  ok  ' : '  FAIL'}  ${c.name}\n          expected lines [${c.expect}], got [${got}]`)
  }
  console.log(
    failed
      ? `\n✗ token-guard --self-test: ${failed} of ${SELF_TEST_CASES.length} case(s) FAILED`
      : `\n✓ token-guard --self-test: ${SELF_TEST_CASES.length}/${SELF_TEST_CASES.length} — comments ignored, code still caught in both directions`,
  )
  process.exit(failed ? 1 : 0)
}

const violations = []
let scanned = 0
for (const file of walk(ROOT)) {
  const rel = file.slice(ROOT.length + 1)
  const isCss = /\.css$/.test(file)
  const isTsx = /\.tsx$/.test(file)
  const isTsOrCss = /\.(tsx?|css)$/.test(file)
  if (!isTsOrCss) continue

  scanned++
  const lines = readFileSync(file, 'utf8').split('\n')
  // `//` is a comment in TS/TSX only; in CSS it is not, and a hex after one must still fail.
  const code = codeOnly(lines, isTsx || /\.tsx?$/.test(file))

  // A — raw hex
  if (HEX_SCOPE.test(rel) && !HEX_ALLOW.has(rel)) {
    lines.forEach((line, i) => {
      if (HEX.test(code[i])) {
        violations.push(`${rel}:${i + 1}  raw hex — use var(--nds-*) / tokens: ${line.trim().slice(0, 80)}`)
      }
    })
  }

  // B — raw numbered ramp in the three component stylesheets
  if (isCss && RAMP_FILES.has(rel)) {
    lines.forEach((line, i) => {
      if (RAMP.test(code[i])) {
        violations.push(`${rel}:${i + 1}  raw ramp — use a semantic/platform token: ${line.trim().slice(0, 80)}`)
      }
    })
  }

  // D — platform-alias token in a DS stylesheet
  if (isCss && ALIAS_FILES.has(rel)) {
    lines.forEach((line, i) => {
      for (const m of code[i].matchAll(ALIAS)) {
        violations.push(
          `${rel}:${i + 1}  platform alias --${m[1]} — use the DS-owned --nds-* token ` +
            `(it is RGB channels inside .h10-shell, so this declaration is DROPPED): ` +
            line.trim().slice(0, 60),
        )
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
      if (TW.test(code[i])) {
        violations.push(`${rel}:${i + 1}  raw Tailwind palette — use .nds-* + tokens: ${line.trim().slice(0, 80)}`)
      }
    })
  }
}

/**
 * The corpus size is printed on BOTH branches, and it is not decoration. With ROOT derived, a
 * wrong anchor or a cwd the tracking check cannot resolve would make `walk` yield nothing — and
 * a guard that scans zero files prints exactly the same ✓ as one that scanned the whole tree.
 * `scanned === 0` is therefore a FAILURE, not a pass: there is no legitimate state in which this
 * tool has nothing to look at.
 */
if (scanned === 0) {
  console.error(
    `✗ token-guard [${APP}]: scanned 0 files under ${ROOT} — the guard found nothing to check,\n` +
      '    which is a broken anchor or an unresolvable git tracking set, NOT a clean tree.',
  )
  process.exit(1)
}
if (violations.length) {
  console.error(
    `✗ token-guard [${APP}]: ${violations.length} violation(s) in ${scanned} file(s) ` +
      '(raw hex / ramp / Tailwind palette / platform alias):',
  )
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log(
  `✓ token-guard [${APP}]: ${scanned} files — no raw hex, no numbered ramps in component CSS,\n` +
    '    no Tailwind palette in DS .tsx, no platform aliases in DS stylesheets',
)
