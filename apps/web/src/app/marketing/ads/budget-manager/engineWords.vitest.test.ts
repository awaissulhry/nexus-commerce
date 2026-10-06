/**
 * AM-8 — the Budget Manager never asserts whether the budget engine is live; it reads `engine` from
 * GET /advertising/budget-manager/enforcement (the engine's own gate, `budgetEnforceMode` in the API).
 *
 * The page used to say "dry-run, nothing applied" and "nothing writes to Amazon until the enforcement engine is
 * explicitly enabled" while the engine wrote real budgets. Node test without a DOM, so it reads the source: the old
 * sentences are gone, and the banner, the FAQ and the toggle toast all take their words from `engine`.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./BudgetManagerClient.tsx', import.meta.url)), 'utf8')

describe('Budget Manager — the engine\'s mode comes from the server, never from the page', () => {
  it('the hard-coded "dry-run" claims are gone', () => {
    expect(src).not.toContain('dry-run, nothing applied')
    expect(src).not.toContain('nothing writes to Amazon until the enforcement engine is explicitly enabled')
    expect(src).not.toContain('Every change is previewed (dry-run)')
    expect(src).not.toContain("toast('Status updated successfully.')")
  })

  it('the status line, the pacing banner, the FAQ and the toggle toast read `engine`', () => {
    expect(src).toMatch(/Budget engine: \{engine \? engine\.label/)
    expect(src).toMatch(/<em title=\{engine\?\.sentence \?\? ENGINE_UNKNOWN\}>/)
    expect(src).toMatch(/q: 'Is the budget engine live right now\?', a: engine \?/)
    expect(src).toMatch(/toast\(value \? `\$\{what\} Budget engine: \$\{engine \? `\$\{engine\.label\}/)
  })

  it('pace is labelled with the complete days it counts (AM-17)', () => {
    expect(src).toContain('pace counts ${result.elapsedDays} complete day')
  })
})
