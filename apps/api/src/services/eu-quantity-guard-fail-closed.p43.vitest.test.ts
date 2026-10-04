/**
 * P4.3b / D9 — the EU shared-quantity guard fails CLOSED.
 *
 * ## The Owner's ruling, already made
 *
 * `FINAL-PLAN.md` decision **D9**:
 *
 * > *The EU shared-quantity guard when its own check fails.*
 * > A: let the push through (today).  **B: hold the push and alert.**
 * > **Decision: B. A wrong EU quantity is worse than a short delay.**
 *
 * ## What the code did
 *
 * ```ts
 * } catch (guardErr) {
 *   // Guard infrastructure failing must not stop legitimate pushes — but say so.
 *   logger.warn('[outbound-sync] EU shared-qty guard check failed (push allowed)', …)
 * }
 * ```
 *
 * **"push allowed".** The comment states the fail-open as a principle. D9 ruled
 * the other way, and the ruling is right for a reason worth keeping: Amazon holds
 * **ONE merchant quantity per SKU across the EU markets**. If the guard cannot
 * run, we do not know whether this push fights a sibling market's intent — and
 * the incident this guard exists for is a scoped Zero that blanked an entire
 * storefront. **"We could not check" is not "there is no conflict."**
 *
 * A retry is cheap: the row stays queued and the next attempt runs the guard
 * again. Sending blind is not reversible.
 *
 * This is the fourth fail-open found in one day, after P4.1d (policy
 * reconciliation warned instead of refusing), P4.1e (the lane marker guessed) and
 * P4.2a's unmatched SKUs. **A rule's `catch` is where it goes to die.**
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * Amazon sheet gaps (bug 3): the guard's rule moved into THE send quantity (`amazon/send-quantity.ts`, shared with studio
 * Publish), so this check reads two places: the shared function decides (fail closed when the sibling read failed), and
 * the stock job's branch for that verdict holds the push and raises the alert. Behaviour:
 * `outbound-sync.amazon-offer-roots.vitest.test.ts` ("the EU guard cannot read the siblings → held").
 */
const SRC = join(import.meta.dirname, '..')
const file = readFileSync(join(SRC, 'services', 'outbound-sync.service.ts'), 'utf8')
const shared = readFileSync(join(SRC, 'services', 'amazon', 'send-quantity.ts'), 'utf8')
const health = readFileSync(join(SRC, 'services', 'sync-health.service.ts'), 'utf8')

/** Comments stripped — a claim about what the code DOES. */
const strip = (text: string) => text
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join('\n')
const code = strip(file)
const sharedCode = strip(shared)

/** The stock job's branch for the "guard could not run" verdict, so a return elsewhere is not credited to it. */
const heldBranch = (() => {
  const start = code.indexOf("if (sent.code === 'EU_SHARED_QTY_GUARD_UNAVAILABLE') {")
  return code.slice(start, start + 1800)
})()
/** Where the sibling read's failure is caught: it must reach the verdict, never be swallowed. */
const readCatch = (() => {
  const start = code.indexOf('} catch (guardErr) {')
  return code.slice(start, start + 200)
})()
/** The shared function's fail-closed branch. */
const sharedBranch = (() => {
  const start = sharedCode.indexOf('if (input.euRowsError != null || !input.euRows) {')
  return sharedCode.slice(start, start + 900)
})()

