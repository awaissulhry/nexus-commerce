# Shopify editing browser verification

> Historical evidence: this run preceded the common channel-sheet consolidation. Port 3175 and its harness have been removed. Current actual-editor checks and remaining live-write limitations are in [COMMON-CHANNEL-SHEET.md](COMMON-CHANNEL-SHEET.md).

These checks used the production Studio client, Shopify Information components and unlinked ChannelSheet against the isolated Vite fixture at `127.0.0.1:3175`. The original `3144` demo is also an isolated fixture. Neither fixture proves a real Shopify write or real database transaction. The production API was verified separately with focused tests, and the connected Shopify account was accessed read-only.

Run the fixture from the repository root:

```sh
node docs/audits/2026-09-10-shopify-editing/browser-fixture/server.mjs
```

Open `/products/store-demo/edit/studio?scope=SHOPIFY&market=GLOBAL&tab=sheet`. QA buttons change fixture state only. The fixture derives its column catalog from the recorded store schema and adds synthetic field families for coverage. Its two store states deliberately reuse product GIDs while keeping data separate. English, Italian and German are fixture languages. State is in memory; a server restart resets it. The JSON receipts below persist independently of the server.

## Verified workflows

| Workflow | Observed result | Evidence |
| --- | --- | --- |
| Native structured field | Dimension changed to 12.5; long numeric metadata `12345678901234567` survived. Save draft, hard reload and keyboard reopen retained the value. | [Native receipt](browser-native.json) |
| Unlinked structured fields | Dimension 0 → 25.5 and money 0 → 12.34 used the production AG editor gateway and sheet writer. Requests targeted `channel`, account `shopify`, locale `en`, and listing version 1. Hard reload retained the saved values. | [Unlinked receipt](browser-unlinked.json) |
| Exact variant | A variant text edit changed the first child only; sibling and parent values remained separate. | [Unlinked receipt](browser-unlinked.json) |
| Rich text and reference clearing | Rich text became “Structured rich text saved” while retaining its tree. Size Chart changed from Page 1 to an explicit null. Native undo/redo and Nexus save worked. | [Native receipt](browser-native.json) |
| Nexus conflict recovery | A forced version conflict retained local edits. “Review saved changes” merged disjoint changes, then “Use reviewed draft” and Save succeeded. Actual same-cell conflict choices are covered by `draftMerge` tests. | [Native receipt](browser-native.json), API/Web tests |
| Interrupted synchronization | The mock applied two changes and returned 502. The UI showed 0 of 2 verified and retained the operation. Resume read back the intended values, reached verified, and cleared pending changes. The 502 was never shown as success. | [Native receipt](browser-native.json) |
| Native language isolation | Italian title “Giacca italiana” survived Nexus save and mock synchronization. English remained MOSS. Shared money/dimension fields gave specific read-only language explanations. | [Native final receipt](browser-native-final.json) |
| Store isolation | “Second destination title” persisted only in `shopify-second`. Switching back retained the primary title. The second store’s Italian source did not inherit the primary store’s Italian override. Hard reload retained destination and locale. | [Second store](browser-second-store.json), [primary](browser-native-final.json) |
| Unlinked language isolation | “Bozza italiana indipendente” persisted through Save and hard reload in Italian. English retained “Original draft text”. The actual sheet request carried locale `it`. | [Locale receipt](browser-unlinked-locales.json) |
| Keyboard range fill | Filling a product dimension across its variants and the next product previewed one compatible change and seven skipped cells. Apply was one undo command; redo and save worked. | [Native receipt](browser-native.json) |
| Pointer drag-fill | The actual AG fill handle was dragged from MOSS to AIRMESH across eight selected rows. Preview showed one compatible change and seven skipped cells; Apply, Undo, Redo and Save retained dimension 16 on the two products. | [Drag-fill receipt](browser-drag-fill.json) |
| Keyboard and pointer editors | Enter/F2, double-click native text, pencil activation and nested reference editing were exercised. Closing the nested entry and its parent dialog restored focus to row 0, `metafield:PRODUCT:custom.collapsible_text`, with one selected cell. | Browser DOM observations; production component tests |
| Virtualization | The 10,000-variant fixture exposed 10,003 ARIA rows including the header and 82 synthetic/catalog columns, with 26 mounted rows and 130 cells in the measured viewport. | Browser DOM observation |

Receipts include mock schema-subscription/layout requests as well as writes; their array lengths are **not** counts of completed Shopify changes. `browser-before-restart.json` predates correction of the fixture channel target and is historical, not evidence of successful unlinked persistence. Native receipts from before the fixture restart contain the rich-text/translation/clear cases; later receipts contain drag-fill and unlinked Italian cases.

## Appearance and interaction measurements

No shared grid theme, loading-overlay configuration, selection border, selection wash, padding or row-height rule was changed. Measured native cell styles remained:

| Property | Measured value |
| --- | --- |
| Selected contour | 1 px solid `rgb(31, 111, 222)` |
| Row height | 35 px |
| Cell padding | 0 px vertically, 9 px horizontally |
| Cell typography | 500, 13 px Arial |
| Multi-cell selection | Existing blue wash at 0.2 opacity; eight selected cells during drag-fill |
| Pending changes | Existing amber wash retained |

The dimension editor measured 350 × 307 px at a 390 px viewport, without horizontal overflow. See [light](editor-light-390.jpg) and [dark](editor-dark-390.jpg). The reference dialog measured 350 × 418 px at the same viewport. The final nested reusable-entry dialog measured 350 × 518 px; [screenshot](entry-editor-390.jpg). It uses the existing medium Modal, removes duplicate scalar headings and collapses the long usage list while keeping shared impact visible. On the standard viewport the reference dialog measured 440 × 418 px.

The grid remains a horizontally scrollable worksheet at narrow widths; dialog-fit measurements are not a claim that all columns fit simultaneously. A pointer attempt on a cell action covered by the pinned column at 390 px did not activate it; the same visible action at the standard viewport opened normally. No grid geometry was changed to conceal this limitation.

Computed-color samples gave 15.48:1 for light body text, 12.73:1 for dark body text and 8.02:1 for the sampled primary button. These are specific measurements, not a complete contrast audit. Controls retain Nexus focus treatment and accessible labels. Existing reduced-motion CSS remains, and the measured modal had no animation; no new feature animation was introduced.

## Transfer, undo and verification limits

- Typed transfer tests preserve raw structures and exact store identity, distinguish clear from empty text, reject media/reference payloads in ordinary text cells, and parse quoted TSV. Browser range-fill used the production handlers. A complete OS clipboard copy/paste round trip remains unverified: the browser automation virtual clipboard returned “no data to paste”.
- Native undo/redo covers up to 50 unsaved commands and resets at Save draft. Existing unlinked AG undo history ends when an acknowledged autosave refreshes row data. Neither path offers a compensating undo after a Shopify synchronization.
- Cmd+plus did not measurably change the browser zoom; actual zoom remains unverified. The browser viewport was restored after testing.
- Screen-reader speech and a forced reduced-motion user preference were not exercised. DOM roles/names, focus restoration, responsive dialogs, keyboard behavior and motion rules were checked. No WCAG AAA certification is claimed.
- A 16-key timing sample previously measured a 25.2 ms p95 two-frame proxy. It is not a measured rendering/paint SLA or broad performance benchmark.
- Real Shopify writes, real Nexus database persistence, uploads and storefront/theme rendering were not exercised in this browser fixture. Category constraints and fresh pre-write applicability are covered by unit tests and [real read-only API evidence](live-applicability-1.json), not a live category/metafield mutation.

