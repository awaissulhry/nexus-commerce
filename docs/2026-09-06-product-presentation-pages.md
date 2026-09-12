# Product eBay presentation pages

Completed 2026-09-06. The owner requested a layout rebuild and a decision about separate navigation. Description themes and Variation order are now separate product pages under the existing eBay sidebar branch. This supersedes the earlier combined-entry decision.

## Result

- Description themes has a listing-alias selector with account, market and ItemID context, theme assignment, access to the existing Information description owner, explicit shared-theme management, and a large buyer preview beside the controls. The shared HTML editor loads on demand.
- Variation order has inline axis/value cards, keyboard and drag ordering, inheritance reset, explicit Save and Discard actions, and the existing reviewed publication workflow. Single products without variants receive an explanatory state and an Information link.
- Existing `tab=presentation` links open Description themes. `tab=variation-order` opens Variation order. Both are available only in eBay scope. Native links and guarded clicks retain the same product/account/market/locale/listing destination; Amazon and Shared cannot land on these tasks.
- Pending theme writes, order drafts and publication requests retain their existing destination guards. The new inline order page uses a DS Drawer for discard confirmation, replacing the old editor's in-panel confirmation in this consumer. Browser verification caught and fixed the initial confirmation appearing behind navigation.
- Theme assignment still uses the canonical channel writer and listing version. Order reads, saves, revision tokens and publication use the existing account/market/alias services. Information still owns description overrides. Shared product facts, theme definitions, inventory, pricing and the shared grid retain their owners.

## Files

The implementation changes are in `PresentationTab.tsx`, Studio tab types/availability/navigation/host/save-label files, and `ebay-flat-file/Presentation/OrderEditor.tsx`. Layout-only semantic-token CSS is in `Presentation/presentation.module.css`. Navigation and availability tests cover the new route and retained alias coordinates. The README and product-context addendum record the new accepted decision.

All new controls compose Nexus PageHeader, Card, Field, Listbox, OrderedList, Drawer, Button, Banner, ProgressBar and EmptyState. No shared DS or grid implementation changed: Web and Factory hashes match the starting snapshot. No Factory mirror was necessary.

## Verification

- Web Studio/Presentation regression suite: **80 files / 1,323 tests passed**. This includes the existing 13 read-only local-API cases; all edit/publication browser work used isolated fixtures. `/tmp/nexus-presentation-split-web-suite.log`.
- API destination/presentation/alias/canonical-write fixtures: **83 passed, 2 opt-in browser cases skipped**. Permission matrix and route precedence: **31 passed**. `/tmp/nexus-presentation-split-api-tests.log` and `/tmp/nexus-presentation-split-permissions.log`. Existing conflict, stale revision, foreign/inactive alias, account isolation and exact publication tests pass.
- Final Web and Factory types pass. An intermediate Web typecheck encountered an unrelated `referenceLabels.ts` error while that file was changing elsewhere; this session did not edit it, and the final standard typecheck is clean. `/tmp/nexus-presentation-split-types-final.log`, `/tmp/nexus-presentation-split-factory-types.log`.
- Web generated tokens, token guard and raw-control ratchet pass. Owned TSX/CSS was also checked directly because the repository ratchet skips untracked feature files.
- Actual Studio browser on isolated ports 3105/4105: primary/alternate alias selection, exact account and ItemID, theme/order navigation, keyboard ordering, draft Keep/Discard, automatic theme assignment and explicit order save passed. A primary alias order save changed only `f1-b-IT-` v1→2; an alternate theme assignment changed only `f1-b-IT-alt` v1→2. Other listing versions stayed 1. Returning to the other alias restored its own values. The existing shared theme stayed unchanged; the theme-list service seeded its built-in themes in the in-memory fixture.
- Publication review displayed **Item 102 / account b / IT / primary listing / v2**. Only mocked marketplace reads occurred; no publication execution or live catalog mutation was performed.
- Desktop and 390×844 light/dark layouts inspected. At 390 pixels both page panels were 324 pixels beside the 66-pixel primary rail, with document width/scrollWidth 390. Separate sidebar entries fit; keyboard activation and focus restoration worked. New page body copy uses the strong semantic text token at the DS 13px base size.

## Limits and cleanup

This is a product-page layout and navigation rebuild, not a rebuild of the shared theme library, publication service or mapping engine. Inventory-managed publication, standing order activation, alias-creation migration checks and other existing owner restrictions remain. The earlier Factory token-guard baseline and wider shared-control AAA findings remain documented in the scope audit; no full AAA certification, full production build or production-scale performance claim is made here.

The isolated preview initially used an origin blocked by the development server. Restarting only the owned Web preview on its configured localhost origin resolved hydration; no platform configuration was changed. Sandbox IPC/localhost checks were rerun with approved execution and passed.

Browser released: dark appearance restored, viewport reset to its normal 1728-pixel width, owned tab closed, and only the owned 3105/4105 servers stopped. The temporary API fixture was archived as `/tmp/nexus-presentation-split-browser-fixture.vitest.test.ts` and removed from the repository. No temporary frontend page was created.

Starting source and DS hashes: `/tmp/nexus-presentation-split-before`. Review delta: `/tmp/nexus-presentation-split-review.diff`. Isolated browser evidence: `/tmp/nexus-presentation-split-browser-evidence.json`. The dirty shared tree was preserved; no commits, resets, stashes, migrations or unrelated platform edits were performed.
