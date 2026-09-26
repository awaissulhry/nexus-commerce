# Saved listing issues

Status: **deployed 2026-09-26** in release B+C (PR #32) after the review rework below; no switch.
Not production-verified (no browser check in production yet). P3.3's Diagnostics card is included;
the studio pane remains owned by PES.3. The implementation notes below keep their lane-time wording.

## API contract for both consumers

`GET /api/cx/connections/:id/listing-issues` uses the existing integrations-manage
permission and scoped connection visibility. It reads only open `ListingIssue`
rows owned by the current business, for that connection's current-business listing
and product. A visible shared account exposes the guest's findings only. Invisible
accounts return404. No caller-supplied workspace selector retargets the query.

Parameters: `take` defaults25, range1–50; optional `listingId`; optional opaque
`after` cursor. Cursors bind account, business and listing filter, with descending
last-seen time and ascending issue-ID tie-breaker. Invalid input returns400.
A resolved cursor row does not prevent continuation. Pages are live, not a frozen
snapshot: updated/new findings may require refresh, stated in the UI.

Shared DTO: `@nexus/shared/channel-listing-issues`. Response contains connection,
business, channel, read timestamp, bounded items, and nullable nextCursor. Items
include productSku (master product SKU, not a claimed channel SKU), listing and
product IDs, marketplace, external listing ID, code, severity, message, attributes,
categories, source and first/last/channel timestamps. No raw payload or credentials.
All responses use no-store. Storage failure is503 with a static public message,
never an empty success. This route makes no vendor call and resolves no finding.

## Diagnostics behavior

The card uses Nexus Card, Banner, Button and Tag. Refresh reads saved records.
It reports the count shown, source and timestamps; missing channel time is explicit.
Empty data makes no healthy verdict. Provider text renders as text. Loading and
failure remain distinct; failed continuation preserves already-read findings.

Requests carry the selected profile, with bounded waits and both response and
render identity fences. Late responses cannot paint another account/profile.
Diagnostics remounts on profile change; the same account shared between profiles
still has distinct card state. Continuation merges duplicate IDs from live pages.
Held buttons keep keyboard focus and reject activation while busy/exhausted.

## Local proof — 2026-09-25

Evidence in `build/evidence/listing-issues-20260925/` in the helper:

- Route red10fail/3pass before implementation; final29/29 pass.
- Real PostgreSQL red1pass/6assertion failures; final7/7, zero skips, production
  owner capability model and real runtime RLS. Initial fixture setup failures
  (missing region, read-only grant unable to create guest listing) are retained,
  not treated as red proof. Valid guest fixture has a publish grant.
- Client red11fail; final13 hook tests plus2 card action tests and7 existing scoped
  data tests =22 passes. API/web typechecks pass.
- 30 feature guard mutations assertion-killed/restored (27 API/client +3 card);
  hashes recorded. First cursor-length and immediate-render mutants survived
  incomplete tests; strengthened cases killed both, with original results retained.
- Four additional shared Tag contrast mutations and14 guard tests documented in
  `build/TAG-CONTRAST-20260925.md`. Strict gates: web102/factory116 measured pairs,
  none below7:1. Route-Prisma/raw-primitives ratchets hold; both token guards pass.
- Chrome real browser, actual component/styles and synthetic local responses:
  390/1280 light/dark, no horizontal overflow, settled text contrast minimum8.237
  light /8.961 dark; provider HTML remained text with zero image elements.
  Keyboard pagination retained focus, Shift+Tab returned to refresh; empty/error
  states and retry checked. Recorded request6 Alpha finished after request7 Beta;
  only Beta findings rendered. Account switch then showed only account-two.
  Final browser console had zero errors. Viewport restored, tab/server closed.
- Browser artifacts use the app's Arial font fallback. Initial fixture bundling
  errors (unrelated Next barrel import, root React19 versus web React18) were fixed
  before final verification; no production code workaround or live call was used.

No schema or migration change. New exact realPG runner registration adds one suite
of7 tests to this helper's base25/328, giving26/335 before other lanes integrate.
Final integration gates and whole-package review remain required. Factory's existing
unrelated type error remains recorded with the shared Tag evidence.

## Review rework — 2026-09-26

Source: `2026-09-26-APPROACH-REVIEW.md` ("Listing-issues card: KEEP, small CHANGE"), approved by the Owner.
Local only; not pushed or deployed.

- The SKU links to the product page (`/products/<productId>/edit`); "Open listing" links to the listing's
  own workspace (`productWorkspaceHref`: scope, market, account, listing), the route the listings grid
  already opens. Both use the workspace-aware `Link` inside a DS `Button asChild variant="link"`, so the
  business profile stays in the URL. Each "Open listing" is named "Open listing <SKU> on <market>".
- The recorder's source code is no longer shown. The card says "Reported by <plain label>" (for example
  "Amazon feed upload"); an unknown source reads "an unrecognised source". No DS screen keeps raw codes in
  a secondary place, so none is kept. The channel's own issue code and severity word are unchanged.
- DS gap closed: `.nds-btn` is `nowrap`, so a long SKU link overflowed at 390 px (642 px wide). Added
  opt-in `Button wrap`, mirrored in Factory, catalog specimen, changelog and DS-GAPS entry.

Proof: red first (5 card tests, then 3 wrap tests). Card 8 + hook 13 + wrap 3 = 24 pass. 14/14 mutations
killed by assertion, sha256 restored. Web tsc clean; Factory's pre-existing `scripts/` errors unchanged,
none in the DS. Strict 7:1 gate: web 102 / Factory 116 pairs, none below. `check-token-role` fails on
pre-existing `grid.css` lines, untouched here. Real browser (local harness, synthetic data): 390 and 1280
px, light and dark, no overflow, link contrast 8.02 / 8.28, focus ring visible on both links, Tab order
Refresh → SKU → Open listing. Not yet checked: the whole app shell against a local API.

Coordinator follow-up (2026-09-26): severity shows on the DS `Tag` in sentence case ("Error", "Warning",
"Info"; an empty value reads "Unknown severity"). The channel's issue code stays, as muted secondary text
beside the source label ("· issue code <code>", `--nds-text-muted`), because sellers search the vendor's help
by it; it is no longer in the label row. Red 6 -> 186 pass; 6 mutations killed (one redundant severity map
was removed after its mutation survived). Browser: code text 8.16:1 light / 9.37:1 dark, no overflow.

