# English Information grid headings

The eBay adapter treated untranslated marketplace names as English labels. The current Italian
category therefore showed nine Italian headings, including `Scollatura`, `Cura dell'indumento`,
and `Paese di origine`.

The adapter now uses a pure English display-name lookup. The existing eBay translation dictionary
was moved into `apps/api/src/services/ebay-aspect-names.ts` and reused, with display translations
for the additional names found in the cached categories. Explicit English metadata retains its
wording. The lookup adds no requests to the page-load path.

Display translations preserve existing column keys, mapping attributes, localized item-specific
storage paths, and product values. The legacy schema-ingestion dictionary keeps its existing
coverage so adding a heading translation does not change future schema keys.

Verification:

- Read all four active cached eBay category schemas: all 29 distinct aspect names resolve to English.
- Read the live GALE-JACKET Information responses: all 49 eBay, 162 Amazon, and 56 Shared product
  column headings are English. Amazon and Shared product needed no changes.
- Verified the live eBay grid and Customise columns dialog, including searching for `Neckline` and
  dismissing with Escape. Checked desktop light and 900px dark presentation without page overflow.
- 98 tests passed across the English-heading regressions, sheet-column builder, and channel specs.
  API typecheck and both web/Factory token checks passed.
- No product values, layout preferences, or credentials were saved during verification.

Coverage reflects the currently cached categories. New marketplace terms need an English name
in their schema metadata or a display dictionary entry; arbitrary unknown names are not guessed.
