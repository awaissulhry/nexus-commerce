#!/usr/bin/env node
/**
 * D2c — a component may not MIX button idioms.
 *
 * The defect this exists to stop, reported by the operator on 2026-08-20 as "the buttons are
 * inconsistent":
 *
 *   A single dialog shipped with FOUR button idioms — `h10-am-btn primary`, `h10-am-link`, the
 *   modal chassis's classless `.cancel`/`.next`, and `h10-ram-newbtn`, a dashed thing invented for
 *   that one modal. Nothing failed. Every gate was green, because none of them can see that two
 *   buttons an inch apart are different objects.
 *
 * WHAT THIS CHECKS, and why it is not "use h10-am-btn everywhere". The first cut flagged every
 * labelled button outside the vocabulary and found **654** across marketing/ads — most of them
 * component-local styles inside self-contained builders, which are legitimately scoped. A ratchet
 * that large is coarse enough to be ignored, and it would not have caught the reported defect any
 * better than a smaller one.
 *
 * The real invariant is the operator's own sentence: within ONE surface, the buttons should be one
 * object. So this counts, per FILE, the distinct button idioms among **labelled** `<button>`/`<a>`
 * elements — the first css class, so `h10-am-btn` and `h10-am-btn primary` are one idiom, not two.
 * More than one idiom in a file is a hit. `h10-am-link` is exempt from the count: a text action
 * beside a button is a real distinction, not a drift.
 *
 * Icon-only buttons are exempt by design. A 12px pencil or an `×` is not the same object as a
 * labelled action and does not belong in the same vocabulary — forcing it there would produce
 * noise, and a check that cries wolf gets ignored.
 *
 * Parsed from the TypeScript AST, never grepped: a regex over source cannot tell a className
 * attribute from a string that mentions one, and this repo has been burnt by exactly that
 * (`reference_verification_probe_false_positives`).
 *
 * RATCHET, not a gate. Lower BASELINE whenever you clear some.
 */
import ts from 'typescript'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ROOT = process.argv[2] ?? 'apps/web/src/app/marketing/ads'
/** EXCESS idioms (Σ per file of idioms−1) across the tree, measured 2026-08-20 after D2c. */
// FB.3c (2026-08-20) lowered 288 → 286: the RD grids' filter conversion removed two idioms.
// BSP-B5 (2026-08-22) lowered 286 → 283: the dead "Learn" button was removed from AdsPageHeader,
// ScheduleBuilder, RankGoalBuilder and AiGoalBuilder — it had no onClick in any of them.
const BASELINE = Number(process.env.BUTTON_VOCAB_BASELINE ?? 283)

/** Never counted as an idiom of its own: a text action beside a button is a real distinction. */
const NEUTRAL = new Set(['h10-am-link'])

process.chdir(execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim())
if (!existsSync(ROOT)) {
  console.error(`❌ button-vocabulary: scan root ${ROOT} does not exist — the check would pass vacuously.`)
  process.exit(1)
}
const files = execSync(`find ${ROOT} -name '*.tsx'`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
if (files.length === 0) {
  console.error(`❌ button-vocabulary: no .tsx found under ${ROOT} — the check would pass vacuously.`)
  process.exit(1)
}

/** The leading literal of a className, which is the class that decides what the element IS. */
function firstClass(attr) {
  if (!attr || !attr.initializer) return null
  const init = attr.initializer
  if (ts.isStringLiteral(init)) return init.text.trim().split(/\s+/)[0] ?? null
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression
    if (ts.isStringLiteral(e)) return e.text.trim().split(/\s+/)[0] ?? null
    // `className={`h10-am-btn ${x}`}` — the head is what matters.
    if (ts.isTemplateExpression(e)) return e.head.text.trim().split(/\s+/)[0] || null
    if (ts.isNoSubstitutionTemplateLiteral(e)) return e.text.trim().split(/\s+/)[0] ?? null
  }
  return null
}

/** Text content, i.e. a LABEL. An icon-only button has element children and no words. */
function isLabelled(node) {
  if (!node.parent || !ts.isJsxElement(node.parent)) return false
  return node.parent.children.some((c) => {
    if (ts.isJsxText(c)) return c.text.trim().length > 0
    // `{busy ? 'Saving…' : 'Save'}` is a label; `{<Icon/>}` is not.
    if (ts.isJsxExpression(c) && c.expression) return !ts.isJsxElement(c.expression) && !ts.isJsxSelfClosingElement(c.expression)
    return false
  })
}

const hits = []
let excess = 0
for (const f of files) {
  const src = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  /** idiom → first line it appears on, so the message can point at both sides of a mix. */
  const idioms = new Map()
  const visit = (n) => {
    if (ts.isJsxOpeningElement(n)) {
      const tag = n.tagName.getText()
      if (tag === 'button' || tag === 'a') {
        const attr = n.attributes.properties.filter(ts.isJsxAttribute).find((a) => a.name.getText() === 'className')
        const cls = firstClass(attr)
        // No className = unstyled/structural, not a competing idiom.
        if (cls && !NEUTRAL.has(cls) && isLabelled(n)) {
          const { line } = src.getLineAndCharacterOfPosition(n.getStart())
          if (!idioms.has(cls)) idioms.set(cls, line + 1)
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  if (idioms.size > 1) {
    const where = [...idioms.entries()].map(([c, l]) => `${c}:${l}`).join('  ')
    // 🔴 EXCESS idioms, not files. Counting files would let a file that already mixes two grow to
    // five without moving the number — which is exactly the shape of the reported defect.
    excess += idioms.size - 1
    hits.push(`${f}  — ${idioms.size} idioms: ${where}`)
  }
}

const n = excess
if (n > BASELINE) {
  console.error(`\n❌ button-vocabulary ratchet: ${BASELINE} → ${n} excess idiom(s) — a component mixes buttons.`)
  console.error('   Two labelled buttons in one surface should be the same object. Pick one class')
  console.error('   (h10-am-btn + modifiers is the tree\'s own, 257 uses) and use it for all of them.')
  console.error('   Icon-only buttons and h10-am-link are exempt. Files:\n')
  for (const h of hits) console.error(`   ${h}`)
  console.error('')
  process.exit(1)
}
if (n < BASELINE) {
  console.log(`✓ button-vocabulary: ${n} excess idiom(s) across ${hits.length} file(s) — below the ${BASELINE} baseline. Lower BASELINE to hold the ground.`)
} else {
  console.log(`✓ button-vocabulary: ${n} excess idiom(s) across ${hits.length} file(s), at the ${BASELINE} baseline.`)
}
