# PR.8 toolbar — measured baseline and work in progress

2026-09-13, signed-in GALE-JACKET (`cmokmy3a40078pm0p1fvnu523`), `http://localhost:3000`, 1440×900. No product, view or channel write was performed. View prompts were cancelled; the Requirements dialog was opened and closed without refreshing. API environment identification names local `127.0.0.1:55439/nexus_development` from `apps/api` CWD and Neon production from root CWD. Browser API-origin verification is still required before any write rehearsal.

**P-TOOLBAR and W3-SURFACE are not DONE.** This folder records the before measurements, the independent overflow explanation change, and outstanding coordinated work. It contains no passing Listings browser gate.

## Toolbar before, both themes

| Measurement | Shared product | Amazon · IT |
| --- | --- | --- |
| Frame bands | 49 + 40 = 89px | 49 + 40 = 89px |
| Toolbar | x67, y146, 1372×40px | x67, y146, 1372×40px |
| Computed padding | 0px 6px | 0px 6px |
| Required chip | `1 column` | `31 columns` |
| Languages chip | `64 columns` | `13 columns` |
| Folded filter count | `Filters 4` | `Filters 7` |
| Status-slot content | Classification button, 106.39×28px | Requirements button, 107.67×28px |

On shared product, Warnings displays `1 column`; its accessible text describes `21 affected cells across 1 column and 21 rows`. The Owner later approved displaying the producer quantity. The test now asserts `63 cells` while retaining `3 columns` and `21 rows` in the filter-breadth detail.

The shared-product Views prompt replaces a 124.14px trigger with an inline group: 180px input, 85.06px Save view, 65.98px Cancel, and gaps. Required moves from x606.52 to x770.19 (+163.66px); Classification moves from x1020.53 to x1184.20. Find shrinks from 317px to 259.76px. Both themes retain a 40px toolbar and 1372px client/scroll widths with the existing folding behavior. This is a layout shift, not a measured overflow.

Numeric readings: [before.json](before.json), [Amazon light](before-amazon-light.json), [Amazon dark](before-amazon-dark.json). Screens: [shared light](before-light-toolbar.png), [shared dark](before-dark-toolbar.png), [light prompt](before-light-prompt.png), [dark prompt](before-dark-prompt.png), [Amazon light](before-amazon-light-toolbar.png), [Amazon dark](before-amazon-dark-toolbar.png), [Requirements dialog](before-amazon-light-requirements.png).

## Actual padding owners

Both active declarations have specificity (0,2,0):

- `design-system/styles/patterns.css`: `.nds-gridcard .nds-toolbar { padding: 14px 16px }`.
- `design-system/grid/theme/grid.css`: `.nds-grid-sheet .nds-toolbar { padding: 0 6px }`.

The latter wins in both themes at 1440. Neither literal comes from a studio stylesheet. The max-width:1279 rule is inactive at this viewport. PR.6 owns the requested specificity correction; the 6px gutter and existing responsive policy stay within D23's hold.

## Skeleton and frame precedent

The actual route fallback is **48 + 44 + 34 = 126px**, in both themes. Each band uses border-box sizing, so its 1px bottom border is included. The audit's 129px and the initial source-derived prediction double-count the borders. The live frame is 89px: the actual excess is 37px. PR.7 owns removal of the obsolete third skeleton band and the dead studio CSS.

Evidence: [light numbers](before-skeleton-light.json), [dark numbers](before-skeleton-dark.json), [light screenshot](before-skeleton-light.png), [dark screenshot](before-skeleton-dark.png).

Variants confirms 49px subheader, 40px scope, 40px page band, 40px toolbar, 30px group strip, 28px column header plus 1px rule, 36px rows, 36px footer, 380px identity and 28px controls. Its projection read fails after one retry and adds a visible 63.67px warning banner. Those captures establish geometry, not a healthy data run: [light](before-variants-light.json), [dark](before-variants-dark.json), [light screenshot](before-variants-light.png), [dark screenshot](before-variants-dark.png).

[Navigation screenshot](before-navigation-dark.png) witnesses Matrix mounted between Information and Variants. The proposed Listings roll-up position is immediately after Matrix; each channel gets Listings before Listing information.

## Applied change and validation

PR.8's `SheetToolbar.tsx` hunk gives sheet-wide loading/read-failure overflow holds both a `title` and a keyboard-reachable `description`, preserving prior refusal text, separators and Reload recovery. PR.7 then applied the prepared pending-write consumer and all three real caller props in one save. Pending writes now hold overflow verbs with `Wait for the pending write to finish.` while keeping the loaded row count visible. Other changes in that file's git diff predate this lane.

