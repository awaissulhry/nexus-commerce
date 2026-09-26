# Tag contrast correction — local, 2026-09-25

The listing-issues browser check measured danger Tag text at 6.41:1 light and
6.92:1 dark. Adding actual Tag CSS pairs to the gate also found success at4.57:1
light. The existing semantic text tokens passed, but these components used their
`*-strong` alternatives. Both apps now use `*-text`; no token, fill or threshold
changed. Catalog and changelog describe the correction, including the limit of
previous token-only claims.

The normal contrast hook now derives every `.nds-tag.<tone>` foreground/background
pair from that app's `primitives.css`; missing/unmeasurable tone rules fail closed.
`--primitives` supports deliberate CSS fixtures; scratch token copies otherwise
use web component CSS. Relative and absolute Factory token paths select Factory.

Evidence: `build/evidence/listing-issues-20260925/` in the listing-issues helper.

- `tag-guard-red.log`: existing gate omitted all Tag pairs (assertion failure).
- `tag-color-red.log/json`: measured component contrast fails before CSS correction.
- `tag-factory-path-red.log`: relative Factory path wrongly selected web CSS; fixed.
- `tag-tests-final.log`:14 tests pass. Web102/factory116 pairs, zero below7:1.
- Four applied/restored mutations fail assertions: danger/success CSS regression,
  pair omission, Factory path selection. SHA-256 evidence in `tag-mutations.json`
  and `tag-factory-path-mutation.json`; all initial attempts retained.
- Both token guards pass. Web typecheck passes. Factory typecheck fails in unchanged
  `src/lib/shipping/poll-tracking.ts:62` (`orderId` on `{}`), outside this CSS/docs
  slice; log retained. No check was relaxed and its generated build-info was restored.
- Actual Tag in the new card, Chrome390/1280 light/dark: settled minimum measured
  card text contrast8.237 light /8.961 dark. Screenshots and measurements in
  `evidence/listing-issues-20260925/browser/`. Early pre-fix and transition samples
  remain labeled; they are not claimed as passing. Browser fixture uses actual
  components/styles with synthetic local data and the app's Arial fallback.

Independent review pending. Not integrated, deployed, enabled or production-verified.
