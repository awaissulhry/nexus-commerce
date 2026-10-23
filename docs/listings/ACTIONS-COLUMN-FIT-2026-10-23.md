# Actions column that always fits — plan (23 October 2026)

Status: BUILT (23 Oct) on branch `fix/ds-actions-column-fits`, the Owner's yes (own PR). Merge waits for "Merge #N".

## 1. What is wrong (measured on the live Approvals page, 23 Oct)

- The design-system (DS) `actionsColumn` gets a **fixed width that a person guessed**: 56, 120 or 200 px, from the
  number of buttons only. The real labels, the language, the font and the density are not part of the number.
- A waiting row on Approvals shows **Approve · Reject · ⋯**. These need **204 px**. The column is **200 px**. The
  last 4 px are cut on every waiting row. The Harvest terms page has the same three buttons and the same cut.
- The buttons can shrink and be cut: the cell does not stop them from squeezing.
- Saved layouts and views store this column's width. An old saved width wins over the code.
- Some columns are too wide: Listing readiness "Fix · Edit" needs about 122 px but gets 200 px (78 px empty).

## 2. The fix — in the design system, so every page gets it

| # | Change | File (DS, mirrored to Factory where the file is mirrored) |
|---|---|---|
| 1 | **The width follows the buttons.** Each row's cell measures its own buttons. The column becomes the widest row on screen plus the cell padding on both sides. It measures again when the labels, the rows, the density (Compact / Cozy / Spacious), the font or the screen width change. While you look at the page it only grows, so it never jumps when you scroll. It starts from today's numbers, so the first paint looks the same. | `grid/renderers/cells.tsx` (`ActionsCell`), new pure `grid/renderers/actionsFit.ts` + test |
| 2 | **Nothing else can change this width.** A saved layout or a saved view never sets it. If anything changes it (a saved layout, a view, an auto-size), the DS puts the measured width straight back. | `grid/columns/presets.ts` (`actionsColumn`), `grid/NexusGrid.tsx` (initial state), `grid/views/landing.ts` |
| 3 | **Buttons never squeeze or wrap.** They keep their own size in one line. | `grid/theme/grid.css` (`.nds-cell-actions`) |
| 4 | **Very narrow screens (phones):** if the buttons need more than one third of the table width, the buttons that do not fit move into the ⋯ menu, with the same action and the same "why not" text. Nothing is cut. | `cells.tsx`, `actionsFit.ts` |
| 5 | **It cannot come back.** The `width` option is removed from `actionsColumn`, so the type check refuses a fixed width on any page. Approvals (200 / 104 px) and Waste (120 px) lose their fixed numbers. Tests cover the width rule, the saved-width case, grow-only and the phone fold. | `presets.ts`, `fleet/approvals/grid/queueColumns.tsx`, `negative-targeting/waste/columns.tsx`, tests, `CHANGELOG.md` |

## 3. What changes on screen (measured with the live font, Cozy density)

| Page | Buttons | Today | After |
|---|---|---|---|
| Approvals (waiting row) | Approve · Reject · ⋯ | 200 px, 4 px cut | 204 px, all visible |
| Harvest terms | Approve · Reject · ⋯ | 200 px, 4 px cut | 204 px, all visible |
| Listing readiness | Fix · Edit | 200 px (78 px empty) | about 122 px |
| Products | Edit · ⋯ | 120 px | about 108 px; the buttons look the same |
| ⋯-only tables (rules, sources) | ⋯ | 56 px | about 54 px |
| Approvals on a phone | Approve | 104 px | about 102 px |

The buttons themselves (size, colour, order, keys) do not change.

## 4. Build and checks

- One branch from `origin/main`, its own PR (not inside #748). #748 gets the fix through the DS, with no change of
  its own.
- Checks: `npm run typecheck -w @nexus/web`; the DS grid tests and the tests of the pages above; the DS guards
  (`check-ds-fork-drift`, `check-raw-primitives-ratchet`, `css-shadow`, `ds-gaps`).
- Browser check on the private local stack: Approvals, Products, Listing readiness, Harvest terms — light and dark,
  desktop and 390 px phone, all three densities, a saved layout with a wrong width, keyboard only.
- The merge waits for "Merge #N".

## 5. What was built (23 October 2026)

Built as planned, with two changes found during the browser check:

- **The fold starts at half of the table, not one third.** At one third, Listing readiness on a phone (table 288 px)
  would have hidden Edit inside ⋯. At half, Fix · Edit stay. Approve · Reject · ⋯ (206 px) fold only in a
  table narrower than 412 px.
- **The width is set at once, not on the next screen update.** A tab in the background does not update its screen, so
  it kept the 200 px first paint until it was shown. Now no frame of the old width is drawn, and background tabs are
  fitted too.

Measured in the browser (private stack, loopback only):

| Page | Before | After |
|---|---|---|
| Approvals, waiting row (Approve · Reject · ⋯) | 200 px, cut | 206 px, all visible (the cell borders add 2 px) |
| Approvals, saved layout of 104 px or 400 px | the saved width | 206 px |
| Approvals, phone (Approve) | 104 px | 104 px |
| Approvals, table squeezed to 380 px | cut | Approve · ⋯ (138 px); Reject is in the ⋯ menu, red; it comes back when the table is wide again |
| Listing readiness (Fix · Edit) | 200 px | 123 px (Compact 115 px) |
| Products (Edit · ⋯) | 120 px | 110 px |

Also checked: light and dark, Compact / Cozy / Spacious, keyboard (Tab walks Approve → Reject → ⋯), no new console
errors. Harvest terms and Waste have no rows in the local copy, so they were not seen in the browser; they use the same
column, and the tests cover the rule.
