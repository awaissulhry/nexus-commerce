#!/usr/bin/env node
/**
 * Wave 1 — Design-system conformance ratchet (Owner directive 2026-07-04:
 * "I do not want any such thing on any page or even a single tab").
 *
 * Counts the banned idioms per top-level app section:
 *   - native <select>            (system components exist: DS Select / H10Select)
 *   - native <input type="date"> (DS DateRangePicker / EbDateField)
 *   - inline style fontSize      (type scales are classes/tokens)
 *   - inline style hex colours   (palette lives in CSS)
 *
 * Modes:
 *   --census              print the per-section table
 *   --baseline            write scripts/ds-conformance-baseline.json
 *   --check               fail (exit 1) if ANY section exceeds its baseline
 *                         — the ratchet: waves lower baselines, never raise
 *   --manifest <section>  file:line offender checklist for a wave
 *
 * Scope: apps/web/src/app. Allowlisted (counted as their own sections but
 * never enforced): the two legacy ad consoles (Wave 0 retires them later)
 * and the Amazon H10 pixel-match world. marketing/ads/ebay IS enforced —
 * it reached zero in EV4 and stays there.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { stripComments } from './lib/strip-comments.mjs'
import { execSync } from 'node:child_process'
import { join, relative } from 'node:path'

const ROOT = join(process.cwd(), 'apps/web/src/app')
const BASELINE = join(process.cwd(), 'scripts/ds-conformance-baseline.json')

// Never-enforced prefixes (relative to app/). Legacy consoles await Wave 0;
// the Amazon ads tree is the deliberate H10 pixel-match world. NOTE:
// marketing/ads/ebay is carved back IN below — it must stay at zero.
// 2026-08-25 — `marketing/ads/` LEFT this list. It is the platform's largest surface (397 tsx
// files) and it was the only one exempt from the ratchet, which meant the section most likely to
// grow was the one nothing was counting. It is now enforced at its own baseline: today's numbers
// are frozen, nothing is asked of the existing code, and the next file added cannot make them
// worse. The two LEGACY consoles stay exempt — Wave 0 retires them wholesale, so ratcheting code
// that is scheduled for deletion buys nothing.
const ALLOW = ['marketing/ads-console/', 'marketing/advertising/',
  // /r = the RV.6 public review-funnel (customer-facing, email-linked, server-rendered
  // without app CSS — its inline styles are load-bearing, not chrome). Investigated 2026-07-04.
  'r/']
// Kept for the record, now a no-op: with `marketing/ads/` out of ALLOW, ebay is enforced by
// default. Its zero is protected by giving it its OWN section below, not by this list.
const ENFORCE_ANYWAY = ['marketing/ads/ebay/']

/**
 * Which budget a file counts against. Top-level directory, with two deliberate splits:
 *
 *   marketing/ads       397 files — 3.3x the rest of `marketing`. Sharing one budget would let a
 *                       regression in the smaller half hide behind an improvement in the larger.
 *   marketing/ads/ebay  reached zero in EV4 and must STAY zero. A budget of its own is what makes
 *                       that a guarantee rather than a hope: inside the ads budget its first
 *                       regression would be invisible until the whole section moved.
 */
const sectionOf = (rel) =>
  rel.startsWith('marketing/ads/ebay/') ? 'marketing/ads/ebay'
  : rel.startsWith('marketing/ads/') ? 'marketing/ads'
  : rel.split('/')[0]

