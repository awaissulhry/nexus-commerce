# Historical implementation checkpoint

The current delivery record is [README.md](README.md). The notes below are an earlier work checkpoint and are superseded by its coverage, verification and migration records.

In progress; this is not a completion claim. Preserve unrelated working-tree changes. Baselines for existing files touched in this phase are in `/tmp/nexus-information-before`. No production data or provider writes.

Implemented and under verification:

- Requested/effective locale, legacy translation adoption without destructive migration, explicit null/empty/reset, draft/reviewed/outdated state and source hashes, atomic localized saves and locale-aware existing master-content synchronization.
- CellFormula account/alias identity, additive migration (not applied), exact destination authoring/read/recalculation/recovery, grid row identity, history isolation. Unattributed older recovery operations now refuse mutation instead of guessing an account.
- Resolver batches the complete family beyond 250 IDs. Amazon conditional UTF-8 and selector uniqueness vocabulary validates serialized structures. Seller-specific schema fetch/cache uses the selected account.
- Existing common sheet extended for Etsy localized Nexus drafts and named shipping/section/return/processing references. Etsy property option codes now retain value IDs with labels, scale constraints under verification.
- New RecordListInput design-system control, mirrored Factory, connected to dictionary-driven structured editing and validation. Localized dictionary option labels, measurement bounds, explicit empty lists, conditional family requirements.
- Nonfunctional alias publish control replaced by an accurate saved Information check. Shopify's existing synchronization/recovery remains in place.
- Candidate channel saves now use the existing read-only resolver simulation before persistence, including formula previews. Fixed a real second-account bug (writer parameter accountId versus channelConnectionId) and missing Etsy category context on writes.

Evidence so far:

- Disposable PostgreSQL API/formula suite: 15 passed, including 2 Etsy accounts × 3 listings × 2 languages (12 independently saved formulas), undo/recovery/conflicts, localized writes and recalculation. Latest complete log `/tmp/nexus-information-formula-db.log`.
- 19 focused locale/Amazon/batching/Etsy content checks passed; earlier 88 formula/core tests passed before the newest changes.
- API/web types passed earlier; rerun required after current edits. One latest slot-number type error has been fixed.
- Browser skill initialized with Chrome; session named “Information page verification”; no page verification yet.

Remaining acceptance work:

- Complete migration impact preview and isolated migration check, safe dictionary correction definitions/procedure and concrete impact record.
- Finish history field/locale aliases, list reset UX, localized custom facts fallback, formula source-language and shared field ownership handling.
- Finish destination locale guards and Etsy stable IDs/scale test expectations; named reference/seller cache tests.
- Browser fixture of real common sheet across all scopes: typed editing, save/reload, errors/recovery/scope switches, keyboard/focus and visual/accessibility checks.
- Run broader relevant tests/types/token/DS guards; correct regressions and report unrelated failures separately.
- Deliver scope coverage, evidence/limits, safe migration steps, later-page/publishing backlog. Do not claim formal AAA conformance or provider delivery that has not been verified.
