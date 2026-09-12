import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 🔴 THE RECONCILE MUST BE QUIET — a source guard, because nothing else here can see it.
 *
 * `apps/web`'s vitest is node-only: it cannot render a hook, so no test in this suite can observe
 * that a re-read left the grid mounted. What it CAN do is hold the one line that decided it.
 *
 * The defect this guards: the first version passed `onReconcile: () => reload()`, and `reload()`
 * begins `setLoading(true)`. The grid dropped its rows, and the `unknown` mark and the operator's
 * typed value went with them one second after they appeared — an empty sheet and a spinner for the
 * length of the outage. The fix is not "call a different function"; it is that **the read taken to
 * resolve an unknown write must touch no state that can unmount what the operator is looking at.**
 *
 * This is a text assertion and it knows it. It is not evidence that the reconcile works — the
 * behaviour is proven in `sheetWriter.reconcile.vitest.test.ts` and against a real closed port in
 * `masterWrite.deadport.vitest.test.ts`. It exists to stop the *shape* coming back.
 */
describe('useMasterSheet — the reconcile read is quiet', () => {
  const src = readFileSync(join(__dirname, 'useMasterSheet.ts'), 'utf8')

  /** The `readBack:` property's body, brace-matched. Throws rather than passing when absent. */
  const readRowBody = () => {
    const at = src.indexOf('readBack:')
    // A guard that cannot find its subject must say NOT MEASURED, never "clean".
    if (at === -1) throw new Error('readRow is not passed to the writer — the reconcile cannot run at all')
    const open = src.indexOf('{', at)
    if (open === -1) throw new Error('readRow has no body to read')
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
    }
    throw new Error('readRow body is unbalanced — the guard cannot bound it')
  }

  it('🔴 sets no React state: nothing it does can unmount the grid under the mark', () => {
    const body = readRowBody()
    const setters = body.match(/\bset[A-Z]\w*\s*\(/g) ?? []
    expect(setters).toEqual([])
  })

  it('🔴 does not call reload() — the exact line that destroyed the mark', () => {
    expect(readRowBody()).not.toMatch(/\breload\s*\(/)
  })

  it('reads with no-store, so a cached body cannot answer "did this save?"', () => {
    // The one question this read exists to answer is what the database holds RIGHT NOW. An
    // intermediary's copy of the pre-write row would resolve every unknown to `refused`.
    expect(readRowBody()).toMatch(/cache:\s*'no-store'/)
  })

  it('parses through the rule that keeps "no answer" apart from "empty row"', () => {
    // Not a text check of `return null`: that passed with one of the two returns mutated to `{}`,
    // because the other one still matched. The distinction is tested where it lives, in
    // `reconcileRead.vitest.test.ts` — this only holds the read to using it.
    expect(readRowBody()).toMatch(/recoverSheetRow\(/)
  })
})
