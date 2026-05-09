#!/usr/bin/env node
// Per-commit verifier for /products/[id]/list-wizard.
//
// Source-level smoke checks for the invariants the wizard depends on.
// Run after every wizard commit — bash:
//   node scripts/verify-list-wizard-commit.mjs
// Exits non-zero on any failure so it can chain into CI.
//
// Checks:
//   1. Cross-tab events still emitted (Q.10 — wizard.created /
//      wizard.deleted / wizard.submitted) at known anchor sites.
//   2. WizardStepper still hardened against overflow + a11y (Q.15).
//   3. WizardHeader dark mode pair (W1.3) — guards regressions.
//   4. lib/steps.ts still describes 9 steps.
//   5. Wizard chrome avoids native dialogs (alert/confirm/prompt).
//   6. Optimistic-concurrency 409 banner still wired.
//   7. ⌘G / ⌘Enter / ⌘← / ⌘→ keyboard shortcuts still wired.
//   8. ResumeBanner + BlockerBanner still present.
//   9. Telemetry POST is fire-and-forget (sendBeacon + keepalive).
//  10. page.tsx has `dynamic = 'force-dynamic'`.
//  11. WizardStepEvent telemetry helper imported in client + step9.
//
// New checks appended as the wizard evolves; old checks should NOT be
// removed unless the underlying invariant is intentionally retired.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}
function read(rel) {
  return fs.readFileSync(path.join(repo, rel), 'utf8')
}

console.log('\nlist-wizard per-commit verifier\n')

const wizardDir = 'apps/web/src/app/products/[id]/list-wizard'
const client = read(`${wizardDir}/ListWizardClient.tsx`)
const stepper = read(`${wizardDir}/components/WizardStepper.tsx`)
const header = read(`${wizardDir}/components/WizardHeader.tsx`)
const nav = read(`${wizardDir}/components/WizardNav.tsx`)
const resumeBanner = read(`${wizardDir}/components/ResumeBanner.tsx`)
const blockerBanner = read(`${wizardDir}/components/BlockerBanner.tsx`)
const steps = read(`${wizardDir}/lib/steps.ts`)
const telemetry = read(`${wizardDir}/lib/telemetry.ts`)
const page = read(`${wizardDir}/page.tsx`)
const submitStep = read(`${wizardDir}/steps/Step9Submit.tsx`)

console.log('Case 1: cross-tab events (Q.10) still emitted')
check('wizard.created emit on fresh mount',
  /emitInvalidation\(\{[\s\S]{0,120}type:\s*'wizard\.created'/.test(client))
check('wizard.deleted emit on discard',
  /emitInvalidation\(\{[\s\S]{0,120}type:\s*'wizard\.deleted'/.test(client))
check('wizard.submitted emit at terminal step',
  /emitInvalidation\(\{[\s\S]{0,120}type:\s*'wizard\.submitted'/.test(submitStep))
check('listing.created emit per channel',
  /emitInvalidation\(\{[\s\S]{0,120}type:\s*'listing\.created'/.test(submitStep))

console.log('\nCase 2: WizardStepper overflow + a11y (Q.15)')
check('stepper container has overflow-x-auto', /overflow-x-auto/.test(stepper))
check('stepper inner has min-w-max', /min-w-max/.test(stepper))
check('flex-shrink-0 on circles + connector', /flex-shrink-0/.test(stepper))
check('role=tablist + role=tab', /role="tablist"/.test(stepper) && /role="tab"/.test(stepper))
check('aria-current="step"', /aria-current=\{isCurrent \? 'step'/.test(stepper))

console.log('\nCase 3: WizardHeader dark mode pair (W1.3)')
check('header outer has dark border + bg', /dark:border-slate-800[\s\S]{0,40}dark:bg-slate-950/.test(header))
check('back arrow has dark text pair', /dark:text-slate-500[\s\S]{0,80}dark:hover:text-slate-300/.test(header))
check('product name has dark text', /dark:text-slate-100/.test(header))
check('SKU subtle has dark text', /dark:text-slate-400/.test(header))
check('close button has dark hover', /dark:hover:bg-slate-800/.test(header))
check('fallback channel chip has dark trio', /dark:bg-slate-800[\s\S]{0,60}dark:text-slate-300[\s\S]{0,60}dark:border-slate-700/.test(header))

console.log('\nCase 4: 9 steps still described')
const stepIdMatches = steps.match(/^\s*id:\s*\d+,/gm) ?? []
check('STEPS array contains 9 entries', stepIdMatches.length === 9)
check('TOTAL_STEPS exported', /export const TOTAL_STEPS = STEPS\.length/.test(steps))

console.log('\nCase 5: no native dialogs in wizard chrome')
const allWizardSrc = [client, stepper, header, nav, resumeBanner, blockerBanner].join('\n')
check('no alert(', !/\balert\(/.test(allWizardSrc))
check('no window.confirm(', !/window\.confirm\(/.test(allWizardSrc))
check('no window.prompt(', !/window\.prompt\(/.test(allWizardSrc))
check('uses useConfirm primitive in client', /useConfirm/.test(client))

console.log('\nCase 6: optimistic-concurrency banner (NN.1 / A6)')
check('detects 409 in PATCH', /res\.status === 409/.test(client))
check('renders sticky conflict banner', /conflictDetected/.test(client) && /role="alert"/.test(client))

console.log('\nCase 7: keyboard shortcuts wired')
check('Cmd+G jump-to-blocker', /e\.key === 'g' \|\| e\.key === 'G'/.test(client))
check('Cmd+Enter smart Continue', /e\.key === 'Enter'/.test(client))
check('Cmd+Arrow back/forward', /e\.key === 'ArrowRight'/.test(client) && /e\.key === 'ArrowLeft'/.test(client))

console.log('\nCase 8: resume + blocker banners still present')
check('ResumeBanner mounted in client', /<ResumeBanner/.test(client))
check('BlockerBanner mounted in client', /<BlockerBanner/.test(client))
check('ResumeBanner uses 5-min stale threshold default',
  /FIVE_MINUTES_MS = 5 \* 60 \* 1000/.test(resumeBanner))
check('BlockerBanner shows ⌘G hint', /⌘G/.test(blockerBanner))

console.log('\nCase 9: telemetry helper is fire-and-forget')
check('uses sendBeacon when available', /navigator\.sendBeacon/.test(telemetry))
check('falls back to fetch with keepalive', /keepalive:\s*true/.test(telemetry))
check('swallows errors silently', /\/\/\s*swallow/.test(telemetry))

console.log('\nCase 10: page.tsx force-dynamic')
check('export const dynamic = "force-dynamic"', /export const dynamic = 'force-dynamic'/.test(page))

console.log('\nCase 11: telemetry call sites still present')
check('client imports postWizardEvent', /from '\.\/lib\/telemetry'/.test(client))
check('submit step imports postWizardEvent', /postWizardEvent/.test(submitStep))

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}\n`)
process.exit(failures === 0 ? 0 : 1)
