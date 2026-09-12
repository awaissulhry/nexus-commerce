# Product workbook functionality

This pass builds on the [formatting work](../2026-09-08-workbook-format/README.md) using a real saved GALE-JACKET export. It changes the production XLSX writer and reader, field metadata mapping and focused tests. No web or shared design-system source is changed; the product header's existing `titleMenu` remains in `DetailHeader`.

## Changes

- Data rows have a maximum initial height of 72 points with text aligned at the top. The complete stored value remains intact. Instructions and header notes explain how to read long descriptions through the expanded formula bar or a taller row.
- Valid values retains one row per attribute and destination. A separate Choice rule column distinguishes fixed lists, suggestions that allow custom values, and unavailable rule information. Strict lists display a warning for unlisted input, consistent with the existing grid contract; suggestions do not. Import still checks current rules. List fields explain JSON array entry and do not pretend to support Excel multiple selection.
- Workbook fields now retain the source contract's choice mode, including shared fields' character limits and allowed units.
- Dictionary, Valid values and the hidden matching sheet have password-free worksheet protection. Users can select, copy, resize and filter reference cells. Sorting or editing these sheets is disabled to avoid changing the static named ranges' choices. Worksheet protection prevents accidental edits; server-side snapshot, identity and dictionary checks remain authoritative.
- Header filters remain in place. All data columns, including hidden alias identities and versions, belong to the sortable range. Instructions explicitly explain that filtered or hidden rows are imported and that removing rows/columns excludes edits without deleting catalog data.
- Editing exports display their creation and expiry times. The displayed expiry is the exact 30-day timestamp persisted with the owner-bound export baseline. Concurrent changes can invalidate an export sooner.
- Native LibreOffice saving rewrites logical values as `TRUE()` and `FALSE()`. The reader accepts only these zero-argument constants in data value cells, deriving their boolean value directly without trusting cached results. This also preserves legacy booleans under text field definitions. Calculated formulas, formula identities/metadata and error cells remain rejected. Normal type validation still applies to edited values.
- With the new Choice rule column, a horizontal choice row can contain at most 16,379 choices. The writer refuses larger lists explicitly; it never truncates them. Reference cells still count toward the workbook size budget.

## Verification

- **56 focused tests passed, 3 optional tests skipped.** [Test log](tests.log). Coverage includes real export/preview/apply routes, sorted named aliases with one hidden row, independent updates to two aliases while preserving the primary listing, exact named ranges across save/reopen, strict and suggested choices, source metadata, long-text preservation, reference protection, visible expiry and refusal of calculated formulas. Logical-constant tests include absent and deliberately incorrect cached results.
- **Native save/reopen:** LibreOffice 26.2.4.2 opened and saved the real GALE-JACKET workbook. The production reader then recovered all **335 attribute values** with exact identities, destinations, versions and actions. All **13 populated scalar dropdowns** retained their named ranges. Reference protection, header filters, frozen identifiers and compact row heights also survived. Native row-height rounding is below one point. [Machine-readable result](../../../outputs/gale-workbook-functionality-2026-09-08/native-verification.json).
- Artifact Tool previews were inspected for long-content rows, instructions, horizontal reference choices and editable/reference colors. Its known preview differences from native Excel rendering do not alter the XLSX. [Instructions](Instructions.png), [Products](Products.png), [Amazon](AMAZON-IT.png), [eBay](EBAY-IT.png), [Valid values](Valid-values.png), [Dictionary](Dictionary.png).
- **The final full API type check passed.** [Log](types.log). An intermediate run encountered syntax errors in concurrent edits to category and listing-wizard services; those edits completed and the final check passed without changes to those files from this work. The intermediate log is retained as `types-intermediate.log`.
- Microsoft Excel UI interaction and the normal product-page integration were not re-tested in this pass. No deployment or live catalog mutation occurred. These checks do not constitute an unconditional AAA or accessibility certification.

## Real-product example

[GALE-JACKET example](../../../outputs/gale-workbook-functionality-2026-09-08/GALE-JACKET-functional-example.xlsx) preserves the 335 values from the user's Downloads export saved September 5, with field guidance from their saved September 7 export. Its four data sheets cover shared product facts, Italian content, Amazon Italy and eBay Italy. Those source records contain only primary listings; named aliases were not invented. The route tests separately exercise multiple named aliases.

A byte-identical copy was saved to `/Users/awais/Downloads/GALE-JACKET-functional-example.xlsx` (168,854 bytes; SHA-256 `4c61eb7a58c7a9fc1ccad203aac02293513e1fcb8acbb8c4c5e82f3343b2b5f2`).

The example has no registered live export baseline and is clearly labeled for layout inspection. Download a fresh product-editor export before importing edits. The older snapshots do not record strict/open choice modes, so this example honestly asks users to check those rules in Nexus. Fresh production exports carry the available current metadata.

The [example builder](build-gale-example.mts) and [native verification script](verify-native.mts) retain the local source paths for reproduction. The builder writes a temporary baseline for verification only; it does not register an application export.
