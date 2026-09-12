# Mapping workflow quality follow-up — 7 September 2026

The mapping hardening pass preserves the reviewed 31-scope field connections. It changes resolution, validation, propagation, publication guards and the review interface. It does not publish live listings or certify every channel adapter or the whole product as defect-free.

## Scope and behavior

- Standing rules belong to a channel and market, with category overlays. They apply to current and future matching products. Resolution, comparisons, adoption and publication retain the exact account, listing alias, actual category and market language. Product-specific overrides remain separate.
- The product mapping matrix reuses canonical resolution. Each coordinate resolves once; only mapped overrides require a second baseline. It retains individual account columns, readable labels, 50-row pagination, error filters and scoped links to the shared rule editor.
- Required fields and narrowed constraints use the full cached Amazon JSON Schema, including conditions, parent/child context, alternatives, dependent requirements, enums and date formats. Schema evaluation failures block publication. Schema-defined selectors and native scalar/list/measure shapes are preserved. Empty sibling arrays are omitted.
- Missing preview values owned by pricing, inventory, media or listing settings are deferred to those workflows. Their absence in this read model does not prove that the outgoing value is missing. The completed Amazon full-update envelope is validated after those owners supply their values. The UI explicitly states that channel validation has not run.
- Legacy direct field writes, bulk writes and rollback reject with `REVIEW_REQUIRED`. Restoration creates a fresh whole-market impact review using current input hashes and revision guards. History exposes saved revisions and the current operator's recent reviews. Existing checkpoint recovery and activation audit remain in use.
- Propagation recomputes each listing's plan, preserves overrides, requires persisted Master values, and guards product/listing versions and timestamps. Queue and audit rows are keyed by listing identity. Missing translations fail atomically; queue dispatch resolves again and refuses stale values, pending translation or missing schemas.
- The Amazon cockpit dry run now returns the real serialized JSON feed envelope. Mapping-sourced Amazon queue updates rebuild the actual attribute patches and require remote validation before transport. eBay updates merge named aspects while preserving unrelated aspects and images. Unsupported serializers and ambiguous ownership are blocked explicitly.
- Source coverage, populated values, local errors, pending translations and channel validation are distinct. The older product tab's five-field completeness percentage is labelled **Basics**, not publication readiness.
- The mapping table remains the primary authoring interface. A dependency visualization can be added later over the same rules; no separate node-based rule engine was introduced.

## Verification

- API regression: **35 files, 335 tests passed**. Coverage includes conditional requirements, actual payload envelopes, exact account/alias queueing, stale values, atomic translation failure, restoration review guards, override preservation, and avoiding duplicate matrix resolution.
- Web mapping contract tests: **2 files, 9 tests passed**.
- All **89 active cached Amazon schemas** passed the evaluator compatibility check; see `schema-validation-quality.json`. This is a cached-schema compatibility check, not a remote freshness guarantee.
- The database-backed formula benchmark used **1,000 products**: **1,931 ms preview**, **20,664 ms apply**, one successful audit receipt per product. See `formula-quality-benchmark.json`. These are local test measurements, not production latency commitments.
- Existing impact tests cover **2,500 products across two accounts**, 100-product checkpoints, override preservation, recovery after interrupted scans, stale-input rejection and prevention of incomplete or unauthorized activation.
- API, Web and Factory type checks; Web production build; Web and Factory generated-token checks and token guards were checked. Factory's 54 platform aliases were replaced with the existing Web semantic tokens, with catalog/changelog/DS-gap records.
- Live product check: the AIRMESH matrix shows **253 fields across five listings**, with **24 fields** under Needs attention. Amazon IT COAT reports **22 missing required mapped values**, with 71 listing/system fields deferred to their owners. Size and colour serialize correctly.
- Browser checks cover the mapping editor, account selection, history loading, keyboard focus containment and return, light/dark themes, a 390-pixel layout without document overflow, and the product mapping matrix. These checks are not a WCAG AAA certification or a screen-reader audit.

## Remaining production gates and explicit limits

1. Three eBay Italy drafts still need category schemas and classification after the saved account credentials are repaired. The original README records their SKUs. No category or product facts were guessed.
2. Connected fields can still have missing or invalid product facts. Conditional validation exposes requirements the earlier leaf-only validator did not check. Earlier reports of zero newly introduced leaf errors do not certify complete current product readiness.
3. Remote channel validation and actual publication were not exercised against live listings. Cached schemas are visibly dated. The new Amazon outbound adapter explicitly supports the primary Amazon account; unsupported account/channel/compound shapes must use a supported listing publisher or receive a dedicated adapter.
4. A pending `translate` transform remains a publication blocker. Generating or storing text alone is not evidence that the final mapped value is ready; dispatch requires canonical resolution to report no pending translation. This pass does not certify unattended AI translation publication.
5. Full Amazon payload validation includes owner-provided values. Mapping preview alone cannot certify inventory, pricing, media, account authorization, remote policy checks or other publisher-owned prerequisites.
6. The build retains the workspace's warning about multiple lockfiles. Initial sandbox attempts could not open the required local IPC/database sockets; the authorized runs outside the sandbox passed. Background Redis DNS failures in the isolated API are not a successful queue transport test.

JSON Schema implementation references: [Ajv JSON Schema support](https://ajv.js.org/json-schema.html), [Amazon product type definitions](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/retrieve-a-product-type-definition).
