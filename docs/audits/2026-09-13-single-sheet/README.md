# Product sheet consolidation — parity audit

The Information tab now mounts `ProductSheetTab` → `ProductSheet` → one
`ProductSheetSurface` for Shared product, Amazon, eBay, Shopify and Etsy.
The former `MasterSheet` and `ChannelSheet` exports are compatibility wrappers.

The shared surface owns the grid, toolbar, chip display, status/footer, preferences
and drawer mounting. Common hooks own selection and keyboard events, grid lifetime,
save counters, identity measurement, column preferences, diagnostic chip production
and filtering that retains parent/listing bands.

The two adapters retain each scope's existing data and action contracts. Master keeps
family actions, shared writes and its editable drawer/AI proposal review. Channel keeps
listing identities, write acknowledgements, overrides, offer actions, information checks,
Shopify editors/review and the existing read-only drawer. The column factories, popup
editors, formula functions and writer implementations were reused.

## Strict parity corrections

The comparison used copies of the two hosts taken before extraction. During verification
we restored incidental differences in:

- Channel chip registration order and loading behavior; Shared product chip wording/count metadata.
- Preference descriptions, master loading messages and route product identity.
- Scope-specific tooltip portal and drawer placement, including surrounding dialogs.
- Master-only Enter-to-open-record behavior and channel selection semantics.
- Channel focus handling: bare column IDs emitted during grid restoration must not become
  a drawer anchor. A new regression test covers this case.
- Each scope's identity-measurement timing and reset behavior.

The retained callbacks were compared with TypeScript's parser/printer after removing comments.
The editor selection, formula wiring, clipboard handlers, write handlers, cascade actions,
reload guards, cell details, media editors and domain actions match their original bodies.
See `source-review.txt`. Row filtering and identity pinning were replaced with equivalent
shared implementations; the master's structural identity pin was already always enabled.

## Verification

- Web TypeScript check: passed (`web-types.log` is empty).
- Sheet, scope and chip suite: **599 passed across 50 files** (`sheet-tests.log`).
- Broader grid/drawer suite: **1,080 passed**, one unrelated failure described below.
- AG Grid import boundary: passed (5,879 TypeScript and 109 CSS files scanned).
- Semantic token resolution: passed.
- Browser fixtures run under React StrictMode, with in-memory reads/writes and no provider connection.
- Matched rendered accessibility snapshots and measured geometry, fonts, colors and padding
  for Shared product, Etsy, Shopify, and synthetic Amazon/eBay field matrices.
- Compared preferences, search/parent retention, required-chip filtering, long-text popup,
  formula mode, cancellation, row actions, saved state and record drawers.
- An identical Etsy title edit produced identical bulk-write requests, including account,
  market, locale, alias, intent and expected version.
- Light/dark channel drawer screenshots at **1280 × 800** were compared as decoded pixels.
  See `image-comparison.json` and the paired JPEG files.

`browser-comparisons.json` retains intermediate probes as well as final checks. Early false
results include the corrected chip order and focus regressions, a comparison taken before
loading completed, incomplete Shopify fixture schema, mismatched test-tab viewports, and
nonvisible whitespace in aggregate DOM text. Final comparisons exclude aggregate text from
geometry checks and compare the accessibility snapshot separately. The final recorded scope
and responsive comparisons pass; the screenshot comparison checks the rendered pixels too.

## Existing broader-check failures

These files and backend behavior were not changed by this consolidation:

1. `drawer/layers.vitest.test.ts`: the backend's new `channelSnapshot` source is not mapped
   by the existing drawer layer helper. See `grid-drawer-tests.log`.
2. Design-system mirror guard: `grid/renderers/index.ts` differs between web and factory.
   See `ds-mirror-check.log`. This task changed no shared design-system source files.
3. The live channel contract suite cannot find its expected `GALE-JACKET` fixture through
   the current product-list lookup. This also failed before the conversion. The final
   isolated suite explicitly excludes `live-channel-scope.vitest.test.ts`.

The browser comparison is a controlled frontend parity check. Amazon/eBay use a synthetic
field matrix; it does not certify every live marketplace schema or execute provider delivery.
No accessibility conformance certification is claimed.

## Reproduce

From the repository root, start these separately:

```sh
node docs/audits/2026-09-13-single-sheet/browser-fixture/server.mjs
node docs/audits/2026-09-13-single-sheet/browser-fixture/server.mjs --baseline
```

Open the same product URL on ports 3158 (consolidated) and 3159 (original hosts):
`/products/store-demo/edit/studio?market=GLOBAL&locale=en`.
The original hosts are compressed under `baseline/`; the fixture decompresses them in
memory. Both versions use the same current editor libraries, CSS and fixture data, isolating
the sheet-host conversion. Saved test values live only in each server process's memory.