const METRICS = {
  select: /<select\b/g,
  date: /type="date"/g,
  fontSize: /style=\{\{[^}]*fontSize/g,
  hex: /style=\{\{[^}]*#[0-9a-fA-F]{3,6}/g,
  // ── 2026-08-25 — the two that decide whether NEW code joins the design system ──
  // Neither is a defect on its own; both are how the platform stays split in two.
  // Ratcheted, not banned: 397 files import the legacy kit and 376 more style
  // themselves with raw palette classes and import nothing at all. Freezing those
  // counts stops the pile growing while the migration runs — a hard ban would block
  // every push today and teach people to reach for --no-verify.
  legacyKit: /from ['"]@\/components\/ui/g,
  rawColor: /\b(?:bg|text|border|ring|divide|outline|decoration|fill|stroke|accent|caret|placeholder|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/g,
  /* ── 2026-09-02 (hub #623) — the legacy TYPE scale, by class name ──────────────────────────────
     CH.1's chrome mock passed this guard by moving its inline `fontSize`s onto Tailwind
     `text-*` / `font-*` classes: the count went down, the DS adoption did not go up. `fontSize`
     only ever saw `style={{ fontSize }}`, so the metric measured the SYNTAX, not the decision —
     a scanner passing for the wrong reason on the very metric whose remedy text was just fixed.

     🔴 KEYS READ FROM `apps/web/tailwind.config.ts`, NOT GUESSED, and the ruling's own list was
     wrong on both halves: there is no `font-heading` and no `font-label` in this config (families
     are `sans|display|mono`), and the size scale includes `body` and `body-lg`, which the ruling
     omits. A metric matching class names that do not exist would have censused zero and looked
     clean — the same defect as a remedy naming a class nobody wrote.

     Lookbehind and lookahead rather than `\b`: `\b` would match `h10-text-sm` (the `-` before
     `text` is a boundary) and `text-base` inside a hypothetical `text-base-plus`. `body-lg` is
     ordered before `body` so the longer key wins. `text-ellipsis`, `text-left`, `text-center`,
     `text-nowrap`, `text-balance` are not type-scale keys and are not listed. */
  tailwindType: /(?<![\w-])(?:text-(?:body-lg|body|2xl|3xl|4xl|xs|sm|base|md|lg|xl)|font-(?:display|sans|mono))(?![\w-])/g,
}

/** Every metric starts at zero — derived, so adding one above needs no other edit. */
const zero = () => Object.fromEntries(Object.keys(METRICS).map((k) => [k, 0]))

/* 🔴 DISCLOSED EDIT by DS.1 under hub ruling #591 — ENUMERATION ONLY. No rule, threshold or
   baseline is touched.

   The rationale below was deliberate and is preserved because it is right in the general case: in a
   shared tree, another session's untracked work-in-progress should not fail your push. **It is wrong
   for this programme.** Nothing here is committed; the whole rebuild lands in ONE push on the
   Owner's word, so at that moment every untracked file IS part of the push — ~563 of them. Excluding
   them means every green this gate printed was over a subset nobody chose, and the surfaces it has
   never read are the new ones. `--exclude-standard` keeps `.gitignore` honoured. */
// SUPERSEDED RATIONALE: "Untracked files are not in the commit being pushed — in this shared
// working tree they are another session's work in progress. Counting them can push a section over
// its baseline and fail a push that has nothing to do with them. Tracked-but-dirty files are still
// counted: those may be exactly what you are pushing."
let trackedSet = null
function isTracked(p) {
  if (trackedSet === null) {
    try {
      trackedSet = new Set(
        (execSync('git ls-files -z', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
          + execSync('git ls-files --others --exclude-standard -z', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
          .split('\0')
          .filter(Boolean),
      )
    } catch {
      trackedSet = new Set() // not a git checkout — count everything
    }
  }
  return trackedSet.size === 0 || trackedSet.has(relative(process.cwd(), p))
}

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (p.endsWith('.tsx') && isTracked(p)) yield p
  }
}

const allowed = (rel) => ALLOW.some((a) => rel.startsWith(a)) && !ENFORCE_ANYWAY.some((e) => rel.startsWith(e))

function scan() {
  const bySection = {}
  const offenders = {}
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file)
    if (allowed(rel)) continue
    const section = sectionOf(rel)
    /* 🔴 COMMENTS ARE STRIPPED BEFORE ANY METRIC RUNS (hub #684). Every metric here is a text
       match, so prose counted as code: a comment reading `<select` — including one written to
       EXPLAIN why the native control was replaced — scored a violation against the section that
       had just fixed it. That is the pin-comment defect wearing a gate's clothes; it pressures an
       author to delete the explanation to get their push through, which is the opposite of what
       this guard is for. `token-guard` learned the same lesson and became block-comment aware.

       `stripComments` blanks comment characters and KEEPS newlines and offsets, which this scan
       depends on: it matches line by line and reports `file:line`, and a gate must not name a line
       number from a different document than the one the author will open. String literals are
       deliberately kept — `from '@/components/ui'` and a raw palette class are real hits that live
       inside strings. One implementation, shared with `check-global-exposure` and
       `check-grid-modules`, because a copied scanner drifts. */
    /* The control switch is part of the guard, not a scratch edit: a strip that has never been
       measured against its own absence is a claim, and this one moved real counts. */
    const raw = readFileSync(file, 'utf8')
    const src = process.env.NDS_CONFORMANCE_NO_STRIP ? raw : stripComments(raw)
    const lines = src.split('\n')
    for (const [name, re] of Object.entries(METRICS)) {
      lines.forEach((line, i) => {
        if (new RegExp(re.source).test(line)) {
          bySection[section] ??= zero()
          bySection[section][name]++
          ;(offenders[section] ??= []).push(`${name.padEnd(8)} apps/web/src/app/${rel}:${i + 1}`)
        }
      })
    }
    bySection[section] ??= zero()
  }
  return { bySection, offenders }
}

/**
 * The fix line printed under a failing metric. Exported shape so `--self-test` can assert it.
 *
 * 🔴 `fontSize` has its own branch because the shared fallback named a remedy that DOES NOT EXIST
 * (hub #617, DS.2's audit): "use the design-system component instead (Select/DateRangePicker/type
 * classes)" — and `.nds-type-*` matches nothing in the repo, measured 0 today. A guard that names a
 * nonexistent remedy is the pin-comment defect wearing a gate's clothes: it cannot fail, and it
 * leaves the reader worse off than no suggestion, because they go looking for a class that was never
 * written.
 *
 * The scale is spelled out from `tokens.css:393-403` rather than summarised — including `2xl`, which
 * the ruling's own text omits. Naming nine of ten steps is a smaller version of the same defect.
 *
 * DS.2 is landing `.nds-type-<name>` utilities (Phase B). When they exist, append
 * "or the .nds-type-* utility of the same name" HERE — and not before: this line is only worth
 * anything while every token it names is real.
 */
/**
 * The type scale, READ from `tokens.css` rather than restated.
 *
 * 🔴 The list was hardcoded for exactly 40 minutes and was stale by the end of them: it named 11
 * steps from `tokens.css:393-403`, and by 08:37 the table held 14 (`nano`, `micro-plus`, `md-minus`
 * arrived with DS.2's utilities). A remedy that names nine of ten steps sends the next person to
 * write a literal for the tenth — the same defect as naming a class nobody wrote, one loop further
 * out. **A list of members is a set claim; read it, never restate it.**
 *
 * Returns the names and the line range so the message can point at the source without either going
 * stale independently.
 */
export function typeScale() {
  try {
    const src = readFileSync(join(process.cwd(), 'apps/web/src/design-system/styles/tokens.css'), 'utf8')
    const lines = src.split('\n')
    const names = []
    let first = 0
    let last = 0
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/--nds-font-size-([\w-]+)\s*:/)
      if (!m) continue
      if (!names.includes(m[1])) names.push(m[1])
      if (!first) first = i + 1
      last = i + 1
    }
    return { names, first, last }
  } catch {
    return { names: [], first: 0, last: 0 }
  }
}

export function remedyFor(metric) {
  if (metric === 'legacyKit') return '   Import from @/design-system, not @/components/ui — see /DESIGN.md.'
  if (metric === 'rawColor') return '   Raw Tailwind palette classes bypass the token system — use a DS component or an --nds-* token.'
  if (metric === 'tailwindType') {
    const t = typeScale()
    return '   Tailwind type classes are the legacy kit by another name — the inline fontSize count\n' +
           '   falls and DS adoption does not move. Use font-size: var(--nds-font-size-*)\n' +
           `   or the .nds-type-<name> utility (${t.names.join('|')} — tokens.css:${t.first}-${t.last}).`
  }
  if (metric === 'fontSize') {
    const t = typeScale()
    // An unreadable token file must not degrade into a remedy that names an EMPTY set — that reads
    // as "there are no steps". Say where to look instead, and let the self-test's parity check fail.
    if (!t.names.length) return '   Inline fontSize bypasses the type tokens — use font-size: var(--nds-font-size-*)\n   (see design-system/styles/tokens.css).'
    return '   Inline fontSize bypasses the type tokens — use font-size: var(--nds-font-size-*)\n' +
           `   or the .nds-type-<name> utility of the same name (${t.names.join('|')}\n` +
           `   — tokens.css:${t.first}-${t.last}, utilities in design-system/styles/primitives.css).`
  }
  return '   Use the design-system component instead (Select / DateRangePicker).'
}

if (process.argv.includes('--self-test')) {
  const hits = (src) => (src.match(METRICS.tailwindType) ?? []).length
  const metricCases = [
    ['text-sm is counted', 'className="text-sm"', 1],
    ['text-2xl / text-4xl are counted', 'className="text-2xl text-4xl"', 2],
    ['text-body-lg is counted once, not as text-body + lg', 'className="text-body-lg"', 1],
    ['font-display / font-mono are counted (the real families)', 'className="font-display font-mono"', 2],
    ['🔴 text-ellipsis is NOT type scale', 'className="text-ellipsis"', 0],
    ['🔴 text-left / text-center / text-nowrap are NOT type scale', 'className="text-left text-center text-nowrap"', 0],
    ['🔴 font-heading / font-label do not exist in this config', 'className="font-heading font-label"', 0],
    ['🔴 a hyphenated prefix is not a Tailwind class', 'className="h10-text-sm nds-text-lg"', 0],
    ['a raw colour class is rawColor’s job, not this metric', 'className="text-red-500"', 0],
    ['clsx and template literals are reached the same way', 'clsx("text-md", `font-mono ${x}`)', 2],
  ]
  let metricBad = 0
  for (const [name, src, want] of metricCases) {
    const got = hits(src)
    const ok = got === want
    if (!ok) metricBad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — expected ${want}, got ${got}`)
  }
  /* ── comment stripping (hub #684) ────────────────────────────────────────────────────────────
     Counted exactly the way scan() counts: strip first, then test LINE BY LINE, because the guard
     reports `file:line` and scores a line at most once per metric. The negative cases are the point
     — a guard that got quieter is worse than one that was noisy, so each of these must keep firing
     on real code while going silent on prose. */
  const stripHits = (metric, src) =>
    stripComments(src).split('\n').filter((l) => new RegExp(METRICS[metric].source).test(l)).length
  const stripCases = [
    ['🔴 <select in a LINE comment counts 0', 'select', '// a native <select> is what we replaced', 0],
    ['🔴 <select in a BLOCK comment counts 0', 'select', '/* we dropped the native <select> here */', 0],
    ['🔴 <select in a JSDoc BLOCK counts 0 — whole documents, never fragments: the stripper is\n     stateless per call, and a lone " * …" line has no opener to find', 'select',
     '/**\n * Drives the <select> width + size.\n */', 0],
    ['<select in CODE still counts 1', 'select', 'return <select value={v} />', 1],
    ['a string literal is NOT a comment — still counts', 'select', 'const t = "<select>"', 1],
    ['one line scores once, not per occurrence', 'select', '<select /><select />', 1],
    ['tailwindType in a comment counts 0', 'tailwindType', '// name promoted to text-md so it reads', 0],
    ['tailwindType in code still counts 1', 'tailwindType', 'className="text-md"', 1],
    ['type="date" in a JSDoc BLOCK counts 0 (the real ReportRunner.tsx:370 shape)', 'date',
     '/**\n * This page had it switched OFF and hand-rolled two native <input type="date">\n */', 0],
    ['type="date" in code still counts 1', 'date', '<input type="date" />', 1],
    ['LINE NUMBERS SURVIVE — a hit after a 3-line block comment is still on line 4',
     'select', '/* one\n two\n three */\n<select />', 1],
  ]
  for (const [name, metric, src, want] of stripCases) {
    const got = stripHits(metric, src)
    const ok = got === want
    if (!ok) metricBad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — expected ${want}, got ${got}`)
  }
  {
    const src = '/* one\n two\n three */\n<select />'
    const line = stripComments(src).split('\n').findIndex((l) => /<select\b/.test(l)) + 1
    const ok = line === 4
    if (!ok) metricBad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  the stripped hit reports line 4, the line the author will open — got ${line}`)
  }
  const cases = [
    ['tailwindType names the real token family', 'tailwindType', '--nds-font-size'],
    ['fontSize names the real token family', 'fontSize', '--nds-font-size'],
    ['fontSize now names the .nds-type utilities (they landed 08:37:55)', 'fontSize', 'nds-type-'],
    ['fontSize names every step the token table holds', 'fontSize', typeScale().names.at(-1)],
    ['the shared fallback no longer claims "type classes"', 'select', null, 'type classes'],
    ['legacyKit keeps its own line', 'legacyKit', '@/design-system'],
    ['rawColor keeps its own line', 'rawColor', '--nds-* token'],
  ]
  let bad = 0
  for (const [name, metric, must, mustNot] of cases) {
    const out = remedyFor(metric)
    const ok = (must ? out.includes(must) : true) && (mustNot ? !out.includes(mustNot) : true)
    if (!ok) bad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  }
  // 🔴 PRECONDITION, not an assumption: the remedy may only claim `.nds-type-*` while those classes
  // exist. Checked by reading the stylesheets, so the sentence cannot outlive the classes — if DS.2's
  // utilities are ever reverted, this fails here rather than in a reader's editor.
  let styles = ''
  for (const f of ['primitives.css', 'components.css', 'tokens.css', 'tokens-global.css']) {
    try { styles += readFileSync(join(process.cwd(), `apps/web/src/design-system/styles/${f}`), 'utf8') } catch { /* absent is fine */ }
  }
  const utilities = [...new Set([...styles.matchAll(/\.nds-type-([\w-]+)/g)].map((m) => m[1]))]
  const scale = typeScale().names
  const missingUtility = scale.filter((n) => !utilities.includes(n))
  const orphanUtility = utilities.filter((n) => !scale.includes(n))
  const preOk = utilities.length > 0
  console.log(`  ${preOk ? 'PASS' : 'FAIL'}  precondition: .nds-type-* exists in design-system/styles (${utilities.length} found)`)
  if (!preOk) bad++
  // 🔴 `scale.length > 0` is not padding: with an empty scale, "every step has a utility" is
  // VACUOUSLY true and prints PASS at 0/0 — a check that cannot fail on the input it exists for.
  const parityOk = scale.length > 0 && missingUtility.length === 0 && orphanUtility.length === 0
  console.log(`  ${parityOk ? 'PASS' : 'FAIL'}  every --nds-font-size-* step has a .nds-type-* utility of the same name` +
    (parityOk ? ` (${scale.length}/${scale.length})`
              : scale.length === 0 ? ' — the token scale read as EMPTY, so this would have passed vacuously'
              : ` — no utility: [${missingUtility}]; no token: [${orphanUtility}]`))
  if (!parityOk) bad++
  bad += metricBad
  console.log(bad === 0
    ? '\n[ok] self-test: the type-scale metric counts the scale and nothing else, and every remedy names something that exists'
    : `\n[fail] ${bad} case(s)`)
  process.exit(bad ? 1 : 0)
}

const mode = process.argv[2] ?? '--census'
const { bySection, offenders } = scan()
const total = (s) => Object.keys(METRICS).reduce((n, k) => n + (s[k] ?? 0), 0)

if (mode === '--census') {
  const rows = Object.entries(bySection).sort((a, b) => total(b[1]) - total(a[1]))
  const cols = Object.keys(METRICS)
  console.log('section'.padEnd(20), cols.map((c) => c.padEnd(11)).join(''))
  for (const [k, v] of rows) if (total(v)) console.log(k.padEnd(20), cols.map((c) => String(v[c] ?? 0).padEnd(11)).join(''))
  console.log('\n(zero-count sections omitted; legacy consoles + Amazon H10 world allowlisted)')
}

if (mode === '--baseline') {
  writeFileSync(BASELINE, JSON.stringify({ note:
      'DS-conformance ratchet — waves lower these, pushes may never raise them. ' +
      'tailwindType added 2026-09-02 at current counts (hub #623): legacy sits at baseline, nothing ' +
      'new may adopt the Tailwind type scale. ' +
      'RE-CAPTURED 2026-09-02 (hub #684, DS.1-b): comments are now stripped before any metric runs, ' +
      'so prose no longer counts as code. Every metric here is a text match, and a comment reading ' +
      '`<select` — including one written to explain why the native control was replaced — scored ' +
      'against the section that had just fixed it. Measured with the guard\'s own control switch ' +
      '(NDS_CONFORMANCE_NO_STRIP=1): 35282 -> 35262 across 38 sections, a fall of 20, and NOTHING ' +
      'rose. The 20 were all genuine prose: products select 15->12 rawColor 7759->7758 tailwindType ' +
      '3757->3746, marketing/ads select 1->0 date 3->2, bulk-operations date 2->1 rawColor 957->956, ' +
      '_shared date 2->1. A ratchet re-captured after a strip may only FALL; if a later re-capture ' +
      'raises one of these, the strip has regressed and that is the defect, not the count.', updatedAt: new Date().toISOString().slice(0, 10), sections: bySection }, null, 2) + '\n')
  console.log(`baseline written: ${Object.keys(bySection).length} sections`)
}

if (mode === '--check') {
  if (!existsSync(BASELINE)) { console.log('no baseline — run --baseline once'); process.exit(0) }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')).sections
  let failed = false

  // Owner 2026-07-04: the eBay ads console must look EXACTLY like the Amazon
  // one — every colour in ebay.css must exist in ads.css (the Amazon palette).
  // The Amazon palette is ads.css PLUS _shared/shared-shell.css: the neutral rail /
  // brand / nav rules were split out of ads.css and the ads layout loads both, so the
  // console's real palette spans the pair. Reading ads.css alone silently shrinks it —
  // #b87503 lives in the shell half and ebay.css legitimately uses it.
  const adsCss =
    readFileSync(join(ROOT, 'marketing/ads/ads.css'), 'utf8') +
    readFileSync(join(ROOT, '_shared/shared-shell.css'), 'utf8')
  const ebayCss = readFileSync(join(ROOT, 'marketing/ads/ebay/ebay.css'), 'utf8')
  // Phase 9.1 — ads.css is being TOKENIZED, so its palette is no longer only literals. A
  // `var(--nds-blue-600)` contributes #1f6fde exactly as the literal did, and reading literals
  // alone shrinks the palette every time a conversion lands: ebay.css would start failing for
  // colours that are still, in fact, identical. That happened on the first pass — 1,384 literals
  // left ads.css and 5 ebay colours "went off-palette" without anyone changing them. So resolve
  // BOTH sides: literals plus the hex behind every --nds-* token the file references. This is the
  // "resolve both sides through tokens.css" option the note below names.
  const tokenSrc = readFileSync(join(process.cwd(), 'apps/web/src/design-system/styles/tokens.css'), 'utf8')
  const tokenHex = new Map()
  for (const m of tokenSrc.matchAll(/(--nds-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) tokenHex.set(m[1], m[2].toLowerCase())
  for (let i = 0; i < 4; i++) {  // `--nds-primary: var(--nds-blue-600)` — resolve alias hops
    for (const m of tokenSrc.matchAll(/(--nds-[a-z0-9-]+)\s*:\s*var\((--nds-[a-z0-9-]+)\)\s*;/g)) {
      if (!tokenHex.has(m[1]) && tokenHex.has(m[2])) tokenHex.set(m[1], tokenHex.get(m[2]))
    }
  }
  const resolvePalette = (css) => {
    const out = new Set((css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase()))
    for (const m of css.matchAll(/var\((--nds-[a-z0-9-]+)\)/g)) {
      const hex = tokenHex.get(m[1])
      if (hex) out.add(hex)
    }
    return out
  }
  const amazonPalette = resolvePalette(adsCss)
  const offPalette = [...resolvePalette(ebayCss)].filter((h) => !amazonPalette.has(h))
  // 🔴 This check compares literal hex SETS. Phase 9.1 rewrites ads.css to
  // var(--nds-*), at which point the Amazon palette empties and every ebay.css
  // colour would "match" an empty set — the check would pass while enforcing
  // nothing. Fail loudly instead, so the tokenization forces a real decision
  // (resolve both sides through tokens.css, or retire this check) rather than
  // silently going green. 200 is far below the ~900 literals present today and
  // far above anything a tokenized file would leave behind.
  if (amazonPalette.size < 200) {
    failed = true
    console.error(`❌ the Amazon palette resolved to only ${amazonPalette.size} literal colours.`)
    console.error('   ads.css has probably been tokenized (Phase 9.1). This check compares hex')
    console.error('   literals and can no longer enforce anything — resolve both sides through')
    console.error('   tokens.css, or retire it. See docs/TOKEN-GUARD-RATCHET.md §0a.')
  }
  if (offPalette.length) {
    failed = true
    console.error(`❌ ebay.css uses colour(s) not in the Amazon ads palette: ${offPalette.join(', ')}`)
    console.error('   Copy the exact value ads.css uses for the same semantic — the consoles must match.')
  }
  for (const [section, counts] of Object.entries(bySection)) {
    const b = { ...zero(), ...(base[section] ?? {}) }
    for (const m of Object.keys(METRICS)) {
      if (counts[m] > b[m]) {
        failed = true
        const LABEL = {
          select: 'native <select>', date: 'native date input',
          fontSize: 'inline fontSize', hex: 'inline hex colour',
          legacyKit: 'legacy @/components/ui import', rawColor: 'raw Tailwind palette class',
          tailwindType: 'Tailwind type-scale class',
        }
        console.error(`❌ ${section}: ${m} ${b[m]} → ${counts[m]} — new ${LABEL[m] ?? m}(s) added.`)
        console.error(remedyFor(m))
        console.error(`   Offenders: node scripts/ds-conformance-guard.mjs --manifest ${section}`)
      }
    }
  }
  if (failed) process.exit(1)
  console.log('✓ DS-conformance ratchet clean (no section above baseline)')
}

if (mode === '--manifest') {
  const section = process.argv[3]
  if (!section || !offenders[section]) { console.log(`sections with offenders: ${Object.keys(offenders).join(', ')}`); process.exit(0) }
  console.log(offenders[section].join('\n'))
  console.log(`\n${offenders[section].length} offender(s) in ${section}`)
}
