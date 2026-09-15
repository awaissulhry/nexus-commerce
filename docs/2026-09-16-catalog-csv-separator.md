# Catalog CSV separator fix

## Reported behavior

Importing product changes from a CSV failed with
`Invalid Record Length: expect 1, got 2 on line 2`. The 2026-09-15 record-size fix
(`docs/2026-09-15-catalog-csv-record-limit.md`) did not address it: that one raised
`max_record_size`, which produces a different parser error. This one is about the
SEPARATOR, and the two are independent.

## Cause

Every catalog CSV reader parsed with csv-parse's comma default. A spreadsheet writes
the separator of the operator's locale — `;` across most of Europe, sometimes a tab —
and some Excel versions lead the file with a `sep=` dialect line. Under the comma
default the header of such a file is ONE column, so the first value that contains a
comma becomes a second cell and csv-parse refuses the record:

```
entity;sku;field;action;value;version          → 1 field
Products;GALE;name;SET;Gale jacket, blue;3     → 2 fields  → expect 1, got 2 on line 2
```

The message names the parser's counts, not the file's shape, so it reads as a product
bug rather than as "this file is separated by `;`".

## Fixed behavior

`catalog-csv-dialect.ts` reads the dialect from the file before parsing: it consumes an
Excel `sep=` line and otherwise picks the separator whose HEADER RECORD yields the most
columns among `,` `;` tab `|`, comma first on a tie. Detection parses candidates rather
than counting bytes, because only a parse can tell a separator from the same character
inside a quoted value.

Row shape is still enforced — a ragged file is refused exactly as before — but by us, so
the message names the row, both counts and the separator actually used instead of
`Invalid Record Length`. Comma files, quoted commas, quoted separators, embedded
newlines, single-column files, the 10 MiB bound and the record-size fix are unchanged.

## Connections

One rule, four readers — the separator must not be decided twice:

- `catalog-transfer-file.ts:73` (`readTransferFile`) — product-editor import drawer via
  `catalog-editor-workbook.ts:55`, and catalog preview via `catalog-transfer.routes.ts:131`.
- `catalog-source-file.ts:41` (`readSourceFile`) — uploaded and URL-fetched sources
  (`catalog-source.service.ts:19`) and scheduled imports (`scheduled-import.service.ts:199`).
- `product-studio.routes.ts:599` — the sheet's own `POST /products/:id/import/diff`. It
  never raised the error (it parses permissively) but silently matched ZERO columns on a
  `;` file, which is the same defect wearing a quieter coat.
- `variant-transfer.routes.ts:97` — the variants import in the same drawer.

The legacy import-wizard and the FF2 flat-file pipeline are untouched.

## Verification

- `src/services/pim/catalog-csv-dialect.vitest.test.ts` — the reported shape, `sep=` lines,
  tabs, quoted separators, single-column files, and the ragged-row message; gated in
  `deploy-api.yml` beside the record-limit regressions.
- Screen: product sheet → More → Import → a `;` CSV whose value contains a comma reaches
  "Review product changes" with `Description → Giacca da moto impermeabile, ventilata e con
  protezioni` in ONE cell, 0 issues.
