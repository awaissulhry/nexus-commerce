# Historical eBay workbook imports

The product editor accepts the historical Nexus `ebay_it` / `ebay_de` / `ebay_fr` /
`ebay_es` / `ebay_uk` single-sheet XLSX export. Previously it rejected these sheets
as an unknown workbook, while generic SKU mapping could not distinguish repeated
variants belonging to different eBay listings.

## Identity and review

The adapter uses Item ID, parent SKU, variant SKU, marketplace and optional
immutable Listing ID to resolve an existing listing inside the editor's product
group. The account, canonical SKU, alias key and record version come from Nexus.
Adopted parent labels are recovered through `adoptedFromProductId`; changing the
alias's display label cannot redirect an import. Missing and ambiguous matches,
duplicate targets, or inconsistent parent/category relationships block the review.

Native uploads capture current record versions at inspection, like supplier data.
They do not have an original export baseline. The inspection warning makes this
distinction explicit; subsequent preview/apply uses the existing conflict checks.
The regular v3 editing workbook retains its server-owned export baseline.

The existing inspect/preview/apply endpoints and product scope checks remain the
owners of the workflow. No additional publishing or migration endpoint is added.

## Values

- Populated supported fields become typed draft changes. Blank cells preserve data.
- Lists follow the current category's cardinality. Scalar commas are preserved.
- Weight and unit become one measurement; zero and false remain values.
- Ordered image slots become the image URL list.
- Location maps to `itemLocationCountry`, the country code already used by the
  eBay writer. It does not mean the shipping city.
- Price, quantity, follow/buffer controls, external IDs and sync fields remain
  explicitly excluded references. Lifecycle actions are rejected.
- Every populated cell of an identity-resolved row is mapped, excluded with a
  reason, or reported as an issue. Invalid identities block their complete row.
- Unknown populated columns and invalid strict provider choices are issues,
  including custom specifics outside the current category schema. There is no
  automatic custom-field renaming or silent removal.

## Legacy shells

This adapter does not convert `EBAY_LISTING_SHELL` products into aliases. Existing
shell parent rows and shared variant memberships must first be migrated into
account-owned ProductListingAlias and ChannelListing records. The obsolete narrow
ChannelListing unique indexes must also be removed through the database deployment
workflow. The old shell-adoption script alone does not provide all required alias
keys, account ownership or variant rows.

The GALE audit verified five live Italy listings and 100 variation rows. Following
the owner's authorization on September 15, all four shells were adopted into
account-owned aliases, with 80 additional variant listings and both XXS master
records corrected. Parent ChannelListing IDs and the five remote item IDs were
preserved. The retired shells retain their media/history and adoption provenance.

`20260915_pes5_ii_enable_listing_aliases` completes the deferred index cutover and
restores NULLS NOT DISTINCT on the workspace/account/alias keys. A local PostgreSQL
rehearsal accepted distinct aliases and rejected duplicate primary, alias and
unattributed coordinates. The production migration was applied and recorded
against healthy API build `fc92f3d8`.

The operational import explicitly normalizes the provider's season choice and
excludes seven obsolete custom columns while retaining the complete source and
cell evidence. These are reviewed source decisions, not automatic adapter rules.
The original workbook therefore still reports those issues if uploaded unchanged.

## Verification

The new parser tests cover five listings sharing 20 variants, typed values,
parent/category consistency, wrong IDs, missing aliases, ambiguous accounts,
formulas, unsupported columns and canonical workbook round trips. Product HTTP
tests exercise independent alias writes and verify that a missing alias blocks the
whole import without writes. The native eBay HTTP regression also imports a
schema-declared localized Style field independently for each alias. The effective
preview resolver now receives those validated custom content keys; previously
it rejected Style even though the schema and import planner accepted it.

After that fix, the workbook/product/source/HTTP suites passed 74 tests (three
optional tests skipped). Alias, relationship and live-local variation checks also
passed in the separate 83-test run. API type checking passed.
