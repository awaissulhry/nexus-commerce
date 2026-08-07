/**
 * NAF.AQ.2 — the staleness guard must cover every tool that can act.
 *
 * Why this test exists, stated plainly so nobody deletes it as noise:
 *
 * `MATERIAL_PREVIEW_FIELDS` decides which preview fields invalidate an
 * approval when the world moves between the operator saying yes and the action
 * running. For months it held entries for exactly the three fleet
 * propose-tools — which are preview-only and cannot reach Amazon — and nothing
 * at all for the four tools that CAN: `set-price`, `apply-content`,
 * `publish-listing`, `send-customer-message`.
 *
 * Nobody decided those were safe. The map simply defaulted to `?? []`, which
 * compares nothing and complains about nothing, so the omission was invisible.
 * The guard was doing its work exclusively on the actions that could not do
 * damage.
 *
 * `checkStaleness` now fails closed, so a future uncovered tool is refused
 * rather than run unchecked. That is the safety net. THIS is the smoke alarm:
 * it fails in development the moment someone registers an executing tool
 * without declaring what matters for it, instead of an operator discovering it
 * as a mystery refusal.
 */
import { describe, it, expect } from 'vitest'
import { listTools } from '../agents/tool-registry.js'
import { DECIDED_STATUSES, MATERIAL_PREVIEW_FIELDS } from './approval-inbox.service.js'

describe('staleness coverage', () => {
  const executing = listTools().filter((t) => typeof t.execute === 'function')

  it('every tool that can execute declares its material preview fields', () => {
    const uncovered = executing
      .filter((t) => !MATERIAL_PREVIEW_FIELDS[t.name])
      .map((t) => t.name)

    expect(
      uncovered,
      `These tools can change something outside this system and have no material
       preview fields declared, so nothing would be compared before they run.
       Add an entry to MATERIAL_PREVIEW_FIELDS naming the preview fields whose
       change should invalidate the approval — typically whatever the preview
       records as the CURRENT value the operator was moving away from.`,
    ).toEqual([])
  })

  it('declares a non-empty list for each — an empty array is the bug it replaced', () => {
    for (const t of executing) {
      const fields = MATERIAL_PREVIEW_FIELDS[t.name]
      expect(fields, `${t.name} has an entry`).toBeDefined()
      expect(fields!.length, `${t.name} declares at least one material field`).toBeGreaterThan(0)
    }
  })

  it('the preview-only fleet tools stay covered too', () => {
    // Cheap, but it is what stops a refactor quietly dropping them while
    // everyone is looking at the executing ones.
    for (const name of ['set-target-bid', 'create-negative-keyword', 'graduate-keyword']) {
      expect(MATERIAL_PREVIEW_FIELDS[name], `${name} is still declared`).toBeDefined()
    }
  })

  it('an EDITED proposal stays visible in the record', () => {
    // NAF.AQ.8 — editing supersedes the original rather than mutating it. If
    // `superseded` is not one of the decided statuses, that original appears
    // in NO view: not waiting, not decided, not expired. That is the
    // silent-terminal-failure shape this page was built to remove, reintroduced
    // by the feature meant to improve it.
    //
    // Asserted against the exported VALUE, not against the source text. The
    // first version of this test grepped the file for the string and would
    // have passed on the comment above it — a check that cannot fail for the
    // right reason is not a check, which is the same lesson as the `?? []`
    // default it sits next to.
    expect(DECIDED_STATUSES).toContain('superseded')
  })

  it('finds at least one executing tool — a registry that resolves to nothing would pass vacuously', () => {
    // Without this, an import regression that emptied the registry would make
    // every assertion above trivially true.
    expect(executing.length).toBeGreaterThan(0)
  })
})
