# Master-first product grid implementation and verification

Implemented the core follow-up to the [quality audit](2026-09-06-product-grid-quality-audit.md). The editor keeps Master as the source, applies market mappings, and stores explicit overrides on the addressed listing. This is not an unrestricted release sign-off: category setup, verified product content and broader formula/concurrency work remain below.

| Area | Implemented behavior |
| --- | --- |
| Shared storage rules | Manual edits and imports use the same mutation builder. The sheet, mapping resolver and import preview share stored-value interpretation. Formulas continue to save values through the ordinary bulk writer. |
| Explicit blanks | Clear stores an explicit blank. Follow Master removes the override and restores the relevant follow flag. False and zero remain values. |
| Listing fields | Title, price and other mapped columns use the same override/follow rules. Writes remove legacy JSON counterparts that could shadow the intended field. |
| Lists | Resetting a slot opens a whole-list confirmation showing its scope and current positions. Confirmation sends a whole-list reset. Cancel writes nothing. |
| Editing list positions | Existing overrides preserve their siblings, including empty positions. Inherited lists are seeded through the channel mapping resolver, including localization. Missing resolution refuses the edit. |
| Ambiguous list batches | Whole-list replacements/resets cannot be mixed with edits to their slots. Slot edits cannot broadcast one listing's sibling values across several coordinates. |
| Formula scope | Preview/evaluation select the primary account and primary alias explicitly. The API refuses named-alias/account formula coordinates; the grid prevents alias formula edits and hides primary formula marks/exports on aliases. |
| Concurrency | Mixed Master/listing pastes become separate requests with their respective version tokens and per-cell outcomes. Listing guards execute before the transaction's value writes. Platform bags and slot arrays guard the snapshot used for their replacement, including tokenless callers. |
| Disconnected writes | A mixed write retains known successes/refusals and reconciles only cells whose answer is unknown. |
| CI | Added product-grid API and editor regression steps. Embedded PostgreSQL persistence tests use a disposable database and require no catalog credentials. |

The inheritance path remains: shared Master facts → the product/variant's applicable values and locale → the category's channel/market mapping → the explicit override at product + channel + market + account + alias. Follow Master removes that last override. A parent channel listing does not become an implicit inheritance layer for its children.

Verification completed on September 6, 2026:

| Check | Result |
| --- | --- |
| Frontend grid/editor suite | 2,141 tests passed, 139 files; includes the default live eBay contract checks |
| API PIM/formula/bulk suite | 816 tests passed, 70 files |
| Additional live Amazon contract suite | 13 tests passed |
| Web and API TypeScript checks | Passed |
| Isolated web production build | Passed using `.next-product-grid-audit` |
| Grid module gate | Passed |
| Local design-system declarations | Regenerated the four affected declarations |
| Embedded PostgreSQL | Eight persistence cases cover set/clear/inherit, coordinate separation, independent JSON merges, nullable account uniqueness and rollback |
| Real Prisma/database round trips | 24 checks passed across seven storage/value cases, market isolation, stale-version refusal and rollback; zero persisted fixture products |
| Existing catalog-transfer rollback fixture | Nine checks passed, including exact account selection, inheritance, audit entries and stale-preview refusal; zero persisted fixture products |
| Browser | Whole-list tooltip, full confirmation contents, Cancel behavior and return to the grid checked. Temporary column pinning was restored. No live list was reset. |
| Read-only market matrix | 36 requests: 27 successful sheets and nine expected unsupported-market responses; 37,338 cells and 1,842 overrides; zero checked invariant failures |

The market matrix checks scope/market identity, unique rows and columns, declared cells, write targets, mapped/displayed value agreement, override provenance and missing-schema readiness. It does not establish that the product's content satisfies every marketplace requirement. The retained [market evidence](2026-09-06-master-first-market-verification.json) includes the actual content and schema errors.

The embedded PostgreSQL cases exercise production JSON-merge SQL against a minimal schema. They do not simulate two independent remote database sessions. The real database fixture exercises the shared mutation builder through Prisma against the installed schema in an always-rolled-back transaction. Dedicated price/stock services and their outbound queues are outside that fixture.

Remaining release work:

1. **Reconnect Amazon.** Refreshing OUTERWEAR for BE, IE, PL, SE and TR returned an invalid refresh-token grant on every request. No fresh schemas were obtained. The editor continues to report unavailable requirements. After reconnection, rerun `node --import tsx apps/api/scripts/refresh-product-grid-requirements.mts --apply`.
2. **Resolve eBay categories for DE, FR, ES and UK.** These still expose generic requirements (`EBAY:*`). Italy's category must not be copied into another market without a verified category mapping.
3. **Complete product content from verified facts.** The audited family still has required-content errors such as fabric type, localized descriptions/bullets and eBay title length. No product facts were invented or bulk-rewritten during this implementation.
4. **Migrate formula identity before enabling independent alias/account formulas.** This pass adds explicit scope restrictions; it does not add account/alias columns to `CellFormula`. A change to which account is primary also needs an explicit formula migration policy.
5. **Finish concurrency across dedicated services.** The editor fixes do not unify all Master price/stock/import/synchronization transaction boundaries. In particular, mixed Master/listing pastes are two guarded transactions and may partially succeed; the UI reports each result. This is not an atomic operation across both tables.

Repeatable verification scripts:

- [Database round trips](../apps/api/scripts/verify-channel-value-roundtrips.mts)
- [Catalog-transfer rollback verification](../apps/api/scripts/verify-catalog-transfer.mts)
- [Read-only market matrix](../apps/api/scripts/audit-product-grid-markets.mts)
- [Missing schema refresh](../apps/api/scripts/refresh-product-grid-requirements.mts) — prints the plan unless `--apply` is supplied

Detailed local output is retained in `/tmp/nexus-master-first-*`, `/tmp/nexus-product-grid-build.log`, `/tmp/nexus-product-grid-amazon-live.log` and `/tmp/nexus-catalog-transfer-live-verification.log`. No marketplace publication was performed.