describe('the guard fails CLOSED', () => {
  it('the branches exist and are the ones under test', () => {
    expect(heldBranch).toContain("if (sent.code === 'EU_SHARED_QTY_GUARD_UNAVAILABLE') {") // positive controls
    expect(readCatch).toContain('} catch (guardErr) {')
    expect(sharedBranch).toContain('if (input.euRowsError != null || !input.euRows) {')
    // The job hands the read's outcome to the shared verdict.
    expect(code).toMatch(/amazonSendQuantity\(\{[\s\S]{0,400}euRows, euRowsError,/)
  })

  it('HOLDS the push instead of allowing it', () => {
    expect(sharedBranch).toContain("code: 'EU_SHARED_QTY_GUARD_UNAVAILABLE'")
    expect(sharedBranch).toContain('return none(')
    expect(heldBranch).toContain('return { success: false')
    expect(heldBranch).toContain("status: \"SKIPPED\"")
    expect(heldBranch).toContain("error: \"eu-shared-qty-guard-unavailable\"")
  })

  it('no longer says the push was allowed', () => {
    // The old log line was the marker of the fail-open. Its absence is the
    // assertion; the new one names what happens instead.
    expect(code).not.toContain('(push allowed)')
    expect(heldBranch).toContain('(push HELD)')
  })

  it('does not swallow the failure silently', () => {
    // A `catch {}` would also "fail closed" by accident if the surrounding code
    // happened to return — but nobody would know why.
    // Assert the CALL, not the name. A mutation that left `void syncHealthService`
    // in place kept the name and removed the alert, and this test stayed green —
    // the name-versus-value lesson again.
    expect(readCatch).toMatch(/euRowsError = guardErr instanceof Error \? guardErr\.message : String\(guardErr\)/)
    expect(heldBranch).toContain('logger.warn')
    expect(heldBranch).toContain('await syncHealthService.logConflict({')
  })
})

describe('the alert says WHICH fact it is', () => {
  it('uses its own conflict type, not the conflict one', () => {
    // 🔴 "we could not check" and "we checked and found a conflict" are
    // different facts. Reusing EU_SHARED_QTY_CONFLICT would tell the operator
    // their listings disagree when the truth is that OUR guard broke — theirs
    // to fix versus ours to fix.
    expect(heldBranch).toContain("conflictType: 'EU_SHARED_QTY_GUARD_UNAVAILABLE'")
    expect(heldBranch).not.toContain("conflictType: 'EU_SHARED_QTY_CONFLICT'")
  })

  it('the type is declared, so this is not a string that type-checks by luck', () => {
    expect(health).toContain("| 'EU_SHARED_QTY_GUARD_UNAVAILABLE'")
    expect(health).toContain("| 'EU_SHARED_QTY_CONFLICT'") // both still exist
  })

  it('carries the guard error, the SKU and what was attempted', () => {
    expect(heldBranch).toContain('guardError: euRowsError')
    expect(heldBranch).toContain('remoteData: { attemptedQuantity,')
    expect(heldBranch).toContain('sku')
  })

  it('never lets the alert decide the push', () => {
    // The alert is best-effort and wrapped; if logging the conflict throws, the
    // push must STILL be held. An alert failure must not re-open the gate.
    const afterAlert = heldBranch.slice(heldBranch.indexOf('syncHealthService'))
    const iCatch = afterAlert.indexOf('} catch {')
    const iReturn = afterAlert.indexOf('return { success: false')
    expect(iCatch).toBeGreaterThan(0)
    expect(iReturn).toBeGreaterThan(iCatch) // the return is OUTSIDE the alert's try
  })
})

describe('the operator sentence explains itself', () => {
  it('says it was held, why, and that it will retry', () => {
    expect(sharedBranch).toContain('Push held rather than sent blind')
    expect(sharedBranch).toContain('one EU quantity per SKU')
    expect(sharedBranch).toContain('It will be retried')
    expect(sharedBranch).toContain('EU_GUARD_REMEDY')
    // The job sends that sentence, not one of its own.
    expect(heldBranch).toContain('message: sent.refusal')
  })
})

describe('the CONFLICT path is untouched', () => {
  it('still refuses on a real conflict, with its own message', () => {
    // The change is only to the failure path. A mutation that "fixed" the
    // fail-open by deleting the whole block would break this.
    expect(sharedCode).toContain('if (verdict.conflict) {')
    expect(sharedCode).toContain('Push refused so no market\'s intent is silently overwritten')
    expect(code).toContain("if (sent.code === 'EU_SHARED_QTY_CONFLICT') {")
    expect(code).toContain('error: "eu-shared-qty-conflict"')
  })
})