At 18:51 local, load below 8:

```sh
cd apps/web
../../node_modules/.bin/vitest run 'src/app/products/[id]/edit/_studio/sheet/SheetToolbar.vitest.test.ts' 'src/app/products/[id]/edit/_studio/sheet/sheetGridStates.vitest.test.ts' > /private/tmp/nexus-pr8-presence/toolbar-tests.log 2>&1
```

Exit 0: **12 tests, two files**. Node-only, `react-dom/server`, real Menu declarations inspected; available action and recovery positive controls included. [Test log](toolbar-tests.log).

```sh
node scripts/typecheck-scoped.mjs 'apps/web/src/app/products/[id]/edit/_studio/sheet/SheetToolbar.tsx' 'apps/web/src/app/products/[id]/edit/_studio/sheet/SheetToolbar.vitest.test.ts' > /private/tmp/nexus-pr8-presence/toolbar-tsc.log 2>&1
```

Exit 0, 3.9s: the two files, ambient declarations and transitive imports. This is not a full web typecheck. [Typecheck log](toolbar-tsc.log).

## Pending coordination

- Owner D23: resolved by “I’ll go with your recommendations, so please get it all done.” Producer quantity approved and applied.
- PR.6: typed status renderer, portalled Views prompts with `Menu.selectedId`, and measured padding ownership.
- PR.7: atomic chip/status producer migration; dialog verbs in the existing overflow; dead CSS and measured skeleton correction. The separate pending-write pair in `/private/tmp/nexus-pr8-presence/toolbar_pending_pair.py` was applied with all three real pending-state caller props by PR.7; validation is below.
- MX: lanes explicitly closed; count/status compatibility applied. Future Listings editor-open additions claimed.
- W3: await full `W2-READ`, `W2-DS`, `W2-WIRE` and `W3-API` gates. `W2-READ-SHAPE` is consumed. Seller SKU, alias ID, last change and verification cap copy are requested from PR.1/PR.7. Listings must handle missing coordinates before the tab host's coordinate-dependent editor guards.

No collapse ladder, Transfer merge, gutter redesign, Listings mount, channel-reaching verb, database mutation, commit or completion gate is claimed here.

## Pending-write pair validation

At 19:04 local, initial load7.93, the same two-file node-only Vitest command passed **14 tests**, exit0. The added arms prove the exact pending-write sentence, preserved prior reason, and visible loaded/selected row counts. [Test log](toolbar-pending-tests.log).

Full web typecheck, private build-info:

```sh
node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json --tsBuildInfoFile /private/tmp/nexus-pr8-presence/web-pending.tsbuildinfo > /private/tmp/nexus-pr8-presence/web-pending-tsc.log 2>&1
```

Exit0, zero diagnostics. [Typecheck log](web-pending-tsc.log). This predates the remaining typed-status, chip-count and portalled-prompt work and is not the final PR.8 gate run.


## Resumed implementation and interim screen check

The producer-owned `{n,unit}|null` contract and typed `SheetStatus[]` slot are applied atomically with their callers. Classification and Requirements now open from the existing overflow; their dialogs live outside the bar. A status detail can open an InfoTip, but accepts no command callback or arbitrary React node. PR.6 supplies the existing-tier `compact` prop.

Actual source tests: **8 files, 63 passed**, exit 0, node-only. The final staged full web check had zero diagnostics across the nine paired status files. [Actual tests](toolbar-final-tests.log), [staged full check](status-final-virtual-tsc.log), [status change](status-final.diff), [22 applied file hashes](paired-source-hashes.json).

The 18:56–19:02Z browser window was disturbed by other lanes’ disclosed source saves. All `after-*` files from that window are **interim evidence**, not clean acceptance. Observed at 1440×900 in both themes: toolbar 1372×40px with equal client/scroll width; master Warnings `21 cells`; Amazon Missing required `342 cells`, Warnings `42 cells`, Mapping errors `126 cells`, Invalid values `127 cells`. Existing Required/Languages column-view selectors retain their column units. Classification and Requirements both opened from ⋯; the Requirements status opened only its detail (zero dialogs). The prompt was portalled at 320×126px with a 292px input, and Required stayed x832.27 in both open/closed states (0px shift). Console errors were zero, but HMR is recorded in [the log](after-browser-log.json).

The actual padding cascade still contained the obsolete `padding:0 6px` rule as well as the new specific owner; PR.6 was asked to remove the redundant old declarations. The first after-skeleton capture contains the hydrated frame, **not a measured fallback**. Final clean measurement remains outstanding.
