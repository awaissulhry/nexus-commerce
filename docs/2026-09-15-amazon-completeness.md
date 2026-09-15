# Amazon channel progress — issue #2

Issue: https://github.com/awaissulhry/nexus-commerce/issues/2

## Reproduced cause

The production GALE-JACKET Amazon · IT Information sheet showed 100% on the
parent listing and 26% on all 20 children. A read-only probe confirmed that every
child had 31/31 applicable required fields filled, with no missing required
fields. Overall coverage was 64/247, which rounds to 26%.

The parent listing and scope selector used required-field completion. The child
identity bars used overall coverage, including optional fields. The channel
Variants view used that same overall coverage. The saved required values were
present; the inconsistent choice of ratio caused the reported result.

## Change

- Information child bars use each row's required-field counts, retaining the
  listing's existing guard against scoring an unavailable schema.
- Channel Variants bars use the server's existing `readiness.requiredPct`, for
  both parent and child. The client type now carries the parent's ratio and the
  server's reason when scoring is unavailable.
- Tooltips and accessible labels explicitly name required fields. Listing/error
  state still controls color independently of the percentage.
- Empty required schemas remain unscorable. Overall coverage stays in the API
  response. Existing confirmed-save refreshes supply updated row counts.

No product data, schema, shared design-system component, or CSS changes are
needed. The existing Nexus CompletenessPill and readiness vocabulary are reused.

## Verification

- The regression first failed with the reported 26% instead of 100%.
- 149 focused frontend tests passed, including partial and zero completion,
  unavailable requirements, error-state preservation, saved-row refresh,
  channel writes, view rules and design-system rendering. The projection test
  renders the actual identity column and checks the number, bar width and
  accessible label. These regressions run in GitHub CI and the pre-push suite.
- Replayed the fixed row function over the unchanged production capture: all
  20 children changed from 26% to 100%, each labelled 31/31 required fields.
- Local browser verified distinct incomplete row scores, light/dark appearance,
  a 768px viewport, and keyboard collapse/expand of all 20 variants. No browser
  error logs were reported. Local catalog values differ from production.
- Web TypeScript, token generation, token guard, design conformance and
  whitespace checks passed.

Evidence is in `/private/tmp/nexus-amazon-completeness/`. The owner authorized
commit, push and production deployment on 15 September. Release verification
will match the deployed Vercel commit and confirm that all 20 variants show
100% in the production editor before closing the issue.
